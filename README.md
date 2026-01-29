# 🪩 Disco Demon 😈

Persistent Claude Code sessions in Discord. Create a channel, start typing, Claude responds.

## ⚠️ Security Warning

**This is a security nightmare. Advanced users only.**

This bot gives anyone in your Discord channel the ability to execute arbitrary code on your machine. Read that again. Anyone who can type in a session channel can tell Claude to:

- Run any shell command (`rm -rf /`, `curl malware.sh | bash`, whatever)
- Read any file your user can access (SSH keys, browser cookies, env files)
- Edit any file (inject backdoors, modify configs, corrupt data)
- Exfiltrate data to external servers

If that doesn't terrify you, you're not thinking hard enough. This is raw, unsandboxed access to your system through a chat interface.

**Do not run this bot if:**
- You share your Discord server with anyone you don't trust completely
- You're on a machine with sensitive data
- You don't understand what `--dangerously-skip-permissions` means

Still here? See [Locking It Down](#locking-it-down) for how to reduce the blast radius.

---

## Features

- 📺 **Channel per session** - Each Claude session gets its own Discord channel
- 💬 **Just type** - No commands needed, messages go straight to Claude
- 🖼️ **Image support** - Send images and Claude can analyze them
- 📡 **Live output** - Claude's responses stream to the channel in real-time
- ✨ **Clean formatting** - Tool calls shown as compact summaries with emojis
- 🛑 **Stop button** - Click to interrupt Claude mid-response
- ⌨️ **Typing indicator** - Shows "typing..." while Claude processes
- 🔄 **Persistent** - Sessions survive disconnects and bot restarts
- 🔗 **Auto-reconnect** - Bot finds existing sessions on startup
- 🖥️ **Terminal access** - Drop into tmux whenever you want full control

## Installation

### Prerequisites

- **Node.js 18+**
- **tmux** - `sudo dnf install tmux` (Fedora) or `brew install tmux` (macOS)
- **Claude Code CLI** - installed and authenticated (`claude --version`)
- **Discord server** - where you have Manage Channels permission

### 1. Clone the repo

```bash
git clone https://github.com/QwertyMcQwertz/disco-demon.git
cd disco-demon
npm install
```

### 2. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it whatever you want
3. Go to **Bot** → **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Manage Channels`, `Embed Links`, `Add Reactions`, `Read Message History`
6. Open the generated URL → invite the bot to your server

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_application_id      # From Developer Portal → General Information
DISCORD_GUILD_ID=your_server_id            # Right-click server → Copy Server ID

# Security (see "Locking It Down")
ALLOWED_USERS=your_discord_user_id         # Right-click yourself → Copy User ID
ALLOWED_PATHS=~/projects,~/work

# Optional
DEFAULT_DIRECTORY=~/projects
CATEGORY_NAME=Disco Demon
MESSAGE_RETENTION_DAYS=7
RATE_LIMIT_MS=1000
```

### 4. Run

```bash
npm start           # Production
npm run dev         # Development (hot reload)
```

Then in Discord: `/claude new myproject ~/code/myproject`

### Running as a systemd Service

If you use systemd, you **must** set `KillMode=process` or tmux sessions die when the bot restarts:

```ini
# ~/.config/systemd/user/discod.service
[Unit]
Description=Disco Demon

[Service]
WorkingDirectory=/path/to/disco-demon
ExecStart=/usr/bin/npm start
Restart=always
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now discod
```

## Commands

| Command | Description |
|---------|-------------|
| `/claude new <name> [directory]` | Create a new session + channel |
| `/claude list` | List all active sessions |
| `/claude sync` | Reconnect orphaned tmux sessions |
| `/claude end` | End the current session |
| `/claude attach` | Get the tmux attach command |
| `/claude output [lines]` | Dump recent raw terminal output |
| `/claude stop` | Send ESC to interrupt Claude |

## Usage Examples

**Create a session:**
```
/claude new api-server ~/code/my-api
```
→ Creates `#api-server` channel in the "Disco Demon" category

**In the channel, just type:**
```
Help me add rate limiting to the /users endpoint
```
→ Claude reads your code, makes changes, responds with what it did

**Attach to the terminal:**
```
/claude attach
```
→ Copy the `tmux attach -t disco_...` command, paste in your terminal

## How It Works

```
You (Discord)              Disco Demon                tmux + Claude
     │                          │                          │
     │  "add rate limiting"     │                          │
     └─────────────────────────►│  tmux send-keys ────────►│
                                │                          │ Claude thinks...
                                │◄──── capture-pane ───────│ Claude responds
     │◄─────────────────────────│                          │
     │  [formatted response]    │                          │
```

1. You type in a session channel
2. Disco Demon sends your message to a tmux session running `claude`
3. Disco Demon polls the tmux pane for new output
4. Output is parsed, formatted, and streamed back to Discord

Sessions are named `disco_{guildId}_{channelId}` - the bot finds them by querying tmux directly (no state file needed).

## Locking It Down

You're running this thing. Might as well reduce the damage when (not if) something goes wrong.

### User Whitelist (Required)

Only let specific Discord users interact with sessions:

```bash
ALLOWED_USERS=123456789012345678,987654321098765432
```

Get your user ID: Discord Settings → Advanced → Developer Mode → right-click your name → Copy User ID

### Path Restrictions (Recommended)

Limit which directories sessions can be created in:

```bash
ALLOWED_PATHS=~/projects,~/work
```

Claude can still read/write anywhere, but at least you control where sessions start.

### Additional Measures

- **Private server** - Don't invite randos
- **2FA on Discord** - Protect your account
- **VM/container** - Run this in isolation if possible
- **Audit `#disco-logs`** - The bot logs session creation and file edits

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | - | Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | - | Application ID from Developer Portal |
| `DISCORD_GUILD_ID` | Yes | - | Your server ID |
| `ALLOWED_USERS` | Yes* | - | Comma-separated user IDs (*or set `ALLOW_ALL_USERS=true`) |
| `ALLOWED_PATHS` | No | - | Comma-separated directory paths |
| `DEFAULT_DIRECTORY` | No | `~/.discod/sessions` | Default working directory |
| `CATEGORY_NAME` | No | `Disco Demon` | Discord category name |
| `MESSAGE_RETENTION_DAYS` | No | - | Auto-delete old messages |
| `RATE_LIMIT_MS` | No | `1000` | Minimum ms between messages per user |
| `ALLOW_ALL_USERS` | No | `false` | Allow anyone (dangerous) |

## Troubleshooting

### "tmux: command not found"

Install it: `sudo dnf install tmux` or `brew install tmux`

### Bot not responding

1. Is the user in `ALLOWED_USERS`?
2. Does the channel have an active session? (`/claude list`)
3. Check `#disco-logs` for errors
4. Is the tmux session alive? (`tmux list-sessions`)

### Session lost after restart

Add `KillMode=process` to your systemd service. Without it, systemd kills tmux when the bot restarts.

### Claude not responding in terminal

Attach to the session and look for errors:
```bash
tmux attach -t disco_<guildId>_<channelId>
```
Claude CLI might need re-authentication.

### "Directory not in allowed paths"

Add the directory to `ALLOWED_PATHS` in your `.env`.

## Architecture

**Data flow:**
- Discord messages → `tmux send-keys` → Claude CLI
- Claude output → `tmux capture-pane` → parsed → Discord

**Files created:**
- `<session-dir>/.claude/CLAUDE.md` - Discord formatting guide for Claude
- `<session-dir>/.disco-images/` - Downloaded image attachments

**Session naming:** `disco_{guildId}_{channelId}` - allows stateless reconnection by querying tmux directly.

---

*Originally inspired by [disclaude](https://github.com/disclaude/app)*
