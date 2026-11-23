'use strict';
/*
 * Crunchroom: a self-hosted game-jam team hub.
 * Accounts, workspaces with invite links, real-time chat with uploads,
 * handoffs, a task board with dependency pings, presence, private notes,
 * and an AI copilot (Anthropic API, optional).
 *
 * Run:  npm install  &&  npm start     (Node 18 or newer)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- tiny .env loader (no extra dependency) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file: fine */ }

const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UP_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_MB = +process.env.MAX_UPLOAD_MB || 25;
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const AI_MODEL_DEEP = process.env.AI_MODEL_DEEP || 'claude-opus-5-5';
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const AI_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
fs.mkdirSync(UP_DIR, { recursive: true });

// ---- storage: one JSON file, written atomically ----
let db = { users: {}, sessions: {}, workspaces: {}, notes: {}, ai: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read', DB_FILE, e.message); process.exit(1); } }
let saveT = null, saving = false, dirty = false;
function save() { dirty = true; if (saveT || saving) return; saveT = setTimeout(flush, 400); }
function flush() {
  saveT = null; if (!dirty) return; dirty = false; saving = true;
  const tmp = DB_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), e => {
    if (e) { saving = false; console.error('Save failed:', e.message); return; }
    fs.rename(tmp, DB_FILE, e2 => { saving = false; if (e2) console.error('Save failed:', e2.message); if (dirty) save(); });
  });
}
function saveNow() { try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.error(e); } }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); process.exit(0); });

// ---- helpers ----
const AL = 'abcdefghijkmnpqrstuvwxyz23456789';
const rid = (n = 12) => { let s = ''; for (const x of crypto.randomBytes(n)) s += AL[x % AL.length]; return s; };
const str = (v, max) => String(v ?? '').slice(0, max);
const now = () => Date.now();
const COLORS = /^#[0-9a-f]{6}$/i;
const ROLES = ['Programmer', 'Artist', 'Audio', 'Designer', 'Writer', 'Producer', 'QA', 'Generalist'];
const TAGS = ['Code', 'Art', 'Audio', 'Design', 'Writing', 'QA', 'Other'];
const PRIS = ['low', 'med', 'high'];
const STS = ['todo', 'doing', 'review', 'done'];
const PINGS = ['handoff', 'review', 'blocked', 'question'];
const STATUSES = ['available', 'focus', 'blocked', 'away'];
const RESERVED = /^(ai|copilot|everyone|here|admin|system)$/i;
const fail = m => { const e = new Error(m); e.expose = true; throw e; };

function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; }
function checkPw(pw, p) {
  if (!p || !p.salt) return false;
  const h = crypto.scryptSync(String(pw), p.salt, 64), b = Buffer.from(p.hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}
function parseCookies(h) { const o = {}; for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o; }
const SESSION_DAYS = 30;
function uidFromCookie(h) {
  const tok = parseCookies(h).cr_sid; const s = tok && db.sessions[tok];
  if (!s) return null;
  if (now() - s.at > SESSION_DAYS * 864e5 || !db.users[s.uid]) { delete db.sessions[tok]; save(); return null; }
  return s.uid;
}
function newSession(res, req, uid) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[tok] = { uid, at: now() }; save();
  res.setHeader('Set-Cookie', `cr_sid=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}
const pubUser = u => ({ id: u.id, username: u.username, role: u.role, color: u.color });
function memberView(w, uid) {
  const m = w.members[uid] || {}, u = db.users[uid] || {};
  return { uid, handle: u.username || 'former-member', role: u.role || '', color: u.color || '#2f3cff', st: m.st || 'available', note: m.note || '', joined: m.joined || 0, seen: m.seen || 0 };
}
const wsByInvite = code => Object.values(db.workspaces).find(w => w.invite === code);
const metaOf = w => ({ id: w.id, name: w.name, jam: w.jam, theme: w.theme, start: w.start, deadline: w.deadline, by: w.by, at: w.at, invite: w.invite });

// ---- command line: npm run reset-password -- <username> <new password> ----
if (process.argv[2] === 'reset-password') {
  const [name, pw] = process.argv.slice(3);
  const u = Object.values(db.users).find(x => x.username.toLowerCase() === String(name || '').toLowerCase());
  if (!u || !pw || pw.length < 8) { console.log('Usage: npm run reset-password -- <username> <new password (8+ chars)>'); process.exit(1); }
  u.pass = hashPw(pw); for (const [t, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[t];
  saveNow(); console.log(`Password for ${u.username} was reset. Restart the server if it is running.`); process.exit(0);
}

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

function auth(req, res, next) { const uid = uidFromCookie(req.headers.cookie); if (!uid) return res.status(401).json({ error: 'Please log in' }); req.uid = uid; next(); }

// login rate limiting (per IP)
const tries = new Map();
function limited(ip) { const t = tries.get(ip) || { n: 0, at: now() }; if (now() - t.at > 10 * 60e3) { t.n = 0; t.at = now(); } t.n++; tries.set(ip, t); return t.n > 20; }

app.post('/api/register', express.json(), (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  const b = req.body || {};
  const username = str(b.username, 40).trim();
  if (!/^[A-Za-z0-9_.-]{2,20}$/.test(username) || RESERVED.test(username)) return res.status(400).json({ error: 'Username: 2–20 letters, numbers, dots, dashes or underscores.' });
  if (String(b.password || '').length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters.' });
  if (SIGNUP_CODE && b.signup !== SIGNUP_CODE) return res.status(403).json({ error: 'Wrong sign-up code. Ask whoever runs this server.' });
  if (Object.values(db.users).some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'That username is taken.' });
  const u = { id: 'u' + rid(12), username, pass: hashPw(String(b.password)), role: ROLES.includes(b.role) ? b.role : 'Generalist', color: COLORS.test(b.color) ? b.color : '#2f3cff', at: now(), wss: [], lr: {}, last: '' };
  db.users[u.id] = u; save();
  newSession(res, req, u.id);
  res.json({ ok: true });
});
app.post('/api/login', express.json(), (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  const b = req.body || {};
  const u = Object.values(db.users).find(x => x.username.toLowerCase() === str(b.username, 40).trim().toLowerCase());
  if (!u || !checkPw(String(b.password || ''), u.pass)) return res.status(401).json({ error: 'Wrong username or password.' });
  newSession(res, req, u.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const tok = parseCookies(req.headers.cookie).cr_sid; if (tok) { delete db.sessions[tok]; save(); }
  res.setHeader('Set-Cookie', 'cr_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const uid = uidFromCookie(req.headers.cookie);
  const cfg = { ai: !!AI_KEY, maxMb: MAX_MB, signupCode: !!SIGNUP_CODE };
  if (!uid) return res.status(401).json({ error: 'Please log in', cfg });
  const u = db.users[uid];
  const wss = (u.wss || []).map(id => db.workspaces[id]).filter(w => w && w.members[uid]).map(w => ({ id: w.id, name: w.name, jam: w.jam, theme: w.theme, deadline: w.deadline }));
  res.json({ user: pubUser(u), wss, last: u.last || '', cfg });
});

// ---- uploads ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, f, cb) => { const d = path.join(UP_DIR, req.w.id); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, f, cb) => { req.fileId = rid(14); cb(null, req.fileId); }
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 }
});
app.post('/api/upload', auth, (req, res) => {
  const w = db.workspaces[req.query.ws];
  if (!w || !w.members[req.uid]) return res.status(403).json({ error: 'Not a member of that workspace' });
  req.w = w;
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `That file is over ${MAX_MB} MB` : 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    let name = req.file.originalname || 'file';
    try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch (e) {}
    const f = { id: req.fileId, n: str(name, 120) || 'file', ty: str(req.file.mimetype, 100), s: req.file.size, by: req.uid, at: now(), ch: str(req.query.ch, 20) };
    w.files.unshift(f); if (w.files.length > 3000) w.files.length = 3000;
    save(); up(w, 'files', f);
    res.json(f);
  });
});
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[a-z0-9.+-]+|application\/pdf)$/i;
app.get('/f/:ws/:id', auth, (req, res) => {
  const w = db.workspaces[req.params.ws];
  if (!w || !w.members[req.uid]) return res.status(404).end();
  const f = w.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).end();
  const inline = INLINE.test(f.ty) && req.query.dl !== '1';
  res.setHeader('Content-Type', INLINE.test(f.ty) ? f.ty : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.n)}`);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(path.join(UP_DIR, w.id, f.id), e => { if (e && !res.headersSent) res.status(404).end(); });
});

// ---- AI (Anthropic Messages API, streamed) ----
const SYSTEM = `You are Copilot, an expert game-jam assistant built into the team's workspace "Crunchroom". You know Unity, Godot, Unreal, GameMaker, Phaser, PICO-8, Bevy, Love2D, Blender, Aseprite, FMOD, Bfxr and jam culture. Help the team ship a fun, finished, playable game before the deadline: favour aggressive scoping, MVP first, and fake-it-till-it-ships tricks. Be direct and practical. Use markdown and put code in fenced blocks. Only add tasks to the board when the user asks you to.`;
function ctxText(w, uid, withBoard) {
  const left = (w.deadline || 0) - now();
  const fmt = ms => { if (ms <= 0) return 'time is up'; const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3); return `${h}h ${m}m`; };
  const ms = Object.keys(w.members).map(id => memberView(w, id));
  let s = `<workspace>\nNow: ${new Date().toString()}\nJam: ${w.jam || 'unspecified'} · Team: ${w.name}\nTheme: ${w.theme || 'not announced yet'}\nDeadline: ${w.deadline ? new Date(w.deadline).toString() : '?'} (time left: ${fmt(left)})\nYou are talking with: ${db.users[uid].username} (${db.users[uid].role})\nTeam:\n${ms.map(m => `- ${m.handle} (${m.role}), ${m.st}${m.note ? ': ' + m.note : ''}`).join('\n')}`;
  if (withBoard) {
    const ts = Object.values(w.tasks);
    s += `\nTask board (${ts.length} tasks):\n${ts.slice(0, 150).map(t => `- [${t.st}] ${t.title} · ${t.tag}, ${t.pri}${t.who ? ', @' + memberView(w, t.who).handle : ', unassigned'}${t.dep && w.tasks[t.dep] ? `, waiting on "${w.tasks[t.dep].title}"` : ''}`).join('\n') || '(empty)'}`;
  }
  return s + '\n</workspace>';
}
function aiTools(w, uid, note) {
  const handleTo = h => { const x = String(h || '').replace(/^@/, '').toLowerCase(); return Object.keys(w.members).find(id => memberView(w, id).handle.toLowerCase() === x) || ''; };
  return [
    { def: { name: 'get_board', description: 'Get every task on the team board with status, discipline, priority, assignee and blocker.', input_schema: { type: 'object', properties: {} } },
      run: () => { note('Read the task board'); return { tasks: Object.values(w.tasks).slice(0, 200).map(t => ({ title: t.title, status: t.st, tag: t.tag, priority: t.pri, assignee: t.who ? memberView(w, t.who).handle : null, waiting_on: t.dep && w.tasks[t.dep] ? w.tasks[t.dep].title : null })) }; } },
    { def: { name: 'add_tasks', description: 'Add new tasks to the team board in the To do column. Only use this when the user asks you to create, add or break down tasks.', input_schema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, tag: { type: 'string', enum: TAGS }, priority: { type: 'string', enum: PRIS }, assignee: { type: 'string', description: 'Exact team member handle, optional' }, notes: { type: 'string' } }, required: ['title'] } } }, required: ['tasks'] } },
      run: inp => { let n = 0; for (const t of ((inp && inp.tasks) || []).slice(0, 25)) { const title = str(t.title, 120).trim(); if (!title) continue; createTask(w, uid, { title, desc: t.notes, tag: t.tag, pri: t.priority, who: handleTo(t.assignee) }); n++; } note(`Added ${n} task${n === 1 ? '' : 's'} to the board`); return { added: n }; } },
    { def: { name: 'get_chat', description: 'Read the most recent messages of one team chat channel.', input_schema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } },
      run: inp => { const ch = String(inp.channel || 'general').replace(/^#/, '').toLowerCase(); const list = (w.msgs[ch] || []).filter(m => !m.d).slice(-Math.min(60, inp.limit || 40)); note(`Read #${ch}`); return { messages: list.map(m => ({ from: m.k === 'ai' ? 'Copilot' : memberView(w, m.u).handle, text: str(m.x, 800), files: (m.a || []).map(a => a.n) })) }; } }
  ];
}
async function claude({ model, messages, tools = [], maxTokens = 4096, onText, signal }) {
  let out = '';
  for (let turn = 0; turn < 6; turn++) {
    const body = { model, max_tokens: maxTokens, system: SYSTEM, messages, stream: true };
    if (tools.length) body.tools = tools.map(t => t.def);
    const r = await fetch(AI_URL, {
      method: 'POST', signal,
      headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      let msg = `AI request failed (${r.status})`;
      try { const j = await r.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) {}
      if (r.status === 401) msg = 'The AI API key was rejected. Check ANTHROPIC_API_KEY.';
      if (r.status === 429) msg = 'The AI is rate-limited right now. Try again in a minute.';
      fail(msg);
    }
    const blocks = []; let stop = null, buf = '', first = true;
    const reader = r.body.getReader(), dec = new TextDecoder();
    const handle = ev => {
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        blocks[ev.index] = cb.type === 'tool_use' ? { type: 'tool_use', id: cb.id, name: cb.name, json: '' } : { type: cb.type, text: '' };
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]; if (!b) return;
        if (ev.delta.type === 'text_delta') { if (first && out) out += '\n\n'; first = false; b.text += ev.delta.text; out += ev.delta.text; if (onText) onText(out); }
        else if (ev.delta.type === 'input_json_delta') b.json += ev.delta.partial_json;
      } else if (ev.type === 'message_delta') { stop = ev.delta && ev.delta.stop_reason; }
      else if (ev.type === 'error') fail((ev.error && ev.error.message) || 'The AI returned an error.');
    };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        let data = ''; for (const line of chunk.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trim();
        if (!data) continue; let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
        handle(ev);
      }
    }
    const content = blocks.filter(Boolean).map(b => b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: (() => { try { return JSON.parse(b.json || '{}'); } catch (e) { return {}; } })() } : b.type === 'text' && b.text ? { type: 'text', text: b.text } : null).filter(Boolean);
    if (stop !== 'tool_use') return { text: out, truncated: stop === 'max_tokens' };
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const c of content.filter(c => c.type === 'tool_use')) {
      const t = tools.find(x => x.def.name === c.name);
      let result; try { result = t ? await t.run(c.input || {}) : { error: 'Unknown tool' }; } catch (e) { result = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result).slice(0, 60000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: out || 'I ran out of steps. Try asking more specifically.', truncated: false };
}
app.post('/api/ai', auth, express.json({ limit: '30mb' }), async (req, res) => {
  if (!AI_KEY) return res.status(400).json({ error: 'AI is not set up on this server. Add ANTHROPIC_API_KEY to .env and restart.' });
  const b = req.body || {}, uid = req.uid, w = db.workspaces[b.ws];
  if (!w || !w.members[uid]) return res.status(403).json({ error: 'Not a member of that workspace' });
  const text = str(b.text, 20000).trim(); if (!text) return res.status(400).json({ error: 'Empty message' });
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(d => String(d).match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/)).filter(Boolean)
    .map(m => ({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }));
  const hist = ((db.ai[uid] = db.ai[uid] || {})[w.id] = db.ai[uid][w.id] || []);
  const turns = [];
  for (const m of hist.slice(-20)) { if (!m.c) continue; const role = m.r === 'user' ? 'user' : 'assistant'; if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += '\n\n' + m.c; else turns.push({ role, content: m.c }); }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  let ctx = ctxText(w, uid, b.ctx !== false);
  if (b.chat && w.msgs[b.chat]) ctx += `\n<recent_chat channel="#${str(b.chat, 20)}">\n${w.msgs[b.chat].filter(m => !m.d).slice(-25).map(m => `${m.k === 'ai' ? 'Copilot' : memberView(w, m.u).handle}: ${m.x}`).join('\n')}\n</recent_chat>`;
  const userContent = [{ type: 'text', text: `${ctx}\n\n${text}` }, ...images];
  if (turns.length && turns[turns.length - 1].role === 'user') turns.push({ role: 'assistant', content: '(no reply)' });
  turns.push({ role: 'user', content: userContent });
  hist.push({ r: 'user', c: text, t: now(), ...(images.length ? { img: images.length } : {}) });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Accel-Buffering', 'no');
  const send = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  const notes = [];
  const all = aiTools(w, uid, n => { notes.push(n); send({ t: 'tool', note: n }); });
  const tools = b.ctx === false ? all.filter(t => t.def.name === 'add_tasks') : all;
  let last = 0;
  try {
    const r = await claude({ model: b.deep ? AI_MODEL_DEEP : AI_MODEL, maxTokens: b.deep ? 8192 : 4096, messages: turns, tools, signal: ctrl.signal,
      onText: t => { if (now() - last > 60 || t.length < 40) { last = now(); send({ t: 'text', text: t }); } else { clearTimeout(res._tt); res._tt = setTimeout(() => send({ t: 'text', text: t }), 70); } } });
    clearTimeout(res._tt);
    hist.push({ r: 'assistant', c: r.text, t: now(), ...(notes.length ? { tools: notes } : {}), ...(r.truncated ? { err: 'The answer was cut off. Ask it to continue.' } : {}) });
    send({ t: 'text', text: r.text }); send({ t: 'done', truncated: r.truncated });
  } catch (e) {
    clearTimeout(res._tt);
    const msg = e.name === 'AbortError' ? 'Stopped.' : (e.expose ? e.message : 'The AI request failed: ' + e.message);
    hist.push({ r: 'assistant', c: '', t: now(), err: msg });
    send({ t: 'error', message: msg });
  }
  if (hist.length > 40) hist.splice(0, hist.length - 40);
  save(); res.end();
});
async function chatAI(w, ch, uid) {
  if (!AI_KEY) { postMsg(w, ch, uid, '_The AI copilot is not set up on this server (no ANTHROPIC_API_KEY)._', null, 'ai'); return; }
  io.to('ws:' + w.id).emit('typing', { ws: w.id, ch, uid: 'ai', on: true });
  const recent = (w.msgs[ch] || []).slice(-30).map(m => `${m.k === 'ai' ? 'Copilot' : memberView(w, m.u).handle}: ${m.d ? '(deleted)' : m.x}${m.a && m.a.length ? ` [files: ${m.a.map(a => a.n).join(', ')}]` : ''}`).join('\n');
  const prompt = `${ctxText(w, uid, true)}\n\nYou were @-mentioned in the team chat channel #${ch}. Reply to the most recent message that mentions you, as a sharp, friendly teammate. Keep it under 160 words unless code is needed.\n\n<chat>\n${recent}\n</chat>`;
  try { const r = await claude({ model: AI_MODEL, messages: [{ role: 'user', content: prompt }], tools: aiTools(w, uid, () => {}).filter(t => t.def.name !== 'get_chat') }); if (r.text) postMsg(w, ch, uid, r.text, null, 'ai'); }
  catch (e) { postMsg(w, ch, uid, `_Copilot couldn't answer: ${e.expose ? e.message : 'request failed'}_`, null, 'ai'); }
  io.to('ws:' + w.id).emit('typing', { ws: w.id, ch, uid: 'ai', on: false });
}

// ---- workspace data operations ----
const up = (w, type, item) => io.to('ws:' + w.id).emit('up', { ws: w.id, type, item });
const rm = (w, type, id) => io.to('ws:' + w.id).emit('rm', { ws: w.id, type, id });
function addNotif(w, from, to, kind, text, extra = {}) {
  if (!to || to === from || !w.members[to]) return null;
  const n = { id: rid(10), to, from, kind, text: str(text, 500), at: now(), st: 'new', ...extra };
  w.notifs.unshift(n); if (w.notifs.length > 600) w.notifs.length = 600;
  save(); up(w, 'notifs', n); return n;
}
function createTask(w, uid, p) {
  if (Object.keys(w.tasks).length >= 3000) fail('The board is full (3000 tasks).');
  const t = { id: rid(8), title: str(p.title, 120).trim(), desc: str(p.desc, 2000), tag: TAGS.includes(p.tag) ? p.tag : 'Other', pri: PRIS.includes(p.pri) ? p.pri : 'med', who: p.who && w.members[p.who] ? p.who : '', dep: p.dep && w.tasks[p.dep] ? p.dep : '', st: STS.includes(p.st) ? p.st : 'todo', by: uid, at: now(), up: now() };
  if (!t.title) fail('Give the task a title.');
  if (t.st === 'done') t.done = now();
  w.tasks[t.id] = t; save(); up(w, 'tasks', t);
  if (t.who && t.who !== uid) addNotif(w, uid, t.who, 'assigned', t.title, { task: t.id });
  return t;
}
function moveTask(w, uid, id, st, skip = []) {
  const t = w.tasks[id]; if (!t || !STS.includes(st) || t.st === st) return 0;
  t.st = st; t.up = now(); if (st === 'done') t.done = now(); if (st === 'doing' && !t.who) t.who = uid;
  save(); up(w, 'tasks', t);
  let n = 0;
  if (st === 'done') for (const o of Object.values(w.tasks)) if (o.dep === id && o.st !== 'done' && o.who && !skip.includes(o.who)) { if (addNotif(w, uid, o.who, 'unblocked', `“${t.title}” is done, so “${o.title}” is unblocked`, { task: o.id })) n++; }
  return n;
}
function chanList(w, ch) { if (!w.channels[ch]) fail('That channel does not exist.'); return (w.msgs[ch] = w.msgs[ch] || []); }
function postMsg(w, ch, uid, x, a, k) {
  const list = chanList(w, ch);
  const m = { id: rid(10), u: uid, x: str(x, 8000), t: now() }; if (a && a.length) m.a = a; if (k) m.k = k;
  list.push(m); if (list.length > 5000) list.splice(0, list.length - 5000);
  Object.assign(w.channels[ch], { lastAt: m.t, lastBy: uid });
  save();
  io.to('ws:' + w.id).emit('msg', { ws: w.id, ch, m });
  up(w, 'channels', { id: ch, ...w.channels[ch] });
  return m;
}
function findMsg(w, ch, id) { const m = chanList(w, ch).find(x => x.id === id); if (!m) fail('Message not found.'); return m; }
function wsState(w, uid) {
  return {
    meta: metaOf(w), members: Object.keys(w.members).map(id => memberView(w, id)), channels: w.channels, tasks: Object.values(w.tasks),
    notifs: w.notifs.slice(0, 300), files: w.files.slice(0, 400), online: Object.keys(w.members).filter(id => online.get(id) > 0),
    lr: ((db.users[uid].lr || {})[w.id]) || {}
  };
}
function newWorkspace(uid, p) {
  const name = str(p.name, 40).trim() || 'Jam team', start = +p.start || now(), deadline = +p.deadline;
  if (!deadline || deadline <= start) fail('The deadline needs to be after the start.');
  const w = { id: rid(10), invite: rid(10), name, jam: str(p.jam, 60).trim(), theme: str(p.theme, 80).trim(), start, deadline, by: uid, at: now(),
    members: { [uid]: { st: 'available', note: '', joined: now(), seen: now() } }, channels: {}, tasks: {}, notifs: [], files: [], msgs: {} };
  ['general', 'code', 'art', 'audio', 'ideas'].forEach((c, i) => { w.channels[c] = { name: c, ord: i, lastAt: 0, lastBy: '' }; });
  db.workspaces[w.id] = w; const u = db.users[uid]; u.wss = (u.wss || []).filter(x => x !== w.id).concat(w.id); save();
  return w;
}

// ---- realtime ----
const online = new Map();
function conn(uid, d) {
  const c = Math.max(0, (online.get(uid) || 0) + d); if (c) online.set(uid, c); else online.delete(uid);
  const u = db.users[uid]; if (!u) return;
  if ((d > 0 && c === 1) || (d < 0 && c === 0)) for (const id of u.wss || []) { const w = db.workspaces[id]; if (w && w.members[uid]) { w.members[uid].seen = now(); io.to('ws:' + id).emit('online', { ws: id, uid, on: c > 0 }); } }
  save();
}
io.use((socket, next) => { const uid = uidFromCookie(socket.handshake.headers.cookie); if (!uid) return next(new Error('unauthorized')); socket.data.uid = uid; next(); });
io.on('connection', socket => {
  const uid = socket.data.uid; socket.join('u:' + uid); conn(uid, +1);
  socket.on('disconnect', () => conn(uid, -1));
  const on = (ev, fn) => socket.on(ev, async (p, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    if (!db.users[uid]) return ack({ error: 'Your account no longer exists.' });
    try { ack((await fn(p && typeof p === 'object' ? p : {})) || { ok: true }); }
    catch (e) { if (!e.expose) console.error(ev, e); ack({ error: e.expose ? e.message : 'Something went wrong on the server.' }); }
  });
  const W = id => { const w = db.workspaces[id]; if (!w || !w.members[uid]) fail('You are not a member of that workspace.'); return w; };
  const isLead = w => w.by === uid;

  on('ws:create', p => { const w = newWorkspace(uid, p); return { id: w.id }; });
  on('ws:preview', p => { const w = wsByInvite(str(p.code, 20).toLowerCase()); if (!w) fail('No workspace matches that invite. Check it with your teammate.'); return { id: w.id, name: w.name, jam: w.jam, theme: w.theme, deadline: w.deadline, member: !!w.members[uid] }; });
  on('ws:join', p => {
    const w = wsByInvite(str(p.code, 20).toLowerCase()); if (!w) fail('No workspace matches that invite.');
    if (!w.members[uid]) {
      if (Object.keys(w.members).length >= 50) fail('This workspace is full.');
      w.members[uid] = { st: 'available', note: '', joined: now(), seen: now() };
      const u = db.users[uid]; u.wss = (u.wss || []).filter(x => x !== w.id).concat(w.id); save();
      up(w, 'members', memberView(w, uid)); io.to('ws:' + w.id).emit('online', { ws: w.id, uid, on: true });
      postMsg(w, 'general', uid, 'joined the team', null, 'sys');
    }
    return { id: w.id };
  });
  on('ws:open', p => {
    const w = W(p.ws);
    for (const r of socket.rooms) if (r.startsWith('ws:') && r !== 'ws:' + w.id) socket.leave(r);
    socket.join('ws:' + w.id); w.members[uid].seen = now(); db.users[uid].last = w.id; save();
    return wsState(w, uid);
  });
  on('ws:update', p => {
    const w = W(p.ws); const start = +p.start || w.start, deadline = +p.deadline || w.deadline;
    if (deadline <= start) fail('The deadline needs to be after the start.');
    Object.assign(w, { name: str(p.name, 40).trim() || w.name, jam: str(p.jam, 60).trim(), theme: str(p.theme, 80).trim(), start, deadline });
    save(); up(w, 'meta', metaOf(w));
  });
  on('ws:invite', p => { const w = W(p.ws); if (!isLead(w)) fail('Only the workspace creator can reset the invite.'); w.invite = rid(10); save(); up(w, 'meta', metaOf(w)); return { invite: w.invite }; });
  on('ws:leave', p => {
    const w = W(p.ws); delete w.members[uid]; const u = db.users[uid]; u.wss = (u.wss || []).filter(x => x !== w.id); if (u.last === w.id) u.last = '';
    save(); socket.leave('ws:' + w.id); rm(w, 'members', uid);
  });
  on('ws:kick', p => {
    const w = W(p.ws); if (!isLead(w)) fail('Only the workspace creator can remove people.');
    const t = str(p.uid, 40); if (!w.members[t] || t === uid) fail('Cannot remove that person.');
    delete w.members[t]; const u = db.users[t]; if (u) { u.wss = (u.wss || []).filter(x => x !== w.id); if (u.last === w.id) u.last = ''; }
    save(); io.in('u:' + t).socketsLeave('ws:' + w.id); io.to('u:' + t).emit('kicked', { ws: w.id }); rm(w, 'members', t);
  });
  on('member:status', p => {
    const w = W(p.ws); const m = w.members[uid];
    if (STATUSES.includes(p.st)) m.st = p.st; if (p.note !== undefined) m.note = str(p.note, 80);
    m.seen = now(); save(); up(w, 'members', memberView(w, uid));
  });
  on('profile:update', p => {
    const u = db.users[uid];
    if (p.newPassword) { if (!checkPw(String(p.oldPassword || ''), u.pass)) fail('Your current password is wrong.'); if (String(p.newPassword).length < 8) fail('New password needs at least 8 characters.'); u.pass = hashPw(String(p.newPassword)); }
    if (ROLES.includes(p.role)) u.role = p.role; if (COLORS.test(p.color || '')) u.color = p.color;
    save(); for (const id of u.wss || []) { const w = db.workspaces[id]; if (w && w.members[uid]) up(w, 'members', memberView(w, uid)); }
    return { user: pubUser(u) };
  });
  on('read', p => { const w = W(p.ws); const u = db.users[uid]; u.lr = u.lr || {}; (u.lr[w.id] = u.lr[w.id] || {})[str(p.ch, 20)] = now(); save(); });

  // chat
  on('chan:create', p => {
    const w = W(p.ws); const id = str(p.name, 20).toLowerCase().replace(/[^a-z0-9-]/g, ''); if (!id) fail('Use lowercase letters, numbers and dashes.');
    if (!w.channels[id]) { if (Object.keys(w.channels).length >= 40) fail('Too many channels.'); w.channels[id] = { name: id, ord: 50, lastAt: 0, lastBy: '' }; save(); up(w, 'channels', { id, ...w.channels[id] }); }
    return { id };
  });
  on('chan:history', p => {
    const w = W(p.ws); const list = chanList(w, str(p.ch, 20)); const before = +p.before || Infinity;
    let end = list.length; while (end > 0 && list[end - 1].t >= before) end--;
    const startI = Math.max(0, end - 80); return { msgs: list.slice(startI, end), more: startI > 0 };
  });
  on('msg:send', p => {
    const w = W(p.ws); const ch = str(p.ch, 20); chanList(w, ch);
    const x = str(p.x, 6000).trim();
    const a = (Array.isArray(p.a) ? p.a : []).slice(0, 10).map(id => w.files.find(f => f.id === id)).filter(Boolean).map(f => ({ id: f.id, n: f.n, ty: f.ty, s: f.s }));
    if (!x && !a.length) fail('Empty message.');
    const m = postMsg(w, ch, uid, x, a);
    if (x) {
      const ats = new Set([...x.matchAll(/(^|\s)@([A-Za-z0-9_.-]{2,20})/g)].map(r => r[2].toLowerCase()));
      for (const id of Object.keys(w.members)) if (id !== uid && (ats.has(memberView(w, id).handle.toLowerCase()) || ats.has('everyone'))) addNotif(w, uid, id, 'mention', `#${ch}: ${x.slice(0, 160)}`, { ch });
      if (ats.has('ai') || ats.has('copilot')) chatAI(w, ch, uid);
    }
    return { id: m.id };
  });
  const emitMsg = (w, ch, m) => io.to('ws:' + w.id).emit('msg', { ws: w.id, ch, m });
  on('msg:edit', p => { const w = W(p.ws), ch = str(p.ch, 20), m = findMsg(w, ch, p.id); if (m.u !== uid || m.k) fail('You can only edit your own messages.'); const x = str(p.x, 6000).trim(); if (!x) fail('Empty message.'); m.x = x; m.e = now(); save(); emitMsg(w, ch, m); });
  on('msg:del', p => { const w = W(p.ws), ch = str(p.ch, 20), m = findMsg(w, ch, p.id); if (m.u !== uid && !isLead(w)) fail('You can only delete your own messages.'); m.d = true; m.x = ''; delete m.a; delete m.r; save(); emitMsg(w, ch, m); });
  on('msg:react', p => { const w = W(p.ws), ch = str(p.ch, 20), m = findMsg(w, ch, p.id); const k = str(p.k, 10); if (!['up', 'fire', 'lol', 'eyes', 'ok', 'love'].includes(k)) fail('Unknown reaction.'); m.r = m.r || {}; const set = new Set(m.r[k] || []); set.has(uid) ? set.delete(uid) : set.add(uid); if (set.size) m.r[k] = [...set]; else delete m.r[k]; save(); emitMsg(w, ch, m); });
  on('msg:pin', p => { const w = W(p.ws), ch = str(p.ch, 20), m = findMsg(w, ch, p.id); m.p = !m.p; save(); emitMsg(w, ch, m); });
  on('typing', p => { const w = W(p.ws); socket.to('ws:' + w.id).emit('typing', { ws: w.id, ch: str(p.ch, 20), uid, on: !!p.on }); });

  // tasks
  on('task:save', p => {
    const w = W(p.ws);
    if (!p.id) return { id: createTask(w, uid, p).id };
    const t = w.tasks[p.id]; if (!t) fail('Task not found.');
    const title = str(p.title, 120).trim(); if (!title) fail('Give the task a title.');
    const prevWho = t.who;
    Object.assign(t, { title, desc: str(p.desc, 2000), tag: TAGS.includes(p.tag) ? p.tag : t.tag, pri: PRIS.includes(p.pri) ? p.pri : t.pri, who: p.who && w.members[p.who] ? p.who : '', dep: p.dep && w.tasks[p.dep] && p.dep !== t.id ? p.dep : '', up: now() });
    save(); up(w, 'tasks', t);
    if (t.who && t.who !== prevWho && t.who !== uid) addNotif(w, uid, t.who, 'assigned', t.title, { task: t.id });
    return { id: t.id, unblocked: p.st ? moveTask(w, uid, t.id, p.st) : 0 };
  });
  on('task:move', p => { const w = W(p.ws); if (!w.tasks[p.id]) fail('Task not found.'); return { unblocked: moveTask(w, uid, p.id, p.st) }; });
  on('task:del', p => { const w = W(p.ws); if (!w.tasks[p.id]) fail('Task not found.'); delete w.tasks[p.id]; for (const o of Object.values(w.tasks)) if (o.dep === p.id) { o.dep = ''; up(w, 'tasks', o); } save(); rm(w, 'tasks', p.id); });

  // handoffs / pings
  on('notif:send', p => {
    const w = W(p.ws); const kind = PINGS.includes(p.kind) ? p.kind : 'handoff';
    const task = p.task && w.tasks[p.task] ? p.task : '';
    const targets = p.to === '*' ? Object.keys(w.members).filter(x => x !== uid) : [str(p.to, 40)].filter(x => w.members[x] && x !== uid);
    if (!targets.length) fail('Pick a teammate.');
    const text = str(p.text, 500).trim() || (task ? w.tasks[task].title : ''); if (!text) fail('Add a short message or pick a task.');
    for (const t of targets) addNotif(w, uid, t, kind, text, task ? { task } : {});
    if (task && p.assign && p.to !== '*') { const t = w.tasks[task]; t.who = p.to; t.up = now(); save(); up(w, 'tasks', t); }
    const unblocked = task && p.done ? moveTask(w, uid, task, 'done', targets) : 0;
    return { sent: targets.length, unblocked };
  });
  on('notif:set', p => { const w = W(p.ws); const n = w.notifs.find(x => x.id === p.id); if (!n || n.to !== uid) fail('That ping is not yours.'); if (!['new', 'ack', 'done'].includes(p.st)) fail('Bad status.'); n.st = p.st; n.sa = now(); save(); up(w, 'notifs', n); });
  on('notif:nudge', p => { const w = W(p.ws); const n = w.notifs.find(x => x.id === p.id); if (!n || n.from !== uid) fail('You can only nudge your own pings.'); addNotif(w, uid, n.to, n.kind, 'Reminder: ' + n.text.replace(/^Reminder: /, ''), n.task ? { task: n.task } : {}); });

  // files
  on('file:del', p => {
    const w = W(p.ws); const i = w.files.findIndex(f => f.id === p.id); if (i < 0) fail('File not found.');
    const f = w.files[i]; if (f.by !== uid && !isLead(w)) fail('You can only delete your own files.');
    w.files.splice(i, 1); fs.unlink(path.join(UP_DIR, w.id, f.id), () => {}); save(); rm(w, 'files', f.id);
  });

  // private per-user data
  on('notes:get', p => { const w = W(p.ws); return { x: ((db.notes[uid] || {})[w.id] || {}).x || '' }; });
  on('notes:set', p => { const w = W(p.ws); (db.notes[uid] = db.notes[uid] || {})[w.id] = { x: str(p.x, 300000), at: now() }; save(); });
  on('ai:get', p => { const w = W(p.ws); return { msgs: ((db.ai[uid] || {})[w.id]) || [], enabled: !!AI_KEY }; });
  on('ai:clear', p => { const w = W(p.ws); if (db.ai[uid]) delete db.ai[uid][w.id]; save(); });
});

// ---- pages ----
app.get('/join/:code', (req, res) => res.redirect('/?join=' + encodeURIComponent(str(req.params.code, 20))));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

server.listen(PORT, () => {
  console.log(`\n  Crunchroom is running:  http://localhost:${PORT}`);
  for (const list of Object.values(require('os').networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  On your network:        http://${a.address}:${PORT}`);
  console.log(`  AI copilot: ${AI_KEY ? 'on (' + AI_MODEL + ')' : 'off (set ANTHROPIC_API_KEY in .env to turn it on)'}`);
  console.log(`  Data folder: ${DATA_DIR}\n`);
});
