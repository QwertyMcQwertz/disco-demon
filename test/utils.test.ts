import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatUptime,
  formatLastActivity,
  detectFileEdits,
  cleanForCompare,
  cleanForDisplay,
  convertAnsiForDiscord,
  stripPromptFooter,
  sanitizeSessionName,
  isUserAllowed,
} from '../src/utils.js';

describe('formatUptime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should format seconds', () => {
    const startTime = new Date('2024-01-15T11:59:30Z'); // 30 seconds ago
    expect(formatUptime(startTime)).toBe('30s');
  });

  it('should format minutes', () => {
    const startTime = new Date('2024-01-15T11:45:00Z'); // 15 minutes ago
    expect(formatUptime(startTime)).toBe('15m');
  });

  it('should format hours and minutes', () => {
    const startTime = new Date('2024-01-15T09:30:00Z'); // 2h 30m ago
    expect(formatUptime(startTime)).toBe('2h 30m');
  });

  it('should format days and hours', () => {
    const startTime = new Date('2024-01-13T06:00:00Z'); // 2d 6h ago
    expect(formatUptime(startTime)).toBe('2d 6h');
  });
});

describe('formatLastActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "just now" for recent activity', () => {
    const lastActivity = new Date('2024-01-15T11:59:55Z'); // 5 seconds ago
    expect(formatLastActivity(lastActivity)).toBe('just now');
  });

  it('should format seconds ago', () => {
    const lastActivity = new Date('2024-01-15T11:59:30Z'); // 30 seconds ago
    expect(formatLastActivity(lastActivity)).toBe('30s ago');
  });

  it('should format minutes ago', () => {
    const lastActivity = new Date('2024-01-15T11:45:00Z'); // 15 minutes ago
    expect(formatLastActivity(lastActivity)).toBe('15m ago');
  });

  it('should format hours ago', () => {
    const lastActivity = new Date('2024-01-15T09:00:00Z'); // 3 hours ago
    expect(formatLastActivity(lastActivity)).toBe('3h ago');
  });
});

describe('detectFileEdits', () => {
  it('should detect Edit tool calls', () => {
    const text = 'Edit("src/index.ts", "old", "new")';
    expect(detectFileEdits(text)).toEqual(['src/index.ts']);
  });

  it('should detect Write tool calls', () => {
    const text = 'Write("src/new-file.ts", "content")';
    expect(detectFileEdits(text)).toEqual(['src/new-file.ts']);
  });

  it('should detect multiple file edits', () => {
    const text = `
      Edit("src/index.ts", "old", "new")
      Write("src/config.ts", "content")
      Edit("src/utils.ts", "foo", "bar")
    `;
    expect(detectFileEdits(text)).toEqual(['src/index.ts', 'src/config.ts', 'src/utils.ts']);
  });

  it('should deduplicate file paths', () => {
    const text = `
      Edit("src/index.ts", "a", "b")
      Edit("src/index.ts", "c", "d")
    `;
    expect(detectFileEdits(text)).toEqual(['src/index.ts']);
  });

  it('should return empty array for no edits', () => {
    const text = 'Just some text without any tool calls';
    expect(detectFileEdits(text)).toEqual([]);
  });

  it('should handle single quotes', () => {
    const text = "Edit('src/file.ts', 'old', 'new')";
    expect(detectFileEdits(text)).toEqual(['src/file.ts']);
  });
});

describe('cleanForCompare', () => {
  it('should strip ANSI codes', () => {
    const text = '\x1b[32mGreen text\x1b[0m';
    expect(cleanForCompare(text)).toBe('Green text');
  });

  it('should remove carriage returns', () => {
    const text = 'Line 1\r\nLine 2';
    expect(cleanForCompare(text)).toBe('Line 1\nLine 2');
  });

  it('should collapse multiple newlines', () => {
    const text = 'Line 1\n\n\n\nLine 2';
    expect(cleanForCompare(text)).toBe('Line 1\n\nLine 2');
  });

  it('should trim whitespace', () => {
    const text = '  content  ';
    expect(cleanForCompare(text)).toBe('content');
  });
});

describe('cleanForDisplay', () => {
  it('should keep ANSI codes', () => {
    const text = '\x1b[32mGreen text\x1b[0m';
    expect(cleanForDisplay(text)).toBe('\x1b[32mGreen text\x1b[0m');
  });

  it('should remove carriage returns', () => {
    const text = 'Line 1\r\nLine 2';
    expect(cleanForDisplay(text)).toBe('Line 1\nLine 2');
  });

  it('should collapse multiple newlines', () => {
    const text = 'Line 1\n\n\n\nLine 2';
    expect(cleanForDisplay(text)).toBe('Line 1\n\nLine 2');
  });
});

describe('convertAnsiForDiscord', () => {
  it('should keep basic foreground colors', () => {
    const text = '\x1b[31mRed\x1b[0m';
    expect(convertAnsiForDiscord(text)).toBe('\x1b[31mRed\x1b[0m');
  });

  it('should keep basic background colors', () => {
    const text = '\x1b[41mRed BG\x1b[0m';
    expect(convertAnsiForDiscord(text)).toBe('\x1b[41mRed BG\x1b[0m');
  });

  it('should keep bold and underline', () => {
    const text = '\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m';
    expect(convertAnsiForDiscord(text)).toBe('\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m');
  });

  it('should convert 256-color to basic', () => {
    const text = '\x1b[38;5;196mRed 256\x1b[0m'; // 196 is red in 256-color
    const result = convertAnsiForDiscord(text);
    expect(result).toMatch(/\x1b\[3[0-7]mRed 256\x1b\[0m/);
  });

  it('should convert RGB to basic', () => {
    const text = '\x1b[38;2;255;0;0mRed RGB\x1b[0m';
    const result = convertAnsiForDiscord(text);
    expect(result).toMatch(/\x1b\[3[0-7]mRed RGB\x1b\[0m/);
  });

  it('should convert bright colors to normal', () => {
    const text = '\x1b[91mBright Red\x1b[0m'; // 91 is bright red
    expect(convertAnsiForDiscord(text)).toBe('\x1b[31mBright Red\x1b[0m');
  });

  it('should remove cursor control sequences', () => {
    const text = '\x1b[?25h\x1b[2JVisible content';
    expect(convertAnsiForDiscord(text)).toBe('Visible content');
  });

  it('should remove OSC sequences', () => {
    const text = '\x1b]0;Window Title\x07Content';
    expect(convertAnsiForDiscord(text)).toBe('Content');
  });

  it('should escape triple backticks', () => {
    const text = '```code```';
    const result = convertAnsiForDiscord(text);
    expect(result).not.toContain('```');
    expect(result).toContain('`\u200B``');
  });
});

describe('stripPromptFooter', () => {
  it('should remove separator lines', () => {
    const text = 'Content\n────────────────────\n> ';
    expect(stripPromptFooter(text)).toBe('Content');
  });

  it('should remove empty prompt line', () => {
    const text = 'Content\n> ';
    expect(stripPromptFooter(text)).toBe('Content');
  });

  it('should remove shortcuts hint', () => {
    const text = 'Content\n? for shortcuts';
    expect(stripPromptFooter(text)).toBe('Content');
  });

  it('should keep content with ANSI codes', () => {
    const text = '\x1b[32mGreen content\x1b[0m\n> ';
    expect(stripPromptFooter(text)).toBe('\x1b[32mGreen content\x1b[0m');
  });

  it('should trim trailing empty lines', () => {
    const text = 'Content\n\n\n';
    expect(stripPromptFooter(text)).toBe('Content');
  });
});

describe('sanitizeSessionName', () => {
  it('should lowercase the name', () => {
    expect(sanitizeSessionName('MyProject')).toBe('myproject');
  });

  it('should replace invalid characters with hyphens', () => {
    expect(sanitizeSessionName('my_project/test')).toBe('my-project-test');
  });

  it('should allow hyphens', () => {
    expect(sanitizeSessionName('my-project')).toBe('my-project');
  });

  it('should allow numbers', () => {
    expect(sanitizeSessionName('project123')).toBe('project123');
  });

  it('should truncate to 50 characters', () => {
    const longName = 'a'.repeat(60);
    expect(sanitizeSessionName(longName)).toHaveLength(50);
  });

  it('should handle special characters', () => {
    expect(sanitizeSessionName('hello@world!')).toBe('hello-world-');
  });
});

describe('isUserAllowed', () => {
  it('should return true when allowedUsers is empty', () => {
    expect(isUserAllowed('123456', [])).toBe(true);
  });

  it('should return true when user is in list', () => {
    expect(isUserAllowed('123456', ['123456', '789012'])).toBe(true);
  });

  it('should return false when user is not in list', () => {
    expect(isUserAllowed('999999', ['123456', '789012'])).toBe(false);
  });

  it('should handle single user in list', () => {
    expect(isUserAllowed('123456', ['123456'])).toBe(true);
    expect(isUserAllowed('999999', ['123456'])).toBe(false);
  });
});
