/**
 * "Open in external terminal" (§2.6-5). The profile's CLAUDE_CONFIG_DIR is set
 * inside the launched command itself, because Windows Terminal may reuse an
 * existing window process whose environment is not ours.
 */
import { spawn, execFileSync } from 'node:child_process';

export type ExternalTerminalKind = 'auto' | 'windows-terminal' | 'powershell' | 'terminal-app' | 'iterm';

export interface ExternalLaunch {
  claudePath: string;
  configDir: string;
  cwd: string;
  args: string[];
}

export interface Command {
  file: string;
  args: string[];
  /** Spawn detached in its own console (Windows PowerShell fallback). */
  detached?: boolean;
}

// ---------- Windows ----------

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function powershellScript(l: ExternalLaunch): string {
  return [
    `$env:CLAUDE_CONFIG_DIR = ${psQuote(l.configDir)}`,
    `Set-Location -LiteralPath ${psQuote(l.cwd)}`,
    `& ${psQuote(l.claudePath)} ${l.args.map(psQuote).join(' ')}`,
  ].join('\n');
}

/** -EncodedCommand avoids every quoting layer (wt treats ';' as a separator, cmd has its own rules). */
export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function windowsCommand(l: ExternalLaunch, useWindowsTerminal: boolean): Command {
  const ps = [
    'powershell.exe',
    '-NoLogo',
    '-NoExit',
    '-EncodedCommand',
    encodePowershell(powershellScript(l)),
  ];
  if (useWindowsTerminal) return { file: 'wt.exe', args: ['-w', 'new', '-d', l.cwd, ...ps] };
  return { file: ps[0]!, args: ps.slice(1), detached: true };
}

// ---------- macOS ----------

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function shellLine(l: ExternalLaunch): string {
  return `cd ${shQuote(l.cwd)} && CLAUDE_CONFIG_DIR=${shQuote(l.configDir)} ${shQuote(l.claudePath)} ${l.args
    .map(shQuote)
    .join(' ')}`;
}

export function macCommand(l: ExternalLaunch, kind: 'terminal-app' | 'iterm'): Command {
  const line = appleScriptString(shellLine(l));
  if (kind === 'iterm') {
    return {
      file: 'osascript',
      args: [
        '-e',
        'tell application "iTerm" to create window with default profile',
        '-e',
        `tell application "iTerm" to tell current session of current window to write text ${line}`,
        '-e',
        'tell application "iTerm" to activate',
      ],
    };
  }
  return {
    file: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to do script ${line}`,
      '-e',
      'tell application "Terminal" to activate',
    ],
  };
}

// ---------- dispatch ----------

function hasWindowsTerminal(): boolean {
  try {
    execFileSync('where.exe', ['wt'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function resolveCommand(
  l: ExternalLaunch,
  kind: ExternalTerminalKind,
  platform: NodeJS.Platform = process.platform,
): Command {
  if (platform === 'win32') {
    const useWt = kind === 'windows-terminal' || (kind === 'auto' && hasWindowsTerminal());
    return windowsCommand(l, useWt);
  }
  if (platform === 'darwin') return macCommand(l, kind === 'iterm' ? 'iterm' : 'terminal-app');
  throw new Error(`external terminal is not supported on ${platform} yet`);
}

export function launchExternal(cmd: Command, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, {
      env,
      detached: cmd.detached ?? false,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
