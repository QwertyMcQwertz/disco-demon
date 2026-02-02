# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-02-02

### Added

- **User context in prompts** - Claude now knows who's talking (username, channel, timestamp) for more relevant responses
- **Message debouncing** - Rapid consecutive messages are batched into a single Claude turn, improving context and reducing API calls
- **Simpler tmux session names** - Human-readable names like `disco_4769_research` instead of 20-digit IDs; easier to attach manually

### Changed

- **Log sensitivity split** - Sanitized logs safe to share publicly, detailed logs kept private; no more exposed Discord IDs in output

### Fixed

- Rate limiting conflict with debouncing resolved
- Session map now used for reverse lookup on startup

## [1.1.0] - 2026-01-31

### Added

- **ClawHub skill installation** - Install skills directly from [ClawHub](https://clawhub.ai) using `/disco clawhub add <slug>` and search with `/disco clawhub search <query>`
- **GitHub skill installation** - Install skills from any GitHub repository with `/disco skill add user/repo` or `/disco skill add user/repo/path/to/skill`
- **Skill scope selection** - Choose where skills are installed: channel-only, all Disco Demon channels, or globally
- **Agent self-installation** - Claude can request skill installations by outputting `[SKILL_REQUEST: ...]`; user confirmation required
- **Security warnings** - Skills scanned for suspicious patterns (shell injection, prompt overrides, credential references) with line numbers shown
- **Per-channel workspaces** - Each channel gets its own subdirectory with dedicated skills folder and CLAUDE.md
- **Skill management commands** - List installed skills with `/disco skill list` and remove with `/disco skill remove <name>`

### Changed

- Directory structure now uses hierarchical per-channel workspaces; old sessions continue to work but lack new skills directories

## [1.0.1] - 2026-01-30

### Fixed

- **Stop button session mismatch** - Previously clicking the stop button showed "Session mismatch" instead of interrupting Claude
- **Stop button persistence** - Stop buttons now correctly disappear after Claude stops responding or idle timeout

### Changed

- Slash commands renamed from `/claude` to `/disco`

## [1.0.0] - 2026-01-30

### Added

- **Discord-native output formatting** - Claude responses formatted properly for Discord with code blocks and markdown
- **Typing indicator** - Shows typing indicator while Claude processes messages
- **Tool call formatting** - Improved formatting for tool calls and fixed URL wrapping
- **Session workspace** - Default session workspace with Discord formatting guide
- **Session persistence** - Session-to-channel mappings persist across bot restarts
- **Image attachment support** - Claude can receive and analyze image attachments
- **Customizable session template** - CLAUDE.md instructions replace interactive prompt buttons
- **Convention-based session naming** - Eliminates state file; sessions named by channel
- **tmux reliability** - Added delay between tmux text send and Enter key for reliability

### Changed

- Rebranded to Disco Demon (from disclaude-improved)
- Channel naming drops `claude-` prefix

### Fixed

- Compatibility fix for Claude Code v2.1.22

[1.2.0]: https://github.com/QwertyMcQwertz/disco-demon/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/QwertyMcQwertz/disco-demon/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/QwertyMcQwertz/disco-demon/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/QwertyMcQwertz/disco-demon/releases/tag/v1.0.0
