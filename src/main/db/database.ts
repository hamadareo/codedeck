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
