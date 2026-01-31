import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import AdmZip from 'adm-zip';

// Types
export type SkillScope = 'channel' | 'disco' | 'global';

export interface SkillManifest {
  name: string;
  description: string;
}

export interface SecurityCheckResult {
  safe: boolean;
  errors: string[];
  warnings: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface ClawHubSearchResult {
  slug: string;
  name: string;
  description: string;
}

export interface DownloadResult {
  content: string;
  manifest: SkillManifest | null;
}

// ClawHub API base URL (www subdomain avoids redirect)
const CLAWHUB_API = 'https://www.clawhub.ai/api/v1';

// Dangerous patterns to detect (Layer 1: Pattern Matching)
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Shell execution risks
  { pattern: /curl\s+[^|]*\|.*sh/gi, reason: 'Pipe curl to shell execution' },
  { pattern: /wget\s+[^|]*\|.*sh/gi, reason: 'Pipe wget to shell execution' },
  { pattern: /\$\(curl/gi, reason: 'Command substitution with curl' },
  { pattern: /eval\s*\(/gi, reason: 'Dynamic code execution' },
  { pattern: /base64\s*-d/gi, reason: 'Base64 decoding (potential obfuscation)' },

  // Instruction override attempts
  { pattern: /ignore\s+(all\s+)?previous\s+instructions?/gi, reason: 'Instruction override attempt' },
  { pattern: /disregard\s+(all\s+)?above/gi, reason: 'Instruction override attempt' },
  { pattern: /new\s+instructions?\s*:/gi, reason: 'Instruction injection attempt' },
  { pattern: /you\s+are\s+now\s+(in\s+)?developer\s+mode/gi, reason: 'Mode override attempt' },
  { pattern: /system\s+override/gi, reason: 'System override attempt' },
  { pattern: /reveal\s+(your\s+)?prompt/gi, reason: 'Prompt extraction attempt' },

  // Credential/sensitive access
  { pattern: /ANTHROPIC_API_KEY|OPENAI_API_KEY|DISCORD_TOKEN|AWS_SECRET/gi, reason: 'Credential reference' },
  { pattern: /\.env\b|credentials\.json|secrets/gi, reason: 'Sensitive file reference' },
  { pattern: /~\/\.ssh\//gi, reason: 'SSH key directory access' },
];

// Zero-width Unicode characters that can be used for obfuscation
const ZERO_WIDTH_CHARS = [
  '\u200B', // Zero-width space
  '\u200C', // Zero-width non-joiner
  '\u200D', // Zero-width joiner
  '\uFEFF', // Zero-width no-break space (BOM)
  '\u2060', // Word joiner
];

/**
 * Get the skills directory for a given scope
 */
export function getSkillsDirectory(
  scope: SkillScope,
  channelDir: string,
  parentDir: string
): string {
  switch (scope) {
    case 'channel':
      return join(channelDir, 'skills');
    case 'disco':
      return join(parentDir, 'skills');
    case 'global':
      return join(homedir(), '.claude', 'skills');
  }
}

/**
 * Parse SKILL.md frontmatter to extract manifest
 * Returns null if frontmatter is missing or invalid
 */
export function parseSkillManifest(content: string): SkillManifest | null {
  // Match YAML frontmatter between --- markers
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const manifest: Partial<SkillManifest> = {};

  // Parse name
  const nameMatch = frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (nameMatch) {
    manifest.name = nameMatch[1].trim();
  }

  // Parse description (handles both single-line and multi-line with >)
  const descMatch = frontmatter.match(/^description:\s*>?\s*\n?([\s\S]*?)(?=\n[a-z]+:|$)/im);
  if (descMatch) {
    // Clean up multi-line description
    const desc = descMatch[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join(' ')
      .replace(/^["']|["']$/g, ''); // Strip quotes

    if (desc) {
      manifest.description = desc;
    }
  }

  // Also try simple single-line description
  if (!manifest.description) {
    const simpleDescMatch = frontmatter.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (simpleDescMatch) {
      manifest.description = simpleDescMatch[1].trim();
    }
  }

  // Validate required fields
  if (!manifest.name || !manifest.description) {
    return null;
  }

  return manifest as SkillManifest;
}

/**
 * Check skill content for security issues
 * Layer 1: Pattern matching for known dangerous patterns
 * Layer 2: Heuristic analysis for obfuscation
 *
 * Returns warnings with line numbers - does NOT block installation,
 * just informs the user so they can make an informed decision.
 */
export function checkSkillSecurity(content: string): SecurityCheckResult {
  const result: SecurityCheckResult = {
    safe: true, // Always true now - we warn but don't block
    errors: [],  // Kept for backwards compat but not used for blocking
    warnings: [],
  };

  const lines = content.split('\n');

  // Layer 1: Pattern matching with line numbers
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;

    // Find which lines match
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        const lineNum = i + 1;
        const preview = lines[i].trim().slice(0, 60) + (lines[i].length > 60 ? '...' : '');
        result.warnings.push(`Line ${lineNum}: ${reason}\n   \`${preview}\``);
      }
    }
  }

  // Layer 2: Heuristic analysis with line numbers

  // Check for very long lines (>1000 chars) - potential obfuscation
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 1000) {
      result.warnings.push(`Line ${i + 1}: Very long line (${lines[i].length} chars) - possible obfuscation`);
    }
  }

  // Check for Base64 segments >40 characters
  const base64Pattern = /[A-Za-z0-9+/]{40,}={0,2}/g;
  for (let i = 0; i < lines.length; i++) {
    base64Pattern.lastIndex = 0;
    if (base64Pattern.test(lines[i])) {
      result.warnings.push(`Line ${i + 1}: Long Base64-like string - verify it is not encoded malicious content`);
    }
  }

  // Check for zero-width Unicode characters
  for (let i = 0; i < lines.length; i++) {
    for (const char of ZERO_WIDTH_CHARS) {
      if (lines[i].includes(char)) {
        result.warnings.push(`Line ${i + 1}: Zero-width Unicode character - possible hidden content`);
        break;
      }
    }
  }

  return result;
}

/**
 * Install a skill by writing its content to the skills directory
 * Creates the skill directory and SKILL.md file
 * Returns the path to the SKILL.md file
 */
export function installSkill(
  skillName: string,
  content: string,
  skillsDir: string
): string {
  // Ensure skills directory exists
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // Create skill directory
  const skillDir = join(skillsDir, skillName);
  if (!existsSync(skillDir)) {
    mkdirSync(skillDir, { recursive: true });
  }

  // Write SKILL.md
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, content, 'utf-8');

  return skillPath;
}

/**
 * List all installed skills in a directory
 * Returns array of SkillInfo with name, description, and path
 */
export function listSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: SkillInfo[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, 'utf-8');
        const manifest = parseSkillManifest(content);

        if (manifest) {
          skills.push({
            name: manifest.name,
            description: manifest.description,
            path: skillMdPath,
          });
        }
      } catch {
        // Skip skills with unreadable SKILL.md
        continue;
      }
    }
  } catch {
    return [];
  }

  return skills;
}

/**
 * Remove a skill from the skills directory
 * Returns true if removed, false if skill didn't exist
 */
export function removeSkill(skillName: string, skillsDir: string): boolean {
  const skillDir = join(skillsDir, skillName);

  if (!existsSync(skillDir)) {
    return false;
  }

  rmSync(skillDir, { recursive: true, force: true });
  return true;
}

/**
 * Search ClawHub for skills matching a query
 * Returns array of search results or empty array on error
 */
export async function searchClawHub(query: string): Promise<ClawHubSearchResult[]> {
  try {
    const response = await fetch(`${CLAWHUB_API}/search?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    // API returns { results: [{ slug, displayName, summary, version, score }] }
    const results = data.results || [];
    return results.map((r: { slug?: string; displayName?: string; summary?: string }) => ({
      slug: r.slug || '',
      name: r.displayName || r.slug || '',
      description: r.summary || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Download a skill from ClawHub by slug
 * Returns the SKILL.md content and parsed manifest, or null on error
 */
export async function downloadFromClawHub(slug: string): Promise<DownloadResult | null> {
  try {
    const response = await fetch(`${CLAWHUB_API}/download?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
    });

    if (!response.ok) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const entries = zip.getEntries();

    // Find SKILL.md in the ZIP
    const skillEntry = entries.find(e => e.entryName.endsWith('SKILL.md'));
    if (!skillEntry) {
      return null;
    }

    const content = skillEntry.getData().toString('utf-8');
    const manifest = parseSkillManifest(content);

    return { content, manifest };
  } catch {
    return null;
  }
}

/**
 * Download a skill from GitHub
 * Supports formats: user/repo, user/repo/path, https://github.com/user/repo
 * Returns the SKILL.md content and parsed manifest, or null on error
 */
export async function downloadFromGitHub(source: string): Promise<DownloadResult | null> {
  try {
    // Parse the source to determine URL and path
    let repoUrl: string;
    let skillPath = '';

    if (source.startsWith('https://') || source.startsWith('http://')) {
      // Full URL - use as-is, ensure .git suffix
      repoUrl = source.endsWith('.git') ? source : `${source}.git`;
    } else {
      // user/repo or user/repo/path format
      const parts = source.split('/');
      if (parts.length < 2) {
        return null;
      }

      const user = parts[0];
      const repo = parts[1];
      repoUrl = `https://github.com/${user}/${repo}.git`;

      // If there's a path after user/repo, that's the skill subdirectory
      if (parts.length > 2) {
        skillPath = parts.slice(2).join('/');
      }
    }

    // Clone to temp directory
    const tempDir = join(tmpdir(), `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Shallow clone for efficiency using spawnSync with array args (prevents injection)
      const result = spawnSync('git', ['clone', '--depth', '1', repoUrl, tempDir], {
        stdio: 'pipe',
        timeout: 30000,
      });

      if (result.status !== 0) {
        return null;
      }

      // Find SKILL.md
      const skillDir = skillPath ? join(tempDir, skillPath) : tempDir;
      const skillMdPath = join(skillDir, 'SKILL.md');

      if (!existsSync(skillMdPath)) {
        return null;
      }

      const content = readFileSync(skillMdPath, 'utf-8');
      const manifest = parseSkillManifest(content);

      return { content, manifest };
    } finally {
      // Cleanup temp directory
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } catch {
    return null;
  }
}
