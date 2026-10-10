import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Db } from '../db/database';
import { validateHost, type SshHost, type SshHostInput } from '@shared/ssh';

interface Row {
  id: string;
  name: string;
  destination: string;
  port: number | null;
  identity_file: string;
  remote_dir: string;
  remote_config_dir: string;
  created_at: number;
}

const toHost = (r: Row): SshHost => ({
  id: r.id,
  name: r.name,
  destination: r.destination,
  port: r.port,
  identityFile: r.identity_file,
  remoteDir: r.remote_dir,
  remoteConfigDir: r.remote_config_dir,
  createdAt: r.created_at,
});

export class SshRepo {
  constructor(private readonly db: Db) {}

  list(): SshHost[] {
    return (this.db.prepare('SELECT * FROM ssh_hosts ORDER BY name').all() as unknown as Row[]).map(toHost);
  }

  get(id: string): SshHost | null {
    const r = this.db.prepare('SELECT * FROM ssh_hosts WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toHost(r) : null;
  }

  private check(h: SshHostInput, exceptId?: string): SshHostInput {
    const err = validateHost(h);
    if (err) throw new Error(err);
    const name = h.name.trim().slice(0, 60);
    const dup = this.db.prepare('SELECT id FROM ssh_hosts WHERE name = ? COLLATE NOCASE').get(name) as
      { id: string } | undefined;
    if (dup && dup.id !== exceptId) throw new Error('ssh.error.nameTaken');
    return {
      ...h,
      name,
      destination: h.destination.trim(),
      identityFile: h.identityFile.trim(),
      remoteDir: h.remoteDir.trim(),
      remoteConfigDir: h.remoteConfigDir.trim(),
    };
  }

  create(input: SshHostInput): SshHost {
    const h = this.check(input);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO ssh_hosts (id, name, destination, port, identity_file, remote_dir, remote_config_dir, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, h.name, h.destination, h.port, h.identityFile, h.remoteDir, h.remoteConfigDir, Date.now());
    return this.get(id)!;
  }

  update(id: string, input: SshHostInput): SshHost {
    if (!this.get(id)) throw new Error(`ssh host not found: ${id}`);
    const h = this.check(input, id);
    this.db
      .prepare(
        `UPDATE ssh_hosts SET name = ?, destination = ?, port = ?, identity_file = ?, remote_dir = ?, remote_config_dir = ?
         WHERE id = ?`,
      )
      .run(h.name, h.destination, h.port, h.identityFile, h.remoteDir, h.remoteConfigDir, id);
    return this.get(id)!;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id);
  }
}

let cachedSsh: string | null | undefined;

/** The OS ssh client (CODEDECK_SSH_PATH overrides it, for tests). */
export function resolveSsh(): string | null {
  if (process.env.CODEDECK_SSH_PATH) return process.env.CODEDECK_SSH_PATH;
  if (cachedSsh !== undefined) return cachedSsh;
  const candidates =
    process.platform === 'win32'
      ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\OpenSSH\\ssh.exe`]
      : ['/usr/bin/ssh', '/opt/homebrew/bin/ssh', '/usr/local/bin/ssh'];
  cachedSsh = candidates.find((c) => fs.existsSync(c)) ?? null;
  if (!cachedSsh) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ssh'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      cachedSsh =
        out
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim() ?? null;
    } catch {
      cachedSsh = null;
    }
  }
  return cachedSsh;
}
