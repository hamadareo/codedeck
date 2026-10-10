import type { NotifySettings } from './notify';

export type ProfileKind = 'personal' | 'team' | 'other';
export type AuthStatus = 'unknown' | 'connected' | 'logged_out';

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  color: string;
  icon: string;
  /** Absolute path passed to the CLI as CLAUDE_CONFIG_DIR. */
  configDir: string;
  note: string;
  authStatus: AuthStatus;
  /** Display-only account label reported by `claude auth status`. Never a credential. */
  accountEmail: string | null;
  sort: number;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  pinnedProfileId: string | null;
  createdAt: number;
}

export type SessionLocation = 'embedded' | 'external';

export interface Session {
  /** Also the claude conversation id (passed as --session-id / --resume). */
  id: string;
  title: string;
  projectId: string | null;
  profileId: string;
  cwd: string;
  open: boolean;
  location: SessionLocation;
  /** True once claude has been launched for this id at least once. */
  started: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export type PtyState = 'idle' | 'running' | 'exited';

/** What claude is doing, reported by CodeDeck's hooks (docs/phase2-plan.md). */
export type Activity = 'unknown' | 'working' | 'waiting' | 'approval' | 'done' | 'error' | 'limit';

/** What the UI shows for a session (§4: running / waiting / approval / done / error / limit). */
export type SessionStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'working'
  | 'waiting'
  | 'approval'
  | 'done'
  | 'error'
  | 'limit'
  | 'exited'
  | 'external';

export type ThemeMode = 'system' | 'light' | 'dark';
export type Locale = 'ja' | 'en';

export type SplitDir = 'row' | 'col';
export type LayoutNode =
  | { kind: 'pane'; id: string; sessionId: string | null }
  | { kind: 'split'; id: string; dir: SplitDir; children: LayoutNode[]; sizes: number[] };

export interface Layout {
  root: LayoutNode;
  focusedPaneId: string;
  maximizedPaneId: string | null;
}

export type RightPanelTab = 'notes' | 'diff' | 'tasks' | 'usage';

export interface Settings {
  externalTerminal: 'auto' | 'windows-terminal' | 'powershell' | 'terminal-app' | 'iterm';
  theme: ThemeMode;
  locale: Locale;
  uiFontSize: number;
  terminalFontSize: number;
  /** Empty = the built-in monospace stack. */
  terminalFontFamily: string;
  layout: Layout | null;
  rightPanel: { open: boolean; tab: RightPanelTab; width: number };
  /** Sessions shown in their own window; reopened after a restart. */
  popouts: string[];
  sidebarWidth: number;
  notifications: NotifySettings;
}

export interface EnvInfo {
  platform: string;
  claudePath: string | null;
  claudeVersion: string | null;
  gitAvailable: boolean;
  homeDir: string;
}

export interface NewProfileInput {
  name: string;
  kind: ProfileKind;
  color?: string;
  icon?: string;
  note?: string;
  /** Optional custom config dir. Defaults to ~/.codedeck/profiles/<name>. */
  configDir?: string;
}

export interface NewProjectInput {
  name: string;
  path: string;
  pinnedProfileId?: string | null;
}

export interface NewSessionInput {
  profileId: string;
  projectId?: string | null;
  cwd: string;
  title?: string;
}
