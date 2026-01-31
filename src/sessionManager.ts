import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get template paths relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PARENT_TEMPLATE_PATH = join(__dirname, '..', 'config', 'parent-claude.md');
const CHANNEL_TEMPLATE_PATH = join(__dirname, '..', 'config', 'channel-claude.md');

// Session prefix - tmux sessions are named disco_{guildId}_{channelId}
const SESSION_PREFIX = 'disco_';

/**
 * Expand ~ to home directory
 */
function expandPath(path: string): string {
  return path.startsWith('~') ? path.replace('~', homedir()) : path;
}

/**
 * Strip HTML comments and clean up template
 */
function cleanTemplate(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Read parent CLAUDE.md template (Discord formatting rules - inherited by all channels)
 */
function getParentTemplate(): string {
  try {
    const template = readFileSync(PARENT_TEMPLATE_PATH, 'utf-8');
    return cleanTemplate(template);
  } catch (err) {
    console.error('Failed to read parent template:', err);
    return '# Disco Demon - Discord Environment\n\nYour output is being relayed to Discord.';
  }
}

/**
 * Read channel CLAUDE.md template with placeholder substitution
 */
function getChannelTemplate(channelName: string, channelDir: string, parentDir: string): string {
  try {
    const template = readFileSync(CHANNEL_TEMPLATE_PATH, 'utf-8');
    return cleanTemplate(template)
      .replace(/\{\{CHANNEL_NAME\}\}/g, channelName)
      .replace(/\{\{CHANNEL_DIR\}\}/g, channelDir)
      .replace(/\{\{PARENT_DIR\}\}/g, parentDir);
  } catch (err) {
    console.error('Failed to read channel template:', err);
    return `# Channel Agent - ${channelName}\n\nYou are the Claude agent for "${channelName}".`;
  }
}

/**
 * Ensure the parent workspace directory exists with Discord formatting CLAUDE.md
 * This is the sessions/ directory that all channel subdirectories live under.
 * Only creates files if they don't exist (preserves user customizations)
 */
export function ensureParentWorkspace(dir: string): void {
  const resolvedDir = resolve(expandPath(dir));

  // Create directory if needed
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
    console.log(`Created parent session directory: ${resolvedDir}`);
  }

  // Create .claude directory
  const claudeDir = join(resolvedDir, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Create parent CLAUDE.md (Discord formatting rules - inherited by all channels)
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, getParentTemplate(), 'utf-8');
    console.log(`Created Discord formatting guide: ${claudeMdPath}`);
  }

  // Create parent skills directory
  const skillsDir = join(resolvedDir, 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }
}

/**
 * Ensure a channel workspace directory exists with channel-specific CLAUDE.md
 * Creates the channel subdirectory under the parent sessions directory.
 * Returns the full path to the channel directory.
 */
export function ensureChannelWorkspace(parentDir: string, channelName: string): string {
  // Validate channel name to prevent path traversal
  if (!channelName || channelName.includes('/') || channelName.includes('\\') ||
      channelName === '..' || channelName === '.' || channelName.startsWith('.')) {
    throw new Error(`Invalid channel name: ${channelName}`);
  }

  const resolvedParent = resolve(expandPath(parentDir));
  const channelDir = join(resolvedParent, channelName);

  // Ensure parent workspace exists first
  ensureParentWorkspace(parentDir);

  // Create channel directory
  if (!existsSync(channelDir)) {
    mkdirSync(channelDir, { recursive: true });
    console.log(`Created channel directory: ${channelDir}`);
  }

  // Create channel .claude directory
  const claudeDir = join(channelDir, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Create channel CLAUDE.md (meta-aware template)
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, getChannelTemplate(channelName, channelDir, resolvedParent), 'utf-8');
    console.log(`Created channel guide: ${claudeMdPath}`);
  }

  // Create channel skills directory
  const skillsDir = join(channelDir, 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  return channelDir;
}

/**
 * Delete a channel workspace directory and all its contents
 * Called when a Discord channel is deleted.
 */
export function deleteChannelWorkspace(parentDir: string, channelName: string): void {
  const resolvedParent = resolve(expandPath(parentDir));
  const channelDir = join(resolvedParent, channelName);

  if (existsSync(channelDir)) {
    rmSync(channelDir, { recursive: true, force: true });
    console.log(`Deleted channel workspace: ${channelDir}`);
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

export interface SessionInfo {
  id: string;           // Format: {guildId}_{channelId}
  tmuxName: string;     // Format: disco_{guildId}_{channelId}
  directory: string;
  guildId: string;
  channelId: string;
  attachCommand: string;
  createdAt: Date | null;
}

/**
 * Generate session ID from Discord IDs
 */
function makeSessionId(guildId: string, channelId: string): string {
  return `${guildId}_${channelId}`;
}

/**
 * Parse guildId and channelId from session ID
 */
function parseSessionId(sessionId: string): { guildId: string; channelId: string } | null {
  const parts = sessionId.split('_');
  if (parts.length !== 2) return null;
  return { guildId: parts[0], channelId: parts[1] };
}

class SessionManager {
  // Track last captured output for diff detection (keyed by sessionId)
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
   * Get session ID from tmux name
   */
  getSessionIdFromTmuxName(tmuxName: string): string | null {
    if (!tmuxName.startsWith(SESSION_PREFIX)) return null;
    return tmuxName.slice(SESSION_PREFIX.length);
  }

  /**
   * Create a new Claude Code session in tmux
   * Session name is derived from guildId + channelId (convention-based)
   * Creates a channel subdirectory under the base directory.
   */
  async createSession(
    guildId: string,
    channelId: string,
    channelName: string,
    baseDirectory: string
  ): Promise<SessionInfo> {
    const sessionId = makeSessionId(guildId, channelId);
    const tmuxName = this.getTmuxName(sessionId);

    // Expand and resolve the base directory
    const resolvedBase = resolve(expandPath(baseDirectory));

    // Security: Check if base path is in allowed directories
    if (!isPathAllowed(resolvedBase)) {
      throw new Error(`Directory not in allowed paths: ${resolvedBase}`);
    }

    // Check if session already exists
    if (this.sessionExists(sessionId)) {
      throw new Error(`Session for this channel already exists`);
    }

    // Create the channel workspace (subdirectory with CLAUDE.md and skills/)
    const channelDir = ensureChannelWorkspace(baseDirectory, channelName);

    try {
      // Create a new tmux session running claude
      // Using spawnSync with args array to prevent command injection
      // Set wide terminal (200 cols) to prevent URL wrapping in output
      const result = spawnSync('tmux', [
        'new-session', '-d',
        '-x', '200', '-y', '50',
        '-s', tmuxName,
        '-c', channelDir,
        'claude', '--dangerously-skip-permissions'
      ], { stdio: 'pipe' });

      if (result.status !== 0) {
        throw new Error(result.stderr?.toString() || 'tmux command failed');
      }

      return {
        id: sessionId,
        directory: channelDir,
        tmuxName,
        guildId,
        channelId,
        attachCommand: `tmux attach -t ${tmuxName}`,
        createdAt: new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to create session: ${(error as Error).message}`);
    }
  }

  /**
   * Check if a tmux session exists by session ID
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
   * Check if a session exists for a Discord channel
   */
  sessionExistsForChannel(guildId: string, channelId: string): boolean {
    return this.sessionExists(makeSessionId(guildId, channelId));
  }

  /**
   * Get session ID for a Discord channel (if session exists)
   */
  getSessionIdForChannel(guildId: string, channelId: string): string | null {
    const sessionId = makeSessionId(guildId, channelId);
    return this.sessionExists(sessionId) ? sessionId : null;
  }

  /**
   * List all disco-demon tmux sessions
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
          const sessionId = this.getSessionIdFromTmuxName(name);
          const parsed = sessionId ? parseSessionId(sessionId) : null;
          return {
            id: sessionId || name,
            tmuxName: name,
            directory: path || 'unknown',
            guildId: parsed?.guildId || '',
            channelId: parsed?.channelId || '',
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
      throw new Error(`Session does not exist`);
    }

    try {
      // Send keys to the tmux session using a temp file to avoid escaping issues
      const escapedText = text.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t "${tmuxName}" -l '${escapedText}'`, { stdio: 'pipe' });

      // Wait for tmux buffer to process before sending Enter
      // Prevents race condition where Enter is lost on fast dispatch
      await new Promise(resolve => setTimeout(resolve, 1500));

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
      throw new Error(`Session does not exist`);
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
      throw new Error(`Session does not exist`);
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
      throw new Error(`Session does not exist`);
    }

    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: 'pipe' });

      // Clean up last output tracking
      this.lastOutput.delete(sessionId);

      return true;
    } catch (error) {
      throw new Error(`Failed to kill session: ${(error as Error).message}`);
    }
  }

  /**
   * Get session info by session ID
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
      const parsed = parseSessionId(sessionId);
      return {
        id: sessionId,
        tmuxName: name,
        directory: path || 'unknown',
        guildId: parsed?.guildId || '',
        channelId: parsed?.channelId || '',
        createdAt: created ? new Date(parseInt(created) * 1000) : null,
        attachCommand: `tmux attach -t ${name}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get session info for a Discord channel
   */
  getSessionForChannel(guildId: string, channelId: string): SessionInfo | null {
    const sessionId = makeSessionId(guildId, channelId);
    return this.getSession(sessionId);
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
