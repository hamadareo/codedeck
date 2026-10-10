import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMissed, nextRun, parseTime, validateRule, type Schedule } from '@shared/schedule';
import { remoteCommand, shQuote, sshArgs, validateHost } from '@shared/ssh';
import { openDatabase, type Db } from '../../src/main/db/database';
import { ProfileRepo } from '../../src/main/profiles/profileRepo';
import { Scheduler } from '../../src/main/schedule/scheduler';
import { SshRepo } from '../../src/main/ssh/sshRepo';
import { OutputBatcher } from '../../src/main/sessions/outputBatcher';
import { normalizeSettings } from '../../src/main/settings';
import type { NotifyKind } from '@shared/notify';
import type { Session } from '@shared/types';

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('schedule rules', () => {
  it('parses times and validates rules', () => {
    expect(parseTime('09:30')).toBe(570);
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('9:5')).toBeNull();
    expect(validateRule({ kind: 'weekly', day: 7, time: '10:00' })).toBe('schedule.error.day');
    expect(validateRule({ kind: 'daily', time: 'x' })).toBe('schedule.error.time');
  });

  it('next run: daily, weekdays (skips the weekend), weekly, once', () => {
    // 2026-10-09 is a Friday.
    const fri0930 = local(2026, 10, 9, 9, 30);
    expect(nextRun({ kind: 'daily', time: '09:00' }, fri0930)).toBe(local(2026, 10, 10, 9, 0));
    expect(nextRun({ kind: 'daily', time: '10:00' }, fri0930)).toBe(local(2026, 10, 9, 10, 0));
    expect(nextRun({ kind: 'weekdays', time: '09:00' }, fri0930)).toBe(local(2026, 10, 12, 9, 0)); // Monday
    expect(nextRun({ kind: 'weekly', day: 3, time: '08:00' }, fri0930)).toBe(local(2026, 10, 14, 8, 0)); // Wednesday
    expect(nextRun({ kind: 'once', at: fri0930 + 1000 }, fri0930)).toBe(fri0930 + 1000);
    expect(nextRun({ kind: 'once', at: fri0930 - 1000 }, fri0930)).toBeNull();
    // Exactly at the time: the next one, never the same minute again.
    expect(nextRun({ kind: 'daily', time: '09:30' }, fri0930)).toBe(local(2026, 10, 10, 9, 30));
  });

  it('missed after a grace period', () => {
    expect(isMissed(0, 60_000)).toBe(false);
    expect(isMissed(0, 10 * 60_000)).toBe(true);
  });
});

describe('Scheduler', () => {
  let tmp = '';
  let db: Db;
  let now = 0;
  let runs: string[] = [];
  let notes: [NotifyKind, Record<string, string | number>][] = [];
  let profileId = '';
  let fail = false;

  const make = () =>
    new Scheduler({
      db,
      now: () => now,
      run: async (s: Schedule) => {
        if (fail) throw new Error('claude.notFound');
        runs.push(s.name);
        return { id: 'sess', title: `⏰ ${s.name}` } as Session;
      },
      notify: (k, v) => notes.push([k, v]),
      onChanged: () => {},
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd sched '));
    db = openDatabase(path.join(tmp, 'db'));
    profileId = new ProfileRepo(db).insert({
      name: 'p',
      kind: 'personal',
      color: '#000',
      icon: '',
      note: '',
      configDir: tmp,
    }).id;
    now = local(2026, 10, 9, 8, 0);
    runs = [];
    notes = [];
    fail = false;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const input = (name: string, time = '09:00') => ({
    name,
    rule: { kind: 'daily' as const, time },
    profileId,
    projectId: null,
    prompt: 'do the thing',
    enabled: true,
  });

  it('runs when due, once, then moves to the next day', async () => {
    const s = make();
    const sch = s.create(input('morning'));
    expect(sch.nextRunAt).toBe(local(2026, 10, 9, 9, 0));
    await s.tick();
    expect(runs).toEqual([]);
    now = local(2026, 10, 9, 9, 0) + 20_000;
    await s.tick();
    await s.tick();
    expect(runs).toEqual(['morning']);
    expect(notes.map((n) => n[0])).toEqual(['scheduleRan']);
    expect(s.get(sch.id)?.nextRunAt).toBe(local(2026, 10, 10, 9, 0));
    expect(s.get(sch.id)?.lastRunAt).toBe(now);
  });

  it('regression: a run missed while the app was closed is reported, not executed late', async () => {
    const s = make();
    const sch = s.create(input('morning'));
    now = local(2026, 10, 9, 15, 0); // the app was closed at 09:00
    const restarted = make();
    await restarted.tick();
    expect(runs).toEqual([]);
    expect(notes[0]![0]).toBe('scheduleMissed');
    expect(restarted.get(sch.id)?.nextRunAt).toBe(local(2026, 10, 10, 9, 0));
  });

  it('failures are reported and not retried; disabled schedules never run; validation', async () => {
    const s = make();
    s.create({ ...input('off'), enabled: false });
    const sch = s.create(input('broken'));
    fail = true;
    now = local(2026, 10, 9, 9, 1);
    await s.tick();
    await s.tick();
    expect(notes.map((n) => n[0])).toEqual(['scheduleFailed']);
    expect(s.get(sch.id)?.nextRunAt).toBe(local(2026, 10, 10, 9, 0));
    expect(() => s.create({ ...input('x'), prompt: ' ' })).toThrow('schedule.error.prompt');
    expect(() => s.create({ ...input('x'), rule: { kind: 'daily', time: '25:00' } })).toThrow(
      'schedule.error.time',
    );
    fail = false;
    await s.runNow(sch.id);
    expect(runs).toEqual(['broken']);
  });

  it('a one-off runs once and is then done', async () => {
    const s = make();
    const sch = s.create({ ...input('once'), rule: { kind: 'once', at: now + 60_000 } });
    now += 61_000;
    await s.tick();
    expect(runs).toEqual(['once']);
    expect(s.get(sch.id)?.nextRunAt).toBeNull();
    expect(s.hasEnabled()).toBe(false);
  });
});

describe('SSH', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const host = {
    destination: 'me@example.com',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519',
    remoteDir: "~/my work/it's",
    remoteConfigDir: '',
  };

  it('builds safe ssh arguments; remote paths are single-quoted, ~ expands', () => {
    expect(sshArgs(host, id, false)).toEqual([
      '-t',
      '-p',
      '2222',
      '-i',
      '~/.ssh/id_ed25519',
      '--',
      'me@example.com',
      `cd ~/'my work/it'\\''s' && claude --session-id ${id}`,
    ]);
    expect(remoteCommand({ remoteDir: '', remoteConfigDir: '/home/me/.cd/team' }, id, true)).toBe(
      `{ CLAUDE_CONFIG_DIR='/home/me/.cd/team' claude --resume ${id} || CLAUDE_CONFIG_DIR='/home/me/.cd/team' claude --session-id ${id}; }`,
    );
    expect(() => remoteCommand({ remoteDir: '', remoteConfigDir: '' }, '; rm -rf /', false)).toThrow();
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('rejects destinations that could become ssh options or contain spaces', () => {
    const ok = {
      name: 'n',
      destination: 'me@host',
      port: null,
      identityFile: '',
      remoteDir: '',
      remoteConfigDir: '',
    };
    expect(validateHost(ok)).toBeNull();
    expect(validateHost({ ...ok, destination: '-oProxyCommand=evil' })).toBe('ssh.error.destination');
    expect(validateHost({ ...ok, destination: 'me@host evil' })).toBe('ssh.error.destination');
    expect(validateHost({ ...ok, port: 70000 })).toBe('ssh.error.port');
  });

  it('stores hosts (no secrets) and keeps names unique', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd ssh '));
    const db = openDatabase(path.join(tmp, 'db'));
    const repo = new SshRepo(db);
    const h = repo.create({
      name: 'build box',
      destination: 'me@box',
      port: null,
      identityFile: '',
      remoteDir: '~/app',
      remoteConfigDir: '',
    });
    expect(repo.list()).toHaveLength(1);
    expect(() => repo.create({ ...h, name: 'BUILD BOX' })).toThrow('ssh.error.nameTaken');
    expect(Object.keys(h).sort()).toEqual(
      [
        'createdAt',
        'destination',
        'id',
        'identityFile',
        'name',
        'port',
        'remoteConfigDir',
        'remoteDir',
      ].sort(),
    );
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('OutputBatcher', () => {
  it('coalesces per session, keeps order and the last offset, flushes big chunks at once', () => {
    vi.useFakeTimers();
    const sent: [string, string, number][] = [];
    const b = new OutputBatcher((id, d, end) => sent.push([id, d, end]), 8, 10);
    b.push('a', 'he', 2);
    b.push('b', 'x', 1);
    b.push('a', 'llo', 5);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(8);
    expect(sent).toEqual([
      ['a', 'hello', 5],
      ['b', 'x', 1],
    ]);
    b.push('a', '0123456789AB', 17); // over the size limit: immediately
    expect(sent.at(-1)).toEqual(['a', '0123456789AB', 17]);
    b.push('b', 'y', 2);
    b.flush('b');
    expect(sent.at(-1)).toEqual(['b', 'y', 2]);
    vi.useRealTimers();
  });
});

describe('settings (Phase 6)', () => {
  it('residency and login launch default off; updates default on', () => {
    const s = normalizeSettings({});
    expect(s).toMatchObject({ stayInTray: false, launchAtLogin: false, autoUpdate: true });
    expect(normalizeSettings({ autoUpdate: false, stayInTray: 'yes' as never })).toMatchObject({
      autoUpdate: false,
      stayInTray: false,
    });
  });
});
