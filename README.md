# Crunchroom: your game jam team's war room

A self-hosted website for jam teams. One person runs it and everyone else opens it in a browser.

- **Accounts:** username and password login. Each person's notes and AI chats are private to their account.
- **Workspaces and invite links:** a workspace is one team. Only people who joined through its invite can see its chat, board and files.
- **Chat:** channels; drag, paste or attach images, GIFs, video, audio and any other file; reactions, pins and edits; typing indicators; `@name` pings someone.
- **Handoffs:** tell a teammate "Ready for you", "Needs review", "Blocked on you" or "Quick question". They get a pop-up and a sound, and can reply "On it" or "Done".
- **Task board:** To do, Doing, Review and Done. When a task moves to Done, anyone whose task was waiting on it gets pinged automatically.
- **AI copilot (optional):** brainstorming, scope checks, code help and screenshot feedback. It can read your board and add tasks to it. Type `@ai` in chat to bring it into the conversation.
- **Extras:** a deadline countdown with jam phases, who's online and what they're on, a focus timer, a files library and private notes.

## Run it

1. Install **Node.js 18 or newer** (the LTS version from https://nodejs.org).
2. Unzip this folder.
3. Start it:
   - **Windows:** double-click `start.bat`.
   - **Mac or Linux:** in a terminal in this folder, run `./start.sh`.
   - **Any system:** in a terminal in this folder, run `npm install` once, then `npm start`.
4. Open **http://localhost:3000**, create an account, create a workspace, and click **Invite**.

Keep the terminal window open. The site is only up while the server is running.

## Getting teammates in

The invite link uses whatever address *you* opened the site with, so open it through the address your teammates will use before you copy the invite.

- **Same Wi-Fi or LAN:** the terminal prints an address like `http://192.168.1.20:3000` under "On your network". Open that address, then copy the invite. If teammates can't connect, allow Node.js through your firewall.
- **Teammates elsewhere:** you need a public address. Either:
  - **Run a tunnel from your computer**, for example `npx localtunnel --port 3000` or Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`). Your computer has to stay on for the whole jam.
  - **Deploy it** to any host that runs Node.js apps (a VPS, Render, Railway, Fly.io…). Use the start command `npm start`. Give it **persistent storage** and point `DATA_DIR` at it, otherwise your data can be wiped when the host restarts or redeploys.

Use an `https://` address when it's public. Tunnels and most hosts give you one automatically.

## Turning on the AI copilot

1. Get an API key at https://console.anthropic.com. Usage is billed to that key.
2. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY=...`.
3. Restart the server. The terminal will say `AI copilot: on`.

Without a key, everything else still works and the AI page explains how to switch it on.

## Settings (`.env`)

| Setting | What it does |
|---|---|
| `PORT` | Port to run on (default 3000) |
| `ANTHROPIC_API_KEY` | Turns on the AI copilot |
| `AI_MODEL`, `AI_MODEL_DEEP` | Claude models for normal answers and "Deep think" |
| `SIGNUP_CODE` | If set, people need this code to create an account. Recommended when the site is public |
| `MAX_UPLOAD_MB` | Max size per file (default 25) |
| `DATA_DIR` | Where data is stored (default `./data`) |

## Your data

- Everything is stored in the `data` folder: `db.json` holds accounts, chat, tasks and so on, and `uploads/` holds files. To back up, copy that folder while the server is stopped.
- Passwords are stored hashed (scrypt), never in plain text.
- Files can only be downloaded by logged-in members of the workspace they were uploaded to.
- Notes and AI conversations are hidden from other users. As with any self-hosted app, whoever runs the server can read the `data` folder.
- It's built for jam teams (tens of people), not thousands: all data lives in one file.

## Troubleshooting

- **"Can't reach the Crunchroom server":** the server isn't running. Start it again.
- **Forgot a password:** stop the server, run `npm run reset-password -- <username> <new password>`, then start it again.
- **Invite link says localhost:** you copied it while browsing on `localhost`. Open the site using your network or public address and copy it again.
- **Workspace creator powers:** remove members, reset the invite code (old links stop working), and delete any message or file.
