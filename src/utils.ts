/**
 * Utility functions for Disclaude
 * Extracted for testability
 */

/**
 * Format uptime as human-readable string
 */
export function formatUptime(startTime: Date): string {
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

/**
 * Format last activity as human-readable relative time
 */
export function formatLastActivity(lastActivity: Date): string {
  const ms = Date.now() - lastActivity.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 10) return `${seconds}s ago`;
  return 'just now';
}

/**
 * Detect file edits in Claude's output by looking for Edit( and Write( tool calls
 */
export function detectFileEdits(text: string): string[] {
  const files: string[] = [];
  const editMatches = text.matchAll(/(?:Edit|Write)\s*\(\s*["']?([^"'\s,)]+)/g);
  for (const match of editMatches) {
    const file = match[1];
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }
  return files;
}

/**
 * Clean text for comparison by stripping ANSI codes and normalizing whitespace
 */
export function cleanForCompare(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Clean text for display (keep ANSI for colors, normalize whitespace)
 */
export function cleanForDisplay(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert ANSI codes to Discord-compatible format
 * Discord only supports: 0 (reset), 1 (bold), 4 (underline), 30-37 (fg), 40-47 (bg)
 */
export function convertAnsiForDiscord(text: string): string {
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
  text = text.replace(/\x1b\[[^m]*[^0-9m][^m]*m/g, '');  // Remove malformed color sequences

  // Remove ALL non-SGR escape sequences (cursor control, erase, scroll, etc.)
  text = text.replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');   // Private mode sequences like [?25h
  text = text.replace(/\x1b\[[0-9;]*[A-LN-Za-ln-z]/g, ''); // Non-m sequences: cursor, erase, etc.
  text = text.replace(/\x1b[78]/g, '');                   // Cursor save/restore: ESC 7, ESC 8
  text = text.replace(/\x1b\([AB0-2]/g, '');             // Character set selection
  text = text.replace(/\x1b[=>]/g, '');                   // Keypad modes
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); // OSC sequences (title, etc.)

  // Clean up any remaining orphaned escape characters
  text = text.replace(/\x1b(?!\[)/g, '');                // Remove lone ESC not followed by [
  text = text.replace(/\x1b\[(?![0-9;]*m)/g, '');        // Remove ESC[ not followed by valid SGR

  // Remove orphaned bracket sequences where \x1b was stripped
  text = text.replace(/(?<!\x1b)\[([0-9;]*)m/g, '');

  // Escape triple backticks to prevent breaking out of Discord code blocks
  text = text.replace(/```/g, '`\u200B``');

  return text;
}

/**
 * Remove the raw prompt input line from output, keep status info
 */
export function stripPromptFooter(text: string): string {
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

    result.push(line);
  }

  // Trim trailing empty lines
  while (result.length > 0 && stripAnsi(result[result.length - 1]).trim() === '') {
    result.pop();
  }

  return result.join('\n').trim();
}

/**
 * Sanitize session name for use in tmux and Discord channel names
 */
export function sanitizeSessionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
}

/**
 * Check if a user is in the allowed users list
 */
export function isUserAllowed(userId: string, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
}

/**
 * Output segment types for parsed Claude output
 */
export interface OutputSegment {
  type: 'text' | 'tool_call' | 'tool_output' | 'prompt' | 'status' | 'discard';
  content: string;
  toolName?: string;
  toolTarget?: string;
}

/**
 * Tool name to emoji mapping
 */
const TOOL_EMOJI: Record<string, string> = {
  'Bash': '⚡',
  'Read': '📖',
  'Edit': '✏️',
  'Write': '📝',
  'Glob': '🔍',
  'Grep': '🔍',
  'Task': '🤖',
  'WebFetch': '🌐',
  'WebSearch': '🔎',
  'AskUserQuestion': '❓',
  'MCP': '📔',
};

/**
 * Strip ANSI codes from text
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Parse raw Claude Code terminal output into structured segments
 * Only parses content AFTER the last user prompt marker
 */
export function parseClaudeOutput(raw: string): OutputSegment[] {
  const segments: OutputSegment[] = [];
  const lines = raw.split('\n');

  // First, find the LAST user prompt line WITH CONTENT to only parse the current response
  // Skip empty prompts like "❯ " which is just the input line
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const clean = stripAnsi(lines[i]).trim();
    // User prompt: ❯ followed by actual text (not just whitespace)
    // Must have more than just "❯ " - need actual user input
    if (clean.startsWith('❯') && clean.replace(/^❯\s*/, '').length > 0) {
      startIdx = i + 1;  // Start parsing AFTER this line
      break;
    }
  }

  let currentSegment: OutputSegment | null = null;
  let inToolOutput = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const clean = stripAnsi(line).trim();

    // Skip empty lines (but we might want to preserve them in text)
    if (!clean) {
      if (currentSegment?.type === 'text') {
        currentSegment.content += '\n';
      }
      continue;
    }

    // Discard: separator lines
    if (/^[─━]{5,}$/.test(clean)) {
      continue;
    }

    // Discard: status bar and terminal UI hints
    if (clean.startsWith('⏵') || clean.includes('bypass permissions') ||
        clean.includes('Context left') || clean.includes('shift+Tab') ||
        clean.includes('ctrl+o') || clean.includes('ctrl+') ||
        clean.includes('to expand') || clean.includes('? for shortcuts')) {
      continue;
    }

    // Discard: any prompt line (❯ with anything)
    if (clean.startsWith('❯')) {
      continue;
    }

    // Tool output lines (⎿ prefix) - always skip these
    if (clean.startsWith('⎿')) {
      inToolOutput = true;
      continue;
    }

    // │ can be tool output OR ASCII table borders in text
    // Only skip if we're already in tool output mode, otherwise keep for tables
    if ((clean.startsWith('│') || clean.startsWith('|')) && inToolOutput) {
      continue;
    }

    // Skip raw JSON lines (from MCP responses)
    if (/^[\[{"]/.test(clean) || /^"[\w]+":/.test(clean) || clean === '}' || clean === ']' || clean.startsWith('…')) {
      continue;
    }

    // Web Search: "● Web Search("query")"
    const webSearchMatch = clean.match(/^●?\s*Web Search\s*\(["']?(.+?)["']?\)/i);
    if (webSearchMatch) {
      // Save previous segment
      if (currentSegment) {
        segments.push(currentSegment);
      }
      let query = webSearchMatch[1].replace(/\)$/, '').replace(/["']/g, '').trim();
      if (query.length > 50) {
        query = query.slice(0, 47) + '...';
      }
      currentSegment = {
        type: 'tool_call',
        content: clean,
        toolName: 'WebSearch',
        toolTarget: query,
      };
      inToolOutput = true;
      continue;
    }

    // MCP tools: "● provider - method (MCP)(params)" or "● provider - method (MCP)"
    const mcpMatch = clean.match(/^●?\s*(\w+)\s*-\s*([\w_]+)\s*\(MCP\)/i);
    if (mcpMatch) {
      // Save previous segment
      if (currentSegment) {
        segments.push(currentSegment);
      }
      const provider = mcpMatch[1];  // e.g., "obsidian"
      const method = mcpMatch[2];    // e.g., "search_notes"
      currentSegment = {
        type: 'tool_call',
        content: clean,
        toolName: 'MCP',
        toolTarget: `${provider}: ${method.replace(/_/g, ' ')}`,  // "obsidian: search notes"
      };
      inToolOutput = true;
      continue;
    }

    // Tool summary line: "Read 1 file", "Searched for 1 pattern", "Bash: /usr/bin/ls"
    // These are the collapsed tool indicators Claude Code shows
    const toolSummaryMatch = clean.match(/^●?\s*(Read|Edit|Write|Bash|Glob|Grep|Task|Searched)\s*[:(]?\s*(.*)$/i);
    if (toolSummaryMatch) {
      // Save previous segment
      if (currentSegment) {
        segments.push(currentSegment);
      }

      let toolName = toolSummaryMatch[1];
      let toolTarget = toolSummaryMatch[2];

      // Normalize tool name
      if (toolName.toLowerCase() === 'searched') toolName = 'Grep';

      // Clean up target - remove terminal hints
      toolTarget = toolTarget
        .replace(/\(ctrl\+[a-z] to expand\)/gi, '')
        .replace(/\(.*to expand.*\)/gi, '')
        .replace(/^\d+\s*(files?|patterns?)\s*/i, '')  // "1 file" -> ""
        .replace(/["']/g, '')
        .trim();

      if (toolTarget.length > 50) {
        toolTarget = toolTarget.slice(0, 47) + '...';
      }

      currentSegment = {
        type: 'tool_call',
        content: clean,
        toolName,
        toolTarget: toolTarget || undefined,
      };
      inToolOutput = true;
      continue;
    }

    // Tool call line with parentheses: ● ToolName(...)
    const toolCallMatch = clean.match(/^●?\s*(Bash|Read|Edit|Write|Glob|Grep|Task|WebFetch|WebSearch|AskUserQuestion)\s*\((.*)$/);
    if (toolCallMatch) {
      // Save previous segment
      if (currentSegment) {
        segments.push(currentSegment);
      }

      const toolName = toolCallMatch[1];
      let toolTarget = toolCallMatch[2];

      // Clean up the target
      toolTarget = toolTarget.replace(/\)$/, '').replace(/["']/g, '').trim();
      if (toolTarget.length > 50) {
        toolTarget = toolTarget.slice(0, 47) + '...';
      }

      currentSegment = {
        type: 'tool_call',
        content: clean,
        toolName,
        toolTarget,
      };
      inToolOutput = true;
      continue;
    }

    // Text response: ● followed by text (not a tool)
    if (clean.startsWith('●')) {
      // Save previous segment
      if (currentSegment) {
        segments.push(currentSegment);
      }

      const textContent = clean.replace(/^●\s*/, '');
      currentSegment = {
        type: 'text',
        content: textContent,
      };
      inToolOutput = false;
      continue;
    }

    // Continuation of text segment (no ● prefix, not in tool output)
    if (currentSegment?.type === 'text' && !inToolOutput) {
      currentSegment.content += '\n' + clean;
    }
  }

  // Don't forget the last segment
  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

/**
 * Format parsed segments for Discord output
 */
export function formatForDiscord(segments: OutputSegment[]): string {
  const parts: string[] = [];
  const toolCalls: OutputSegment[] = [];

  for (const segment of segments) {
    if (segment.type === 'text') {
      // Flush any accumulated tool calls first
      if (toolCalls.length > 0) {
        parts.push(formatToolCallSummary(toolCalls));
        toolCalls.length = 0;
      }
      // Add the text content
      parts.push(segment.content.trim());
    } else if (segment.type === 'tool_call') {
      toolCalls.push(segment);
    }
    // Discard tool_output, prompt, status, discard types
  }

  // Flush remaining tool calls
  if (toolCalls.length > 0) {
    parts.push(formatToolCallSummary(toolCalls));
  }

  return parts.join('\n\n').trim();
}

/**
 * Format a group of tool calls as a collapsed summary
 */
function formatToolCallSummary(calls: OutputSegment[]): string {
  if (calls.length === 0) return '';

  // Group by tool type
  const grouped: Record<string, OutputSegment[]> = {};
  for (const call of calls) {
    const name = call.toolName || 'Unknown';
    if (!grouped[name]) grouped[name] = [];
    grouped[name].push(call);
  }

  const summaries: string[] = [];

  for (const [toolName, toolCalls] of Object.entries(grouped)) {
    const emoji = TOOL_EMOJI[toolName] || '🔧';

    // Friendly names for display
    const displayName: Record<string, string> = {
      'Bash': 'Ran command',
      'Read': 'Read file',
      'Edit': 'Edited',
      'Write': 'Created',
      'Glob': 'Searched',
      'Grep': 'Searched',
      'Task': 'Spawned agent',
      'WebSearch': 'Searched',
      'WebFetch': 'Fetched',
      'MCP': 'MCP',
    };
    const friendly = displayName[toolName] || toolName;

    if (toolCalls.length === 1) {
      // Single call - show target if available
      const target = toolCalls[0].toolTarget;
      if (target) {
        summaries.push(`${emoji} ${friendly}: \`${target}\``);
      } else {
        summaries.push(`${emoji} ${friendly}`);
      }
    } else if (toolCalls.length <= 3) {
      // 2-3 calls - list them
      const targets = toolCalls
        .map(c => c.toolTarget)
        .filter(Boolean)
        .map(t => `\`${t}\``)
        .join(', ');
      if (targets) {
        summaries.push(`${emoji} ${friendly}: ${targets}`);
      } else {
        summaries.push(`${emoji} ${friendly} ×${toolCalls.length}`);
      }
    } else {
      // Many calls - just count
      summaries.push(`${emoji} ${friendly} ×${toolCalls.length}`);
    }
  }

  return summaries.join('\n');
}
