import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import type { Project } from '@shared/types';

interface Row {
  id: string;
  name: string;
  path: string;
  pinned_profile_id: string | null;
  created_at: number;
}

function toProject(r: Row): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    pinnedProfileId: r.pinned_profile_id,
    createdAt: r.created_at,
  };
}

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as unknown as Row[]
    ).map(toProject);
  }

  get(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toProject(r) : null;
  }

  insert(p: { name: string; path: string; pinnedProfileId: string | null }): Project {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO projects (id, name, path, pinned_profile_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, p.name, p.path, p.pinnedProfileId, Date.now());
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Project, 'name' | 'pinnedProfileId'>>): Project {
    const cur = this.get(id);
    if (!cur) throw new Error(`project not found: ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE projects SET name = ?, pinned_profile_id = ? WHERE id = ?')
      .run(next.name, next.pinnedProfileId, id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
