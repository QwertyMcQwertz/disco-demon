<p align="center">
  <img src="disco-demon-clear.png" width="200" alt="Disco Demon logo">
</p>

# 🪩 Disco Demon 😈

Discord + Claude Code Daemon with persistent sessions.
Create a channel, start typing, Claude responds.

## ⚠️ Security Warning

**Anyone who can type in a session channel can run arbitrary commands on your machine.** This is raw, unsandboxed shell access through Discord. Only run this on a private server with people you trust completely.

See [Locking It Down](#locking-it-down) to reduce the blast radius.

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
- 🧩 **Skill installation** - Install skills from [ClawHub](https://clawhub.ai) or GitHub
- 🤖 **Agent self-install** - Claude can request skills, you confirm or cancel
- 📁 **Per-channel workspaces** - Each channel gets its own skills and config

## Installation

### Prerequisites

- **[Node.js 18+](https://nodejs.org/en/download)**
- **[tmux](https://github.com/tmux/tmux/wiki/Installing)**
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)** - installed and authenticated (`claude --version`)
- **[Discord server](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server)** - where you have Manage Channels permission

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

# Note: Enable Developer Mode in Discord (Settings → Advanced) to see "Copy ID" options
ALLOWED_PATHS=~/disco

# Optional
DEFAULT_DIRECTORY=~/disco
CATEGORY_NAME=Disco Demon
MESSAGE_RETENTION_DAYS=7
RATE_LIMIT_MS=1000
```

### 4. Run

```bash
npm start           # Production
npm run dev         # Development (hot reload)
```

Then in Discord: `/disco new myproject`

### Running as a Service

Running Disco Demon as a service ensures it:
- **Starts automatically** when your machine boots
- **Restarts on crash** without manual intervention
- **Keeps tmux sessions alive** across bot restarts

#### systemd (Linux)

Create a user service file:

```ini
# ~/.config/systemd/user/discod.service
[Unit]
Description=Disco Demon
After=network.target

[Service]
WorkingDirectory=/path/to/disco-demon
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now discod
```

**Important:** `KillMode=process` keeps tmux sessions alive when the service restarts. Without it, systemd kills all child processes including your sessions.

#### pm2 (Cross-platform)

[pm2](https://pm2.keymetrics.io/docs/usage/quick-start/) is a Node.js process manager that works on Linux, macOS, and Windows.

```bash
npm install -g pm2
pm2 start npm --name discod -- start
pm2 save
pm2 startup  # Follow the instructions to enable boot persistence
```

#### launchd (macOS)

For native macOS service management, see Apple's [launchd documentation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) or use [LaunchControl](https://www.soma-zone.com/LaunchControl/) for a GUI.

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/disco new <name> [directory]` | Create a new channel + Claude session (directory optional) |
| `/disco list` | List all active sessions |
| `/disco sync` | Reconnect orphaned tmux sessions |
| `/disco end` | End the current session |
| `/disco attach` | Get the tmux attach command |
| `/disco output [lines]` | Dump recent raw terminal output |
| `/disco stop` | Send ESC to interrupt Claude |

### Skills

| Command | Description |
|---------|-------------|
| `/disco clawhub search <query>` | Search for skills on ClawHub |
| `/disco clawhub add <slug> [scope]` | Install a skill from ClawHub |
| `/disco skill add <source> [scope]` | Install a skill from GitHub |
| `/disco skill list` | List installed skills by scope |
| `/disco skill remove <name> [scope]` | Remove an installed skill |

**Scope options:** `channel` (this channel only), `disco` (all Disco Demon channels), `global` (all Claude sessions)

**GitHub source formats:**
- `user/repo` - skill at repo root
- `user/repo/path/to/skill` - skill in subdirectory

## Usage Examples

**Create a session:**
```
/disco new my-project
```
→ Creates `#my-project` channel with a Claude session in the default directory

**Create a session in a specific directory:**
```
/disco new my-project ~/code/my-project
```
→ Same, but Claude works in `~/code/my-project`

**In the channel, just type:**
```
What does this codebase do?
```
→ Claude explores the files, summarizes the project, and answers follow-up questions

**Attach to the terminal:**
```
/disco attach
```
→ Copy the `tmux attach -t disco_...` command, paste in your terminal

**Install a skill from ClawHub:**
```
/disco clawhub add rlm
```
→ Prompts for scope (1=channel, 2=disco, 3=global), then installs

**Install a skill from GitHub:**
```
/disco skill add openclaw/openclaw/skills/skill-creator
```
→ Clones repo, extracts SKILL.md, prompts for scope

**Let Claude install skills:**
When Claude needs a skill, it requests it and you type `confirm` or `cancel`

## How It Works

```
You (Discord)              Disco Demon                tmux + Claude
     │                          │                          │
     │  "what does this do?"    │                          │
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

Sessions are named `disco_{last4-of-guild}_{channel-name}` - human-readable names the bot finds by querying tmux directly (no state file needed).

## Locking It Down

### User Whitelist (Required)

```bash
ALLOWED_USERS=123456789012345678,987654321098765432
```

Get your user ID: Discord Settings → Advanced → Developer Mode → right-click your name → Copy User ID

### Path Restrictions (Recommended)

Limit where sessions can be created:

```bash
ALLOWED_PATHS=~/disco
```

Note: Claude can still read/write anywhere once a session starts.

### Additional Measures

- **Private server** - Keep the invite list tight
- **2FA on Discord** - Protect your account
- **VM/container** - Run in isolation if possible
- **Audit `#disco-logs`** - The bot logs session creation and file edits

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | - | Bot token from Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | - | Application ID from Developer Portal |
| `DISCORD_GUILD_ID` | No | - | Your server ID (recommended for faster command updates) |
| `ALLOWED_USERS` | Yes* | - | Comma-separated user IDs (*or set `ALLOW_ALL_USERS=true`) |
| `ALLOWED_PATHS` | No | - | Comma-separated directory paths |
| `DEFAULT_DIRECTORY` | No | `~/.discod/sessions` | Default working directory |
| `CATEGORY_NAME` | No | `Disco Demon` | Discord category name |
| `MESSAGE_RETENTION_DAYS` | No | - | Auto-delete old messages |
| `RATE_LIMIT_MS` | No | `1000` | Minimum ms between messages per user |
| `ALLOW_ALL_USERS` | No | `false` | Allow anyone (dangerous) |

## Troubleshooting

### "tmux: command not found"

Install tmux: [github.com/tmux/tmux/wiki/Installing](https://github.com/tmux/tmux/wiki/Installing)

### Bot not responding

1. Is the user in `ALLOWED_USERS`?
2. Does the channel have an active session? (`/disco list`)
3. Check `#disco-logs` for errors
4. Is the tmux session alive? (`tmux list-sessions`)

### Session lost after restart (systemd)

Add `KillMode=process` to your systemd service. See [Running as a Service](#running-as-a-service) for details.

### Claude not responding in terminal

Attach to the session and look for errors:
```bash
tmux attach -t disco_<last4>_<channel-name>
```
Claude CLI might need re-authentication.

### "Directory not in allowed paths"

Add the directory to `ALLOWED_PATHS` in your `.env`.

## Architecture

**Data flow:**
- Discord messages → `tmux send-keys` → Claude CLI
- Claude output → `tmux capture-pane` → parsed → Discord

**Directory structure:**
```
~/.discod/sessions/           # Parent workspace (DEFAULT_DIRECTORY)
├── .claude/
│   └── CLAUDE.md             # Discord formatting rules (inherited by all)
├── skills/                   # Skills for ALL disco-demon channels
├── my-project/               # Channel workspace (channel name)
│   ├── .claude/
│   │   └── CLAUDE.md         # Channel-specific instructions
│   ├── skills/               # Skills for just this channel
│   └── .disco-images/        # Downloaded image attachments
└── another-channel/
    └── ...
```

**Skills hierarchy:**
- Channel skills: `~/.discod/sessions/<channel>/skills/`
- Disco skills: `~/.discod/sessions/skills/`
- Global skills: `~/.claude/skills/`

**Session naming:** `disco_{last4-of-guild}_{channel-name}` - human-readable names allow easy `tmux attach -t disco_4769_research`.

---

## Star History

<a href="https://www.star-history.com/#QwertyMcQwertz/disco-demon&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=QwertyMcQwertz/disco-demon&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=QwertyMcQwertz/disco-demon&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=QwertyMcQwertz/disco-demon&type=date&legend=top-left" />
 </picture>
</a>

---

*Originally inspired by [disclaude](https://github.com/disclaude/app)*
