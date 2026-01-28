import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';

// Persistence file path
const SESSIONS_FILE = join(homedir(), '.disclaude', 'sessions.json');

// Interface for persisted session data
export interface PersistedSession {
  id: string;
  channelId: string;
  directory: string;
  tmuxName: string;
}

/**
 * Default CLAUDE.md content for Discord-friendly formatting
 */
const CLAUDE_MD_CONTENT = `# Discord Bot Session

Your output is being relayed to Discord. Markdown rendering is limited.

## What Works
- Bullet points with \`-\`
- Numbered lists
- Inline \`code\`
- Unicode formatting for emphasis:
  - 𝗯𝗼𝗹𝗱 (Mathematical Sans-Serif Bold)
  - 𝘪𝘵𝘢𝘭𝘪𝘤 (Mathematical Sans-Serif Italic)
  - 𝙗𝙤𝙡𝙙 𝙞𝙩𝙖𝙡𝙞𝙘 (Mathematical Sans-Serif Bold Italic)
  - u̲n̲d̲e̲r̲l̲i̲n̲e̲ (combining underline characters)

## What Does NOT Work
- **Tables** - pipe tables break completely, avoid them
- Standard markdown bold (\`**text**\`)
- Standard markdown italic (\`*text*\`)
- Code blocks with triple backticks

## Instead of Tables
Use bullet lists:
- Server: laptop | IP: 100.91.125.103 | Role: App server
- Server: sv1 | IP: 100.84.12.60 | Role: DNS

Or structured lists:
- 𝗹𝗮𝗽𝘁𝗼𝗽
  - IP: 100.91.125.103
  - Role: App server

## Keep It Concise
- Discord has a 2000 character limit per message
- Prefer bullet points over paragraphs
- Keep output under ~80 chars wide when possible
`;

/**
 * Ensure the session workspace directory exists with a CLAUDE.md file
 * Only creates files if they don't exist (preserves user customizations)
 */
export function ensureSessionWorkspace(dir: string): void {
  // Expand ~ to home directory
  const expandedDir = dir.startsWith('~') ? dir.replace('~', homedir()) : dir;
  const resolvedDir = resolve(expandedDir);

  // Create directory if needed
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
    console.log(`Created session directory: ${resolvedDir}`);
  }

  // Create .claude directory
  const claudeDir = join(resolvedDir, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Create CLAUDE.md only if it doesn't exist (preserve user edits)
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT, 'utf-8');
    console.log(`Created Discord formatting guide: ${claudeMdPath}`);
  }
}

// Allowed base paths for sessions (set via config)
let allowedPaths: string[] = [];

export function setAllowedPaths(paths: string[]): void {
  allowedPaths = paths.map(p => resolve(p.startsWith('~') ? p.replace('~', homedir()) : p));
}

function isPathAllowed(targetPath: string): boolean {
  // If no restrictions configured, allow all (with warning at startup)
  if (allowedPaths.length === 0) return true;
  const resolved = resolve(targetPath);
  return allowedPaths.some(allowed => resolved.startsWith(allowed + '/') || resolved === allowed);
}

const SESSION_PREFIX = 'claude-';

export interface Session {
  id: string;
  tmuxName: string;
  directory: string;
  channelId: string;
  createdAt: Date;
}

export interface SessionInfo {
  id: string;
  tmuxName: string;
  directory: string;
  channelId?: string;
  attachCommand: string;
  createdAt: Date | null;
}

class SessionManager {
  // Maps session ID -> channel ID
  private channelMap = new Map<string, string>();
  // Maps channel ID -> session ID (reverse lookup)
  private reverseMap = new Map<string, string>();
  // Track last captured output for diff detection
  private lastOutput = new Map<string, string>();

  /**
   * Check if tmux is installed
   */
  checkTmux(): boolean {
    try {
      execSync('which tmux', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the tmux session name for a given session ID
   */
  getTmuxName(sessionId: string): string {
    return `${SESSION_PREFIX}${sessionId}`;
  }

  /**
   * Create a new Claude Code session in tmux
   */
  async createSession(
    sessionId: string,
    directory: string,
    channelId: string
  ): Promise<SessionInfo> {
    const tmuxName = this.getTmuxName(sessionId);

    // Expand ~ to home directory, then resolve
    const expandedDir = directory.startsWith('~')
      ? directory.replace('~', homedir())
      : directory;
    const resolvedDir = resolve(expandedDir);

    // Security: Check if path is in allowed directories
    if (!isPathAllowed(resolvedDir)) {
      throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
    }

    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`);
    }

    // Check if session already exists
    if (this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" already exists`);
    }

    try {
      // Create a new tmux session running claude
      // Using spawnSync with args array to prevent command injection
      // Set wide terminal (200 cols) to prevent URL wrapping in output
      const result = spawnSync('tmux', [
        'new-session', '-d',
        '-x', '200', '-y', '50',
        '-s', tmuxName,
        '-c', resolvedDir,
        'claude', '--dangerously-skip-permissions'
      ], { stdio: 'pipe' });

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'tmux command failed');
      }

      // Store channel mapping
      this.channelMap.set(sessionId, channelId);
      this.reverseMap.set(channelId, sessionId);

      // Persist to disk
      this.saveSessionsToFile();

      return {
        id: sessionId,
        directory: resolvedDir,
        tmuxName,
        channelId,
        attachCommand: `tmux attach -t ${tmuxName}`,
        createdAt: new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to create session: ${(error as Error).message}`);
    }
  }

  /**
   * Check if a tmux session exists
   */
  sessionExists(sessionId: string): boolean {
    const tmuxName = this.getTmuxName(sessionId);
    try {
      execSync(`tmux has-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Link an existing tmux session to a channel
   */
  linkChannel(sessionId: string, channelId: string): void {
    this.channelMap.set(sessionId, channelId);
    this.reverseMap.set(channelId, sessionId);
    this.saveSessionsToFile();
  }

  /**
   * Get session ID from channel ID
   */
  getSessionByChannel(channelId: string): string | undefined {
    return this.reverseMap.get(channelId);
  }

  /**
   * Get channel ID from session ID
   */
  getChannelBySession(sessionId: string): string | undefined {
    return this.channelMap.get(sessionId);
  }

  /**
   * List all Claude Code tmux sessions
   */
  listSessions(): SessionInfo[] {
    try {
      const output = execSync(
        'tmux list-sessions -F "#{session_name}|#{session_created}|#{pane_current_path}" 2>/dev/null',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      return output
        .trim()
        .split('\n')
        .filter((line) => line.startsWith(SESSION_PREFIX))
        .map((line) => {
          const [name, created, path] = line.split('|');
          const id = name.replace(SESSION_PREFIX, '');
          return {
            id,
            tmuxName: name,
            directory: path || 'unknown',
            channelId: this.channelMap.get(id),
            createdAt: created ? new Date(parseInt(created) * 1000) : null,
            attachCommand: `tmux attach -t ${name}`,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Send input to a Claude Code session
   */
  async sendToSession(sessionId: string, text: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);

    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }

    try {
      // Send keys to the tmux session using a temp file to avoid escaping issues
      const escapedText = text.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t "${tmuxName}" -l '${escapedText}'`, { stdio: 'pipe' });
      execSync(`tmux send-keys -t "${tmuxName}" Enter`, { stdio: 'pipe' });

      return true;
    } catch (error) {
      throw new Error(`Failed to send to session: ${(error as Error).message}`);
    }
  }

  /**
   * Capture current output from a session
   * Captures both scrollback history and visible screen including status bar
   */
  captureOutput(sessionId: string, lines = 100): string {
    const tmuxName = this.getTmuxName(sessionId);

    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }

    try {
      // Capture scrollback history plus visible pane
      // -S -lines: start from N lines back
      // -E '': end at bottom of visible pane (captures status bar area)
      const output = execSync(
        `tmux capture-pane -t "${tmuxName}" -p -e -S -${lines} -E ''`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return output;
    } catch (error) {
      throw new Error(`Failed to capture output: ${(error as Error).message}`);
    }
  }

  /**
   * Get new output since last check (for streaming)
   */
  getNewOutput(sessionId: string, lines = 200): string | null {
    const output = this.captureOutput(sessionId, lines);
    const last = this.lastOutput.get(sessionId) || '';

    this.lastOutput.set(sessionId, output);

    // If first capture or output unchanged, return null
    if (!last || output === last) {
      return null;
    }

    // Find new content
    // Simple approach: if new output contains old, return the difference
    if (output.length > last.length && output.endsWith(last.slice(-500))) {
      return output.slice(0, output.length - last.length);
    }

    // If outputs differ significantly, return the new part that's different
    // Find where they start to differ
    const lastLines = last.trim().split('\n');
    const newLines = output.trim().split('\n');

    // Find lines in new that aren't in last
    let diffStart = 0;
    for (let i = 0; i < newLines.length; i++) {
      if (lastLines.includes(newLines[i])) {
        diffStart = i + 1;
      } else {
        break;
      }
    }

    const newContent = newLines.slice(diffStart).join('\n').trim();
    return newContent || null;
  }

  /**
   * Send escape key to stop Claude
   */
  async sendEscape(sessionId: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);

    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }

    try {
      execSync(`tmux send-keys -t "${tmuxName}" Escape`, { stdio: 'pipe' });
      return true;
    } catch (error) {
      throw new Error(`Failed to send escape: ${(error as Error).message}`);
    }
  }

  /**
   * Kill a Claude Code session
   */
  async killSession(sessionId: string): Promise<boolean> {
    const tmuxName = this.getTmuxName(sessionId);

    if (!this.sessionExists(sessionId)) {
      throw new Error(`Session "${sessionId}" does not exist`);
    }

    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' });

      // Clean up mappings
      const channelId = this.channelMap.get(sessionId);
      if (channelId) {
        this.reverseMap.delete(channelId);
      }
      this.channelMap.delete(sessionId);
      this.lastOutput.delete(sessionId);

      // Persist changes to disk
      this.saveSessionsToFile();

      return true;
    } catch (error) {
      throw new Error(`Failed to kill session: ${(error as Error).message}`);
    }
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): SessionInfo | null {
    const tmuxName = this.getTmuxName(sessionId);

    if (!this.sessionExists(sessionId)) {
      return null;
    }

    try {
      const output = execSync(
        `tmux list-sessions -F "#{session_name}|#{session_created}|#{pane_current_path}" -f "#{==:#{session_name},${tmuxName}}" 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      const line = output.trim();
      if (!line) return null;

      const [name, created, path] = line.split('|');
      return {
        id: sessionId,
        tmuxName: name,
        directory: path || 'unknown',
        channelId: this.channelMap.get(sessionId),
        createdAt: created ? new Date(parseInt(created) * 1000) : null,
        attachCommand: `tmux attach -t ${name}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Unlink a channel (when channel is deleted)
   */
  unlinkChannel(channelId: string): void {
    const sessionId = this.reverseMap.get(channelId);
    if (sessionId) {
      this.channelMap.delete(sessionId);
      this.reverseMap.delete(channelId);
      this.saveSessionsToFile();
    }
  }

  /**
   * Save current session state to disk
   */
  private saveSessionsToFile(): void {
    const sessions: PersistedSession[] = [];
    for (const [sessionId, channelId] of this.channelMap.entries()) {
      const info = this.getSession(sessionId);
      if (info) {
        sessions.push({
          id: sessionId,
          channelId,
          directory: info.directory,
          tmuxName: info.tmuxName,
        });
      }
    }

    // Ensure directory exists
    const dir = join(homedir(), '.disclaude');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
    } catch (e) {
      console.error('Failed to save sessions file:', e);
    }
  }

  /**
   * Load sessions from disk
   */
  private loadSessionsFromFile(): PersistedSession[] {
    try {
      if (existsSync(SESSIONS_FILE)) {
        return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('Failed to load sessions file:', e);
    }
    return [];
  }

  /**
   * Restore sessions from disk on startup
   * Returns list of restored sessions for caller to start pollers
   */
  restoreSessions(): PersistedSession[] {
    const saved = this.loadSessionsFromFile();
    const restored: PersistedSession[] = [];

    for (const session of saved) {
      // Verify tmux session still exists
      if (this.sessionExists(session.id)) {
        this.channelMap.set(session.id, session.channelId);
        this.reverseMap.set(session.channelId, session.id);
        restored.push(session);
      }
    }

    return restored;
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
