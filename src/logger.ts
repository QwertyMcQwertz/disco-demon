import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { TextChannel } from 'discord.js';

// Log directory
const LOG_DIR = join(homedir(), '.discod', 'logs');

// Discord channel for sanitized logs
let discordLogChannel: TextChannel | null = null;
const logBuffer: string[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

// Track if we've written the header today
let lastDebugLogDate: string | null = null;

/**
 * Get today's date string for log file naming
 */
function getDateString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Write debug log header if needed (new day or first run)
 */
function writeDebugHeaderIfNeeded(): void {
  const today = getDateString();
  if (lastDebugLogDate !== today) {
    ensureLogDir();
    const debugLogPath = join(LOG_DIR, `${today}-debug.log`);
    if (!existsSync(debugLogPath)) {
      const header = `⚠️ SENSITIVE DATA - DO NOT SHARE
Contains: Guild IDs, User IDs, Channel IDs
Generated: ${new Date().toISOString()}
${'='.repeat(60)}

`;
      appendFileSync(debugLogPath, header);
    }
    lastDebugLogDate = today;
  }
}

/**
 * Flush buffered logs to Discord
 */
async function flushLogs(): Promise<void> {
  if (!discordLogChannel || logBuffer.length === 0) return;

  const messages = logBuffer.splice(0, logBuffer.length);
  const content = messages.join('\n').slice(0, 1900); // Discord limit

  try {
    await discordLogChannel.send(content);
  } catch {
    // Ignore errors sending to log channel
  }
}

/**
 * Sanitized logging - safe for Discord and console
 * Shows human-readable names, NOT numeric IDs
 */
export function sanitizedLog(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const formatted = `\`${timestamp}\` ${prefix} ${message}`;

  // Console output
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);

  // Buffer for Discord (batch to avoid rate limits)
  logBuffer.push(formatted);

  // Flush after 2 seconds of inactivity
  if (logFlushTimer) clearTimeout(logFlushTimer);
  logFlushTimer = setTimeout(flushLogs, 2000);
}

/**
 * Debug logging - writes to file with full IDs
 * NOT safe to share - contains sensitive Discord IDs
 */
export function debugLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  ids?: Record<string, string>
): void {
  writeDebugHeaderIfNeeded();

  const timestamp = new Date().toISOString();
  const levelStr = level.toUpperCase().padEnd(5);

  let logLine = `[${timestamp}] ${levelStr} ${message}`;

  // Append IDs if provided
  if (ids && Object.keys(ids).length > 0) {
    const idStr = Object.entries(ids)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    logLine += ` | ${idStr}`;
  }

  const debugLogPath = join(LOG_DIR, `${getDateString()}-debug.log`);
  appendFileSync(debugLogPath, logLine + '\n');
}

/**
 * Set the Discord channel for sanitized log output
 */
export function setDiscordChannel(channel: TextChannel | null): void {
  discordLogChannel = channel;
}

export default {
  sanitizedLog,
  debugLog,
  setDiscordChannel,
};
