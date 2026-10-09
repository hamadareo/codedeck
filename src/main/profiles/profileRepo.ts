import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import type { AuthStatus, Profile, ProfileKind } from '@shared/types';

interface Row {
  id: string;
  name: string;
  kind: ProfileKind;
  color: string;
  icon: string;
  config_dir: string;
  note: string;
  auth_status: AuthStatus;
  account_email: string | null;
  sort: number;
  created_at: number;
}

function toProfile(r: Row): Profile {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    color: r.color,
    icon: r.icon,
    configDir: r.config_dir,
    note: r.note,
    authStatus: r.auth_status,
    accountEmail: r.account_email,
    sort: r.sort,
    createdAt: r.created_at,
  };
}

export class ProfileRepo {
  constructor(private readonly db: Db) {}

  list(): Profile[] {
    return (
      this.db.prepare('SELECT * FROM profiles ORDER BY sort, created_at').all() as unknown as Row[]
    ).map(toProfile);
  }

  get(id: string): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toProfile(r) : null;
  }

  insert(p: Omit<Profile, 'id' | 'createdAt' | 'sort' | 'authStatus' | 'accountEmail'>): Profile {
    const id = randomUUID();
    const now = Date.now();
    const sort = (
      this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM profiles').get() as { s: number }
    ).s;
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, kind, color, icon, config_dir, note, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, p.name, p.kind, p.color, p.icon, p.configDir, p.note, sort, now);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Profile, 'name' | 'kind' | 'color' | 'icon' | 'note'>>): Profile {
    const cur = this.get(id);
    if (!cur) throw new Error(`profile not found: ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE profiles SET name = ?, kind = ?, color = ?, icon = ?, note = ? WHERE id = ?')
      .run(next.name, next.kind, next.color, next.icon, next.note, id);
    return this.get(id)!;
  }

  setAuth(id: string, status: AuthStatus, email: string | null): Profile {
    this.db
      .prepare('UPDATE profiles SET auth_status = ?, account_email = ? WHERE id = ?')
      .run(status, email, id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }
}
