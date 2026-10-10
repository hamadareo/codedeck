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
import { ScreenMirror } from './discord/screenMirror';
import { TaskRepo } from './projects/taskRepo';
import { resolveSsh, SshRepo } from './ssh/sshRepo';
import { sshArgs, type SshHost, type SshHostInput } from '@shared/ssh';
import { sanitizeEnv } from './platform/env';
import { PromptRepo } from './prompts/promptRepo';
import { syncCommands } from './prompts/commandSync';
import { commitMessageRequest } from './git';
import { nextActivity, type ActivityEvent } from '@shared/status';
import { detectLimitMessage, type LimitMessage } from '@shared/usage';
import type { WorkSpan } from '@shared/stats';
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

/** Strip escape sequences so messages can be matched across colors and cursor moves. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const TAIL_CHARS = 2000;

export type ChangeKind =
  'profiles' | 'projects' | 'sessions' | 'tasks' | 'prompts' | 'sshHosts' | 'schedules';

export interface ServiceDeps {
  db: Db;
  settings: SettingsStore;
  ptyEvents: PtyEvents;
  onChange(kind: ChangeKind): void;
  onActivity?(sessionId: string, activity: Activity, prev: Activity): void;
  /** `claude auth status` reported this profile's subscription (for usage presets). */
  onPlan?(profileId: string, subscriptionType: string | null): void;
  /** A "limit reached" message appeared in a session's output (§7). */
  onLimit?(sessionId: string, profileId: string, msg: LimitMessage): void;
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
  readonly tasks: TaskRepo;
  readonly prompts: PromptRepo;
  readonly sshHosts: SshRepo;
  /** Clean screen text per session for Discord (§6); fed with the same output as the terminal. */
  readonly screens = new ScreenMirror();
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
    this.tasks = new TaskRepo(deps.db);
    this.prompts = new PromptRepo(deps.db);
    this.sshHosts = new SshRepo(deps.db);
    this.ptys = new PtyManager({
      onData: (id, data, end) => {
        deps.ptyEvents.onData(id, data, end);
        this.screens.write(id, data);
        this.observeOutput(id, data);
      },
      onState: (id, state, code) => {
        if (state !== 'running') {
          this.status?.end(id);
          this.endWork(id);
          this.activities.delete(id);
          this.tails.delete(id);
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
    if (next === 'working') this.workStart.set(id, Date.now());
    else if (prev === 'working') this.endWork(id);
    this.deps.onActivity?.(id, next, prev);
  }

  // ---------- work time (statistics, §5) ----------

  private readonly workStart = new Map<string, number>();

  /** Close an open "working" span and record it. */
  private endWork(id: string): void {
    const start = this.workStart.get(id);
    this.workStart.delete(id);
    if (start === undefined || !this.sessions.get(id)) return;
    const end = Date.now();
    if (end - start < 1000) return;
    this.deps.db
      .prepare('INSERT INTO work_log (session_id, started_at, ended_at) VALUES (?, ?, ?)')
      .run(id, start, end);
  }

  workSpans(since: number): WorkSpan[] {
    return (
      this.deps.db
        .prepare('SELECT session_id, started_at, ended_at FROM work_log WHERE ended_at > ?')
        .all(since) as { session_id: string; started_at: number; ended_at: number }[]
    ).map((r) => ({ sessionId: r.session_id, startedAt: r.started_at, endedAt: r.ended_at }));
  }

  private readonly tails = new Map<string, string>();

  /**
   * Watch a session's output for "limit reached" (§7). Read-only: the output
   * still goes to the terminal untouched. Only a short tail is kept, in memory.
   */
  observeOutput(id: string, data: string): void {
    const tail = ((this.tails.get(id) ?? '') + data.replace(ANSI, ' ')).slice(-TAIL_CHARS);
    const msg = detectLimitMessage(tail);
    if (!msg) {
      this.tails.set(id, tail);
      return;
    }
    // Consume the matched text so the same message is not reported again.
    this.tails.set(id, '');
    if (this.activities.get(id) === 'limit') return;
    this.applyActivity(id, 'limit');
    const s = this.sessions.get(id);
    if (s) this.deps.onLimit?.(id, s.profileId, msg);
  }

  /** Keystrokes from the user. Answering an approval prompt moves the session back to "working". */
  input(id: string, data: string): void {
    this.ptys.write(id, data);
    if (this.activities.get(id) === 'approval') this.applyActivity(id, 'input');
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.resize(id, cols, rows);
    this.screens.resize(id, cols, rows);
  }

  /**
   * Submit an instruction as if typed (Discord /send, /new). The text goes in as a
   * bracketed paste — multi-line text stays one message — and Enter follows separately,
   * so claude does not take it as part of the paste.
   */
  async submitText(id: string, text: string): Promise<void> {
    if (!this.ptys.isRunning(id)) throw new Error('session.notRunning');
    const clean = text.replace(/\r\n?/g, '\n');
    this.input(id, clean.includes('\n') ? `\x1b[200~${clean}\x1b[201~` : clean);
    await new Promise((r) => setTimeout(r, 150));
    this.input(id, '\r');
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
    // Prompts marked as commands are available in the new profile too.
    this.syncPromptCommands();
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
    if (res?.loggedIn) this.deps.onPlan?.(id, res.subscriptionType);
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
    const host = input.sshHostId ? this.sshHosts.get(input.sshHostId) : null;
    if (input.sshHostId && !host) throw new Error(`ssh host not found: ${input.sshHostId}`);
    const base = host ? `${host.name}` : (project?.name ?? (path.basename(input.cwd) || input.cwd));
    const n = this.sessions.list().filter((s) => s.title.startsWith(base)).length + 1;
    const s = this.sessions.insert({
      id: randomUUID(),
      title: input.title?.trim() || `${base} #${n}`,
      projectId: host ? null : (project?.id ?? null),
      profileId: profile.id,
      cwd: host ? host.remoteDir || '~' : input.cwd,
      sshHostId: host?.id ?? null,
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
    this.screens.dispose(id);
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
    if (s.sshHostId) return this.startSsh(s, cols, rows);
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
    this.screens.start(id, Math.max(cols, 2), Math.max(rows, 1));
    this.ptys.start(id, spec, cwd, cols, rows);
    if (!s.started) {
      this.sessions.patch(id, { started: true });
      this.deps.onChange('sessions');
    }
    if (p.authStatus !== 'connected') this.watchLogin(p.id);
  }

  /**
   * SSH session (§5): the OS ssh client runs claude on the remote machine. Hooks cannot
   * report back from there, so the status stays "running". The remote side resumes the
   * conversation when this id was used before.
   */
  private startSsh(s: Session, cols: number, rows: number): void {
    const host = this.sshHosts.get(s.sshHostId!);
    if (!host) throw new Error('ssh.error.hostGone');
    const ssh = resolveSsh();
    if (!ssh) throw new Error('ssh.error.noClient');
    const env = sanitizeEnv(process.env);
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    const spec = { file: ssh, args: sshArgs(host, s.id, s.started), env };
    if (this.ptys.state(s.id) === 'exited') this.ptys.note(s.id, '\r\n\x1b[2m────────\x1b[0m\r\n');
    this.screens.start(s.id, Math.max(cols, 2), Math.max(rows, 1));
    this.ptys.start(s.id, spec, this.home, cols, rows);
    if (!s.started) {
      this.sessions.patch(s.id, { started: true });
      this.deps.onChange('sessions');
    }
  }

  // ---------- SSH hosts ----------

  createSshHost(input: SshHostInput): SshHost {
    const h = this.sshHosts.create(input);
    this.deps.onChange('sshHosts');
    return h;
  }

  updateSshHost(id: string, input: SshHostInput): SshHost {
    const h = this.sshHosts.update(id, input);
    this.deps.onChange('sshHosts');
    return h;
  }

  removeSshHost(id: string): void {
    for (const s of this.sessions.list().filter((x) => x.sshHostId === id)) this.ptys.stop(s.id);
    this.sshHosts.remove(id);
    this.deps.onChange('sshHosts');
    this.deps.onChange('sessions');
  }

  /** §2.6-5: hand the session to an OS terminal. The embedded PTY is stopped first so one id runs once. */
  async openExternal(id: string): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    if (s.sshHostId) throw new Error('ssh.error.noExternal');
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

  // ---------- tasks (§5 タスクバックログ) ----------

  createTask(projectId: string, title: string, body = '') {
    if (!this.projects.get(projectId)) throw new Error(`project not found: ${projectId}`);
    const t = this.tasks.create(projectId, title, body);
    this.deps.onChange('tasks');
    return t;
  }

  updateTask(id: string, patch: Parameters<TaskRepo['update']>[1]) {
    const t = this.tasks.update(id, patch);
    this.deps.onChange('tasks');
    return t;
  }

  removeTask(id: string): void {
    this.tasks.remove(id);
    this.deps.onChange('tasks');
  }

  moveTask(id: string, delta: -1 | 1) {
    const list = this.tasks.move(id, delta);
    this.deps.onChange('tasks');
    return list;
  }

  /**
   * Start a task in a new session of its project: the pinned profile (or the one given),
   * claude is started, and once it waits for input the task is typed in and submitted.
   */
  async startTask(id: string, profileId?: string | null, cols = 120, rows = 32): Promise<Session> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`task not found: ${id}`);
    const project = this.projects.get(task.projectId);
    if (!project) throw new Error(`project not found: ${task.projectId}`);
    const pid = profileId || project.pinnedProfileId || this.profiles.list()[0]?.id;
    if (!pid) throw new Error('task.error.noProfile');
    const s = this.createSession({
      profileId: pid,
      projectId: project.id,
      cwd: project.path,
      title: task.title.slice(0, 60),
    });
    this.updateTask(id, { status: 'doing', sessionId: s.id });
    this.startPty(s.id, cols, rows);
    await this.waitForInput(s.id);
    const text = task.body.trim() ? `${task.title}\n\n${task.body.trim()}` : task.title;
    await this.submitText(s.id, text);
    return s;
  }

  /** Wait until claude reports it is waiting for input (SessionStart hook), with a time limit. */
  async waitForInput(id: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const a = this.activity(id);
      if (a === 'waiting' || a === 'done') return;
      if (!this.ptys.isRunning(id)) throw new Error('session.notRunning');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ---------- prompt library (§5) ----------

  createPrompt(input: { name: string; body: string; asCommand?: boolean }) {
    const p = this.prompts.create(input);
    this.syncPromptCommands();
    this.deps.onChange('prompts');
    return p;
  }

  updatePrompt(id: string, patch: Parameters<PromptRepo['update']>[1]) {
    const p = this.prompts.update(id, patch);
    this.syncPromptCommands();
    this.deps.onChange('prompts');
    return p;
  }

  removePrompt(id: string): void {
    this.prompts.remove(id);
    this.syncPromptCommands();
    this.deps.onChange('prompts');
  }

  /** Write "as command" prompts into every profile's commands/codedeck/ (callable as /name in claude). */
  syncPromptCommands(): void {
    const prompts = this.prompts.list();
    for (const p of this.profiles.list()) {
      try {
        syncCommands(p.configDir, prompts);
      } catch {
        // a profile dir that cannot be written does not block the others
      }
    }
  }

  // ---------- git (§5) ----------

  /** Ask Claude Code in this session to propose a commit message (it does not commit). */
  async askCommitMessage(sessionId: string): Promise<void> {
    await this.submitText(sessionId, commitMessageRequest(this.deps.settings.get().locale));
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
    this.screens.disposeAll();
    this.status?.close();
  }
}
