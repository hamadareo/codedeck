import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from './db/database';
import { ProfileRepo } from './profiles/profileRepo';
import { ProjectRepo } from './projects/projectRepo';
import { SessionRepo } from './sessions/sessionRepo';
import { PtyManager, type PtyEvents } from './sessions/ptyManager';
import { shouldResume } from './sessions/transcript';
import { StatusWatcher } from './sessions/statusWatcher';
import { STATUS_FILE_ENV, writeHookSettings } from './sessions/hooks';
import { NoteRepo } from './projects/noteRepo';
import { nextActivity, type ActivityEvent } from '@shared/status';
import { authStatus, buildSpawnSpec, resolveClaude, sessionArgs } from './platform/claude';
import { defaultProfileDir } from './platform/paths';
import { claudeEnv } from './platform/env';
import { launchExternal, resolveCommand } from './platform/externalTerminal';
import type { SettingsStore } from './settings';
import { DEFAULT_COLORS, validateProfileName } from '@shared/profileRules';
import type {
  Activity,
  NewProfileInput,
  NewProjectInput,
  NewSessionInput,
  Profile,
  Project,
  Session,
} from '@shared/types';

export type ChangeKind = 'profiles' | 'projects' | 'sessions';

export interface ServiceDeps {
  db: Db;
  settings: SettingsStore;
  ptyEvents: PtyEvents;
  onChange(kind: ChangeKind): void;
  onActivity?(sessionId: string, activity: Activity): void;
  /** Where hook status files and the hook settings file live (userData). Omit to run without hooks. */
  stateDir?: string;
  home?: string;
}

const LOGIN_POLL_MS = 4000;
const LOGIN_POLL_LIMIT_MS = 15 * 60 * 1000;

/** All app logic that does not depend on Electron itself (testable from Vitest). */
export class CodeDeckService {
  readonly profiles: ProfileRepo;
  readonly projects: ProjectRepo;
  readonly sessions: SessionRepo;
  readonly ptys: PtyManager;
  readonly notes: NoteRepo;
  private readonly home: string;
  private readonly loginWatchers = new Map<string, NodeJS.Timeout>();
  private readonly activities = new Map<string, Activity>();
  private readonly status: StatusWatcher | null;
  private readonly hookSettingsFile: string | null;

  constructor(private readonly deps: ServiceDeps) {
    this.profiles = new ProfileRepo(deps.db);
    this.projects = new ProjectRepo(deps.db);
    this.sessions = new SessionRepo(deps.db);
    this.notes = new NoteRepo(deps.db);
    this.ptys = new PtyManager({
      onData: deps.ptyEvents.onData,
      onState: (id, state, code) => {
        if (state !== 'running') {
          this.status?.end(id);
          this.activities.delete(id);
        }
        deps.ptyEvents.onState(id, state, code);
      },
    });
    this.home = deps.home ?? os.homedir();
    if (deps.stateDir) {
      this.status = new StatusWatcher(path.join(deps.stateDir, 'status'), (id, word) =>
        this.applyActivity(id, word),
      );
      this.hookSettingsFile = writeHookSettings(deps.stateDir);
    } else {
      this.status = null;
      this.hookSettingsFile = null;
    }
  }

  // ---------- activity (session status via hooks) ----------

  activity(id: string): Activity {
    return this.activities.get(id) ?? 'unknown';
  }

  allActivities(): Record<string, Activity> {
    return Object.fromEntries(this.activities);
  }

  applyActivity(id: string, ev: ActivityEvent): void {
    if (!this.ptys.isRunning(id)) return;
    const prev = this.activity(id);
    const next = nextActivity(prev, ev);
    if (next === prev) return;
    this.activities.set(id, next);
    this.deps.onActivity?.(id, next);
  }

  /** Keystrokes from the user. Answering an approval prompt moves the session back to "working". */
  input(id: string, data: string): void {
    this.ptys.write(id, data);
    if (this.activities.get(id) === 'approval') this.applyActivity(id, 'input');
  }

  /** The session is on screen: a finished turn has been seen. */
  seen(id: string): void {
    if (this.activities.get(id) === 'done') this.applyActivity(id, 'seen');
  }

  // ---------- profiles ----------

  createProfile(input: NewProfileInput): Profile {
    const err = validateProfileName(input.name, this.profiles.list());
    if (err) throw new Error(err);
    const name = input.name.trim();
    const configDir = input.configDir?.trim() || defaultProfileDir(name, this.home);
    fs.mkdirSync(configDir, { recursive: true });
    const p = this.profiles.insert({
      name,
      kind: input.kind,
      color: input.color || DEFAULT_COLORS[input.kind],
      icon: input.icon ?? '',
      note: input.note ?? '',
      configDir,
    });
    this.deps.onChange('profiles');
    return p;
  }

  updateProfile(id: string, patch: Parameters<ProfileRepo['update']>[1]): Profile {
    if (patch.name !== undefined) {
      const others = this.profiles.list().filter((p) => p.id !== id);
      const err = validateProfileName(patch.name, others);
      if (err) throw new Error(err);
      patch = { ...patch, name: patch.name.trim() };
    }
    const p = this.profiles.update(id, patch);
    this.deps.onChange('profiles');
    return p;
  }

  /** Removes the profile from the app. Its config dir (and the login inside) is left untouched. */
  removeProfile(id: string): { configDir: string } {
    const p = this.profiles.get(id);
    if (!p) throw new Error(`profile not found: ${id}`);
    for (const s of this.sessions.list().filter((s) => s.profileId === id)) this.ptys.stop(s.id);
    this.stopLoginWatch(id);
    this.profiles.remove(id);
    this.deps.onChange('profiles');
    this.deps.onChange('projects');
    this.deps.onChange('sessions');
    return { configDir: p.configDir };
  }

  async checkAuth(id: string): Promise<Profile> {
    const p = this.profiles.get(id);
    if (!p) throw new Error(`profile not found: ${id}`);
    const res = await authStatus(p.configDir);
    if (!this.profiles.get(id)) return p; // removed meanwhile
    const next = res
      ? this.profiles.setAuth(id, res.loggedIn ? 'connected' : 'logged_out', res.loggedIn ? res.email : null)
      : this.profiles.setAuth(id, 'unknown', p.accountEmail);
    if (next.authStatus !== p.authStatus || next.accountEmail !== p.accountEmail)
      this.deps.onChange('profiles');
    return next;
  }

  checkAllAuth(): Promise<unknown> {
    return Promise.allSettled(this.profiles.list().map((p) => this.checkAuth(p.id)));
  }

  /** §3-2: while a not-yet-connected profile has a running session, poll until /login completes. */
  private watchLogin(profileId: string): void {
    if (this.loginWatchers.has(profileId)) return;
    const startedAt = Date.now();
    const tick = async () => {
      const p = this.profiles.get(profileId);
      const running = this.sessions
        .list()
        .some((s) => s.profileId === profileId && this.ptys.isRunning(s.id));
      if (!p || !running || Date.now() - startedAt > LOGIN_POLL_LIMIT_MS)
        return this.stopLoginWatch(profileId);
      const next = await this.checkAuth(profileId).catch(() => null);
      if (next?.authStatus === 'connected') return this.stopLoginWatch(profileId);
      this.loginWatchers.set(profileId, setTimeout(tick, LOGIN_POLL_MS));
    };
    this.loginWatchers.set(profileId, setTimeout(tick, LOGIN_POLL_MS));
  }

  private stopLoginWatch(profileId: string): void {
    const t = this.loginWatchers.get(profileId);
    if (t) clearTimeout(t);
    this.loginWatchers.delete(profileId);
  }

  // ---------- projects ----------

  createProject(input: NewProjectInput): Project {
    const p = this.projects.insert({
      name: input.name.trim() || path.basename(input.path),
      path: input.path,
      pinnedProfileId: input.pinnedProfileId ?? null,
    });
    this.deps.onChange('projects');
    return p;
  }

  updateProject(id: string, patch: Parameters<ProjectRepo['update']>[1]): Project {
    const p = this.projects.update(id, patch);
    this.deps.onChange('projects');
    return p;
  }

  removeProject(id: string): void {
    this.projects.remove(id);
    this.deps.onChange('projects');
    this.deps.onChange('sessions');
  }

  // ---------- sessions ----------

  createSession(input: NewSessionInput): Session {
    const profile = this.profiles.get(input.profileId);
    if (!profile) throw new Error(`profile not found: ${input.profileId}`);
    const project = input.projectId ? this.projects.get(input.projectId) : null;
    const base = project?.name ?? (path.basename(input.cwd) || input.cwd);
    const n = this.sessions.list().filter((s) => s.title.startsWith(base)).length + 1;
    const s = this.sessions.insert({
      id: randomUUID(),
      title: input.title?.trim() || `${base} #${n}`,
      projectId: project?.id ?? null,
      profileId: profile.id,
      cwd: input.cwd,
    });
    this.deps.onChange('sessions');
    return s;
  }

  closeSession(id: string): void {
    this.ptys.stop(id);
    this.sessions.patch(id, { open: false });
    this.deps.onChange('sessions');
  }

  reopenSession(id: string): Session {
    const s = this.sessions.patch(id, { open: true });
    this.deps.onChange('sessions');
    return s;
  }

  removeSession(id: string): void {
    this.ptys.stop(id);
    this.status?.remove(id);
    this.sessions.remove(id);
    this.deps.onChange('sessions');
  }

  renameSession(id: string, title: string): Session {
    const t = title.trim().slice(0, 120);
    if (!t) throw new Error('session.error.titleRequired');
    const s = this.sessions.patch(id, { title: t });
    this.deps.onChange('sessions');
    return s;
  }

  private launchArgs(s: Session, p: Profile, withHooks: boolean): string[] {
    return sessionArgs(
      s.id,
      shouldResume(p.configDir, s.id),
      withHooks ? (this.hookSettingsFile ?? undefined) : undefined,
    );
  }

  startPty(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    if (s.location !== 'embedded' || this.ptys.isRunning(id)) return;
    const p = this.profiles.get(s.profileId);
    if (!p) throw new Error(`profile not found: ${s.profileId}`);
    const claudePath = resolveClaude();
    if (!claudePath) throw new Error('claude.notFound');
    const cwd = fs.existsSync(s.cwd) ? s.cwd : this.home;
    const statusFile = this.status?.begin(id);
    const spec = buildSpawnSpec({
      claudePath,
      args: this.launchArgs(s, p, !!statusFile),
      configDir: p.configDir,
      extraEnv: statusFile ? { [STATUS_FILE_ENV]: statusFile } : undefined,
    });
    if (this.ptys.state(id) === 'exited') this.ptys.note(id, '\r\n\x1b[2m────────\x1b[0m\r\n');
    this.ptys.start(id, spec, cwd, cols, rows);
    if (!s.started) {
      this.sessions.patch(id, { started: true });
      this.deps.onChange('sessions');
    }
    if (p.authStatus !== 'connected') this.watchLogin(p.id);
  }

  /** §2.6-5: hand the session to an OS terminal. The embedded PTY is stopped first so one id runs once. */
  async openExternal(id: string): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    const p = this.profiles.get(s.profileId);
    if (!p) throw new Error(`profile not found: ${s.profileId}`);
    const claudePath = resolveClaude();
    if (!claudePath) throw new Error('claude.notFound');
    this.ptys.stop(id);
    const launch = { claudePath, configDir: p.configDir, cwd: s.cwd, args: this.launchArgs(s, p, false) };
    const cmd = resolveCommand(launch, this.deps.settings.get().externalTerminal);
    await launchExternal(cmd, claudeEnv(process.env, p.configDir));
    const next = this.sessions.patch(id, { location: 'external', started: true });
    this.deps.onChange('sessions');
    return next;
  }

  /** Bring an external session back into the app (the user should quit it in the OS terminal first). */
  reclaim(id: string): Session {
    const next = this.sessions.patch(id, { location: 'embedded' });
    this.deps.onChange('sessions');
    return next;
  }

  // ---------- notes ----------

  getNote(projectId: string): string {
    return this.notes.get(projectId);
  }

  setNote(projectId: string, body: string): void {
    if (!this.projects.get(projectId)) throw new Error(`project not found: ${projectId}`);
    this.notes.set(projectId, body);
  }

  shutdown(): void {
    for (const id of [...this.loginWatchers.keys()]) this.stopLoginWatch(id);
    this.ptys.stopAll();
    this.status?.close();
  }
}
