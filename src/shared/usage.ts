/**
 * Usage estimation (§7). Pure functions over (timestamp, tokens) entries read
 * from the transcripts' `message.usage`; shared by main, renderer and tests.
 */

export interface UsageEntry {
  ts: number;
  tokens: number;
}

export const HOUR = 3_600_000;
export const FIVE_HOURS = 5 * HOUR;
export const SEVEN_DAYS = 7 * 24 * HOUR;

export type UsageWindow = '5h' | '7d';

export interface WindowUsage {
  used: number;
  limit: number | null;
  /** 0–∞ (may exceed 100); null without a limit. */
  percent: number | null;
  /** 5h: block start; 7d: now − 7 days. */
  start: number | null;
  /** When this window frees up: 5h block end; 7d when the oldest entry leaves the window. */
  resetAt: number | null;
}

export type Plan = 'auto' | 'pro' | 'max5' | 'max20' | 'team' | 'enterprise' | 'custom';
export type LimitSource = 'preset' | 'observed' | 'manual' | 'none';

export interface UsageConfig {
  plan: Plan;
  limit5h: number | null;
  limit7d: number | null;
  limitSource: LimitSource;
  thresholds: number[];
}

export interface ProfileUsage {
  profileId: string;
  /** Plan detected from `claude auth status` (subscriptionType), if any. */
  detectedPlan: string | null;
  config: UsageConfig;
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
  /** A "limit reached" message was seen in a session's output. */
  limitHit: { at: number; window: UsageWindow; resetText: string | null } | null;
  updatedAt: number;
}

export const DEFAULT_THRESHOLDS = [70, 90, 100];

/**
 * Rough starting points per plan, in tokens (input + output + cache writes).
 * NOT official: Anthropic does not publish token limits. They are shown as
 * "仮の目安" and replaced by the observed value once a limit message is seen.
 */
export const PLAN_PRESETS: Record<Exclude<Plan, 'auto' | 'custom'>, { limit5h: number; limit7d: number }> = {
  pro: { limit5h: 4_000_000, limit7d: 40_000_000 },
  max5: { limit5h: 20_000_000, limit7d: 200_000_000 },
  max20: { limit5h: 80_000_000, limit7d: 800_000_000 },
  team: { limit5h: 5_000_000, limit7d: 50_000_000 },
  enterprise: { limit5h: 5_000_000, limit7d: 50_000_000 },
};

/** Map `subscriptionType` from `claude auth status --json` to a preset. */
export function planFromSubscription(
  sub: string | null | undefined,
): Exclude<Plan, 'auto' | 'custom'> | null {
  const s = (sub ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('20')) return 'max20';
  if (s.includes('max')) return 'max5';
  if (s.includes('pro')) return 'pro';
  if (s.includes('team')) return 'team';
  if (s.includes('enterprise')) return 'enterprise';
  return null;
}

export function defaultConfig(): UsageConfig {
  return {
    plan: 'auto',
    limit5h: null,
    limit7d: null,
    limitSource: 'none',
    thresholds: [...DEFAULT_THRESHOLDS],
  };
}

/** Limits in effect: manual/observed values win; otherwise the plan (or detected plan) preset. */
export function effectiveLimits(
  cfg: UsageConfig,
  detectedPlan: string | null,
): { limit5h: number | null; limit7d: number | null; source: LimitSource } {
  if (cfg.limitSource === 'manual' || cfg.limitSource === 'observed')
    return { limit5h: cfg.limit5h, limit7d: cfg.limit7d, source: cfg.limitSource };
  const plan =
    cfg.plan === 'auto' ? planFromSubscription(detectedPlan) : cfg.plan === 'custom' ? null : cfg.plan;
  if (!plan) return { limit5h: null, limit7d: null, source: 'none' };
  return { ...PLAN_PRESETS[plan], source: 'preset' };
}

export interface Block {
  start: number;
  end: number;
  used: number;
}

/** 5-hour blocks: a block starts at the hour of the first message after the previous block ended. */
export function fiveHourBlocks(entries: UsageEntry[]): Block[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const e of sorted) {
    if (!cur || e.ts >= cur.end) {
      const start = Math.floor(e.ts / HOUR) * HOUR;
      cur = { start, end: start + FIVE_HOURS, used: 0 };
      blocks.push(cur);
    }
    cur.used += e.tokens;
  }
  return blocks;
}

function windowOf(
  used: number,
  limit: number | null,
  start: number | null,
  resetAt: number | null,
): WindowUsage {
  return {
    used,
    limit,
    percent: limit && limit > 0 ? (used / limit) * 100 : null,
    start,
    resetAt,
  };
}

export function computeWindows(
  entries: UsageEntry[],
  now: number,
  limits: { limit5h: number | null; limit7d: number | null },
): { fiveHour: WindowUsage; sevenDay: WindowUsage; currentBlock: Block | null } {
  const blocks = fiveHourBlocks(entries.filter((e) => e.ts <= now));
  const last = blocks.at(-1);
  const current = last && now < last.end ? last : null;
  const since = now - SEVEN_DAYS;
  const week = entries.filter((e) => e.ts > since && e.ts <= now);
  const oldest = week.reduce((m, e) => Math.min(m, e.ts), Infinity);
  return {
    fiveHour: windowOf(current?.used ?? 0, limits.limit5h, current?.start ?? null, current?.end ?? null),
    sevenDay: windowOf(
      week.reduce((s, e) => s + e.tokens, 0),
      limits.limit7d,
      since,
      Number.isFinite(oldest) ? oldest + SEVEN_DAYS : null,
    ),
    currentBlock: current,
  };
}

/**
 * Thresholds to announce now. Crossing several at once announces only the
 * highest (and marks the lower ones as done). Already-announced ones never repeat.
 */
export function thresholdsToAnnounce(
  percent: number | null,
  thresholds: number[],
  announced: ReadonlySet<number>,
): { announce: number | null; markDone: number[] } {
  if (percent === null) return { announce: null, markDone: [] };
  const crossed = thresholds.filter((t) => percent >= t && !announced.has(t)).sort((a, b) => a - b);
  if (crossed.length === 0) return { announce: null, markDone: [] };
  return { announce: crossed.at(-1)!, markDone: crossed };
}

/** Sanitize user-entered thresholds: integers 1–200, unique, ascending, at most 6. */
export function normalizeThresholds(input: unknown): number[] {
  if (!Array.isArray(input)) return [...DEFAULT_THRESHOLDS];
  const nums = input
    .map((x) => Math.round(Number(x)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 200);
  const out = [...new Set(nums)].sort((a, b) => a - b).slice(0, 6);
  return out.length ? out : [...DEFAULT_THRESHOLDS];
}

export type LimitMessage = { window: UsageWindow; resetText: string | null };

/**
 * Detect Claude Code's "limit reached" messages in terminal text (ANSI already stripped).
 * Matches phrasings like "5-hour limit reached ∙ resets 3pm", "Claude usage limit reached.
 * Your limit will reset at 5pm (Asia/Tokyo)", "You've hit your weekly limit · resets Oct 15, 9am".
 */
export function detectLimitMessage(text: string): LimitMessage | null {
  const m = /(usage limit reached|limit reached|hit your (?:\w+ )?(?:usage )?limit)/i.exec(text);
  if (!m) return null;
  const around = text.slice(Math.max(0, m.index - 40), m.index + 200);
  const window: UsageWindow = /weekly|7-day|week/i.test(around) ? '7d' : '5h';
  const reset = /resets?(?: at)?\s+([^\n·∙|]{1,48}?)(?:\s*[.·∙|]\s|\s{2,}|$|\n)/i.exec(text.slice(m.index));
  const resetText = reset?.[1]?.trim().replace(/[.\s]+$/, '') || null;
  return { window, resetText };
}

/** "2時間10分" / "2h 10m". */
export function formatDuration(ms: number, locale: 'ja' | 'en'): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (locale === 'ja') {
    if (d) return `${d}日${h}時間`;
    if (h) return `${h}時間${m}分`;
    return `${m}分`;
  }
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "1.2M" / "850K" / "999". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

export function usageLevel(percent: number | null): 'none' | 'ok' | 'warn' | 'danger' {
  if (percent === null) return 'none';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'ok';
}
