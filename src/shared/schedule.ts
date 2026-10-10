/**
 * Scheduled prompts (§5 スケジュール実行). Pure time rules, in local time.
 */

export type ScheduleRule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; day: number; time: string } // 0 = Sunday
  | { kind: 'once'; at: number };

export interface Schedule {
  id: string;
  name: string;
  rule: ScheduleRule;
  profileId: string;
  projectId: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
}

export interface ScheduleInput {
  name: string;
  rule: ScheduleRule;
  profileId: string;
  projectId: string | null;
  prompt: string;
  enabled: boolean;
}

/** "HH:MM" → minutes after midnight, or null. */
export function parseTime(t: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function validateRule(rule: ScheduleRule): string | null {
  if (rule.kind === 'once') return Number.isFinite(rule.at) ? null : 'schedule.error.time';
  if (parseTime(rule.time) === null) return 'schedule.error.time';
  if (rule.kind === 'weekly' && !(Number.isInteger(rule.day) && rule.day >= 0 && rule.day <= 6))
    return 'schedule.error.day';
  return null;
}

/**
 * The first run strictly after `after` (local time via the Date object), or null
 * when the rule will not run again (a past one-off).
 */
export function nextRun(rule: ScheduleRule, after: number): number | null {
  if (rule.kind === 'once') return rule.at > after ? rule.at : null;
  const minutes = parseTime(rule.time);
  if (minutes === null) return null;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(d);
    candidate.setDate(d.getDate() + i);
    if (candidate.getTime() <= after) continue;
    const dow = candidate.getDay();
    if (rule.kind === 'weekdays' && (dow === 0 || dow === 6)) continue;
    if (rule.kind === 'weekly' && dow !== rule.day) continue;
    return candidate.getTime();
  }
  return null;
}

/** A run is "missed" (not executed late) when the app was not running at its time. */
export const MISSED_GRACE_MS = 5 * 60_000;

export function isMissed(dueAt: number, now: number): boolean {
  return now - dueAt > MISSED_GRACE_MS;
}
