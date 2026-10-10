import { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite (built into Electron's Node) instead of better-sqlite3:
 * no native rebuild per Electron version (docs/decisions.md).
 */
const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('personal','team','other')),
    color TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    config_dir TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    auth_status TEXT NOT NULL DEFAULT 'unknown',
    account_email TEXT,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    pinned_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    cwd TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    location TEXT NOT NULL DEFAULT 'embedded',
    started INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  `,
  // v2: per-project notes (right panel, §4)
  `
  CREATE TABLE project_notes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  `,
  // v3: usage limits per profile and the alerts already sent (§7: never twice)
  `
  CREATE TABLE profile_usage (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'auto',
    limit_5h INTEGER,
    limit_7d INTEGER,
    limit_source TEXT NOT NULL DEFAULT 'none',
    thresholds TEXT NOT NULL DEFAULT '[70,90,100]',
    detected_plan TEXT
  );
  CREATE TABLE usage_alerts (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    window TEXT NOT NULL,
    window_key TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, window, window_key, threshold)
  );
  `,
  // v4: one Discord thread per session (§6)
  `
  CREATE TABLE discord_threads (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL
  );
  `,
  // v5: task backlog, prompt library, work time (§5)
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    body TEXT NOT NULL,
    as_command INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE work_log (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE INDEX work_log_session ON work_log(session_id);
  `,
  // v6: scheduled prompts and SSH hosts (§5)
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rule TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ssh_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    destination TEXT NOT NULL,
    port INTEGER,
    identity_file TEXT NOT NULL DEFAULT '',
    remote_dir TEXT NOT NULL DEFAULT '',
    remote_config_dir TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  ALTER TABLE sessions ADD COLUMN ssh_host_id TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL;
  `,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
