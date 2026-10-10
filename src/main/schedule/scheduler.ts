import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import {
  isMissed,
  nextRun,
  validateRule,
  type Schedule,
  type ScheduleInput,
  type ScheduleRule,
} from '@shared/schedule';
import type { NotifyKind } from '@shared/notify';
import type { Session } from '@shared/types';

interface Row {
  id: string;
  name: string;
  rule: string;
  profile_id: string;
  project_id: string | null;
  prompt: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  name: r.name,
  rule: JSON.parse(r.rule) as ScheduleRule,
  profileId: r.profile_id,
  projectId: r.project_id,
  prompt: r.prompt,
  enabled: r.enabled === 1,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
  createdAt: r.created_at,
});

export interface SchedulerDeps {
  db: Db;
  /** Opens a session for the profile/project and sends the prompt once claude waits for input. */
  run(s: Schedule): Promise<Session>;
  notify(kind: NotifyKind, vars: Record<string, string | number>, sessionId?: string): void;
  onChanged(): void;
  now?: () => number;
}

/**
 * Scheduled prompts (§5). Runs only while CodeDeck is running; a run whose time
 * passed while the app was closed is reported as missed, never executed late.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  list(): Schedule[] {
    return (
      this.deps.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as unknown as Row[]
    ).map(toSchedule);
  }

  get(id: string): Schedule | null {
    const r = this.deps.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return r ? toSchedule(r) : null;
  }

  private check(input: ScheduleInput): ScheduleInput {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error('schedule.error.name');
    if (!input.prompt.trim()) throw new Error('schedule.error.prompt');
    const err = validateRule(input.rule);
    if (err) throw new Error(err);
    return { ...input, name, prompt: input.prompt.slice(0, 20_000) };
  }

  create(input: ScheduleInput): Schedule {
    const s = this.check(input);
    const id = randomUUID();
    const next = s.enabled ? nextRun(s.rule, this.now()) : null;
    this.deps.db
      .prepare(
        `INSERT INTO schedules (id, name, rule, profile_id, project_id, prompt, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.name,
        JSON.stringify(s.rule),
        s.profileId,
        s.projectId,
        s.prompt,
        s.enabled ? 1 : 0,
        next,
        this.now(),
      );
    this.deps.onChanged();
    return this.get(id)!;
  }

  update(id: string, input: ScheduleInput): Schedule {
    if (!this.get(id)) throw new Error(`schedule not found: ${id}`);
    const s = this.check(input);
    const next = s.enabled ? nextRun(s.rule, this.now()) : null;
    this.deps.db
      .prepare(
        `UPDATE schedules SET name = ?, rule = ?, profile_id = ?, project_id = ?, prompt = ?, enabled = ?, next_run_at = ?
         WHERE id = ?`,
      )
      .run(s.name, JSON.stringify(s.rule), s.profileId, s.projectId, s.prompt, s.enabled ? 1 : 0, next, id);
    this.deps.onChanged();
    return this.get(id)!;
  }

  remove(id: string): void {
    this.deps.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.deps.onChanged();
  }

  hasEnabled(): boolean {
    return this.list().some((s) => s.enabled && s.nextRunAt !== null);
  }

  start(intervalMs = 30_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run what is due; report what was missed. Exposed for tests and "run now". */
  async tick(): Promise<void> {
    const now = this.now();
    for (const s of this.list()) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now || this.running.has(s.id)) continue;
      const due = s.nextRunAt;
      // Advance first, so a slow or failing run is never repeated.
      this.deps.db
        .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
        .run(nextRun(s.rule, Math.max(now, due)), s.id);
      if (isMissed(due, now)) {
        this.deps.notify('scheduleMissed', { name: s.name, time: new Date(due).toLocaleString() });
        this.deps.onChanged();
        continue;
      }
      await this.execute(s);
    }
  }

  async runNow(id: string): Promise<void> {
    const s = this.get(id);
    if (!s) throw new Error(`schedule not found: ${id}`);
    await this.execute(s);
  }

  private async execute(s: Schedule): Promise<void> {
    this.running.add(s.id);
    try {
      const session = await this.deps.run(s);
      this.deps.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(this.now(), s.id);
      this.deps.notify('scheduleRan', { name: s.name, session: session.title }, session.id);
    } catch (e) {
      this.deps.notify('scheduleFailed', { name: s.name, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running.delete(s.id);
      this.deps.onChanged();
    }
  }
}
