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
import { join } from 'path';
import sessionManager, { setAllowedPaths, ensureSessionWorkspace, PersistedSession } from './sessionManager.js';
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
ensureSessionWorkspace(config.defaultDirectory);

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
    .setName('claude')
    .setDescription('Manage Claude Code sessions')
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

// Find or create the Claude Sessions category
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

// Sync orphaned sessions to channels
async function syncSessions(guild: Guild): Promise<{ linked: string[]; created: string[] }> {
  const sessions = sessionManager.listSessions();
  const linked: string[] = [];
  const created: string[] = [];

  for (const session of sessions) {
    // Skip if already linked
    if (session.channelId) {
      // Verify channel still exists
      try {
        const channel = await guild.channels.fetch(session.channelId);
        if (channel) {
          // Re-link and start poller
          sessionManager.linkChannel(session.id, session.channelId);
          if (!outputStates.has(session.id)) {
            startOutputPoller(session.id, channel as TextChannel);
          }
          continue;
        }
      } catch {
        // Channel doesn't exist, need to re-link
      }
    }

    // Look for matching channel by name
    const expectedChannelName = `claude-${session.id}`;
    const existingChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === expectedChannelName
    ) as TextChannel | undefined;

    if (existingChannel) {
      // Link to existing channel
      sessionManager.linkChannel(session.id, existingChannel.id);
      startOutputPoller(session.id, existingChannel);
      linked.push(session.id);

      // Send reconnection message
      await existingChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Session Reconnected')
            .setColor(0x22c55e)
            .setDescription('Bot restarted - session has been reconnected to this channel.')
            .setTimestamp(),
        ],
      });
    } else {
      // Create new channel for orphaned session
      const category = await getOrCreateCategory(guild);
      const newChannel = await guild.channels.create({
        name: expectedChannelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Claude Code session | Directory: ${session.directory} | Attach: ${session.attachCommand}`,
      });

      sessionManager.linkChannel(session.id, newChannel.id);
      startOutputPoller(session.id, newChannel);
      created.push(session.id);

      // Send welcome message
      await newChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Orphaned Session Adopted')
            .setColor(0x7c3aed)
            .addFields(
              { name: 'Directory', value: `\`${session.directory}\``, inline: false },
              { name: 'Attach via Terminal', value: `\`${session.attachCommand}\``, inline: false }
            )
            .setDescription('Found an existing tmux session and created this channel for it.\nJust type to talk to Claude.')
            .setTimestamp(),
        ],
      });
    }
  }

  return { linked, created };
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
              if ('customId' in component && component.customId && !component.customId.startsWith('stop_')) {
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
            // Log file edit to bot-logs
            const fileName = file.split('/').pop() || file;
            botLog('info', `📝 **${sessionId}**: Edited \`${fileName}\``);
          }
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
        .setCustomId(`stop_${sessionId}`)
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

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'claude') return;

  // Check user whitelist
  if (!isUserAllowed(interaction.user.id)) {
    await interaction.reply({ content: 'Unauthorized', ephemeral: true });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'new': {
        const name = interaction.options.getString('name', true);
        const directory = interaction.options.getString('directory') || config.defaultDirectory;

        await interaction.deferReply();

        const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
        const category = await getOrCreateCategory(interaction.guild!);

        const channel = await interaction.guild!.channels.create({
          name: `claude-${cleanName}`,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `Claude Code session | Directory: ${directory} | Attach: tmux attach -t claude-${cleanName}`,
        });

        const session = await sessionManager.createSession(cleanName, directory, channel.id);
        startOutputPoller(cleanName, channel);

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

        botLog('info', `Session **${cleanName}** created by ${interaction.user.tag}`);
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
          .setTitle('Active Claude Sessions')
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

        if (result.linked.length === 0 && result.created.length === 0) {
          embed.setDescription('All sessions are already synced.');
        } else {
          const parts: string[] = [];
          if (result.linked.length > 0) {
            parts.push(`**Re-linked:** ${result.linked.join(', ')}`);
          }
          if (result.created.length > 0) {
            parts.push(`**Created channels:** ${result.created.join(', ')}`);
          }
          embed.setDescription(parts.join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'end': {
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

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
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

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
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

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
        const channelId = interaction.channelId;
        const sessionId = sessionManager.getSessionByChannel(channelId);

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

  const [type, sessionId, choice] = interaction.customId.split('_');

  // Verify the session belongs to this channel (prevent cross-channel attacks)
  const expectedSession = sessionManager.getSessionByChannel(interaction.channelId);
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

  const sessionId = sessionManager.getSessionByChannel(message.channelId);
  if (!sessionId) return;

  if (!sessionManager.sessionExists(sessionId)) {
    sessionManager.unlinkChannel(message.channelId);
    return;
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
        const imageDir = join(session.directory, '.disclaude-images');

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
    const sessionId = sessionManager.getSessionByChannel(channel.id);
    if (sessionId) {
      stopOutputPoller(sessionId);
      sessionManager.unlinkChannel(channel.id);
      sessionStats.delete(sessionId);
      if (sessionManager.sessionExists(sessionId)) {
        sessionManager.killSession(sessionId).catch((e) => botLog('error', `Failed to kill session: ${e.message}`));
        botLog('info', `Session **${sessionId}** ended (channel deleted)`);
        updateBotStatus();
      }
    }
  }
});

// Clean up old messages in session channels
async function cleanupOldMessages(guild: Guild): Promise<number> {
  if (!config.messageRetentionDays) return 0;

  const cutoffTime = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  // Find the Claude Sessions category
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

      // Find or create #bot-logs channel in the category
      const category = await getOrCreateCategory(guild);
      const existingLogChannel = guild.channels.cache.find(
        (c): c is TextChannel =>
          c.type === ChannelType.GuildText &&
          c.parentId === category.id &&
          c.name === 'bot-logs'
      );

      if (existingLogChannel) {
        logChannel = existingLogChannel;
      } else {
        logChannel = await guild.channels.create({
          name: 'bot-logs',
          type: ChannelType.GuildText,
          parent: category.id,
          topic: 'Bot activity logs and status updates',
        });
        botLog('info', 'Created #bot-logs channel');
      }

      // Set initial bot status
      updateBotStatus();

      // Restore persisted sessions first (before auto-sync)
      const restored = sessionManager.restoreSessions();
      for (const session of restored) {
        // Verify Discord channel still exists
        const channel = await client.channels.fetch(session.channelId).catch(() => null);
        if (channel && channel.type === ChannelType.GuildText) {
          startOutputPoller(session.id, channel as TextChannel);
          botLog('info', `Restored session: ${session.id} -> <#${session.channelId}>`);
        }
      }
      if (restored.length > 0) {
        botLog('info', `Restored ${restored.length} persisted session(s)`);
      }

      const result = await syncSessions(guild);
      botLog('info', `Auto-sync: linked ${result.linked.length}, created ${result.created.length} channels`);

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
