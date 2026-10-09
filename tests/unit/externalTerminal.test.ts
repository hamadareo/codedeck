import { describe, expect, it } from 'vitest';
import {
  encodePowershell,
  macCommand,
  powershellScript,
  shellLine,
  windowsCommand,
  type ExternalLaunch,
} from '../../src/main/platform/externalTerminal';

const tricky: ExternalLaunch = {
  claudePath: "C:\\Users\\O'Neil\\.local\\bin\\claude.exe",
  configDir: "C:\\Users\\O'Neil\\.codedeck\\profiles\\会社 チーム",
  cwd: 'C:\\work\\my app; rm -rf',
  args: ['--resume', '0b6f'],
};

describe('Windows external terminal', () => {
  it('sets CLAUDE_CONFIG_DIR inside the script and quotes single quotes', () => {
    const s = powershellScript(tricky);
    expect(s).toContain("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O''Neil\\.codedeck\\profiles\\会社 チーム'");
    expect(s).toContain("Set-Location -LiteralPath 'C:\\work\\my app; rm -rf'");
    expect(s).toContain("& 'C:\\Users\\O''Neil\\.local\\bin\\claude.exe' '--resume' '0b6f'");
  });

  it('passes the script base64-encoded (UTF-16LE), so wt never sees ";" from paths', () => {
    const cmd = windowsCommand(tricky, true);
    expect(cmd.file).toBe('wt.exe');
    const b64 = cmd.args[cmd.args.indexOf('-EncodedCommand') + 1]!;
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe(powershellScript(tricky));
    expect(b64).not.toContain(';');
    expect(encodePowershell('a')).toBe(Buffer.from('a', 'utf16le').toString('base64'));
  });

  it('falls back to a detached PowerShell console', () => {
    const cmd = windowsCommand(tricky, false);
    expect(cmd.file).toBe('powershell.exe');
    expect(cmd.detached).toBe(true);
  });
});

describe('macOS external terminal', () => {
  const l: ExternalLaunch = {
    claudePath: '/Users/a/.local/bin/claude',
    configDir: "/Users/a/.codedeck/profiles/it's",
    cwd: '/Users/a/my "app"',
    args: ['--session-id', 'x'],
  };

  it('builds a POSIX-quoted command line', () => {
    expect(shellLine(l)).toBe(
      `cd '/Users/a/my "app"' && CLAUDE_CONFIG_DIR='/Users/a/.codedeck/profiles/it'\\''s' '/Users/a/.local/bin/claude' '--session-id' 'x'`,
    );
  });

  it('escapes the line for AppleScript', () => {
    const cmd = macCommand(l, 'terminal-app');
    expect(cmd.file).toBe('osascript');
    expect(cmd.args[1]).toContain('do script "cd \'/Users/a/my \\"app\\"\'');
    expect(macCommand(l, 'iterm').args.join(' ')).toContain('iTerm');
  });
});
