/**
 * Statistics (§5): usage, sessions and work time per project and profile. Pure.
 */
import type { Profile, Project, Session, Stats, StatsRow } from './types';
import type { UsageEntry } from './usage';

const DAY = 24 * 3_600_000;

export interface WorkSpan {
  sessionId: string;
  startedAt: number;
  endedAt: number;
}

/** "YYYY-MM-DD" in local time (offset in minutes as from Date#getTimezoneOffset). */
export function localDate(ts: number, tzOffsetMin: number): string {
  return new Date(ts - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

export function computeStats(input: {
  days: number;
  now: number;
  tzOffsetMin: number;
  entries: Map<string, UsageEntry[]>; // per profile id
  sessions: Session[];
  projects: Project[];
  profiles: Profile[];
  work: WorkSpan[];
  labels: { outside: string; noProject: string };
}): Stats {
  const { days, now, tzOffsetMin } = input;
  const since = now - days * DAY;
  // Transcripts are named by conversation id: a session that resumed another conversation owns it too.
  const sessionById = new Map(
    input.sessions.flatMap((s) => [
      [s.id, s] as const,
      ...(s.conversationId ? [[s.conversationId, s] as const] : []),
    ]),
  );
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const profileName = new Map(input.profiles.map((p) => [p.id, p.name]));

  const byProject = new Map<string, StatsRow & { ids: Set<string> }>();
  const byProfile = new Map<string, StatsRow & { ids: Set<string> }>();
  const row = (m: Map<string, StatsRow & { ids: Set<string> }>, key: string, label: string) => {
    let r = m.get(key);
    if (!r) {
      r = { key, label, tokens: 0, sessions: 0, workMs: 0, ids: new Set() };
      m.set(key, r);
    }
    return r;
  };
  const projectKey = (s: Session | undefined): [string, string] => {
    if (!s) return ['__outside', input.labels.outside];
    if (!s.projectId || !projectName.has(s.projectId)) return ['__none', input.labels.noProject];
    return [s.projectId, projectName.get(s.projectId)!];
  };

  // Daily buckets, oldest first.
  const daily = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) daily.set(localDate(now - i * DAY, tzOffsetMin), 0);

  for (const [profileId, list] of input.entries) {
    for (const e of list) {
      if (e.ts <= since || e.ts > now) continue;
      const s = e.session ? sessionById.get(e.session) : undefined;
      const [pk, pl] = projectKey(s);
      const pr = row(byProject, pk, pl);
      pr.tokens += e.tokens;
      if (e.session) pr.ids.add(e.session);
      const fr = row(byProfile, profileId, profileName.get(profileId) ?? '?');
      fr.tokens += e.tokens;
      if (e.session) fr.ids.add(e.session);
      const d = localDate(e.ts, tzOffsetMin);
      if (daily.has(d)) daily.set(d, daily.get(d)! + e.tokens);
    }
  }

  for (const w of input.work) {
    const start = Math.max(w.startedAt, since);
    const end = Math.min(w.endedAt, now);
    if (end <= start) continue;
    const s = sessionById.get(w.sessionId);
    if (!s) continue;
    const [pk, pl] = projectKey(s);
    const pr = row(byProject, pk, pl);
    pr.workMs += end - start;
    pr.ids.add(s.id);
    const fr = row(byProfile, s.profileId, profileName.get(s.profileId) ?? '?');
    fr.workMs += end - start;
    fr.ids.add(s.id);
  }

  const finish = (m: Map<string, StatsRow & { ids: Set<string> }>): StatsRow[] =>
    [...m.values()]
      .map(({ ids, ...r }) => ({ ...r, sessions: ids.size }))
      .sort((a, b) => b.tokens - a.tokens || b.workMs - a.workMs);

  const projects = finish(byProject);
  const allIds = new Set<string>();
  for (const r of byProject.values()) r.ids.forEach((id) => allIds.add(id));
  return {
    days,
    byProject: projects,
    byProfile: finish(byProfile),
    daily: [...daily].map(([date, tokens]) => ({ date, tokens })),
    totalTokens: projects.reduce((s, r) => s + r.tokens, 0),
    totalSessions: allIds.size,
    totalWorkMs: projects.reduce((s, r) => s + r.workMs, 0),
  };
}
