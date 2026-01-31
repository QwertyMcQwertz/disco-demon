import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ChannelType,
  TextChannel,
  CategoryChannel,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Guild,
  ActivityType,
  MessageFlags,
} from 'discord.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import sessionManager, { setAllowedPaths, ensureParentWorkspace, deleteChannelWorkspace } from './sessionManager.js';
import {
  getSkillsDirectory,
  searchClawHub,
  downloadFromClawHub,
  downloadFromGitHub,
  installSkill,
  listSkills,
  removeSkill,
  checkSkillSecurity,
  type SkillScope,
} from './skillManager.js';
import config from './config.js';
import { parseClaudeOutput, formatForDiscord } from './utils.js';

// Download a file from URL to local path
async function downloadAttachment(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  writeFileSync(destPath, Buffer.from(buffer));
}

// Initialize allowed paths from config
setAllowedPaths(config.allowedPaths);

// Ensure default session directory exists with CLAUDE.md
ensureParentWorkspace(config.defaultDirectory);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Bot logs channel
let logChannel: TextChannel | null = null;
const logBuffer: string[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

// Log to both console and Discord
function botLog(level: 'info' | 'warn' | 'error', message: string): void {
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

async function flushLogs(): Promise<void> {
  if (!logChannel || logBuffer.length === 0) return;

  const messages = logBuffer.splice(0, logBuffer.length);
  const content = messages.join('\n').slice(0, 1900); // Discord limit

  try {
    await logChannel.send(content);
  } catch {
    // Ignore errors sending to log channel
  }
}

// Update bot presence/status
function updateBotStatus(): void {
  const sessionCount = sessionManager.listSessions().length;
  const statusText = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;

  client.user?.setPresence({
    activities: [{
      name: statusText,
      type: ActivityType.Watching,
    }],
    status: sessionCount > 0 ? 'online' : 'idle',
  });
}

// Check if a user is allowed to use the bot
function isUserAllowed(userId: string): boolean {
  // If no whitelist configured, allow all (backwards compatible but warns at startup)
  if (config.allowedUsers.length === 0) return true;
  return config.allowedUsers.includes(userId);
}

// Output polling state per session
interface OutputState {
  poller: NodeJS.Timeout;
  responseMessage: Message | null;  // Current response being edited
  lastContent: string;
  lastUserMessage: string;          // The user's message to find in output
  awaitingResponse: boolean;        // True after user sends message, until we respond
  accumulatedResponse: string;      // Full accumulated response for this turn
  lastRawCapture: string;           // Last raw capture to detect new content
  lastUpdateTime: number;           // Timestamp of last content change
  buttonsRemoved: boolean;          // Whether we've removed the stop button
  currentMessageStart: number;      // Index in accumulatedResponse where current message starts
}
const outputStates = new Map<string, OutputState>();

const IDLE_TIMEOUT = 5000; // Remove stop button after 5 seconds of no updates

// Session statistics tracking
interface SessionStats {
  messageCount: number;
  lastActivity: Date;
  startTime: Date;
  filesEdited: string[];
}
const sessionStats = new Map<string, SessionStats>();

// Rate limiting: track last message time per user
const userLastMessage = new Map<string, number>();

// Pending skill installation requests from Claude
// Pending skill requests from Claude (agent self-install)
interface PendingSkillRequest {
  source: string;
  sourceType: 'clawhub' | 'github';
  scope: SkillScope;
  requestTime: Date;
  channelId: string;
  guildId: string;
}
const pendingSkillRequests = new Map<string, PendingSkillRequest>(); // keyed by channelId

// Pending skill installations awaiting user confirmation (for warnings)
interface PendingSkillInstall {
  skillName: string;       // Name to install under (from manifest)
  confirmName: string;     // What user must type to confirm (slug they used)
  download: { content: string; manifest: { name: string; description: string } | null };
  scope: SkillScope;
  warnings: string[];
  requestTime: Date;
  channelId: string;
}
const pendingSkillInstalls = new Map<string, PendingSkillInstall>(); // keyed by channelId

// Pending scope selection (when --scope not provided)
interface PendingScopeSelect {
  skillName: string;       // Name to install under
  confirmName: string;     // Slug for warning confirmation
  download: { content: string; manifest: { name: string; description: string } | null };
  warnings: string[];
  requestTime: Date;
  channelId: string;
}
const pendingScopeSelects = new Map<string, PendingScopeSelect>(); // keyed by channelId

// Pattern to detect skill installation requests in Claude's output
const SKILL_REQUEST_PATTERN = /\[SKILL_REQUEST:\s*source="([^"]+)"\s*scope="([^"]+)"\]/g;

function getOrCreateStats(sessionId: string): SessionStats {
  let stats = sessionStats.get(sessionId);
  if (!stats) {
    stats = {
      messageCount: 0,
      lastActivity: new Date(),
      startTime: new Date(),
      filesEdited: [],
    };
    sessionStats.set(sessionId, stats);
  }
  return stats;
}

function formatUptime(startTime: Date): string {
  const ms = Date.now() - startTime.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatLastActivity(lastActivity: Date): string {
  const ms = Date.now() - lastActivity.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 10) return `${seconds}s ago`;
  return 'just now';
}

// Detect file edits in Claude's output
function detectFileEdits(text: string): string[] {
  const files: string[] = [];
  // Match Edit( and Write( tool calls
  const editMatches = text.matchAll(/(?:Edit|Write)\s*\(\s*["']?([^"'\s,)]+)/g);
  for (const match of editMatches) {
    const file = match[1];
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

// Mark that user sent a message - next output should be a new message
function markUserInput(sessionId: string, userMessage: string): void {
  const state = outputStates.get(sessionId);
  if (state) {
    state.awaitingResponse = true;
    state.lastUserMessage = userMessage;
    state.responseMessage = null;  // Force new message for response
    state.accumulatedResponse = '';  // Reset accumulated response for new turn
    state.lastUpdateTime = Date.now();
    state.buttonsRemoved = false;  // Reset for new turn
    state.currentMessageStart = 0;  // Reset for new turn
  }

  // Update session stats
  const stats = getOrCreateStats(sessionId);
  stats.messageCount++;
  stats.lastActivity = new Date();
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('disco')
    .setDescription('Manage Disco Demon sessions')
    .addSubcommand((sub) =>
      sub
        .setName('new')
        .setDescription('Create a new Claude Code session with a dedicated channel')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Session name (becomes channel name)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('directory').setDescription('Working directory').setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List all active sessions'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Sync orphaned tmux sessions to Discord channels'))
    .addSubcommand((sub) =>
      sub.setName('end').setDescription('End the session for this channel')
    )
    .addSubcommand((sub) =>
      sub
        .setName('output')
        .setDescription('Get recent output (use in session channel)')
        .addIntegerOption((opt) =>
          opt.setName('lines').setDescription('Number of lines (default: 100)').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('attach').setDescription('Get tmux attach command for this session')
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop Claude (send ESC key)')
    )
    // ClawHub skill management
    .addSubcommandGroup((group) =>
      group
        .setName('clawhub')
        .setDescription('Manage skills from ClawHub')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Install a skill from ClawHub')
            .addStringOption((opt) =>
              opt.setName('slug').setDescription('ClawHub skill slug').setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName('scope')
                .setDescription('Install scope')
                .setRequired(false)
                .addChoices(
                  { name: 'channel', value: 'channel' },
                  { name: 'disco', value: 'disco' },
                  { name: 'global', value: 'global' }
                )
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('search')
            .setDescription('Search for skills on ClawHub')
            .addStringOption((opt) =>
              opt.setName('query').setDescription('Search query').setRequired(true)
            )
        )
    )
    // General skill management
    .addSubcommandGroup((group) =>
      group
        .setName('skill')
        .setDescription('Manage installed skills')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Install a skill from GitHub or URL')
            .addStringOption((opt) =>
              opt.setName('source').setDescription('user/repo, user/repo/path, or full URL').setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName('scope')
                .setDescription('Install scope')
                .setRequired(false)
                .addChoices(
                  { name: 'channel', value: 'channel' },
                  { name: 'disco', value: 'disco' },
                  { name: 'global', value: 'global' }
                )
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('List all installed skills')
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove an installed skill')
            .addStringOption((opt) =>
              opt.setName('name').setDescription('Skill name').setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName('scope')
                .setDescription('Scope to remove from')
                .setRequired(false)
                .addChoices(
                  { name: 'channel', value: 'channel' },
                  { name: 'disco', value: 'disco' },
                  { name: 'global', value: 'global' }
                )
            )
        )
    ),
].map((cmd) => cmd.toJSON());

// Register slash commands
async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    botLog('info', 'Registering slash commands...');

    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
        body: commands,
      });
      botLog('info', `Commands registered for guild ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), {
        body: commands,
      });
      botLog('info', 'Commands registered globally');
    }
  } catch (error) {
    botLog('error', `Failed to register commands: ${(error as Error).message}`);
  }
}

// Find or create the Disco Demon category
async function getOrCreateCategory(guild: Guild): Promise<CategoryChannel> {
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === config.categoryName
  ) as CategoryChannel | undefined;

  if (!category) {
    category = await guild.channels.create({
      name: config.categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  return category;
}

// Reconnect sessions on bot startup
// With convention naming, channelId is embedded in tmux session name
async function syncSessions(guild: Guild): Promise<{ reconnected: string[]; orphaned: string[] }> {
  const sessions = sessionManager.listSessions();
  const reconnected: string[] = [];
  const orphaned: string[] = [];

  for (const session of sessions) {
    // channelId is parsed from the tmux session name (disco_{guildId}_{channelId})
    if (!session.channelId) {
      // Shouldn't happen with convention naming, but handle gracefully
      orphaned.push(session.id);
      continue;
    }

    // Verify Discord channel still exists
    try {
      const channel = await guild.channels.fetch(session.channelId);
      if (channel && channel.type === ChannelType.GuildText) {
        // Start poller for this session
        if (!outputStates.has(session.id)) {
          startOutputPoller(session.id, channel as TextChannel);
        }
        reconnected.push(session.id);

        // Send reconnection message
        await (channel as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Session Reconnected')
              .setColor(0x22c55e)
              .setDescription('Bot restarted - session has been reconnected to this channel.')
              .setTimestamp(),
          ],
        });
      } else {
        // Channel exists but wrong type
        orphaned.push(session.id);
      }
    } catch {
      // Channel no longer exists - session is orphaned
      orphaned.push(session.id);
    }
  }

  return { reconnected, orphaned };
}

// Clean for comparison (strip ANSI)
function cleanForCompare(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Clean for display (keep ANSI for colors)
function cleanForDisplay(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Convert ANSI codes to Discord-compatible format
// Discord only supports: 0 (reset), 1 (bold), 4 (underline), 30-37 (fg), 40-47 (bg)
function convertAnsiForDiscord(text: string): string {
  // Map 256-color codes to basic 8 colors
  const color256ToBasic = (n: number): number => {
    if (n < 8) return 30 + n;
    if (n < 16) return 30 + (n - 8);
    if (n >= 232) {
      const gray = n - 232;
      return gray < 12 ? 30 : 37;
    }
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;

    if (r >= 3 && g >= 3 && b <= 2) return 33;  // Yellow
    if (r <= 1 && g >= 3 && b >= 3) return 36;  // Cyan
    if (r >= 3 && g <= 2 && b >= 3) return 35;  // Magenta
    if (g >= 3 && r <= 2 && b <= 2) return 32;  // Green
    if (r >= 3 && g <= 2 && b <= 2) return 31;  // Red
    if (b >= 3 && r <= 2 && g <= 2) return 34;  // Blue
    if (r + g + b >= 10) return 37;             // White
    if (r + g + b >= 5) return 37;              // Light gray
    return 30;                                   // Dark
  };

  const rgbToBasic = (ri: number, gi: number, bi: number): number => {
    if (ri >= 150 && gi >= 150 && bi < 100) return 33;
    if (ri < 100 && gi >= 150 && bi >= 150) return 36;
    if (ri >= 150 && gi < 100 && bi >= 150) return 35;
    if (gi >= 150 && ri < 120 && bi < 120) return 32;
    if (ri >= 150 && gi < 120 && bi < 120) return 31;
    if (bi >= 150 && ri < 120 && gi < 120) return 34;
    if (ri + gi + bi >= 500) return 37;
    if (ri + gi + bi >= 250) return 37;
    return 30;
  };

  // Convert 256-color foreground
  text = text.replace(/\x1b\[38;5;(\d+)m/g, (_, n) => `\x1b[${color256ToBasic(parseInt(n))}m`);

  // Convert 256-color background
  text = text.replace(/\x1b\[48;5;(\d+)m/g, (_, n) => `\x1b[${color256ToBasic(parseInt(n)) + 10}m`);

  // Convert RGB foreground
  text = text.replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_, r, g, b) =>
    `\x1b[${rgbToBasic(parseInt(r), parseInt(g), parseInt(b))}m`);

  // Convert RGB background
  text = text.replace(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g, (_, r, g, b) =>
    `\x1b[${rgbToBasic(parseInt(r), parseInt(g), parseInt(b)) + 10}m`);

  // Convert unsupported codes to supported ones or remove them
  text = text.replace(/\x1b\[([0-9;]+)m/g, (match, params) => {
    const codes = params.split(';').map((s: string) => parseInt(s));
    const validCodes: number[] = [];

    for (const code of codes) {
      if (code === 0 || code === 1 || code === 4) {
        validCodes.push(code);  // Reset, bold, underline
      } else if (code >= 30 && code <= 37) {
        validCodes.push(code);  // Basic foreground colors
      } else if (code >= 40 && code <= 47) {
        validCodes.push(code);  // Basic background colors
      } else if (code === 39 || code === 49) {
        validCodes.push(0);     // Default colors -> reset
      } else if (code >= 90 && code <= 97) {
        validCodes.push(code - 60);  // Bright fg -> normal fg
      } else if (code >= 100 && code <= 107) {
        validCodes.push(code - 60);  // Bright bg -> normal bg
      }
      // Other codes are dropped
    }

    if (validCodes.length === 0) return '';
    return `\x1b[${validCodes.join(';')}m`;
  });

  // Clean up any remaining malformed sequences or non-printable chars
  // that might cause display issues
  text = text.replace(/\x1b\[[^m]*[^0-9m][^m]*m/g, '');  // Remove malformed color sequences

  // Remove ALL non-SGR escape sequences (cursor control, erase, scroll, etc.)
  // These don't end with 'm' and Discord doesn't support them
  text = text.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');   // Private mode sequences like [?25h
  text = text.replace(/\x1b\[[0-9;]*[A-LN-Za-ln-z]/g, ''); // Non-m sequences: cursor, erase, etc.
  text = text.replace(/\x1b[78]/g, '');                   // Cursor save/restore: ESC 7, ESC 8
  text = text.replace(/\x1b\([AB0-2]/g, '');             // Character set selection
  text = text.replace(/\x1b[=>]/g, '');                   // Keypad modes
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // OSC sequences (title, etc.)

  // Clean up any remaining orphaned escape characters
  text = text.replace(/\x1b(?!\[)/g, '');                // Remove lone ESC not followed by [
  text = text.replace(/\x1b\[(?![0-9;]*m)/g, '');        // Remove ESC[ not followed by valid SGR

  // Remove orphaned bracket sequences where \x1b was stripped (e.g., [37m, [0m, [40m)
  // These look like ANSI codes but lack the escape character prefix
  text = text.replace(/(?<!\x1b)\[([0-9;]*)m/g, '');

  // Escape triple backticks to prevent breaking out of Discord code blocks
  // Insert zero-width space between first two backticks
  text = text.replace(/```/g, '`\u200B``');

  return text;
}

// Remove only the raw prompt input line, keep status info
function stripPromptFooter(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  // Helper to strip ANSI for pattern matching
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = stripAnsi(line).trim();

    // Skip the horizontal separator lines (the thick line above the prompt)
    if (/^[─]{10,}$/.test(clean)) continue;

    // Skip the empty prompt line "> " (where you type)
    if (/^>\s*$/.test(clean)) continue;

    // Skip the shortcuts hint
    if (clean === '? for shortcuts') continue;

    // Keep everything else including:
    // - Status text (⏵⏵ accept edits, Context left, etc.)
    // - Thinking/processing messages
    // - Any other content

    result.push(line);
  }

  // Trim trailing empty lines
  while (result.length > 0 && stripAnsi(result[result.length - 1]).trim() === '') {
    result.pop();
  }

  return result.join('\n').trim();
}

function startOutputPoller(sessionId: string, channel: TextChannel): void {
  stopOutputPoller(sessionId);

  const state: OutputState = {
    poller: null as unknown as NodeJS.Timeout,
    responseMessage: null,
    lastContent: '',
    lastUserMessage: '',
    awaitingResponse: false,
    accumulatedResponse: '',
    lastRawCapture: '',
    lastUpdateTime: Date.now(),
    buttonsRemoved: true,  // Start with no buttons (no active turn)
    currentMessageStart: 0,
  };

  const processOutput = async () => {
    try {
      if (!sessionManager.sessionExists(sessionId)) {
        stopOutputPoller(sessionId);
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xef4444)
              .setDescription('Session has ended.')
              .setTimestamp(),
          ],
        });
        return;
      }

      // Capture more lines to get full context
      const rawOutput = sessionManager.captureOutput(sessionId, 200);
      const outputForCompare = cleanForCompare(rawOutput);
      const outputForDisplay = cleanForDisplay(rawOutput);

      // Check if content changed
      const contentChanged = outputForCompare !== state.lastContent;

      if (contentChanged) {
        state.lastContent = outputForCompare;
        state.lastUpdateTime = Date.now();
        state.buttonsRemoved = false;
      }

      // Check for idle timeout - remove ONLY the stop button, keep prompt options
      const timeSinceUpdate = Date.now() - state.lastUpdateTime;
      if (!state.buttonsRemoved && timeSinceUpdate > IDLE_TIMEOUT && state.responseMessage) {
        try {
          // Get current components and filter out Stop button, keep prompt options
          const currentComponents = state.responseMessage.components;
          const filteredComponents: ActionRowBuilder<ButtonBuilder>[] = [];

          for (const row of currentComponents) {
            // Type guard: only ActionRows have components
            if (!('components' in row)) continue;

            const filteredRow = new ActionRowBuilder<ButtonBuilder>();
            for (const component of row.components) {
              // Keep buttons that are NOT the stop button
              if ('customId' in component && component.customId && !component.customId.startsWith('stop:')) {
                filteredRow.addComponents(
                  ButtonBuilder.from(component as any)
                );
              }
            }
            // Only add row if it has buttons
            if (filteredRow.components.length > 0) {
              filteredComponents.push(filteredRow);
            }
          }

          await state.responseMessage.edit({ components: filteredComponents });
          state.buttonsRemoved = true;
        } catch {
          // Ignore errors removing buttons
        }
      }

      // Skip further processing if nothing changed
      if (!contentChanged) return;

      // Parse the output into structured segments and format for Discord
      const segments = parseClaudeOutput(outputForCompare);
      const formattedContent = formatForDiscord(segments);

      // If no meaningful content, keep typing indicator alive while waiting
      if (!formattedContent || formattedContent.length < 3) {
        if (state.awaitingResponse) {
          await channel.sendTyping();
        }
        return;
      }

      // Update accumulated response
      state.accumulatedResponse = formattedContent;

      // Detect file edits and track them
      const editedFiles = detectFileEdits(outputForCompare);
      if (editedFiles.length > 0) {
        const stats = getOrCreateStats(sessionId);
        for (const file of editedFiles) {
          if (!stats.filesEdited.includes(file)) {
            stats.filesEdited.push(file);
            // Log file edit to disco-logs
            const fileName = file.split('/').pop() || file;
            botLog('info', `📝 **${sessionId}**: Edited \`${fileName}\``);
          }
        }
      }

      // Detect skill installation requests from Claude
      SKILL_REQUEST_PATTERN.lastIndex = 0; // Reset regex state
      const skillMatches = outputForCompare.matchAll(SKILL_REQUEST_PATTERN);
      for (const match of skillMatches) {
        const source = match[1];
        const scope = match[2] as SkillScope;

        // Determine source type
        const sourceType = source.startsWith('clawhub:') ? 'clawhub' : 'github';
        const cleanSource = source.replace(/^clawhub:/, '');

        // Check if we already have a pending request for this channel
        if (!pendingSkillRequests.has(channel.id)) {
          pendingSkillRequests.set(channel.id, {
            source: cleanSource,
            sourceType,
            scope,
            requestTime: new Date(),
            channelId: channel.id,
            guildId: channel.guildId,
          });

          // Notify user about the skill request
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🔧 Skill Installation Request')
                .setColor(0xf59e0b)
                .setDescription(`Claude is requesting to install a skill.`)
                .addFields(
                  { name: 'Source', value: `\`${source}\``, inline: true },
                  { name: 'Scope', value: scope, inline: true }
                )
                .setFooter({ text: 'Type "confirm" to approve or "cancel" to deny.' }),
            ],
          });

          botLog('info', `🔧 **${sessionId}**: Skill request - ${source} (${scope})`);
        }
      }

      // Use the formatted content directly (plain text for Discord)
      const fullDisplayContent = state.accumulatedResponse;

      // Discord message limit is 2000 chars
      const maxMessageLength = 1950;

      // Get just the content for this message (from currentMessageStart onwards)
      let displayContent = fullDisplayContent.slice(state.currentMessageStart);

      // Plain text message (no code block wrapper)
      let messageContent = displayContent;

      // If message exceeds limit, we need to split
      while (messageContent.length > maxMessageLength) {
        // Find a safe split point
        let splitPoint = Math.min(displayContent.length, maxMessageLength);

        // Find a newline to split at (avoid mid-line splits)
        const searchArea = displayContent.slice(0, splitPoint);
        const lastNewline = searchArea.lastIndexOf('\n');
        if (lastNewline > splitPoint - 300 && lastNewline > 100) {
          splitPoint = lastNewline;
        }

        const chunkContent = displayContent.slice(0, splitPoint);

        // Send or edit with this chunk
        if (state.responseMessage) {
          // Finalize current message with this chunk (no buttons)
          try {
            await state.responseMessage.edit({
              content: chunkContent,
              components: [],
            });
          } catch (e) {
            // Ignore edit errors
          }
        } else {
          // Create new message with this chunk (no buttons - it's finalized)
          try {
            await channel.send({ content: chunkContent });
          } catch (e) {
            console.error('Failed to send chunk:', e);
          }
        }

        // Move to next chunk
        state.currentMessageStart += splitPoint;
        state.responseMessage = null;
        displayContent = displayContent.slice(splitPoint).trim();

        messageContent = displayContent;
      }

      // Build stop button
      const stopButton = new ButtonBuilder()
        .setCustomId(`stop:${sessionId}`)
        .setLabel('⏹ Stop')
        .setStyle(ButtonStyle.Danger);

      const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton)];

      try {
        // If we have a response message for this turn, edit it
        if (state.responseMessage) {
          await state.responseMessage.edit({ content: messageContent, components });
        } else {
          // Create new response message
          state.responseMessage = await channel.send({ content: messageContent, components });
          state.awaitingResponse = false;
        }
      } catch (err) {
        console.error('Failed to send/edit message:', err);
        try {
          state.responseMessage = await channel.send({ content: messageContent, components });
        } catch {
          // Ignore
        }
      }

    } catch (error) {
      console.error(`Poller error for ${sessionId}:`, error);
    }
  };

  state.poller = setInterval(processOutput, 1500);
  outputStates.set(sessionId, state);

  // Capture initial state
  try {
    const initial = sessionManager.captureOutput(sessionId, 80);
    state.lastContent = cleanForCompare(initial);
  } catch {
    // Ignore
  }
}

function stopOutputPoller(sessionId: string): void {
  const state = outputStates.get(sessionId);
  if (state) {
    clearInterval(state.poller);
    outputStates.delete(sessionId);
  }
}

// Get skill directories for current context
function getSkillDirs(guildId: string, channelId: string): { channelDir: string; parentDir: string } | null {
  const session = sessionManager.getSessionForChannel(guildId, channelId);
  if (!session) return null;

  return {
    channelDir: session.directory,
    parentDir: config.defaultDirectory,
  };
}

// Handle skill-related subcommand groups
async function handleSkillCommands(
  interaction: import('discord.js').ChatInputCommandInteraction,
  group: string,
  subcommand: string
): Promise<void> {
  if (group === 'clawhub') {
    switch (subcommand) {
      case 'search': {
        const query = interaction.options.getString('query', true);
        await interaction.deferReply();

        const results = await searchClawHub(query);

        if (results.length === 0) {
          await interaction.editReply('No skills found matching your query.');
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`ClawHub Search: "${query}"`)
          .setColor(0x7c3aed)
          .setDescription(
            results
              .slice(0, 10)
              .map((r) => `**${r.slug}** - ${r.description || 'No description'}`)
              .join('\n\n')
          )
          .setFooter({ text: `${results.length} result(s) found` });

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'add': {
        const slug = interaction.options.getString('slug', true);
        const scopeOption = interaction.options.getString('scope') as SkillScope | null;

        await interaction.deferReply();

        // Download from ClawHub
        const download = await downloadFromClawHub(slug);
        if (!download) {
          await interaction.editReply(`Could not find skill "${slug}" on ClawHub.`);
          return;
        }

        const confirmName = slug;
        const installName = download.manifest?.name || slug;
        const securityCheck = checkSkillSecurity(download.content);

        // If no scope provided, prompt for it
        if (!scopeOption) {
          pendingScopeSelects.set(interaction.channelId, {
            skillName: installName,
            confirmName,
            download,
            warnings: securityCheck.warnings,
            requestTime: new Date(),
            channelId: interaction.channelId,
          });

          const embed = new EmbedBuilder()
            .setTitle(`Install "${installName}"`)
            .setColor(0x7c3aed)
            .setDescription(`Where should this skill be installed?\n\n**1** - This channel only\n**2** - All Disco Demon channels\n**3** - Global (all Claude sessions)\n\nReply with **1**, **2**, or **3**.`);

          if (download.manifest?.description) {
            embed.addFields({ name: 'Description', value: download.manifest.description, inline: false });
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // Scope provided - proceed with install (with warning check if needed)
        if (securityCheck.warnings.length > 0) {
          pendingSkillInstalls.set(interaction.channelId, {
            skillName: installName,
            confirmName,
            download,
            scope: scopeOption,
            warnings: securityCheck.warnings,
            requestTime: new Date(),
            channelId: interaction.channelId,
          });

          const embed = new EmbedBuilder()
            .setTitle('⚠️ Security Warnings Detected')
            .setColor(0xf59e0b)
            .setDescription(`Skill **${installName}** has potential security concerns.\n\nReview the warnings below, then type \`${confirmName}\` to install or anything else to cancel.`)
            .addFields(
              { name: 'Scope', value: scopeOption, inline: true },
              { name: 'Warnings', value: securityCheck.warnings.map(w => `• ${w}`).join('\n').slice(0, 1024), inline: false }
            );

          if (securityCheck.warnings.join('\n').length > 1024) {
            embed.addFields({ name: '...', value: `Plus ${securityCheck.warnings.length - 3} more warnings`, inline: false });
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // No warnings, scope provided - install directly
        await installSkillWithScope(interaction, download, installName, scopeOption, []);
        break;
      }
    }
  } else if (group === 'skill') {
    switch (subcommand) {
      case 'add': {
        const source = interaction.options.getString('source', true);
        const scopeOption = interaction.options.getString('scope') as SkillScope | null;

        await interaction.deferReply();

        // Download from GitHub
        const download = await downloadFromGitHub(source);
        if (!download) {
          await interaction.editReply(`Could not download skill from "${source}". Make sure the repo exists and contains a SKILL.md file.`);
          return;
        }

        const confirmName = source.split('/').pop() || source;
        const installName = download.manifest?.name || confirmName;
        const securityCheck = checkSkillSecurity(download.content);

        // If no scope provided, prompt for it
        if (!scopeOption) {
          pendingScopeSelects.set(interaction.channelId, {
            skillName: installName,
            confirmName,
            download,
            warnings: securityCheck.warnings,
            requestTime: new Date(),
            channelId: interaction.channelId,
          });

          const embed = new EmbedBuilder()
            .setTitle(`Install "${installName}"`)
            .setColor(0x7c3aed)
            .setDescription(`Where should this skill be installed?\n\n**1** - This channel only\n**2** - All Disco Demon channels\n**3** - Global (all Claude sessions)\n\nReply with **1**, **2**, or **3**.`);

          if (download.manifest?.description) {
            embed.addFields({ name: 'Description', value: download.manifest.description, inline: false });
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // Scope provided - proceed with install (with warning check if needed)
        if (securityCheck.warnings.length > 0) {
          pendingSkillInstalls.set(interaction.channelId, {
            skillName: installName,
            confirmName,
            download,
            scope: scopeOption,
            warnings: securityCheck.warnings,
            requestTime: new Date(),
            channelId: interaction.channelId,
          });

          const embed = new EmbedBuilder()
            .setTitle('⚠️ Security Warnings Detected')
            .setColor(0xf59e0b)
            .setDescription(`Skill **${installName}** has potential security concerns.\n\nReview the warnings below, then type \`${confirmName}\` to install or anything else to cancel.`)
            .addFields(
              { name: 'Scope', value: scopeOption, inline: true },
              { name: 'Warnings', value: securityCheck.warnings.map(w => `• ${w}`).join('\n').slice(0, 1024), inline: false }
            );

          if (securityCheck.warnings.join('\n').length > 1024) {
            embed.addFields({ name: '...', value: `Plus ${securityCheck.warnings.length - 3} more warnings`, inline: false });
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // No warnings, scope provided - install directly
        await installSkillWithScope(interaction, download, installName, scopeOption, []);
        break;
      }

      case 'list': {
        const dirs = getSkillDirs(interaction.guildId!, interaction.channelId);

        const allSkills: Array<{ skill: ReturnType<typeof listSkills>[0]; scope: string }> = [];

        // Channel skills (if in a session)
        if (dirs) {
          const channelSkillsDir = getSkillsDirectory('channel', dirs.channelDir, dirs.parentDir);
          const channelSkills = listSkills(channelSkillsDir);
          allSkills.push(...channelSkills.map((s) => ({ skill: s, scope: 'channel' })));
        }

        // Disco skills
        const discoSkillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
        const discoSkills = listSkills(discoSkillsDir);
        allSkills.push(...discoSkills.map((s) => ({ skill: s, scope: 'disco' })));

        // Global skills
        const globalSkillsDir = getSkillsDirectory('global', '', '');
        const globalSkills = listSkills(globalSkillsDir);
        allSkills.push(...globalSkills.map((s) => ({ skill: s, scope: 'global' })));

        if (allSkills.length === 0) {
          await interaction.reply('No skills installed.');
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('Installed Skills')
          .setColor(0x7c3aed)
          .setDescription(
            allSkills
              .map((s) => `**${s.skill.name}** (${s.scope})\n${s.skill.description}`)
              .join('\n\n')
          );

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case 'remove': {
        const name = interaction.options.getString('name', true);
        const scopeOption = interaction.options.getString('scope') as SkillScope | null;

        const dirs = getSkillDirs(interaction.guildId!, interaction.channelId);

        // If scope specified, remove from that scope only
        if (scopeOption) {
          let skillsDir: string;
          if (scopeOption === 'channel') {
            if (!dirs) {
              await interaction.reply({
                content: 'This channel is not linked to a session.',
                ephemeral: true,
              });
              return;
            }
            skillsDir = getSkillsDirectory('channel', dirs.channelDir, dirs.parentDir);
          } else if (scopeOption === 'disco') {
            skillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
          } else {
            skillsDir = getSkillsDirectory('global', '', '');
          }

          const removed = removeSkill(name, skillsDir);
          if (removed) {
            await interaction.reply(`Removed skill "${name}" from ${scopeOption} scope.`);
            botLog('info', `Skill **${name}** removed from ${scopeOption} by ${interaction.user.tag}`);
          } else {
            await interaction.reply({
              content: `Skill "${name}" not found in ${scopeOption} scope.`,
              ephemeral: true,
            });
          }
          break;
        }

        // No scope specified - search all scopes and remove from first found
        const scopesToCheck: Array<{ scope: SkillScope; dir: string }> = [];

        // Channel scope (if in session)
        if (dirs) {
          scopesToCheck.push({ scope: 'channel', dir: getSkillsDirectory('channel', dirs.channelDir, dirs.parentDir) });
        }
        // Disco scope
        scopesToCheck.push({ scope: 'disco', dir: getSkillsDirectory('disco', '', config.defaultDirectory) });
        // Global scope
        scopesToCheck.push({ scope: 'global', dir: getSkillsDirectory('global', '', '') });

        let removedFromScope: SkillScope | null = null;
        for (const { scope, dir } of scopesToCheck) {
          const removed = removeSkill(name, dir);
          if (removed) {
            removedFromScope = scope;
            break;
          }
        }

        if (removedFromScope) {
          await interaction.reply(`Removed skill "${name}" from ${removedFromScope} scope.`);
          botLog('info', `Skill **${name}** removed from ${removedFromScope} by ${interaction.user.tag}`);
        } else {
          const checkedScopes = scopesToCheck.map(s => s.scope).join(', ');
          await interaction.reply({
            content: `Skill "${name}" not found in any scope (${checkedScopes}).`,
            ephemeral: true,
          });
        }
        break;
      }
    }
  }
}

// Helper to install skill at a specific scope
async function installSkillWithScope(
  interaction: import('discord.js').ChatInputCommandInteraction,
  download: { content: string; manifest: { name: string; description: string } | null },
  skillName: string,
  scope: SkillScope,
  warnings: string[] = []
): Promise<void> {
  const dirs = getSkillDirs(interaction.guildId!, interaction.channelId);

  // Determine skills directory based on scope
  let skillsDir: string;
  if (scope === 'channel') {
    if (!dirs) {
      await interaction.editReply('Cannot install to channel scope - this channel is not linked to a session.');
      return;
    }
    skillsDir = getSkillsDirectory('channel', dirs.channelDir, dirs.parentDir);
  } else if (scope === 'disco') {
    skillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
  } else {
    skillsDir = getSkillsDirectory('global', '', '');
  }

  const name = download.manifest?.name || skillName;
  const installedPath = installSkill(name, download.content, skillsDir);

  // Build response embed
  const hasWarnings = warnings.length > 0;
  const embed = new EmbedBuilder()
    .setTitle(hasWarnings ? '⚠️ Skill Installed (with warnings)' : '✅ Skill Installed')
    .setColor(hasWarnings ? 0xf59e0b : 0x22c55e)
    .addFields(
      { name: 'Name', value: name, inline: true },
      { name: 'Scope', value: scope, inline: true },
      { name: 'Path', value: `\`${installedPath}\``, inline: false }
    );

  if (download.manifest?.description) {
    embed.setDescription(download.manifest.description);
  }

  // Add security warnings if any (truncate if too long)
  if (hasWarnings) {
    const warningsText = warnings.slice(0, 5).join('\n\n');
    const truncated = warnings.length > 5 ? `\n\n... and ${warnings.length - 5} more` : '';
    embed.addFields({
      name: '⚠️ Security Warnings',
      value: (warningsText + truncated).slice(0, 1024),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
  botLog('info', `Skill **${name}** installed to ${scope} by ${interaction.user.tag}${hasWarnings ? ' (with warnings)' : ''}`);
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'disco') return;

  // Check user whitelist
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  try {
    // Handle subcommand groups (clawhub, skill)
    if (subcommandGroup) {
      await handleSkillCommands(interaction, subcommandGroup, subcommand);
      return;
    }

    switch (subcommand) {
      case 'new': {
        const name = interaction.options.getString('name', true);
        const directory = interaction.options.getString('directory') || config.defaultDirectory;

        await interaction.deferReply();

        const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
        const category = await getOrCreateCategory(interaction.guild!);

        // Create Discord channel with friendly name
        const channel = await interaction.guild!.channels.create({
          name: cleanName,
          type: ChannelType.GuildText,
          parent: category.id,
        });

        // Create session - creates channel subdirectory under base directory
        const session = await sessionManager.createSession(
          interaction.guildId!,
          channel.id,
          cleanName,
          directory
        );

        // Update channel topic with actual tmux session name
        await channel.setTopic(`Claude Code session | Directory: ${directory} | Attach: ${session.attachCommand}`);

        startOutputPoller(session.id, channel);

        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('Claude Code Session Started')
              .setColor(0x7c3aed)
              .addFields(
                { name: 'Directory', value: `\`${session.directory}\``, inline: false },
                { name: 'Attach via Terminal', value: `\`${session.attachCommand}\``, inline: false }
              )
              .setDescription('Just type your messages here to talk to Claude.\nOutput will appear automatically.')
              .setTimestamp(),
          ],
        });

        await interaction.editReply({
          content: `Session created! Head to ${channel} to start chatting with Claude.`,
        });

        botLog('info', `Session **${cleanName}** (${session.tmuxName}) created by ${interaction.user.tag}`);
        updateBotStatus();
        break;
      }

      case 'list': {
        const sessions = sessionManager.listSessions();

        if (sessions.length === 0) {
          await interaction.reply('No active Claude Code sessions.');
          return;
        }

        const orphaned = sessions.filter(s => !s.channelId);

        const embed = new EmbedBuilder()
          .setTitle('Active Sessions')
          .setColor(0x7c3aed)
          .setDescription(
            sessions
              .map((s) => {
                const channelMention = s.channelId ? `<#${s.channelId}>` : '**No channel**';
                const stats = sessionStats.get(s.id);
                let statsLine = '';
                if (stats) {
                  const parts = [
                    `${stats.messageCount} msg${stats.messageCount !== 1 ? 's' : ''}`,
                    formatUptime(stats.startTime),
                    formatLastActivity(stats.lastActivity),
                  ];
                  if (stats.filesEdited.length > 0) {
                    parts.push(`${stats.filesEdited.length} file${stats.filesEdited.length !== 1 ? 's' : ''} edited`);
                  }
                  statsLine = `\n📊 ${parts.join(' • ')}`;
                }
                return `**${s.id}** - ${channelMention}\n\`${s.directory}\`${statsLine}`;
              })
              .join('\n\n')
          )
          .setTimestamp();

        if (orphaned.length > 0) {
          embed.setFooter({ text: `${orphaned.length} session(s) need syncing. Use /claude sync` });
        }

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case 'sync': {
        await interaction.deferReply();

        const result = await syncSessions(interaction.guild!);

        const embed = new EmbedBuilder()
          .setTitle('Session Sync Complete')
          .setColor(0x22c55e)
          .setTimestamp();

        if (result.reconnected.length === 0 && result.orphaned.length === 0) {
          embed.setDescription('No sessions found.');
        } else {
          const parts: string[] = [];
          if (result.reconnected.length > 0) {
            parts.push(`**Reconnected:** ${result.reconnected.length} session(s)`);
          }
          if (result.orphaned.length > 0) {
            parts.push(`**Orphaned (channel deleted):** ${result.orphaned.join(', ')}`);
          }
          embed.setDescription(parts.join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'end': {
        const sessionId = sessionManager.getSessionIdForChannel(interaction.guildId!, interaction.channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply();
        stopOutputPoller(sessionId);
        await sessionManager.killSession(sessionId);
        sessionStats.delete(sessionId);

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Session Ended')
              .setColor(0xef4444)
              .setDescription(
                `Session \`${sessionId}\` has been terminated.\nYou can delete this channel or keep it for reference.`
              )
              .setTimestamp(),
          ],
        });

        botLog('info', `Session **${sessionId}** ended by ${interaction.user.tag}`);
        updateBotStatus();
        break;
      }

      case 'output': {
        const sessionId = sessionManager.getSessionIdForChannel(interaction.guildId!, interaction.channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        const requestedLines = interaction.options.getInteger('lines') || 100;
        const lines = Math.min(requestedLines, 1000); // Cap at 1000 for security
        await interaction.deferReply();

        const output = cleanForDisplay(sessionManager.captureOutput(sessionId, lines));
        const truncated = output.slice(-3900);

        await interaction.editReply({
          content: `\`\`\`ansi\n${truncated}\n\`\`\``,
        });
        break;
      }

      case 'attach': {
        const sessionId = sessionManager.getSessionIdForChannel(interaction.guildId!, interaction.channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          await interaction.reply({
            content: 'Session not found.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Attach to Session')
              .setColor(0x3b82f6)
              .addFields(
                { name: 'Command', value: `\`\`\`\n${session.attachCommand}\n\`\`\``, inline: false },
                { name: 'Directory', value: `\`${session.directory}\``, inline: false }
              )
              .setDescription('Run this command in your terminal to attach directly to the tmux session.'),
          ],
        });
        break;
      }

      case 'stop': {
        const sessionId = sessionManager.getSessionIdForChannel(interaction.guildId!, interaction.channelId);

        if (!sessionId) {
          await interaction.reply({
            content: 'This channel is not linked to a Claude session.',
            ephemeral: true,
          });
          return;
        }

        try {
          await sessionManager.sendEscape(sessionId);
          await interaction.reply({
            content: '⏹️ Sent stop signal (ESC) to Claude.',
            ephemeral: true,
          });
        } catch (error) {
          await interaction.reply({
            content: `Failed to stop: ${(error as Error).message}`,
            ephemeral: true,
          });
        }
        break;
      }
    }
  } catch (error) {
    botLog('error', `Command error: ${(error as Error).message}`);
    const errorMessage = `Error: ${(error as Error).message}`;

    if (interaction.deferred) {
      await interaction.editReply({ content: errorMessage });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

// Handle button clicks (for prompt responses and stop button)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // Check user whitelist
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const [type, sessionId] = interaction.customId.split(':');

  // Verify the session belongs to this channel (prevent cross-channel attacks)
  const expectedSession = sessionManager.getSessionIdForChannel(interaction.guildId!, interaction.channelId);
  if (expectedSession !== sessionId) {
    await interaction.reply({
      content: 'Session mismatch - this button is not valid for this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Handle stop button
  if (type === 'stop') {
    try {
      await sessionManager.sendEscape(sessionId);
      await interaction.reply({
        content: '⏹️ Sent stop signal (ESC) to Claude.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      botLog('error', `Stop button error: ${(error as Error).message}`);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `Failed to stop: ${(error as Error).message}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // Interaction expired or already handled, ignore
      }
    }
    return;
  }
});

// Handle regular messages in session channels
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  // Check user whitelist
  if (!isUserAllowed(message.author.id)) return;

  if (!message.guildId) return;
  const sessionId = sessionManager.getSessionIdForChannel(message.guildId, message.channelId);
  if (!sessionId) return;

  // Session ID is derived from channel ID, so if it exists, tmux session should too
  if (!sessionManager.sessionExists(sessionId)) {
    return;
  }

  // Handle pending scope selection (when --scope not provided)
  const pendingScope = pendingScopeSelects.get(message.channelId);
  if (pendingScope) {
    const content = message.content.trim();
    const scopeMap: Record<string, SkillScope> = { '1': 'channel', '2': 'disco', '3': 'global' };
    const selectedScope = scopeMap[content];

    if (!selectedScope) {
      // Invalid input - cancel
      pendingScopeSelects.delete(message.channelId);
      await message.reply({
        content: '❌ Installation cancelled. (Reply with 1, 2, or 3)',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    pendingScopeSelects.delete(message.channelId);

    // Check for channel scope validity
    if (selectedScope === 'channel') {
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        await message.reply({
          content: '❌ Channel scope not available - this channel is not linked to a session.',
          allowedMentions: { repliedUser: false },
        });
        return;
      }
    }

    // Now check for warnings
    if (pendingScope.warnings.length > 0) {
      // Move to warning confirmation flow
      pendingSkillInstalls.set(message.channelId, {
        skillName: pendingScope.skillName,
        confirmName: pendingScope.confirmName,
        download: pendingScope.download,
        scope: selectedScope,
        warnings: pendingScope.warnings,
        requestTime: new Date(),
        channelId: message.channelId,
      });

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Security Warnings Detected')
        .setColor(0xf59e0b)
        .setDescription(`Skill **${pendingScope.skillName}** has potential security concerns.\n\nReview the warnings below, then type \`${pendingScope.confirmName}\` to install or anything else to cancel.`)
        .addFields(
          { name: 'Scope', value: selectedScope, inline: true },
          { name: 'Warnings', value: pendingScope.warnings.map(w => `• ${w}`).join('\n').slice(0, 1024), inline: false }
        );

      await message.reply({
        embeds: [embed],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    // No warnings - install directly
    try {
      const session = sessionManager.getSession(sessionId);
      let skillsDir: string;
      if (selectedScope === 'channel' && session) {
        skillsDir = getSkillsDirectory('channel', session.directory, config.defaultDirectory);
      } else if (selectedScope === 'disco') {
        skillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
      } else {
        skillsDir = getSkillsDirectory('global', '', '');
      }

      const installedPath = installSkill(pendingScope.skillName, pendingScope.download.content, skillsDir);

      const embed = new EmbedBuilder()
        .setTitle('✅ Skill Installed')
        .setColor(0x22c55e)
        .addFields(
          { name: 'Name', value: pendingScope.skillName, inline: true },
          { name: 'Scope', value: selectedScope, inline: true },
          { name: 'Path', value: `\`${installedPath}\``, inline: false }
        );

      if (pendingScope.download.manifest?.description) {
        embed.setDescription(pendingScope.download.manifest.description);
      }

      await message.reply({
        embeds: [embed],
        allowedMentions: { repliedUser: false },
      });

      botLog('info', `Skill **${pendingScope.skillName}** installed to ${selectedScope} by ${message.author.tag}`);
    } catch (error) {
      await message.reply({
        content: `Failed to install skill: ${(error as Error).message}`,
        allowedMentions: { repliedUser: false },
      });
    }
    return;
  }

  // Handle pending skill install confirmation (from slash commands with warnings)
  const pendingInstall = pendingSkillInstalls.get(message.channelId);
  if (pendingInstall) {
    const content = message.content.trim();

    // User must type the exact confirm name (slug they used) to confirm
    if (content === pendingInstall.confirmName) {
      pendingSkillInstalls.delete(message.channelId);

      try {
        // Get skill directory for scope
        const session = sessionManager.getSession(sessionId);
        let skillsDir: string;
        if (pendingInstall.scope === 'channel' && session) {
          skillsDir = getSkillsDirectory('channel', session.directory, config.defaultDirectory);
        } else if (pendingInstall.scope === 'disco') {
          skillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
        } else {
          skillsDir = getSkillsDirectory('global', '', '');
        }

        const installedPath = installSkill(pendingInstall.skillName, pendingInstall.download.content, skillsDir);

        const embed = new EmbedBuilder()
          .setTitle('✅ Skill Installed')
          .setColor(0x22c55e)
          .addFields(
            { name: 'Name', value: pendingInstall.skillName, inline: true },
            { name: 'Scope', value: pendingInstall.scope, inline: true },
            { name: 'Path', value: `\`${installedPath}\``, inline: false }
          );

        if (pendingInstall.download.manifest?.description) {
          embed.setDescription(pendingInstall.download.manifest.description);
        }

        await message.reply({
          embeds: [embed],
          allowedMentions: { repliedUser: false },
        });

        botLog('info', `Skill **${pendingInstall.skillName}** installed to ${pendingInstall.scope} by ${message.author.tag} (with warnings acknowledged)`);
      } catch (error) {
        await message.reply({
          content: `Failed to install skill: ${(error as Error).message}`,
          allowedMentions: { repliedUser: false },
        });
      }
      return;
    } else {
      // Anything else = cancel
      pendingSkillInstalls.delete(message.channelId);
      await message.reply({
        content: `❌ Installation cancelled. (Expected \`${pendingInstall.confirmName}\`)`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  }

  // Handle skill installation confirmation/cancellation (from Claude agent requests)
  const pendingRequest = pendingSkillRequests.get(message.channelId);
  if (pendingRequest) {
    const content = message.content.toLowerCase().trim();

    if (content === 'confirm') {
      pendingSkillRequests.delete(message.channelId);

      try {
        // Download and install the skill
        let download;
        if (pendingRequest.sourceType === 'clawhub') {
          download = await downloadFromClawHub(pendingRequest.source);
        } else {
          download = await downloadFromGitHub(pendingRequest.source);
        }

        if (!download) {
          await message.reply({
            content: `Could not download skill from "${pendingRequest.source}".`,
            allowedMentions: { repliedUser: false },
          });
          return;
        }

        // Security check - warnings are informational, not blocking
        const securityCheck = checkSkillSecurity(download.content);
        const warnings = securityCheck.warnings;

        // Get skill directory for scope
        const session = sessionManager.getSession(sessionId);
        let skillsDir: string;
        if (pendingRequest.scope === 'channel' && session) {
          skillsDir = getSkillsDirectory('channel', session.directory, config.defaultDirectory);
        } else if (pendingRequest.scope === 'disco') {
          skillsDir = getSkillsDirectory('disco', '', config.defaultDirectory);
        } else {
          skillsDir = getSkillsDirectory('global', '', '');
        }

        const skillName = download.manifest?.name || pendingRequest.source.split('/').pop() || 'unknown';
        const installedPath = installSkill(skillName, download.content, skillsDir);

        const hasWarnings = warnings.length > 0;
        const embed = new EmbedBuilder()
          .setTitle(hasWarnings ? '⚠️ Skill Installed (with warnings)' : '✅ Skill Installed')
          .setColor(hasWarnings ? 0xf59e0b : 0x22c55e)
          .addFields(
            { name: 'Name', value: skillName, inline: true },
            { name: 'Scope', value: pendingRequest.scope, inline: true },
            { name: 'Path', value: `\`${installedPath}\``, inline: false }
          );

        if (hasWarnings) {
          const warningsText = warnings.slice(0, 5).join('\n\n');
          const truncated = warnings.length > 5 ? `\n\n... and ${warnings.length - 5} more` : '';
          embed.addFields({
            name: '⚠️ Security Warnings',
            value: (warningsText + truncated).slice(0, 1024),
            inline: false,
          });
        }

        await message.reply({
          embeds: [embed],
          allowedMentions: { repliedUser: false },
        });

        botLog('info', `Skill **${skillName}** installed to ${pendingRequest.scope} (approved by ${message.author.tag})${hasWarnings ? ' (with warnings)' : ''}`);
      } catch (error) {
        await message.reply({
          content: `Failed to install skill: ${(error as Error).message}`,
          allowedMentions: { repliedUser: false },
        });
      }
      return;
    } else if (content === 'cancel') {
      pendingSkillRequests.delete(message.channelId);
      await message.reply({
        content: '❌ Skill installation cancelled.',
        allowedMentions: { repliedUser: false },
      });
      botLog('info', `Skill request cancelled by ${message.author.tag}`);
      return;
    }
    // If not confirm/cancel, continue with normal message handling
  }

  // Rate limiting check
  const now = Date.now();
  const lastTime = userLastMessage.get(message.author.id) || 0;
  if (now - lastTime < config.rateLimitMs) {
    // Silently ignore rate-limited messages
    return;
  }
  userLastMessage.set(message.author.id, now);

  try {
    // Show typing indicator while Claude processes
    await (message.channel as TextChannel).sendTyping();

    // Build message content
    let textToSend = message.content;

    // Handle image attachments
    const imageAttachments = message.attachments.filter(a =>
      a.contentType?.startsWith('image/')
    );

    if (imageAttachments.size > 0) {
      const session = sessionManager.getSession(sessionId);
      if (session) {
        const imageDir = join(session.directory, '.disco-images');

        // Ensure directory exists
        if (!existsSync(imageDir)) {
          mkdirSync(imageDir, { recursive: true });
        }

        const imagePaths: string[] = [];
        for (const [, attachment] of imageAttachments) {
          const filename = `${Date.now()}-${attachment.name}`;
          const filepath = join(imageDir, filename);
          await downloadAttachment(attachment.url, filepath);
          imagePaths.push(filepath);
        }

        // Append image references to message
        if (imagePaths.length === 1) {
          textToSend = textToSend
            ? `${textToSend}\n\n[Image attached: ${imagePaths[0]}]`
            : `Please analyze this image: ${imagePaths[0]}`;
        } else {
          const imageList = imagePaths.map(p => `- ${p}`).join('\n');
          textToSend = textToSend
            ? `${textToSend}\n\n[Images attached:\n${imageList}]`
            : `Please analyze these images:\n${imageList}`;
        }
      }
    }

    // Skip if nothing to send
    if (!textToSend.trim()) return;

    // Mark that we're starting a new turn - response should be a new message
    markUserInput(sessionId, textToSend);
    await sessionManager.sendToSession(sessionId, textToSend);
  } catch (error) {
    botLog('error', `Failed to send message to session: ${(error as Error).message}`);
    await message.reply({
      content: `Failed to send: ${(error as Error).message}`,
      allowedMentions: { repliedUser: false },
    });
  }
});

// Handle channel deletion
client.on('channelDelete', (channel) => {
  if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel;
    const sessionId = sessionManager.getSessionIdForChannel(textChannel.guildId, textChannel.id);
    if (sessionId) {
      // Get session info before killing (need directory for workspace deletion)
      const session = sessionManager.getSession(sessionId);

      stopOutputPoller(sessionId);
      sessionStats.delete(sessionId);

      if (sessionManager.sessionExists(sessionId)) {
        sessionManager.killSession(sessionId).catch((e) => botLog('error', `Failed to kill session: ${e.message}`));
        botLog('info', `Session **${sessionId}** ended (channel deleted)`);
        updateBotStatus();
      }

      // Delete the channel workspace (directory, CLAUDE.md, skills, images)
      if (session?.directory) {
        const channelName = basename(session.directory);
        const parentDir = dirname(session.directory);
        deleteChannelWorkspace(parentDir, channelName);
        botLog('info', `Deleted workspace for **${channelName}**`);
      }
    }
  }
});

// Clean up old messages in session channels
async function cleanupOldMessages(guild: Guild): Promise<number> {
  if (!config.messageRetentionDays) return 0;

  const cutoffTime = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  // Find the Disco Demon category
  const category = guild.channels.cache.find(
    (c): c is CategoryChannel =>
      c.type === ChannelType.GuildCategory && c.name === config.categoryName
  );

  if (!category) return 0;

  // Get all text channels in the category
  const channels = guild.channels.cache.filter(
    (c): c is TextChannel =>
      c.type === ChannelType.GuildText && c.parentId === category.id
  );

  for (const channel of channels.values()) {
    try {
      // Fetch messages (Discord limits to 100 per request)
      let lastId: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const messages = await channel.messages.fetch({
          limit: 100,
          ...(lastId ? { before: lastId } : {}),
        });

        if (messages.size === 0) {
          hasMore = false;
          break;
        }

        lastId = messages.last()?.id;

        // Filter messages older than retention period
        const oldMessages = messages.filter(
          (m) => m.createdTimestamp < cutoffTime
        );

        // Delete old messages
        for (const msg of oldMessages.values()) {
          try {
            await msg.delete();
            deletedCount++;
            // Small delay to avoid rate limits
            await new Promise((r) => setTimeout(r, 100));
          } catch {
            // Message might already be deleted
          }
        }

        // If all messages in this batch are old, there might be more
        // If some are new, we've reached recent messages
        if (oldMessages.size < messages.size) {
          hasMore = false;
        }
      }
    } catch (error) {
      botLog('error', `Failed to cleanup messages in ${channel.name}: ${(error as Error).message}`);
    }
  }

  return deletedCount;
}

// Ready event - auto sync on startup
client.once('ready', async () => {
  botLog('info', `Logged in as ${client.user!.tag}`);
  botLog('info', 'Bot is ready to manage Claude Code sessions!');

  if (!sessionManager.checkTmux()) {
    botLog('warn', 'tmux is not installed. Please install tmux to use this bot.');
  }

  // Auto-sync sessions on startup
  if (config.guildId) {
    try {
      const guild = await client.guilds.fetch(config.guildId);

      // Find or create #disco-logs channel in the category
      const category = await getOrCreateCategory(guild);
      const existingLogChannel = guild.channels.cache.find(
        (c): c is TextChannel =>
          c.type === ChannelType.GuildText &&
          c.parentId === category.id &&
          c.name === 'disco-logs'
      );

      if (existingLogChannel) {
        logChannel = existingLogChannel;
      } else {
        logChannel = await guild.channels.create({
          name: 'disco-logs',
          type: ChannelType.GuildText,
          parent: category.id,
          topic: 'Bot activity logs and status updates',
        });
        botLog('info', 'Created #disco-logs channel');
      }

      // Set initial bot status
      updateBotStatus();

      // Reconnect existing tmux sessions to their Discord channels
      // With convention naming, channelId is embedded in tmux session name
      const result = await syncSessions(guild);
      if (result.reconnected.length > 0) {
        botLog('info', `Reconnected ${result.reconnected.length} session(s)`);
      }
      if (result.orphaned.length > 0) {
        botLog('warn', `Orphaned sessions (channel deleted): ${result.orphaned.join(', ')}`);
      }

      // Update status after sync (session count may have changed)
      updateBotStatus();

      // Run message cleanup on startup if configured
      if (config.messageRetentionDays) {
        const deleted = await cleanupOldMessages(guild);
        if (deleted > 0) {
          botLog('info', `Message cleanup: deleted ${deleted} old message(s)`);
        }

        // Schedule hourly cleanup
        setInterval(async () => {
          try {
            const count = await cleanupOldMessages(guild);
            if (count > 0) {
              botLog('info', `Scheduled cleanup: deleted ${count} old message(s)`);
            }
          } catch (error) {
            botLog('error', `Scheduled cleanup failed: ${(error as Error).message}`);
          }
        }, 60 * 60 * 1000); // Every hour
      }
    } catch (error) {
      botLog('error', `Failed to auto-sync sessions: ${(error as Error).message}`);
    }
  }

  const sessions = sessionManager.listSessions();
  botLog('info', `Sessions: ${sessions.map((s) => `${s.id}${s.channelId ? '' : ' (orphaned)'}`).join(', ') || 'none'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const [sessionId] of outputStates) {
    stopOutputPoller(sessionId);
  }
  client.destroy();
  process.exit(0);
});

// Start the bot
async function start(): Promise<void> {
  await registerCommands();
  await client.login(config.token);
}

start().catch(console.error);
