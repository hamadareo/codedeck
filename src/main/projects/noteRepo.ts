import type { Db } from '../db/database';

export const NOTE_MAX_CHARS = 100_000;

/** Per-project scratch notes (§5 スクラッチパッド/メモ). */
export class NoteRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string): string {
    const r = this.db.prepare('SELECT body FROM project_notes WHERE project_id = ?').get(projectId) as
      { body: string } | undefined;
    return r?.body ?? '';
  }

  set(projectId: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO project_notes (project_id, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(projectId, body.slice(0, NOTE_MAX_CHARS), Date.now());
  }
}
