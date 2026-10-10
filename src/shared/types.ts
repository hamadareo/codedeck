import type { NotifySettings } from './notify';
import type { DiscordSettings } from './discord';

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
  /** Runs on a remote machine over SSH (§5); cwd is then the remote folder. */
  sshHostId: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export type PtyState = 'idle' | 'running' | 'exited';

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  body: string;
  status: TaskStatus;
  sessionId: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface Prompt {
  id: string;
  name: string;
  body: string;
  /** Also written as a Claude Code custom command, callable as /name inside claude. */
  asCommand: boolean;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface GitFile {
  path: string;
  /** 'M' modified, 'A' added, 'D' deleted, 'R' renamed, '?' untracked, 'U' conflict. */
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U';
  added: number | null;
  deleted: number | null;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface McpServerInfo {
  name: string;
  target: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'unknown';
  detail: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  /** 'profile' = the profile's config dir (can be toggled here); 'project' = <cwd>/.claude/skills. */
  scope: 'profile' | 'project';
}

export interface ExtensionsInfo {
  mcp: McpServerInfo[];
  /** null when `claude mcp list` could not run. */
  mcpError: string | null;
  skills: SkillInfo[];
}

export interface StatsRow {
  key: string;
  label: string;
  tokens: number;
  sessions: number;
  workMs: number;
}

export interface Stats {
  days: number;
  byProject: StatsRow[];
  byProfile: StatsRow[];
  /** Tokens per day, oldest first (local dates "YYYY-MM-DD"). */
  daily: { date: string; tokens: number }[];
  totalTokens: number;
  totalSessions: number;
  totalWorkMs: number;
}

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
  /** Non-secret Discord settings; the bot token lives in the OS keychain (safeStorage). */
  discord: DiscordSettings;
  /** Closing the window keeps CodeDeck running in the tray (needed for schedules, Discord). */
  stayInTray: boolean;
  /** Start CodeDeck when the user logs in to the OS. */
  launchAtLogin: boolean;
  /** Check GitHub Releases for updates (packaged app only). */
  autoUpdate: boolean;
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
  sshHostId?: string | null;
}
