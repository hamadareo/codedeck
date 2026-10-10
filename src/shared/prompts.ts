/**
 * Prompt library (§5): variables and Claude Code custom commands. Pure.
 *
 * Variables: {{name}} or {{name:default}}. Built-ins are filled from the
 * active session: {{project}} {{cwd}} {{branch}} {{profile}}.
 */

export const BUILTIN_VARS = ['project', 'cwd', 'branch', 'profile'] as const;
export type BuiltinVar = (typeof BUILTIN_VARS)[number];

const VAR = /\{\{\s*([\p{L}\p{N}_-]+)\s*(?::([^}]*))?\}\}/gu;

export interface PromptVar {
  name: string;
  default: string;
}

/** User variables in order of first appearance (built-ins excluded). */
export function promptVariables(body: string): PromptVar[] {
  const out: PromptVar[] = [];
  for (const m of body.matchAll(VAR)) {
    const name = m[1]!;
    if ((BUILTIN_VARS as readonly string[]).includes(name) || out.some((v) => v.name === name)) continue;
    out.push({ name, default: (m[2] ?? '').trim() });
  }
  return out;
}

/** Fill variables; unknown ones fall back to their default (or stay empty). */
export function expandPrompt(body: string, values: Record<string, string>): string {
  return body.replace(VAR, (_m, name: string, dflt?: string) => values[name] ?? (dflt ?? '').trim());
}

/** File-safe command name: lowercase a-z 0-9 - _ (what a user can type after "/"). */
export function commandSlug(name: string, fallbackId: string): string {
  const s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return s || `prompt-${fallbackId.slice(0, 8).toLowerCase()}`;
}

const BUILTIN_IN_COMMAND: Record<BuiltinVar, string> = {
  project: 'this project',
  cwd: 'the current directory',
  branch: 'the current git branch',
  profile: 'this account',
};

/**
 * A Claude Code custom command file (commands/codedeck/<slug>.md). User variables
 * become positional arguments ($1, $2, … typed after the command); built-ins become
 * plain words, since the command runs inside claude where they are already known.
 */
export function commandFile(p: { name: string; body: string }): string {
  const vars = promptVariables(p.body);
  const body = p.body.replace(VAR, (_m, name: string, dflt?: string) => {
    if ((BUILTIN_VARS as readonly string[]).includes(name)) return BUILTIN_IN_COMMAND[name as BuiltinVar];
    const i = vars.findIndex((v) => v.name === name);
    return i >= 0 ? `$${i + 1}` : (dflt ?? '').trim();
  });
  const yaml = (s: string) => JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 200));
  const head = ['---', `description: ${yaml(`CodeDeck: ${p.name}`)}`];
  if (vars.length) head.push(`argument-hint: ${yaml(vars.map((v) => `<${v.name}>`).join(' '))}`);
  head.push('---', '');
  return `${head.join('\n')}${body.trim()}\n`;
}

export interface PromptExport {
  format: 'codedeck-prompts';
  version: 1;
  prompts: { name: string; body: string; asCommand: boolean }[];
}

/** Validate an imported JSON file (§8 import). Never executes anything from it. */
export function parsePromptExport(json: string): PromptExport['prompts'] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('prompts.error.badFile');
  }
  const d = data as Partial<PromptExport>;
  if (d?.format !== 'codedeck-prompts' || !Array.isArray(d.prompts)) throw new Error('prompts.error.badFile');
  return d.prompts
    .filter((p) => p && typeof p.name === 'string' && typeof p.body === 'string' && p.name.trim())
    .slice(0, 1000)
    .map((p) => ({
      name: p.name.trim().slice(0, 80),
      body: p.body.slice(0, 20_000),
      asCommand: p.asCommand === true,
    }));
}
