import type { Db } from '../db/database';
import type { Session, SessionLocation } from '@shared/types';

interface Row {
  id: string;
  title: string;
  project_id: string | null;
  profile_id: string;
  cwd: string;
  open: number;
  location: SessionLocation;
  started: number;
  created_at: number;
  last_active_at: number;
  ssh_host_id: string | null;
  conversation_id: string | null;
  resume_picker: number;
}

function toSession(r: Row): Session {
  return {
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    profileId: r.profile_id,
    cwd: r.cwd,
    open: r.open === 1,
    location: r.location,
    started: r.started === 1,
    sshHostId: r.ssh_host_id ?? null,
    conversationId: r.conversation_id ?? null,
    resumePicker: r.resume_picker === 1,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  };
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  list(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as unknown as Row[]).map(
      toSession,
    );
  }

  get(id: string): Session | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toSession(r) : null;
  }

  insert(s: {
    id: string;
    title: string;
    projectId: string | null;
    profileId: string;
    cwd: string;
    sshHostId?: string | null;
    resumePicker?: boolean;
  }): Session {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, project_id, profile_id, cwd, created_at, last_active_at, ssh_host_id, resume_picker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.title,
        s.projectId,
        s.profileId,
        s.cwd,
        now,
        now,
        s.sshHostId ?? null,
        s.resumePicker ? 1 : 0,
      );
    return this.get(s.id)!;
  }

  /** The conversation claude reported for this session; the picker is done with. */
  setConversation(id: string, conversationId: string): Session {
    this.db
      .prepare('UPDATE sessions SET conversation_id = ?, resume_picker = 0 WHERE id = ?')
      .run(conversationId === id ? null : conversationId, id);
    return this.get(id)!;
  }

  patch(id: string, p: Partial<Pick<Session, 'open' | 'location' | 'started' | 'title'>>): Session {
    const cur = this.get(id);
    if (!cur) throw new Error(`session not found: ${id}`);
    const n = { ...cur, ...p };
    this.db
      .prepare(
        'UPDATE sessions SET open = ?, location = ?, started = ?, title = ?, last_active_at = ? WHERE id = ?',
      )
      .run(n.open ? 1 : 0, n.location, n.started ? 1 : 0, n.title, Date.now(), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
