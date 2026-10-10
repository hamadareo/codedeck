import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { McpServerInfo, SkillInfo } from '@shared/types';
import { buildSpawnSpec, resolveClaude } from './platform/claude';

const SKILLS = 'skills';
/** Disabled skills are parked here by CodeDeck (Claude Code does not read this folder). */
const SKILLS_DISABLED = 'skills-disabled';

/** `name: …` / `description: …` from a SKILL.md front matter (single-line values). */
export function parseSkillFrontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function readSkills(dir: string, enabled: boolean, scope: SkillInfo['scope']): SkillInfo[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => d.isDirectory())
    .map((d) => {
      let fm: { name?: string; description?: string } = {};
      try {
        fm = parseSkillFrontMatter(
          fs.readFileSync(path.join(dir, d.name, 'SKILL.md'), 'utf8').slice(0, 8000),
        );
      } catch {
        // no SKILL.md: still list the folder
      }
      return { name: d.name, description: (fm.description ?? '').slice(0, 300), enabled, scope };
    });
}

/** Skills of a profile (toggleable) and of the project (read-only here). */
export function listSkills(configDir: string, projectDir?: string | null): SkillInfo[] {
  const out = [
    ...readSkills(path.join(configDir, SKILLS), true, 'profile'),
    ...readSkills(path.join(configDir, SKILLS_DISABLED), false, 'profile'),
  ];
  if (projectDir) out.push(...readSkills(path.join(projectDir, '.claude', 'skills'), true, 'project'));
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

/** A skill folder name: one path segment, no traversal. */
export function isSafeSkillName(name: string): boolean {
  return !!name && name === path.basename(name) && !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

/** Enable / disable by moving the folder between skills/ and skills-disabled/ (reversible). */
export function setSkillEnabled(configDir: string, name: string, enabled: boolean): void {
  if (!isSafeSkillName(name)) throw new Error('skills.error.badName');
  const from = path.join(configDir, enabled ? SKILLS_DISABLED : SKILLS, name);
  const toDir = path.join(configDir, enabled ? SKILLS : SKILLS_DISABLED);
  const to = path.join(toDir, name);
  if (!fs.existsSync(from)) throw new Error('skills.error.notFound');
  if (fs.existsSync(to)) throw new Error('skills.error.exists');
  fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(from, to);
}

/** Lines of `claude mcp list` such as "name: target - ✔ Connected". */
export function parseMcpList(out: string): McpServerInfo[] {
  const servers: McpServerInfo[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(.+?):\s+(.+?)\s+-\s+(.+)$/.exec(line);
    if (!m || /^checking/i.test(line)) continue;
    const detail = m[3]!.trim();
    const status: McpServerInfo['status'] = /connected|✔|✓/i.test(detail)
      ? 'connected'
      : /auth/i.test(detail)
        ? 'needs-auth'
        : /fail|✗|✘|error/i.test(detail)
          ? 'failed'
          : 'unknown';
    servers.push({ name: m[1]!.trim(), target: m[2]!.trim(), status, detail });
  }
  return servers;
}

/** `claude mcp list` for one profile (its config dir), run in the project folder for project-scoped servers. */
export function listMcp(
  configDir: string,
  cwd: string,
): Promise<{ servers: McpServerInfo[]; error: string | null }> {
  const claudePath = resolveClaude();
  if (!claudePath) return Promise.resolve({ servers: [], error: 'claude.notFound' });
  const spec = buildSpawnSpec({ claudePath, args: ['mcp', 'list'], configDir });
  return new Promise((resolve) => {
    execFile(
      spec.file,
      spec.args,
      { env: spec.env, cwd, timeout: 60_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const servers = parseMcpList(String(stdout));
        if (err && !servers.length) resolve({ servers, error: String(stderr || err.message).slice(0, 300) });
        else resolve({ servers, error: null });
      },
    );
  });
}
