import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { claudeEnv } from './env';

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Windows only: the exact command line for node-pty (used for cmd.exe shims). */
  commandLine?: string;
  env: Record<string, string>;
}

let cachedPath: string | null | undefined;

/**
 * Resolve the `claude` executable on PATH. CODEDECK_CLAUDE_PATH overrides it
 * (used by E2E tests with a fake CLI).
 */
export function resolveClaude(platform: NodeJS.Platform = process.platform): string | null {
  if (process.env.CODEDECK_CLAUDE_PATH) return process.env.CODEDECK_CLAUDE_PATH;
  if (cachedPath !== undefined) return cachedPath;
  cachedPath = findClaude(platform);
  return cachedPath;
}

export function resetClaudePathCache(): void {
  cachedPath = undefined;
}

function findClaude(platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'win32') {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true });
      return pickWindowsCandidate(out.split(/\r?\n/));
    }
    // GUI apps on macOS do not inherit the login shell PATH; ask the login shell.
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 });
    const line = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    return line && fs.existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

/** Prefer the native .exe, then the npm .cmd shim, then anything else. */
export function pickWindowsCandidate(lines: string[]): string | null {
  const c = lines.map((l) => l.trim()).filter(Boolean);
  return (
    c.find((x) => x.toLowerCase().endsWith('.exe')) ??
    c.find((x) => x.toLowerCase().endsWith('.cmd')) ??
    c[0] ??
    null
  );
}

/** Interactive session args: a fresh conversation gets a fixed id; a known one is resumed. */
export function sessionArgs(sessionId: string, resume: boolean, hookSettingsFile?: string): string[] {
  const id = resume ? ['--resume', sessionId] : ['--session-id', sessionId];
  // A file path, not inline JSON: JSON quotes do not survive cmd.exe for .cmd shims.
  return hookSettingsFile ? ['--settings', hookSettingsFile, ...id] : id;
}

/** Wrap batch shims (.cmd/.bat) in cmd.exe; run everything else directly. */
export function buildSpawnSpec(opts: {
  claudePath: string;
  args: string[];
  configDir: string | null;
  platform?: NodeJS.Platform;
  baseEnv?: NodeJS.ProcessEnv;
  /** Added after sanitizing (e.g. CODEDECK_STATUS_FILE for the status hooks). */
  extraEnv?: Record<string, string>;
}): SpawnSpec {
  const platform = opts.platform ?? process.platform;
  const env = { ...claudeEnv(opts.baseEnv ?? process.env, opts.configDir), ...opts.extraEnv };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(opts.claudePath)) {
    const inner = [opts.claudePath, ...opts.args].map(cmdQuote).join(' ');
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', opts.claudePath, ...opts.args],
      // `cmd /s /c "<line>"` strips exactly the outer quotes, so paths with spaces survive.
      commandLine: `/d /s /c "${inner}"`,
      env,
    };
  }
  return { file: opts.claudePath, args: opts.args, env };
}

/** Quote one argument for a cmd.exe command line (inside quotes, & | < > are literal). */
export function cmdQuote(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) || arg === '' ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function run(spec: SpawnSpec, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      spec.file,
      spec.args,
      { env: spec.env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '' });
      },
    );
  });
}

export async function claudeVersion(): Promise<string | null> {
  const claudePath = resolveClaude();
  if (!claudePath) return null;
  const { stdout } = await run(buildSpawnSpec({ claudePath, args: ['--version'], configDir: null }), 15_000);
  return stdout.trim().split(/\r?\n/)[0] || null;
}

export interface AuthStatusResult {
  loggedIn: boolean;
  email: string | null;
}

/**
 * `claude auth status --json` for one config dir. Uses the CLI's own report;
 * the app never opens credential files (§3, §8).
 */
export async function authStatus(configDir: string): Promise<AuthStatusResult | null> {
  const claudePath = resolveClaude();
  if (!claudePath) return null;
  const { stdout } = await run(
    buildSpawnSpec({ claudePath, args: ['auth', 'status', '--json'], configDir }),
    20_000,
  );
  return parseAuthStatus(stdout);
}

export function parseAuthStatus(stdout: string): AuthStatusResult | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown; email?: unknown };
    return { loggedIn: j.loggedIn === true, email: typeof j.email === 'string' ? j.email : null };
  } catch {
    return null;
  }
}
