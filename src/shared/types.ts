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
