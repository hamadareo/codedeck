import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import type { Prompt } from '@shared/types';

interface Row {
  id: string;
  name: string;
  body: string;
  as_command: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

const toPrompt = (r: Row): Prompt => ({
  id: r.id,
  name: r.name,
  body: r.body,
  asCommand: r.as_command === 1,
  sort: r.sort,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PromptRepo {
  constructor(private readonly db: Db) {}

  list(): Prompt[] {
    return (this.db.prepare('SELECT * FROM prompts ORDER BY sort, name').all() as unknown as Row[]).map(
      toPrompt,
    );
  }

  get(id: string): Prompt | null {
    const r = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toPrompt(r) : null;
  }

  private check(name: string, body: string, exceptId?: string): { name: string; body: string } {
    const n = name.trim().slice(0, 80);
    if (!n) throw new Error('prompts.error.nameRequired');
    if (!body.trim()) throw new Error('prompts.error.bodyRequired');
    const dup = this.db.prepare('SELECT id FROM prompts WHERE name = ? COLLATE NOCASE').get(n) as
      { id: string } | undefined;
    if (dup && dup.id !== exceptId) throw new Error('prompts.error.nameTaken');
    return { name: n, body: body.slice(0, 20_000) };
  }

  create(input: { name: string; body: string; asCommand?: boolean }): Prompt {
    const { name, body } = this.check(input.name, input.body);
    const id = randomUUID();
    const now = Date.now();
    const sort = (
      this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM prompts').get() as { s: number }
    ).s;
    this.db
      .prepare(
        'INSERT INTO prompts (id, name, body, as_command, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, body, input.asCommand ? 1 : 0, sort, now, now);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<Prompt, 'name' | 'body' | 'asCommand'>>): Prompt {
    const cur = this.get(id);
    if (!cur) throw new Error(`prompt not found: ${id}`);
    const { name, body } = this.check(patch.name ?? cur.name, patch.body ?? cur.body, id);
    const asCommand = patch.asCommand ?? cur.asCommand;
    this.db
      .prepare('UPDATE prompts SET name = ?, body = ?, as_command = ?, updated_at = ? WHERE id = ?')
      .run(name, body, asCommand ? 1 : 0, Date.now(), id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }
}
