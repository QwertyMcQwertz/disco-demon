import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';

// Mock child_process and fs before importing sessionManager
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '# Mock template'),
}));

// Import after mocking
const { sessionManager, setAllowedPaths } = await import('../src/sessionManager.js');

describe('SessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkTmux', () => {
    it('should return true when tmux is installed', () => {
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from('/usr/bin/tmux'));
      expect(sessionManager.checkTmux()).toBe(true);
    });

    it('should return false when tmux is not installed', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('command not found');
      });
      expect(sessionManager.checkTmux()).toBe(false);
    });
  });

  describe('getTmuxName', () => {
    it('should prefix session ID with "disco_"', () => {
      expect(sessionManager.getTmuxName('guild123_channel456')).toBe('disco_guild123_channel456');
    });
  });

  describe('getSessionIdFromTmuxName', () => {
    it('should extract session ID from tmux name', () => {
      expect(sessionManager.getSessionIdFromTmuxName('disco_guild123_channel456')).toBe('guild123_channel456');
    });

    it('should return null for non-disco sessions', () => {
      expect(sessionManager.getSessionIdFromTmuxName('other-session')).toBeNull();
    });
  });

  describe('sessionExists', () => {
    it('should return true when session exists', () => {
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''));
      expect(sessionManager.sessionExists('guild_channel')).toBe(true);
    });

    it('should return false when session does not exist', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('session not found');
      });
      expect(sessionManager.sessionExists('nonexistent')).toBe(false);
    });
  });

  describe('sessionExistsForChannel', () => {
    it('should check session exists for guild/channel combo', () => {
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''));
      expect(sessionManager.sessionExistsForChannel('guild123', 'channel456')).toBe(true);
    });
  });

  describe('getSessionIdForChannel', () => {
    it('should return session ID when session exists', () => {
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''));
      expect(sessionManager.getSessionIdForChannel('guild123', 'channel456')).toBe('guild123_channel456');
    });

    it('should return null when session does not exist', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('no session');
      });
      expect(sessionManager.getSessionIdForChannel('guild123', 'channel456')).toBeNull();
    });
  });

  describe('createSession', () => {
    it('should create a new tmux session with convention naming', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('no session'); }); // sessionExists check
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any); // tmux new-session

      const result = await sessionManager.createSession('guild123', 'channel456', 'test-channel', '/tmp');

      // New naming: disco_{last4OfGuildId}_{sanitizedChannelName}
      expect(result).toMatchObject({
        id: 'guild123_channel456',
        tmuxName: 'disco_d123_test-channel',
        directory: '/tmp/test-channel',
        guildId: 'guild123',
        channelId: 'channel456',
        attachCommand: 'tmux attach -t disco_d123_test-channel',
      });
    });

    it('should create directory if it does not exist', async () => {
      // existsSync returns false for initial checks, directories get created
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); }); // sessionExists check
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any); // tmux new-session

      const result = await sessionManager.createSession('guild', 'channel', 'test-channel', '/nonexistent');

      // Directories are created automatically now
      expect(result.directory).toBe('/nonexistent/test-channel');
    });

    it('should throw if session already exists', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockReturnValueOnce(Buffer.from('')); // sessionExists returns true

      await expect(
        sessionManager.createSession('guild', 'channel', 'test-channel', '/tmp')
      ).rejects.toThrow('already exists');
    });

    it('should expand ~ to home directory', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('no session'); }); // sessionExists check
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any); // tmux new-session

      const result = await sessionManager.createSession('guild', 'channel', 'test-channel', '~/projects');

      expect(result.directory).not.toContain('~');
      expect(result.directory).toMatch(/^\/.*projects\/test-channel$/);
    });
  });

  describe('listSessions', () => {
    it('should parse tmux list-sessions output with convention naming', () => {
      const mockOutput = 'disco_guild1_chan1|1700000000|/home/user/project1\ndisco_guild2_chan2|1700000001|/home/user/project2';
      vi.mocked(execSync).mockReturnValueOnce(mockOutput as unknown as Buffer);

      const sessions = sessionManager.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        id: 'guild1_chan1',
        tmuxName: 'disco_guild1_chan1',
        directory: '/home/user/project1',
        guildId: 'guild1',
        channelId: 'chan1',
      });
      expect(sessions[1]).toMatchObject({
        id: 'guild2_chan2',
        tmuxName: 'disco_guild2_chan2',
        directory: '/home/user/project2',
        guildId: 'guild2',
        channelId: 'chan2',
      });
    });

    it('should filter out non-disco sessions', () => {
      const mockOutput = 'disco_guild_channel|1700000000|/tmp\nother-session|1700000001|/home';
      vi.mocked(execSync).mockReturnValueOnce(mockOutput as unknown as Buffer);

      const sessions = sessionManager.listSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('guild_channel');
    });

    it('should return empty array on error', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('tmux error');
      });

      expect(sessionManager.listSessions()).toEqual([]);
    });
  });

  describe('sendToSession', () => {
    it('should send keys to tmux session with delay before Enter', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(Buffer.from('')) // send-keys -l
        .mockReturnValueOnce(Buffer.from('')); // send-keys Enter

      await sessionManager.sendToSession('guild_channel', 'hello world');

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('send-keys'),
        expect.any(Object)
      );
    });

    it('should throw if session does not exist', async () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('no session');
      });

      await expect(
        sessionManager.sendToSession('nonexistent', 'hello')
      ).rejects.toThrow('does not exist');
    });

    it('should escape single quotes in text', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from(''))
        .mockReturnValueOnce(Buffer.from(''))
        .mockReturnValueOnce(Buffer.from(''));

      await sessionManager.sendToSession('test', "it's a test");

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("'\\''"),
        expect.any(Object)
      );
    });
  });

  describe('captureOutput', () => {
    it('should capture pane output with ANSI codes', () => {
      const mockOutput = '\x1b[32mGreen text\x1b[0m\nMore content';
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(mockOutput as unknown as Buffer); // capture-pane

      const output = sessionManager.captureOutput('test', 100);

      expect(output).toBe(mockOutput);
    });

    it('should throw if session does not exist', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('no session');
      });

      expect(() => sessionManager.captureOutput('nonexistent')).toThrow('does not exist');
    });
  });

  describe('sendEscape', () => {
    it('should send Escape key to session', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(Buffer.from('')); // send-keys Escape

      const result = await sessionManager.sendEscape('test');

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('Escape'),
        expect.any(Object)
      );
    });
  });

  describe('killSession', () => {
    it('should kill tmux session', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(Buffer.from('')); // kill-session

      const result = await sessionManager.killSession('guild_channel');

      expect(result).toBe(true);
    });

    it('should throw if session does not exist', async () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('no session');
      });

      await expect(sessionManager.killSession('nonexistent')).rejects.toThrow('does not exist');
    });
  });

  describe('getSession', () => {
    it('should return session info with parsed guildId/channelId', () => {
      const mockOutput = 'disco_guild123_channel456|1700000000|/home/user/project';
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(mockOutput as unknown as Buffer); // list-sessions

      const session = sessionManager.getSession('guild123_channel456');

      expect(session).toMatchObject({
        id: 'guild123_channel456',
        tmuxName: 'disco_guild123_channel456',
        directory: '/home/user/project',
        guildId: 'guild123',
        channelId: 'channel456',
      });
    });

    it('should return null if session does not exist', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('no session');
      });

      expect(sessionManager.getSession('nonexistent')).toBeNull();
    });
  });

  describe('getSessionForChannel', () => {
    it('should get session info by guildId and channelId', () => {
      const mockOutput = 'disco_guild_channel|1700000000|/tmp';
      vi.mocked(execSync)
        .mockReturnValueOnce(Buffer.from('')) // sessionExists
        .mockReturnValueOnce(mockOutput as unknown as Buffer); // list-sessions

      const session = sessionManager.getSessionForChannel('guild', 'channel');

      expect(session).toMatchObject({
        guildId: 'guild',
        channelId: 'channel',
      });
    });
  });

  // Security tests
  describe('Security: Path Restrictions', () => {
    afterEach(() => {
      setAllowedPaths([]);
    });

    it('should allow any path when no restrictions set', async () => {
      setAllowedPaths([]);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);

      const result = await sessionManager.createSession('guild', 'channel', 'test-channel', '/any/path');
      expect(result.directory).toBe('/any/path/test-channel');
    });

    it('should reject paths outside allowed directories', async () => {
      setAllowedPaths(['/home/user/projects']);
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(
        sessionManager.createSession('guild', 'channel', 'test-channel', '/etc/passwd')
      ).rejects.toThrow('Directory not in allowed paths');
    });

    it('should allow paths inside allowed directories', async () => {
      setAllowedPaths(['/home/user/projects']);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);

      const result = await sessionManager.createSession('guild', 'channel', 'test-channel', '/home/user/projects/myapp');
      expect(result.directory).toBe('/home/user/projects/myapp/test-channel');
    });

    it('should allow exact match of allowed directory', async () => {
      setAllowedPaths(['/home/user/projects']);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);

      const result = await sessionManager.createSession('guild', 'channel', 'test-channel', '/home/user/projects');
      expect(result.directory).toBe('/home/user/projects/test-channel');
    });

    it('should reject path that starts with allowed path but is not a subdirectory', async () => {
      setAllowedPaths(['/home/user/projects']);
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(
        sessionManager.createSession('guild', 'channel', 'test-channel', '/home/user/projects-evil')
      ).rejects.toThrow('Directory not in allowed paths');
    });

    it('should support multiple allowed paths', async () => {
      setAllowedPaths(['/home/user/projects', '/var/www']);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementation(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

      const result1 = await sessionManager.createSession('guild1', 'chan1', 'app1', '/home/user/projects/app1');
      expect(result1.directory).toBe('/home/user/projects/app1/app1');

      const result2 = await sessionManager.createSession('guild2', 'chan2', 'site', '/var/www/site');
      expect(result2.directory).toBe('/var/www/site/site');
    });
  });

  describe('Security: Command Injection Prevention', () => {
    it('should use spawnSync with argument array (not string interpolation)', async () => {
      setAllowedPaths([]);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);

      await sessionManager.createSession('guild', 'channel', 'test-channel', '/tmp/test');

      // Verify spawnSync was called with separate arguments (safe)
      // Directory should be the channel subdirectory
      // New naming: disco_{last4OfGuildId}_{sanitizedChannelName}
      expect(spawnSync).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining([
          'new-session', '-d',
          '-x', '200', '-y', '50',
          '-s', 'disco_uild_test-channel',
          '-c', '/tmp/test/test-channel',
          'claude', '--dangerously-skip-permissions'
        ]),
        expect.any(Object)
      );
    });

    it('should not allow shell metacharacters to escape via directory path', async () => {
      setAllowedPaths(['/tmp']);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('no session'); });
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as any);

      const maliciousPath = '/tmp/$(whoami)';
      await sessionManager.createSession('guild', 'channel', 'test-channel', maliciousPath);

      // With spawnSync argument array, the path is passed as a single argument
      // Directory will be the channel subdirectory under the malicious path
      expect(spawnSync).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['-c', `${maliciousPath}/test-channel`]),
        expect.any(Object)
      );
    });
  });
});
