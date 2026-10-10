import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import type { Task, TaskStatus } from '@shared/types';

interface Row {
  id: string;
  project_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  session_id: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  body: r.body,
  status: r.status,
  sessionId: r.session_id,
  sort: r.sort,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const TASK_TITLE_MAX = 200;
export const TASK_BODY_MAX = 20_000;

/** Per-project task backlog (§5). */
export class TaskRepo {
  constructor(private readonly db: Db) {}

  list(projectId: string): Task[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort, created_at')
        .all(projectId) as unknown as Row[]
    ).map(toTask);
  }

  get(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toTask(r) : null;
  }

  create(projectId: string, title: string, body = ''): Task {
    const t = title.trim().slice(0, TASK_TITLE_MAX);
    if (!t) throw new Error('task.error.titleRequired');
    const id = randomUUID();
    const now = Date.now();
    const sort = (
      this.db
        .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM tasks WHERE project_id = ?')
        .get(projectId) as {
        s: number;
      }
    ).s;
    this.db
      .prepare(
        'INSERT INTO tasks (id, project_id, title, body, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, projectId, t, body.slice(0, TASK_BODY_MAX), sort, now, now);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Task, 'title' | 'body' | 'status' | 'sessionId'>>): Task {
    const cur = this.get(id);
    if (!cur) throw new Error(`task not found: ${id}`);
    const n = { ...cur, ...patch };
    const title = n.title.trim().slice(0, TASK_TITLE_MAX);
    if (!title) throw new Error('task.error.titleRequired');
    if (!['todo', 'doing', 'done'].includes(n.status)) throw new Error(`bad status: ${n.status}`);
    this.db
      .prepare(
        'UPDATE tasks SET title = ?, body = ?, status = ?, session_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, n.body.slice(0, TASK_BODY_MAX), n.status, n.sessionId, Date.now(), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** Move a task up (-1) or down (+1) within its project; renumbers sort densely. */
  move(id: string, delta: -1 | 1): Task[] {
    const t = this.get(id);
    if (!t) throw new Error(`task not found: ${id}`);
    const list = this.list(t.projectId);
    const i = list.findIndex((x) => x.id === id);
    const j = i + delta;
    if (j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const stmt = this.db.prepare('UPDATE tasks SET sort = ? WHERE id = ?');
    list.forEach((x, k) => stmt.run(k, x.id));
    return this.list(t.projectId);
  }
}
