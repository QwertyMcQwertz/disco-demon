# Disclaude

A Discord bot for managing persistent Claude Code sessions. Each session gets its own channel - just type to talk to Claude.

> **Note:** This is a fork of [disclaude/app](https://github.com/disclaude/app) with compatibility fixes and improvements. See [Changes from Upstream](#changes-from-upstream) for details.

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
# Discord Bot Token
# Get from: https://discord.com/developers/applications -> Your App -> Bot -> Reset Token
DISCORD_TOKEN=your_bot_token_here

# Discord Application Client ID
# Get from: https://discord.com/developers/applications -> Your App -> OAuth2 -> Client ID
DISCORD_CLIENT_ID=your_client_id_here

# Guild/Server ID
# Enable Developer Mode: Discord Settings -> Advanced -> Developer Mode
# Then right-click your server -> Copy Server ID
DISCORD_GUILD_ID=your_guild_id_here

# Default working directory for new sessions (optional)
DEFAULT_DIRECTORY=/path/to/your/projects

# Category name for session channels (optional, default: "Claude Sessions")
CATEGORY_NAME=Claude Sessions

# Allowed Discord user IDs - HIGHLY RECOMMENDED
# Right-click your username -> Copy User ID (enable Developer Mode)
# Comma-separated for multiple users
ALLOWED_USERS=123456789012345678

# Auto-delete messages older than N days (optional, default: never)
MESSAGE_RETENTION_DAYS=7
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

### Running as a systemd service

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
1. Creates tmux sessions running the `claude` CLI with `--dangerously-skip-permissions`
2. Sends your Discord messages to the session via `tmux send-keys`
3. Polls for new output, parses it, and streams formatted responses to Discord
4. Persists session mappings to `~/.disclaude/sessions.json` for restart recovery

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
- **Typing indicator** - Discord shows "Claude is typing..." while processing
- **Session workspace** - Each session directory gets a `.claude/CLAUDE.md` with Discord formatting tips for Claude
- **Session persistence** - Session-to-channel mappings saved to disk, restored on restart

### Deployment
- **systemd compatibility** - Documents `KillMode=process` requirement for service files

## Security

**This bot can execute arbitrary code on your machine.** Anyone who can send messages to a session channel can instruct Claude to run commands, edit files, etc.

### User Whitelist (Required)

Always set `ALLOWED_USERS` in your `.env`:

```bash
# Single user
ALLOWED_USERS=123456789012345678

# Multiple users
ALLOWED_USERS=123456789012345678,987654321098765432
```

**To get your Discord user ID:**
1. Discord Settings → Advanced → Enable Developer Mode
2. Right-click your username → Copy User ID

Without `ALLOWED_USERS`, the bot warns at startup and allows anyone in the guild to use it.

### Additional Recommendations

- **Enable 2FA** on your Discord account
- **Never commit `.env`** - it's in `.gitignore` by default
- **Regenerate your bot token** immediately if exposed (Discord Developer Portal → Bot → Reset Token)
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
| `DEFAULT_DIRECTORY` | No | Default working directory for new sessions |
| `CATEGORY_NAME` | No | Category name for session channels (default: "Claude Sessions") |
| `ALLOWED_USERS` | No* | Comma-separated Discord user IDs (* highly recommended) |
| `MESSAGE_RETENTION_DAYS` | No | Auto-delete messages older than N days |

## Data Storage

- `~/.disclaude/sessions.json` - Persisted session-to-channel mappings
- `<session-dir>/.claude/CLAUDE.md` - Discord formatting guide for each session
