import { describe, expect, it } from 'vitest';
import { claudeEnv, sanitizeEnv } from '../../src/main/platform/env';
import {
  buildSpawnSpec,
  cmdQuote,
  parseAuthStatus,
  pickWindowsCandidate,
  sessionArgs,
} from '../../src/main/platform/claude';
import { defaultProfileDir } from '../../src/main/platform/paths';

describe('sanitizeEnv', () => {
  it('drops nested-session markers, NO_COLOR and any inherited CLAUDE_CONFIG_DIR', () => {
    const out = sanitizeEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_PID: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CONFIG_DIR: '/other',
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
      CODEDECK_CLAUDE_PATH: '/fake',
      ANTHROPIC_MODEL: 'keep',
    });
    expect(out).toEqual({ PATH: '/bin', ANTHROPIC_MODEL: 'keep' });
  });

  it('sets the profile config dir and color support', () => {
    const env = claudeEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/wrong' }, '/home/u/.codedeck/profiles/team');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.codedeck/profiles/team');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
  });

  it('regression: no config dir means the CLI default, not an inherited one', () => {
    expect(claudeEnv({ CLAUDE_CONFIG_DIR: '/leaked' }, null).CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe('buildSpawnSpec', () => {
  it('runs a native executable directly', () => {
    const s = buildSpawnSpec({
      claudePath: 'C:\\Users\\a b\\.local\\bin\\claude.exe',
      args: ['--session-id', 'abc'],
      configDir: 'C:\\x',
      platform: 'win32',
      baseEnv: {},
    });
    expect(s.file).toBe('C:\\Users\\a b\\.local\\bin\\claude.exe');
    expect(s.args).toEqual(['--session-id', 'abc']);
    expect(s.env.CLAUDE_CONFIG_DIR).toBe('C:\\x');
  });

  it('wraps an npm .cmd shim in cmd.exe on Windows', () => {
    const s = buildSpawnSpec({
      claudePath: 'C:\\npm\\claude.cmd',
      args: ['--resume', 'abc'],
      configDir: null,
      platform: 'win32',
      baseEnv: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    expect(s.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(s.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\claude.cmd', '--resume', 'abc']);
    expect(s.commandLine).toBe('/d /s /c "C:\\npm\\claude.cmd --resume abc"');
  });

  it('regression: a .cmd shim gets paths with spaces intact (cmd /s strips only the outer quotes)', () => {
    const s = buildSpawnSpec({
      claudePath: 'C:\\Program Files\\nodejs\\claude.cmd',
      args: [
        '--settings',
        'C:\\Users\\a b\\AppData\\Roaming\\CodeDeck\\codedeck-hooks.json',
        '--session-id',
        'x',
      ],
      configDir: null,
      platform: 'win32',
      baseEnv: {},
    });
    expect(s.commandLine).toBe(
      '/d /s /c ""C:\\Program Files\\nodejs\\claude.cmd" --settings "C:\\Users\\a b\\AppData\\Roaming\\CodeDeck\\codedeck-hooks.json" --session-id x"',
    );
  });

  it('cmdQuote quotes only when needed and doubles inner quotes', () => {
    expect(cmdQuote('abc')).toBe('abc');
    expect(cmdQuote('a b')).toBe('"a b"');
    expect(cmdQuote('a&b')).toBe('"a&b"');
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""');
    expect(cmdQuote('')).toBe('""');
  });

  it('extraEnv is added after sanitizing (the status file path reaches the child)', () => {
    const s = buildSpawnSpec({
      claudePath: '/bin/claude',
      args: [],
      configDir: '/cfg',
      platform: 'darwin',
      baseEnv: { CODEDECK_STATUS_FILE: '/leaked' },
      extraEnv: { CODEDECK_STATUS_FILE: '/ud/status/id.log' },
    });
    expect(s.env.CODEDECK_STATUS_FILE).toBe('/ud/status/id.log');
  });

  it('does not wrap on macOS', () => {
    const s = buildSpawnSpec({
      claudePath: '/opt/homebrew/bin/claude',
      args: [],
      configDir: null,
      platform: 'darwin',
      baseEnv: {},
    });
    expect(s.file).toBe('/opt/homebrew/bin/claude');
  });
});

describe('claude helpers', () => {
  it('sessionArgs: new vs resume', () => {
    expect(sessionArgs('id1', false)).toEqual(['--session-id', 'id1']);
    expect(sessionArgs('id1', true)).toEqual(['--resume', 'id1']);
    expect(sessionArgs('id1', true, '/ud/codedeck-hooks.json')).toEqual([
      '--settings',
      '/ud/codedeck-hooks.json',
      '--resume',
      'id1',
    ]);
  });

  it('pickWindowsCandidate prefers .exe, then .cmd', () => {
    expect(pickWindowsCandidate(['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe', ''])).toBe(
      'C:\\bin\\claude.exe',
    );
    expect(pickWindowsCandidate(['C:\\npm\\claude', 'C:\\npm\\claude.cmd'])).toBe('C:\\npm\\claude.cmd');
    expect(pickWindowsCandidate([''])).toBeNull();
  });

  it('parseAuthStatus reads the CLI JSON, tolerating noise', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"a@b.c","authMethod":"claude.ai"}')).toEqual({
      loggedIn: true,
      email: 'a@b.c',
    });
    expect(parseAuthStatus('warning\n{\n "loggedIn": false,\n "authMethod": "none"\n}\n')).toEqual({
      loggedIn: false,
      email: null,
    });
    expect(parseAuthStatus('not json')).toBeNull();
  });

  it('defaultProfileDir is under ~/.codedeck/profiles and keeps spaces / Japanese', () => {
    const d = defaultProfileDir(' 会社 チーム ', '/Users/a b');
    expect(d.replace(/\\/g, '/')).toBe('/Users/a b/.codedeck/profiles/会社 チーム');
  });
});
