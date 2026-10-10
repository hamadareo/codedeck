import type {
  Activity,
  EnvInfo,
  ExtensionsInfo,
  GitStatus,
  Prompt,
  Stats,
  Task,
  NewProfileInput,
  NewProjectInput,
  NewSessionInput,
  Profile,
  Project,
  PtyState,
  Session,
  Settings,
} from './types';
import type { Plan, ProfileUsage } from './usage';
import type { NotificationRecord } from './notify';
import type { Schedule, ScheduleInput } from './schedule';
import type { SshHost, SshHostInput } from './ssh';

export interface PtySnapshot {
  data: string;
  end: number;
  state: PtyState;
}

export type WindowContext = { kind: 'main' } | { kind: 'popout'; sessionId: string };

/** Request/response channels (ipcRenderer.invoke ↔ ipcMain.handle). */
export interface InvokeContract {
  'env:info': { args: []; result: EnvInfo };
  'window:context': { args: []; result: WindowContext };
  'settings:get': { args: []; result: Settings };
  'settings:set': { args: [patch: Partial<Settings>]; result: Settings };
  'profiles:list': { args: []; result: Profile[] };
  'profiles:create': { args: [NewProfileInput]; result: Profile };
  'profiles:update': {
    args: [id: string, patch: Partial<Pick<Profile, 'name' | 'kind' | 'color' | 'icon' | 'note'>>];
    result: Profile;
  };
  'profiles:remove': { args: [id: string]; result: { configDir: string } };
  'profiles:checkAuth': { args: [id: string]; result: Profile };
  'projects:list': { args: []; result: Project[] };
  'projects:create': { args: [NewProjectInput]; result: Project };
  'projects:update': {
    args: [id: string, patch: Partial<Pick<Project, 'name' | 'pinnedProfileId'>>];
    result: Project;
  };
  'projects:remove': { args: [id: string]; result: void };
  'notes:get': { args: [projectId: string]; result: string };
  'notes:set': { args: [projectId: string, body: string]; result: void };
  'dialog:pickFolder': { args: []; result: string | null };
  'sessions:list': { args: []; result: Session[] };
  'sessions:create': { args: [NewSessionInput]; result: Session };
  /** Close the tab. The session stays in history (open = false) and can be reopened. */
  'sessions:close': { args: [id: string]; result: void };
  'sessions:reopen': { args: [id: string]; result: Session };
  'sessions:remove': { args: [id: string]; result: void };
  'sessions:rename': { args: [id: string, title: string]; result: Session };
  'sessions:openExternal': { args: [id: string]; result: Session };
  'sessions:reclaim': { args: [id: string]; result: Session };
  /** Start (or report) the PTY for a session. Idempotent. */
  'pty:start': { args: [id: string, cols: number, rows: number]; result: { state: PtyState } };
  'pty:states': { args: []; result: Record<string, PtyState> };
  /** Recent output, for a terminal attaching mid-session (another window, a reload). */
  'pty:snapshot': { args: [id: string]; result: PtySnapshot };
  'activity:list': { args: []; result: Record<string, Activity> };
  /** Show a session in its own window (§4 pop-out). */
  'window:popout': { args: [sessionId: string]; result: void };
  /** Close a session's own window and bring it back to the main window. */
  'window:dock': { args: [sessionId: string]; result: void };
  'window:popouts': { args: []; result: string[] };
  'clipboard:read': { args: []; result: { text: string; hasImage: boolean } };
  'usage:list': { args: []; result: ProfileUsage[] };
  'usage:refresh': { args: []; result: ProfileUsage[] };
  'usage:setConfig': {
    args: [
      profileId: string,
      patch: { plan?: Plan; limit5h?: number | null; limit7d?: number | null; thresholds?: number[] },
    ];
    result: ProfileUsage | undefined;
  };
  'notify:history': { args: []; result: NotificationRecord[] };
  'tasks:list': { args: [projectId: string]; result: Task[] };
  'tasks:create': { args: [projectId: string, title: string, body?: string]; result: Task };
  'tasks:update': {
    args: [id: string, patch: Partial<Pick<Task, 'title' | 'body' | 'status'>>];
    result: Task;
  };
  'tasks:remove': { args: [id: string]; result: void };
  'tasks:move': { args: [id: string, delta: -1 | 1]; result: Task[] };
  /** Opens a session for the task and sends the task as the first instruction. */
  'tasks:start': { args: [id: string, profileId?: string | null]; result: Session };
  'git:status': { args: [cwd: string]; result: GitStatus };
  'git:diff': { args: [cwd: string, file: string]; result: string };
  'git:commit': { args: [cwd: string, message: string]; result: { ok: boolean; output: string } };
  'git:askCommitMessage': { args: [sessionId: string]; result: void };
  'prompts:list': { args: []; result: Prompt[] };
  'prompts:create': { args: [input: { name: string; body: string; asCommand?: boolean }]; result: Prompt };
  'prompts:update': {
    args: [id: string, patch: Partial<Pick<Prompt, 'name' | 'body' | 'asCommand'>>];
    result: Prompt;
  };
  'prompts:remove': { args: [id: string]; result: void };
  /** Save dialog → JSON file. Returns the path, or null when cancelled. */
  'prompts:export': { args: []; result: string | null };
  /** Open dialog → adds prompts from a JSON file. Returns how many were added. */
  'prompts:import': { args: []; result: number | null };
  'extensions:list': { args: [profileId: string, projectDir?: string | null]; result: ExtensionsInfo };
  'skills:setEnabled': { args: [profileId: string, name: string, enabled: boolean]; result: void };
  'stats:get': { args: [days: number]; result: Stats };
  'schedules:list': { args: []; result: Schedule[] };
  'schedules:create': { args: [input: ScheduleInput]; result: Schedule };
  'schedules:update': { args: [id: string, input: ScheduleInput]; result: Schedule };
  'schedules:remove': { args: [id: string]; result: void };
  'schedules:runNow': { args: [id: string]; result: void };
  'ssh:list': { args: []; result: SshHost[] };
  'ssh:create': { args: [input: SshHostInput]; result: SshHost };
  'ssh:update': { args: [id: string, input: SshHostInput]; result: SshHost };
  'ssh:remove': { args: [id: string]; result: void };
  'ssh:available': { args: []; result: boolean };
  'update:state': { args: []; result: UpdateState };
  'update:check': { args: []; result: UpdateState };
  /** Quits and installs a downloaded update. */
  'update:install': { args: []; result: void };
  'app:version': { args: []; result: string };
  'discord:info': { args: []; result: DiscordInfo };
  /** Stores the bot token in the OS keychain. The token is never sent back. */
  'discord:setToken': { args: [token: string]; result: DiscordInfo };
  'discord:clearToken': { args: []; result: DiscordInfo };
  'discord:reconnect': { args: []; result: DiscordInfo };
}

export type UpdateState =
  | { state: 'disabled'; reason: 'dev' | 'off' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'none' }
  | { state: 'error'; error: string };

export interface DiscordInfo {
  status:
    | { state: 'off' }
    | { state: 'connecting' }
    | { state: 'connected'; botTag: string }
    | { state: 'error'; error: string };
  hasToken: boolean;
  keychainAvailable: boolean;
}

export interface RemoteInput {
  sessionId: string;
  user: string;
  kind: 'send' | 'approve' | 'deny' | 'stop' | 'new';
  preview: string;
  at: number;
}

/** Fire-and-forget channels (ipcRenderer.send ↔ ipcMain.on). */
export interface SendContract {
  'pty:input': [id: string, data: string];
  'pty:resize': [id: string, cols: number, rows: number];
  /** The session is visible to the user (a finished turn counts as seen). */
  'session:seen': [id: string];
  'clipboard:write': [text: string];
  'link:open': [url: string];
}

/** Main → renderer events. */
export interface EventContract {
  /** `end` is the stream offset right after `data` (see pty:snapshot). */
  'pty:data': [id: string, data: string, end: number];
  'pty:state': [id: string, state: PtyState, exitCode: number | null];
  'activity:changed': [id: string, activity: Activity];
  'state:changed': [
    what: 'profiles' | 'projects' | 'sessions' | 'tasks' | 'prompts' | 'sshHosts' | 'schedules',
  ];
  'settings:changed': [settings: Settings];
  'windows:changed': [popouts: string[]];
  'usage:changed': [usage: ProfileUsage[]];
  /** An in-app banner (usage alerts). */
  'notify:show': [record: NotificationRecord];
  /** An OS notification was clicked: bring this session on screen. */
  'app:focusSession': [sessionId: string];
  'discord:status': [info: DiscordInfo];
  /** Input that came from Discord (§6: shown as "from Discord" in the app). */
  'remote:input': [input: RemoteInput];
  'update:state': [state: UpdateState];
}

export type InvokeChannel = keyof InvokeContract;
export type SendChannel = keyof SendContract;
export type EventChannel = keyof EventContract;

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'env:info',
  'window:context',
  'settings:get',
  'settings:set',
  'profiles:list',
  'profiles:create',
  'profiles:update',
  'profiles:remove',
  'profiles:checkAuth',
  'projects:list',
  'projects:create',
  'projects:update',
  'projects:remove',
  'notes:get',
  'notes:set',
  'dialog:pickFolder',
  'sessions:list',
  'sessions:create',
  'sessions:close',
  'sessions:reopen',
  'sessions:remove',
  'sessions:rename',
  'sessions:openExternal',
  'sessions:reclaim',
  'pty:start',
  'pty:states',
  'pty:snapshot',
  'activity:list',
  'window:popout',
  'window:dock',
  'window:popouts',
  'clipboard:read',
  'usage:list',
  'usage:refresh',
  'usage:setConfig',
  'notify:history',
  'tasks:list',
  'tasks:create',
  'tasks:update',
  'tasks:remove',
  'tasks:move',
  'tasks:start',
  'git:status',
  'git:diff',
  'git:commit',
  'git:askCommitMessage',
  'prompts:list',
  'prompts:create',
  'prompts:update',
  'prompts:remove',
  'prompts:export',
  'prompts:import',
  'extensions:list',
  'skills:setEnabled',
  'stats:get',
  'schedules:list',
  'schedules:create',
  'schedules:update',
  'schedules:remove',
  'schedules:runNow',
  'ssh:list',
  'ssh:create',
  'ssh:update',
  'ssh:remove',
  'ssh:available',
  'update:state',
  'update:check',
  'update:install',
  'app:version',
  'discord:info',
  'discord:setToken',
  'discord:clearToken',
  'discord:reconnect',
];
export const SEND_CHANNELS: SendChannel[] = [
  'pty:input',
  'pty:resize',
  'session:seen',
  'clipboard:write',
  'link:open',
];
export const EVENT_CHANNELS: EventChannel[] = [
  'pty:data',
  'pty:state',
  'activity:changed',
  'state:changed',
  'settings:changed',
  'windows:changed',
  'usage:changed',
  'notify:show',
  'app:focusSession',
  'discord:status',
  'remote:input',
  'update:state',
];

/** The API exposed on window.codedeck by the preload script. */
export interface CodeDeckApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeContract[C]['args']
  ): Promise<InvokeContract[C]['result']>;
  send<C extends SendChannel>(channel: C, ...args: SendContract[C]): void;
  on<C extends EventChannel>(channel: C, listener: (...args: EventContract[C]) => void): () => void;
}
