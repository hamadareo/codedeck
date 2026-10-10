import type { Db } from '../db/database';
import type { Profile } from '@shared/types';
import {
  computeWindows,
  defaultConfig,
  effectiveLimits,
  fiveHourBlocks,
  formatTokens,
  normalizeThresholds,
  thresholdsToAnnounce,
  type LimitMessage,
  type Plan,
  type ProfileUsage,
  type UsageConfig,
  type UsageEntry,
  type UsageWindow,
} from '@shared/usage';
import { TranscriptScanner } from './transcriptScanner';
import type { NotifyKind } from '@shared/notify';

export interface UsageDeps {
  db: Db;
  profiles(): Profile[];
  notify(kind: NotifyKind, vars: Record<string, string | number>, profileId: string): void;
  onChanged(usage: ProfileUsage[]): void;
  now?: () => number;
}

interface ConfigRow {
  plan: Plan;
  limit_5h: number | null;
  limit_7d: number | null;
  limit_source: UsageConfig['limitSource'];
  thresholds: string;
  detected_plan: string | null;
}

/** Hysteresis for the rolling 7-day window: a threshold re-arms once usage falls 10 points below it. */
const REARM_POINTS = 10;
/** A reset is announced only for blocks that ended recently (not for old history after a restart). */
const RESET_ANNOUNCE_WINDOW = 60 * 60_000;

/**
 * Usage per profile (§7): scans transcripts, applies limits, and sends each
 * threshold / limit / reset notification exactly once (recorded in SQLite).
 */
export class UsageService {
  private readonly scanners = new Map<string, TranscriptScanner>();
  private readonly limitHits = new Map<string, ProfileUsage['limitHit']>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private latest: ProfileUsage[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UsageDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(intervalMs = 60_000): void {
    this.refreshAll();
    this.timer = setInterval(() => this.refreshAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.pending.forEach((t) => clearTimeout(t));
    this.pending.clear();
  }

  list(): ProfileUsage[] {
    return this.latest;
  }

  /** Re-scan soon (e.g. after a turn finished); coalesces bursts. */
  scheduleRefresh(profileId: string, delayMs = 1500): void {
    if (this.pending.has(profileId)) return;
    this.pending.set(
      profileId,
      setTimeout(() => {
        this.pending.delete(profileId);
        this.refreshAll();
      }, delayMs),
    );
  }

  // ---------- config ----------

  config(profileId: string): { config: UsageConfig; detectedPlan: string | null } {
    const r = this.deps.db.prepare('SELECT * FROM profile_usage WHERE profile_id = ?').get(profileId) as
      ConfigRow | undefined;
    if (!r) return { config: defaultConfig(), detectedPlan: null };
    let thresholds: unknown = null;
    try {
      thresholds = JSON.parse(r.thresholds);
    } catch {
      // keep defaults
    }
    return {
      config: {
        plan: r.plan,
        limit5h: r.limit_5h,
        limit7d: r.limit_7d,
        limitSource: r.limit_source,
        thresholds: normalizeThresholds(thresholds),
      },
      detectedPlan: r.detected_plan,
    };
  }

  private saveConfig(profileId: string, c: UsageConfig, detectedPlan: string | null): void {
    this.deps.db
      .prepare(
        `INSERT INTO profile_usage (profile_id, plan, limit_5h, limit_7d, limit_source, thresholds, detected_plan)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET plan = excluded.plan, limit_5h = excluded.limit_5h,
           limit_7d = excluded.limit_7d, limit_source = excluded.limit_source,
           thresholds = excluded.thresholds, detected_plan = excluded.detected_plan`,
      )
      .run(
        profileId,
        c.plan,
        c.limit5h,
        c.limit7d,
        c.limitSource,
        JSON.stringify(normalizeThresholds(c.thresholds)),
        detectedPlan,
      );
  }

  /**
   * User edits. Entering a limit makes it "manual" (never replaced by observations);
   * choosing a plan without limits goes back to the plan's preset.
   */
  setConfig(
    profileId: string,
    patch: { plan?: Plan; limit5h?: number | null; limit7d?: number | null; thresholds?: number[] },
  ): ProfileUsage | undefined {
    const { config, detectedPlan } = this.config(profileId);
    const next: UsageConfig = { ...config };
    if (patch.plan !== undefined) next.plan = patch.plan;
    if (patch.thresholds !== undefined) next.thresholds = normalizeThresholds(patch.thresholds);
    const valid = (n: number | null | undefined) =>
      n === null || n === undefined ? null : Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    if (patch.limit5h !== undefined || patch.limit7d !== undefined) {
      next.limit5h = patch.limit5h !== undefined ? valid(patch.limit5h) : next.limit5h;
      next.limit7d = patch.limit7d !== undefined ? valid(patch.limit7d) : next.limit7d;
      next.limitSource = next.limit5h || next.limit7d ? 'manual' : 'none';
    } else if (patch.plan !== undefined) {
      next.limit5h = null;
      next.limit7d = null;
      next.limitSource = 'none';
    }
    this.saveConfig(profileId, next, detectedPlan);
    this.refreshAll();
    return this.latest.find((u) => u.profileId === profileId);
  }

  setDetectedPlan(profileId: string, plan: string | null): void {
    const { config, detectedPlan } = this.config(profileId);
    if (plan === detectedPlan) return;
    this.saveConfig(profileId, config, plan);
    this.refreshAll();
  }

  // ---------- observations ----------

  /** A "limit reached" message was seen in one of this profile's sessions. */
  onLimitMessage(profileId: string, msg: LimitMessage): void {
    const now = this.now();
    const prev = this.limitHits.get(profileId);
    if (prev && now - prev.at < 10 * 60_000 && prev.window === msg.window) return;
    this.limitHits.set(profileId, { at: now, window: msg.window, resetText: msg.resetText });
    const usage = this.compute(profileId, now);
    // Calibrate: the usage at which the real limit hit is a better limit than the preset.
    const { config, detectedPlan } = this.config(profileId);
    if (config.limitSource !== 'manual') {
      const eff = effectiveLimits(config, detectedPlan);
      const used = msg.window === '5h' ? usage.fiveHour.used : usage.sevenDay.used;
      if (used > 0) {
        const next: UsageConfig = {
          ...config,
          limit5h: msg.window === '5h' ? used : eff.limit5h,
          limit7d: msg.window === '7d' ? used : eff.limit7d,
          limitSource: 'observed',
        };
        this.saveConfig(profileId, next, detectedPlan);
      }
    }
    const key = `${msg.window}:${usage.fiveHour.start ?? Math.floor(now / 3_600_000)}`;
    if (this.markOnce(profileId, 'limit', key, 0)) {
      this.deps.notify(
        'limitReached',
        { profile: this.name(profileId), reset: msg.resetText ?? '-', window: msg.window },
        profileId,
      );
    }
    this.refreshAll();
  }

  /** All kept entries per profile (statistics, §5). */
  allEntries(): Map<string, UsageEntry[]> {
    const now = this.now();
    return new Map(this.deps.profiles().map((p) => [p.id, this.entries(p.id, p.configDir, now)]));
  }

  // ---------- computation ----------

  refreshAll(): ProfileUsage[] {
    const now = this.now();
    const profiles = this.deps.profiles();
    for (const id of [...this.scanners.keys()])
      if (!profiles.some((p) => p.id === id)) this.scanners.delete(id);
    this.latest = profiles.map((p) => {
      const u = this.compute(p.id, now, p.configDir);
      this.announce(p, u, now);
      return u;
    });
    this.deps.onChanged(this.latest);
    return this.latest;
  }

  private entries(profileId: string, configDir?: string, now = this.now()) {
    let s = this.scanners.get(profileId);
    if (!s) {
      const dir = configDir ?? this.deps.profiles().find((p) => p.id === profileId)?.configDir;
      if (!dir) return [];
      s = new TranscriptScanner(dir);
      this.scanners.set(profileId, s);
    }
    return s.scan(now);
  }

  private compute(profileId: string, now: number, configDir?: string): ProfileUsage {
    const { config, detectedPlan } = this.config(profileId);
    const eff = effectiveLimits(config, detectedPlan);
    const w = computeWindows(this.entries(profileId, configDir, now), now, eff);
    const hit = this.limitHits.get(profileId) ?? null;
    // A limit hit belongs to the block it happened in; drop it when that block is over.
    const hitActive =
      hit && (hit.window === '7d' || (w.fiveHour.resetAt !== null && hit.at >= (w.fiveHour.start ?? 0)));
    if (hit && !hitActive) this.limitHits.delete(profileId);
    return {
      profileId,
      detectedPlan,
      config: { ...config, limit5h: eff.limit5h, limit7d: eff.limit7d, limitSource: eff.source },
      fiveHour: w.fiveHour,
      sevenDay: w.sevenDay,
      limitHit: hitActive ? hit : null,
      updatedAt: now,
    };
  }

  private announce(p: Profile, u: ProfileUsage, now: number): void {
    const thresholds = u.config.thresholds;
    // 5h: one set of alerts per block.
    if (u.fiveHour.start !== null) {
      const key = String(u.fiveHour.start);
      this.announceWindow(p, '5h', key, u.fiveHour.percent, thresholds, u.fiveHour.used, u.fiveHour.limit);
    }
    // 7d (rolling): alerts re-arm once usage falls well below the threshold.
    const pct7 = u.sevenDay.percent;
    if (pct7 !== null) {
      for (const t of thresholds)
        if (pct7 < t - REARM_POINTS)
          this.deps.db
            .prepare("DELETE FROM usage_alerts WHERE profile_id = ? AND window = '7d' AND threshold = ?")
            .run(p.id, t);
      this.announceWindow(p, '7d', 'rolling', pct7, thresholds, u.sevenDay.used, u.sevenDay.limit);
    }
    // Reset: a block that got close to (or hit) the limit has ended → "available again".
    const blocks = fiveHourBlocks(this.entries(p.id, p.configDir, now));
    const last = [...blocks].reverse().find((b) => b.end <= now);
    if (last && now - last.end < RESET_ANNOUNCE_WINDOW) {
      const key = String(last.start);
      const wasHigh =
        (u.config.limit5h && (last.used / u.config.limit5h) * 100 >= 90) ||
        this.wasAnnounced(p.id, 'limit', `5h:${key}`);
      if (wasHigh && this.markOnce(p.id, 'reset', key, 0))
        this.deps.notify('usageReset', { profile: p.name }, p.id);
    }
  }

  private announceWindow(
    p: Profile,
    window: UsageWindow,
    key: string,
    percent: number | null,
    thresholds: number[],
    used: number,
    limit: number | null,
  ): void {
    const done = new Set(
      (
        this.deps.db
          .prepare(
            'SELECT threshold FROM usage_alerts WHERE profile_id = ? AND window = ? AND window_key = ?',
          )
          .all(p.id, window, key) as { threshold: number }[]
      ).map((r) => r.threshold),
    );
    const { announce, markDone } = thresholdsToAnnounce(percent, thresholds, done);
    for (const t of markDone) this.markOnce(p.id, window, key, t);
    if (announce !== null)
      this.deps.notify(
        'usageThreshold',
        {
          profile: p.name,
          window,
          threshold: announce,
          percent: Math.round(percent ?? 0),
          used: formatTokens(used),
          limit: limit ? formatTokens(limit) : '-',
        },
        p.id,
      );
  }

  /** Record an alert; false if it was already recorded (so it is never sent twice). */
  private markOnce(profileId: string, window: string, key: string, threshold: number): boolean {
    const r = this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO usage_alerts (profile_id, window, window_key, threshold, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(profileId, window, key, threshold, this.now());
    return Number(r.changes) > 0;
  }

  private wasAnnounced(profileId: string, window: string, key: string): boolean {
    return !!this.deps.db
      .prepare('SELECT 1 FROM usage_alerts WHERE profile_id = ? AND window = ? AND window_key = ?')
      .get(profileId, window, key);
  }

  private name(profileId: string): string {
    return this.deps.profiles().find((p) => p.id === profileId)?.name ?? '';
  }
}
