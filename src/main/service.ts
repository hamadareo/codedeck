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
import { authStatus, buildSpawnSpec, resolveClaude, sessionArgs } from './platform/claude';
import { defaultProfileDir } from './platform/paths';
import { claudeEnv } from './platform/env';
import { launchExternal, resolveCommand } from './platform/externalTerminal';
import type { SettingsStore } from './settings';
import { DEFAULT_COLORS, validateProfileName } from '@shared/profileRules';
import type {
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
  private readonly home: string;
  private readonly loginWatchers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: ServiceDeps) {
    this.profiles = new ProfileRepo(deps.db);
    this.projects = new ProjectRepo(deps.db);
    this.sessions = new SessionRepo(deps.db);
    this.ptys = new PtyManager(deps.ptyEvents);
    this.home = deps.home ?? os.homedir();
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
    this.sessions.remove(id);
    this.deps.onChange('sessions');
  }

  private launchArgs(s: Session, p: Profile): string[] {
    return sessionArgs(s.id, shouldResume(p.configDir, s.id));
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
    const spec = buildSpawnSpec({ claudePath, args: this.launchArgs(s, p), configDir: p.configDir });
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
    const launch = { claudePath, configDir: p.configDir, cwd: s.cwd, args: this.launchArgs(s, p) };
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

  shutdown(): void {
    for (const id of [...this.loginWatchers.keys()]) this.stopLoginWatch(id);
    this.ptys.stopAll();
  }
}
