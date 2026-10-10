import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { displayStatus, needsAttention, nextActivity, type HookWord } from '@shared/status';
import {
  buildHookSettings,
  hookCommand,
  sessionStartHook,
  STATUS_FILE_ENV,
  writeHookSettings,
} from '../../src/main/sessions/hooks';
import { StatusWatcher } from '../../src/main/sessions/statusWatcher';

describe('activity transitions', () => {
  it('a normal turn: start → waiting, prompt → working, stop → done, seen → waiting', () => {
    let a = nextActivity('unknown', 'start');
    expect(a).toBe('waiting');
    a = nextActivity(a, 'prompt');
    expect(a).toBe('working');
    a = nextActivity(a, 'stop');
    expect(a).toBe('done');
    a = nextActivity(a, 'seen');
    expect(a).toBe('waiting');
  });

  it('approval: permission → approval; the user typing an answer → working', () => {
    let a = nextActivity('working', 'permission');
    expect(a).toBe('approval');
    expect(nextActivity(a, 'seen')).toBe('approval'); // looking at it does not answer it
    expect(nextActivity(a, 'start')).toBe('approval');
    a = nextActivity(a, 'input');
    expect(a).toBe('working');
    expect(nextActivity('waiting', 'input')).toBe('waiting');
  });

  it('idle_prompt does not hide an unseen result or an error', () => {
    expect(nextActivity('done', 'idle')).toBe('done');
    expect(nextActivity('error', 'idle')).toBe('error');
    expect(nextActivity('working', 'idle')).toBe('waiting');
    expect(nextActivity('working', 'failure')).toBe('error');
  });

  it('display status: location and PTY state come first; unknown activity shows "running"', () => {
    expect(displayStatus({ location: 'external' }, 'running', 'working')).toBe('external');
    expect(displayStatus({ location: 'embedded' }, 'idle', 'unknown')).toBe('idle');
    expect(displayStatus({ location: 'embedded' }, 'exited', 'unknown', 0)).toBe('exited');
    expect(displayStatus({ location: 'embedded' }, 'exited', 'unknown', 1)).toBe('error');
    expect(displayStatus({ location: 'embedded' }, 'running', 'unknown')).toBe('running');
    expect(displayStatus({ location: 'embedded' }, 'running', 'approval')).toBe('approval');
    expect(needsAttention('approval')).toBe(true);
    expect(needsAttention('working')).toBe(false);
  });
});

describe('status hooks', () => {
  it('only CodeDeck words are written; never the hook input (prompts stay private, §8)', () => {
    const s = buildHookSettings('darwin');
    expect(Object.keys(s.hooks).sort()).toEqual(
      ['Notification', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'].sort(),
    );
    // Only SessionStart reads its input (to match out the conversation id); every other event —
    // UserPromptSubmit carries the prompt — never does.
    const { SessionStart, ...rest } = s.hooks;
    expect(JSON.stringify(rest)).not.toMatch(/\b(cat|tee|jq|sed|Get-Content)\b|stdin|\$input|\$\(|ReadToEnd/);
    expect(SessionStart![0]!.hooks[0]!.command).toMatch(/session_id/);
    for (const groups of Object.values(s.hooks))
      for (const g of groups) for (const h of g.hooks) expect(h.async).toBe(true);
    expect(s.hooks.Notification!.map((g) => g.matcher)).toEqual([
      'permission_prompt|elicitation_dialog',
      'idle_prompt',
    ]);
  });

  it('SessionStart writes "start" and the conversation id — nothing else from its input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd hook テスト '));
    const file = path.join(dir, 'a b.log');
    const id = '0b8e3c5a-1f2d-4c6b-9a7e-123456789abc';
    const input = JSON.stringify({
      session_id: id,
      transcript_path: '/secret/path.jsonl',
      cwd: '/home/me/private project',
      hook_event_name: 'SessionStart',
      source: 'resume',
    });
    const h = sessionStartHook(process.platform);
    const [cmd, args] =
      process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', h.command]]
        : ['/bin/sh', ['-c', h.command]];
    execFileSync(cmd, args, { input, env: { ...process.env, [STATUS_FILE_ENV]: file } });
    const lines = fs
      .readFileSync(file, 'utf8')
      .replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(lines).toEqual(['start', `session ${id}`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Windows hooks run in PowerShell (works without Git Bash); others in sh', () => {
    expect(hookCommand('stop', 'win32')).toMatchObject({
      shell: 'powershell',
      command: `Add-Content -LiteralPath $env:${STATUS_FILE_ENV} -Value 'stop'`,
    });
    const mac = hookCommand('stop', 'darwin');
    expect(mac.shell).toBeUndefined();
    expect(mac.command).toBe(`printf '%s\\n' 'stop' >> "$${STATUS_FILE_ENV}"`);
  });

  it.skipIf(process.platform === 'win32')('the sh command appends to a path with spaces and Japanese', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd hook テスト '));
    const file = path.join(dir, 'a b.log');
    execFileSync('/bin/sh', ['-c', hookCommand('prompt', 'darwin').command], {
      env: { ...process.env, [STATUS_FILE_ENV]: file },
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('prompt\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'win32')(
    'the PowerShell command appends to a path with spaces and Japanese',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd hook テスト '));
      const file = path.join(dir, 'a b.log');
      fs.writeFileSync(file, '');
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', hookCommand('prompt', 'win32').command],
        {
          env: { ...process.env, [STATUS_FILE_ENV]: file },
        },
      );
      expect(fs.readFileSync(file, 'utf8').trim()).toBe('prompt');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  );

  it('writeHookSettings writes valid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd hooks '));
    const file = writeHookSettings(dir, 'win32');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(buildHookSettings('win32'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('StatusWatcher', () => {
  let dir = '';
  let w: StatusWatcher | null = null;
  afterEach(() => {
    w?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads whole new lines once, tolerating BOM/CRLF and ignoring unknown words', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd status '));
    const got: [string, HookWord][] = [];
    w = new StatusWatcher(dir, (id, word) => got.push([id, word]), 60_000);
    const file = w.begin('s1');
    fs.appendFileSync(file, `${String.fromCharCode(0xfeff)}start\r\nprompt\nrm -rf /\nsto`);
    w.read('s1');
    expect(got).toEqual([
      ['s1', 'start'],
      ['s1', 'prompt'],
    ]);
    fs.appendFileSync(file, 'p\n');
    w.read('s1');
    w.read('s1');
    expect(got.at(-1)).toEqual(['s1', 'stop']);
    expect(got).toHaveLength(3);
    // begin() truncates for a new run of the same session.
    w.begin('s1');
    w.read('s1');
    expect(got).toHaveLength(3);
    w.remove('s1');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('picks up appends by itself (watch or poll)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd status '));
    const got: HookWord[] = [];
    w = new StatusWatcher(dir, (_id, word) => got.push(word), 50);
    fs.appendFileSync(w.begin('s2'), 'permission\n');
    await expect.poll(() => got).toEqual(['permission']);
  });
});
