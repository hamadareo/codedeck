import type {
  EnvInfo,
  NewProfileInput,
  NewProjectInput,
  NewSessionInput,
  Profile,
  Project,
  PtyState,
  Session,
} from './types';

/** Request/response channels (ipcRenderer.invoke ↔ ipcMain.handle). */
export interface InvokeContract {
  'env:info': { args: []; result: EnvInfo };
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
  'dialog:pickFolder': { args: []; result: string | null };
  'sessions:list': { args: []; result: Session[] };
  'sessions:create': { args: [NewSessionInput]; result: Session };
  /** Close the tab. The session stays in history (open = false) and can be reopened. */
  'sessions:close': { args: [id: string]; result: void };
  'sessions:reopen': { args: [id: string]; result: Session };
  'sessions:remove': { args: [id: string]; result: void };
  'sessions:openExternal': { args: [id: string]; result: Session };
  'sessions:reclaim': { args: [id: string]; result: Session };
  /** Start (or report) the PTY for a session. Idempotent. */
  'pty:start': { args: [id: string, cols: number, rows: number]; result: { state: PtyState } };
  'pty:states': { args: []; result: Record<string, PtyState> };
  'clipboard:read': { args: []; result: { text: string; hasImage: boolean } };
}

/** Fire-and-forget channels (ipcRenderer.send ↔ ipcMain.on). */
export interface SendContract {
  'pty:input': [id: string, data: string];
  'pty:resize': [id: string, cols: number, rows: number];
  'clipboard:write': [text: string];
  'link:open': [url: string];
}

/** Main → renderer events. */
export interface EventContract {
  'pty:data': [id: string, data: string];
  'pty:state': [id: string, state: PtyState, exitCode: number | null];
  'state:changed': [what: 'profiles' | 'projects' | 'sessions'];
}

export type InvokeChannel = keyof InvokeContract;
export type SendChannel = keyof SendContract;
export type EventChannel = keyof EventContract;

export const INVOKE_CHANNELS: InvokeChannel[] = [
  'env:info',
  'profiles:list',
  'profiles:create',
  'profiles:update',
  'profiles:remove',
  'profiles:checkAuth',
  'projects:list',
  'projects:create',
  'projects:update',
  'projects:remove',
  'dialog:pickFolder',
  'sessions:list',
  'sessions:create',
  'sessions:close',
  'sessions:reopen',
  'sessions:remove',
  'sessions:openExternal',
  'sessions:reclaim',
  'pty:start',
  'pty:states',
  'clipboard:read',
];
export const SEND_CHANNELS: SendChannel[] = ['pty:input', 'pty:resize', 'clipboard:write', 'link:open'];
export const EVENT_CHANNELS: EventChannel[] = ['pty:data', 'pty:state', 'state:changed'];

/** The API exposed on window.codedeck by the preload script. */
export interface CodeDeckApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeContract[C]['args']
  ): Promise<InvokeContract[C]['result']>;
  send<C extends SendChannel>(channel: C, ...args: SendContract[C]): void;
  on<C extends EventChannel>(channel: C, listener: (...args: EventContract[C]) => void): () => void;
}
