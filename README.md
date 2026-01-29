# Disclaude (Improved)

A Discord bot for managing persistent Claude Code sessions. Each session gets its own channel - just type to talk to Claude.

> **Fork Notice:** This is an improved fork of [disclaude/app](https://github.com/disclaude/app) by Mike Burgh. See [Changes from Upstream](#changes-from-upstream) and [Credits](#credits).

## How It Works

1. Create a session with `/claude new myproject /path/to/project`
2. A new channel `#claude-myproject` is created in the "Claude Sessions" category
3. Just type in that channel - your messages go directly to Claude
4. Claude's output streams back to the channel automatically
5. Scroll up to see the full conversation history
6. Drop into the terminal anytime with `tmux attach -t claude-myproject`

## Features

- **Channel per session** - Each Claude session gets its own Discord channel
- **Just type** - No commands needed, messages go straight to Claude
- **Image support** - Send images and Claude can analyze them
- **Live output** - Claude's responses stream to the channel in real-time
- **Clean formatting** - Tool calls shown as compact summaries with emojis (⚡ Bash, 📖 Read, ✏️ Edit, etc.)
- **Interactive prompts** - When Claude shows numbered options, clickable buttons appear
- **Typing indicator** - Shows Discord typing indicator while Claude processes
- **Persistent** - Sessions run in tmux, survive disconnects and bot restarts
- **Auto-reconnect** - Bot automatically reconnects to existing sessions on restart
- **Terminal access** - Attach directly via tmux whenever you want

## Prerequisites

- Node.js 18+
- tmux (`sudo dnf install tmux` on Fedora, `brew install tmux` on macOS)
- Claude Code CLI installed and authenticated
- A Discord server where you have permission to create channels

## Setup

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Go to **Bot** → Click "Reset Token" → Copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Manage Channels`, `Embed Links`, `Add Reactions`, `Read Message History`
6. Open the generated URL to invite the bot to your server

### 2. Configure

Create a `.env` file:
```bash
# Required
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_guild_id_here

# Security (highly recommended)
ALLOWED_USERS=123456789012345678
ALLOWED_PATHS=~/projects,~/work

# Optional
DEFAULT_DIRECTORY=~/projects
CATEGORY_NAME=Claude Sessions
MESSAGE_RETENTION_DAYS=7
RATE_LIMIT_MS=1000
```

### 3. Run

```bash
npm install
npm start
```

For development (with hot reload):
```bash
npm run dev
```

### Running as a systemd Service

If you run disclaude as a systemd user service, you **must** set `KillMode=process` so tmux sessions survive restarts:

```bash
# Add KillMode=process to your service file
sed -i '/^\[Service\]/a KillMode=process' ~/.config/systemd/user/disclaude.service

# Reload and restart
systemctl --user daemon-reload
systemctl --user restart disclaude
```

Without this, systemd kills the tmux server when disclaude restarts, destroying all sessions.

Example service file (`~/.config/systemd/user/disclaude.service`):
```ini
[Unit]
Description=Disclaude - Claude Code Discord Bot

[Service]
WorkingDirectory=/path/to/disclaude
ExecStart=/usr/bin/npm start
Restart=always
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

## Commands

| Command | Description |
|---------|-------------|
| `/claude new <name> [directory]` | Create a new session + channel |
| `/claude list` | List all active sessions with stats |
| `/claude sync` | Reconnect orphaned tmux sessions to Discord channels |
| `/claude end` | End the session (run in session channel) |
| `/claude output [lines]` | Dump recent raw output (run in session channel) |
| `/claude attach` | Get the tmux attach command |
| `/claude stop` | Send ESC to stop Claude mid-response |

## Usage

**In Discord:**
```
/claude new api-server ~/Dev/my-api
```
→ Creates `#claude-api-server` channel

**In the channel:**
```
Help me add rate limiting to the /users endpoint
```
→ Message goes to Claude, response streams back

**In Terminal:**
```bash
tmux attach -t claude-api-server
```
→ Full terminal access to the same session

## Architecture

```
Discord Channel                tmux Session
     │                              │
     │  "Add rate limiting"         │
     └────────────────────────────► │ claude (CLI)
                                    │
     ┌────────────────────────────◄ │
     │  [Claude's response...]      │
     ▼                              │
  Channel                           │
```

Sessions are standard tmux sessions prefixed with `claude-`. The bot:
1. Creates tmux sessions running `claude --dangerously-skip-permissions`
2. Sends your Discord messages to the session via `tmux send-keys`
3. Polls for new output, parses it, and streams formatted responses to Discord
4. Persists session mappings to `~/.disclaude/sessions.json` for restart recovery

## Security

> **⚠️ Warning:** This bot can execute arbitrary code on your machine. Anyone who can send messages to a session channel can instruct Claude to run commands, edit files, etc.

### User Whitelist

**Always** set `ALLOWED_USERS` in your `.env`:

```bash
# Single user
ALLOWED_USERS=123456789012345678

# Multiple users
ALLOWED_USERS=123456789012345678,987654321098765432
```

To get your Discord user ID: Discord Settings → Advanced → Enable Developer Mode, then right-click your username → Copy User ID.

### Path Restrictions

Restrict which directories sessions can be created in:

```bash
ALLOWED_PATHS=~/projects,~/work,/opt/apps
```

Without this, sessions can be created in any directory the bot has access to.

### Additional Recommendations

- **Enable 2FA** on your Discord account
- **Never commit `.env`** - it's in `.gitignore` by default
- **Regenerate your bot token** immediately if exposed
- **Run in a VM/container** for additional isolation
- **Keep the guild private** - don't invite untrusted users

### Bot Logs

The bot creates a `#bot-logs` channel in the Claude Sessions category that logs:
- Session creation/deletion
- File edits detected
- Errors and warnings

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | Application ID from Discord Developer Portal |
| `DISCORD_GUILD_ID` | Yes | Server ID (right-click server → Copy ID) |
| `ALLOWED_USERS` | No* | Comma-separated Discord user IDs (* highly recommended) |
| `ALLOWED_PATHS` | No* | Comma-separated directories for sessions (* recommended) |
| `DEFAULT_DIRECTORY` | No | Default working directory for new sessions |
| `CATEGORY_NAME` | No | Category name for session channels (default: "Claude Sessions") |
| `MESSAGE_RETENTION_DAYS` | No | Auto-delete messages older than N days |
| `RATE_LIMIT_MS` | No | Minimum ms between messages per user (default: 1000) |

## Data Storage

- `~/.disclaude/sessions.json` - Persisted session-to-channel mappings
- `<session-dir>/.claude/CLAUDE.md` - Discord formatting guide for each session
- `<session-dir>/.disclaude-images/` - Downloaded image attachments from Discord

## Troubleshooting

### "tmux: command not found"
Install tmux: `sudo dnf install tmux` (Fedora) or `brew install tmux` (macOS)

### Sessions lost after bot restart
Add `KillMode=process` to your systemd service file. See [Running as a systemd Service](#running-as-a-systemd-service).

### Bot not responding to messages
1. Check that the user is in `ALLOWED_USERS`
2. Verify the channel is linked to a session (`/claude list`)
3. Check `#bot-logs` for errors
4. Verify the tmux session exists: `tmux list-sessions`

### "Directory not in allowed paths" error
Add the directory to `ALLOWED_PATHS` in your `.env` file.

### Claude not responding in tmux
Attach to the session (`tmux attach -t claude-<name>`) and check for errors. The Claude CLI may need re-authentication.

## Changes from Upstream

This fork includes the following improvements over [disclaude/app](https://github.com/disclaude/app):

### Claude Code Compatibility
- **v2.1.22+ support** - Uses `--dangerously-skip-permissions` flag to bypass the trust dialog
- **Updated marker detection** - Recognizes `❯` for user input and `●` for Claude responses (changed in newer Claude Code versions)

### Output Formatting
- **Discord-native formatting** - Parses Claude's terminal output into clean, readable messages
- **Tool call summaries** - Tool calls shown as compact lines with emojis:
  - ⚡ Bash commands
  - 📖 Read / ✏️ Edit / 📝 Write files
  - 🔍 Glob/Grep searches
  - 🤖 Task (subagent)
  - 🌐 WebFetch / 🔎 WebSearch
  - 📔 MCP tool calls
- **Terminal noise removed** - Status bars, prompts, and UI hints are stripped
- **Wide terminal** - 200-column tmux window prevents URL wrapping

### User Experience
- **Image support** - Send images in Discord; they're downloaded locally and Claude can analyze them
- **Typing indicator** - Discord shows "Claude is typing..." while processing
- **Session workspace** - Each session directory gets a `.claude/CLAUDE.md` with Discord formatting tips for Claude
- **Session persistence** - Session-to-channel mappings saved to disk, restored on restart

### Deployment
- **systemd compatibility** - Documents `KillMode=process` requirement for service files

## Credits

This project is based on [disclaude](https://github.com/disclaude/app) by **Mike Burgh**.

See [NOTICE.md](NOTICE.md) for full attribution.
