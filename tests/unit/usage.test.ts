import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeWindows,
  detectLimitMessage,
  effectiveLimits,
  fiveHourBlocks,
  formatDuration,
  formatTokens,
  HOUR,
  normalizeThresholds,
  planFromSubscription,
  thresholdsToAnnounce,
  type UsageConfig,
} from '@shared/usage';
import { parseUsageLine, TranscriptScanner } from '../../src/main/usage/transcriptScanner';
import { UsageService } from '../../src/main/usage/usageService';
import { Notifier } from '../../src/main/notifier';
import { openDatabase, type Db } from '../../src/main/db/database';
import { ProfileRepo } from '../../src/main/profiles/profileRepo';
import { DEFAULT_NOTIFY, type NotifyKind } from '@shared/notify';
import type { Profile } from '@shared/types';

const T0 = Date.parse('2026-10-10T09:00:00Z');

/** A transcript line as Claude Code writes it, with secret-looking text that must never be kept. */
function line(ts: number, tokens: { in?: number; out?: number; cw?: number; cr?: number }, id = `msg_${ts}`) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: {
      id,
      model: 'claude-x',
      content: [{ type: 'text', text: 'SECRET PROMPT CONTENT sk-ant-xxxxxxxx' }],
      usage: {
        input_tokens: tokens.in ?? 0,
        output_tokens: tokens.out ?? 0,
        cache_creation_input_tokens: tokens.cw ?? 0,
        cache_read_input_tokens: tokens.cr ?? 0,
      },
    },
  });
}

describe('usage math', () => {
  it('counts input + output + cache writes (not cache reads); other lines are ignored', () => {
    expect(parseUsageLine(line(T0, { in: 1, out: 2, cw: 3, cr: 1000 }))).toMatchObject({ tokens: 6 });
    expect(parseUsageLine(JSON.stringify({ type: 'user', message: { content: 'x' } }))).toBeNull();
    expect(parseUsageLine('{not json')).toBeNull();
  });

  it('5-hour blocks start at the hour of the first message and close after 5h', () => {
    const blocks = fiveHourBlocks([
      { ts: T0 + 20 * 60_000, tokens: 10 },
      { ts: T0 + 4 * HOUR, tokens: 5 },
      { ts: T0 + 5 * HOUR + 1, tokens: 7 }, // new block
    ]);
    expect(blocks).toEqual([
      { start: T0, end: T0 + 5 * HOUR, used: 15 },
      { start: T0 + 5 * HOUR, end: T0 + 10 * HOUR, used: 7 },
    ]);
  });

  it('current window and rolling 7 days with percent and reset times', () => {
    const entries = [
      { ts: T0 - 8 * 24 * HOUR, tokens: 999 }, // outside 7d
      { ts: T0 - 2 * 24 * HOUR, tokens: 100 },
      { ts: T0 + HOUR, tokens: 300 },
    ];
    const w = computeWindows(entries, T0 + 2 * HOUR, { limit5h: 1000, limit7d: 2000 });
    expect(w.fiveHour).toMatchObject({ used: 300, percent: 30, start: T0 + HOUR, resetAt: T0 + 6 * HOUR });
    expect(w.sevenDay).toMatchObject({ used: 400, percent: 20, resetAt: T0 - 2 * 24 * HOUR + 7 * 24 * HOUR });
    const later = computeWindows(entries, T0 + 7 * HOUR, { limit5h: 1000, limit7d: null });
    expect(later.fiveHour).toMatchObject({ used: 0, percent: 0, resetAt: null });
    expect(later.sevenDay.percent).toBeNull();
  });

  it('thresholds: crossing several at once announces the highest once', () => {
    expect(thresholdsToAnnounce(95, [70, 90, 100], new Set())).toEqual({ announce: 90, markDone: [70, 90] });
    expect(thresholdsToAnnounce(95, [70, 90, 100], new Set([70, 90]))).toEqual({
      announce: null,
      markDone: [],
    });
    expect(thresholdsToAnnounce(null, [70], new Set())).toEqual({ announce: null, markDone: [] });
    expect(normalizeThresholds(['90', 70, 70, 500, 'x'])).toEqual([70, 90]);
    expect(normalizeThresholds([])).toEqual([70, 90, 100]);
  });

  it('limits: manual / observed beat plan presets; auto follows the detected plan', () => {
    const base: UsageConfig = {
      plan: 'auto',
      limit5h: null,
      limit7d: null,
      limitSource: 'none',
      thresholds: [],
    };
    expect(effectiveLimits(base, 'pro').source).toBe('preset');
    expect(effectiveLimits(base, null)).toEqual({ limit5h: null, limit7d: null, source: 'none' });
    expect(effectiveLimits({ ...base, limit5h: 5, limitSource: 'manual' }, 'pro')).toMatchObject({
      limit5h: 5,
      source: 'manual',
    });
    expect(planFromSubscription('max_20x')).toBe('max20');
    expect(planFromSubscription('max')).toBe('max5');
    expect(planFromSubscription('team')).toBe('team');
  });

  it('detects limit messages and their reset time', () => {
    expect(detectLimitMessage('⎿ 5-hour limit reached ∙ resets 3pm (Asia/Tokyo)\n')).toEqual({
      window: '5h',
      resetText: '3pm (Asia/Tokyo)',
    });
    expect(detectLimitMessage('Claude usage limit reached. Your limit will reset at 5pm.')).toMatchObject({
      window: '5h',
      resetText: '5pm',
    });
    expect(detectLimitMessage("You've hit your weekly limit · resets Oct 15, 9am")).toMatchObject({
      window: '7d',
    });
    expect(detectLimitMessage('the rate of change is limited')).toBeNull();
  });

  it('formats', () => {
    expect(formatDuration(2 * HOUR + 10 * 60_000, 'ja')).toBe('2時間10分');
    expect(formatDuration(26 * HOUR, 'en')).toBe('1d 2h');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(950)).toBe('950');
  });
});

describe('TranscriptScanner', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd usage テスト '));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads appended lines only, dedupes repeated messages, and keeps no text', () => {
    const proj = path.join(dir, 'projects', 'C--work-app');
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    const a = path.join(proj, 'a.jsonl');
    fs.writeFileSync(a, `${line(T0, { in: 10, out: 5 }, 'm1')}\n{"type":"user"}\n`);
    // The same message copied into a resumed transcript must not count twice.
    fs.writeFileSync(path.join(proj, 'sub', 'b.jsonl'), `${line(T0, { in: 10, out: 5 }, 'm1')}\n`);
    const s = new TranscriptScanner(dir);
    expect(s.scan(T0 + HOUR)).toEqual([{ ts: T0, tokens: 15 }]);
    // Partial line: counted once it is complete.
    const next = line(T0 + 60_000, { out: 7 }, 'm2');
    fs.appendFileSync(a, next.slice(0, 20));
    expect(s.scan(T0 + HOUR)).toHaveLength(1);
    fs.appendFileSync(a, `${next.slice(20)}\n`);
    const entries = s.scan(T0 + HOUR);
    expect(entries.map((e) => e.tokens)).toEqual([15, 7]);
    expect(JSON.stringify(entries)).not.toMatch(/SECRET|sk-ant/);
  });
});

describe('UsageService alerts', () => {
  let tmp = '';
  let db: Db;
  let now = T0;
  let sent: { kind: NotifyKind; vars: Record<string, string | number> }[] = [];
  let profile: Profile;
  let cfgDir = '';

  const service = () =>
    new UsageService({
      db,
      profiles: () => new ProfileRepo(db).list(),
      notify: (kind, vars) => sent.push({ kind, vars }),
      onChanged: () => {},
      now: () => now,
    });
  const write = (ts: number, tokens: number, id: string) => {
    const f = path.join(cfgDir, 'projects', 'p', 's.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${line(ts, { out: tokens }, id)}\n`);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd usage svc '));
    db = openDatabase(path.join(tmp, 'db.sqlite'));
    cfgDir = path.join(tmp, 'cfg');
    profile = new ProfileRepo(db).insert({
      name: 'team',
      kind: 'team',
      color: '#000',
      icon: '',
      note: '',
      configDir: cfgDir,
    });
    now = T0;
    sent = [];
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('regression: each threshold is announced once per window, also across restarts', () => {
    let u = service();
    u.setConfig(profile.id, { limit5h: 1000 });
    write(T0 + 60_000, 750, 'a');
    now = T0 + 2 * 60_000;
    u.refreshAll();
    expect(sent.map((s) => [s.kind, s.vars.threshold])).toEqual([['usageThreshold', 70]]);
    u.refreshAll();
    u = service(); // app restart
    u.refreshAll();
    expect(sent).toHaveLength(1);
    write(T0 + 3 * 60_000, 300, 'b'); // 105%: 90 and 100 at once → only 100
    now = T0 + 4 * 60_000;
    u.refreshAll();
    expect(sent.map((s) => s.vars.threshold)).toEqual([70, 100]);
    expect(sent[1]!.vars).toMatchObject({ window: '5h', percent: 105, profile: 'team' });
    // A new 5h block re-arms the thresholds.
    write(T0 + 6 * HOUR, 800, 'c');
    now = T0 + 6 * HOUR + 60_000;
    u.refreshAll();
    expect(sent.filter((s) => s.kind === 'usageThreshold').map((s) => s.vars.threshold)).toEqual([
      70, 100, 70,
    ]);
  });

  it('announces "available again" once when a high block ends', () => {
    const u = service();
    u.setConfig(profile.id, { limit5h: 1000 });
    write(T0 + 60_000, 950, 'a');
    now = T0 + 2 * 60_000;
    u.refreshAll();
    now = T0 + 5 * HOUR + 60_000;
    u.refreshAll();
    u.refreshAll();
    expect(sent.filter((s) => s.kind === 'usageReset')).toHaveLength(1);
  });

  it('a limit message calibrates the limit (unless set manually) and is announced once', () => {
    const u = service();
    u.setDetectedPlan(profile.id, 'pro');
    write(T0 + 60_000, 1234, 'a');
    now = T0 + 2 * 60_000;
    u.onLimitMessage(profile.id, { window: '5h', resetText: '3pm' });
    u.onLimitMessage(profile.id, { window: '5h', resetText: '3pm' });
    expect(sent.filter((s) => s.kind === 'limitReached')).toHaveLength(1);
    const usage = u.list().find((x) => x.profileId === profile.id)!;
    expect(usage.config).toMatchObject({ limit5h: 1234, limitSource: 'observed' });
    expect(usage.limitHit).toMatchObject({ window: '5h', resetText: '3pm' });
    expect(usage.fiveHour.percent).toBe(100);
    // Manual limits are never replaced.
    u.setConfig(profile.id, { limit5h: 5000 });
    now += 20 * 60_000;
    u.onLimitMessage(profile.id, { window: '5h', resetText: null });
    expect(u.list()[0]!.config).toMatchObject({ limit5h: 5000, limitSource: 'manual' });
  });

  it('choosing a plan again drops manual limits back to the plan estimate', () => {
    const u = service();
    u.setConfig(profile.id, { limit5h: 10 });
    expect(u.list()[0]!.config.limitSource).toBe('manual');
    u.setConfig(profile.id, { plan: 'max20' });
    expect(u.list()[0]!.config).toMatchObject({ limitSource: 'preset', plan: 'max20' });
  });
});

describe('Notifier', () => {
  const make = (focused: boolean, settings = DEFAULT_NOTIFY) => {
    const os: string[] = [];
    const inApp: string[] = [];
    const n = new Notifier({
      settings: () => ({ notifications: settings, locale: 'ja' }),
      showOs: (title) => os.push(title),
      showInApp: (r) => inApp.push(r.title),
      appFocused: () => focused,
      onClick: () => {},
    });
    return { n, os, inApp };
  };

  it('usage alerts go to the OS and the app; texts are localized', () => {
    const { n, os, inApp } = make(true);
    n.notify('usageThreshold', {
      profile: 'team',
      window: '5h',
      threshold: 90,
      percent: 91,
      used: '9M',
      limit: '10M',
    });
    expect(os).toEqual(['team: 5時間の使用量が 90% を超えました']);
    expect(inApp).toEqual(os);
  });

  it('session alerts only when the app is not in front, and never as in-app banners', () => {
    expect(make(true).n.notify('sessionDone', { session: 's', profile: 'p' })).toBeNull();
    const away = make(false);
    away.n.notify('sessionApproval', { session: 's', profile: 'p' });
    expect(away.os).toEqual(['承認待ち: s']);
    expect(away.inApp).toEqual([]);
  });

  it('per-kind switches and the OS switch are respected', () => {
    const off = { ...DEFAULT_NOTIFY, os: false, kinds: { ...DEFAULT_NOTIFY.kinds, usageReset: false } };
    const { n, os, inApp } = make(false, off);
    expect(n.notify('usageReset', { profile: 'p' })).toBeNull();
    n.notify('limitReached', { profile: 'p', reset: '3pm', window: '5h' });
    expect(os).toEqual([]);
    expect(inApp).toHaveLength(1);
    expect(n.list()).toHaveLength(1);
  });
});
