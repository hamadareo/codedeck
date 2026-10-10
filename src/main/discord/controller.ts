import { execFile } from 'node:child_process';
import type { Db } from '../db/database';
import type { DiscordSettings } from '@shared/discord';
import type { Locale } from '@shared/i18n';
import { DiscordBridge, type BridgeDeps, type BridgeStatus } from './bridge';
import type { DiscordTransport } from './transport';
import type { SecretStore } from './secretStore';

/** `git diff --shortstat HEAD` → numbers (null outside a repository). */
export function parseShortstat(out: string): { files: number; insertions: number; deletions: number } | null {
  const files = /(\d+) files? changed/.exec(out);
  if (!files) return out.trim() === '' ? { files: 0, insertions: 0, deletions: 0 } : null;
  return {
    files: Number(files[1]),
    insertions: Number(/(\d+) insertions?\(\+\)/.exec(out)?.[1] ?? 0),
    deletions: Number(/(\d+) deletions?\(-\)/.exec(out)?.[1] ?? 0),
  };
}

export function gitDiffSummary(
  cwd: string,
): Promise<{ files: number; insertions: number; deletions: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'diff', '--shortstat', 'HEAD'],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => resolve(err ? null : parseShortstat(String(stdout))),
    );
  });
}

export class ThreadRepo {
  constructor(private readonly db: Db) {}
  get(sessionId: string): string | null {
    const r = this.db.prepare('SELECT thread_id FROM discord_threads WHERE session_id = ?').get(sessionId) as
      { thread_id: string } | undefined;
    return r?.thread_id ?? null;
  }
  set(sessionId: string, threadId: string): void {
    this.db
      .prepare(
        'INSERT INTO discord_threads (session_id, thread_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id',
      )
      .run(sessionId, threadId);
  }
}

/**
 * Owns the bridge's lifecycle: connects when enabled and a token is stored,
 * reconnects when the server changes, holds sleep prevention while connected.
 */
export class DiscordController {
  readonly bridge: DiscordBridge;
  private applied = '';
  private keepAwake: { start(): number; stop(id: number): void } | null = null;
  private blockerId: number | null = null;

  constructor(
    transport: DiscordTransport,
    private readonly secrets: SecretStore,
    private readonly settings: () => { discord: DiscordSettings; locale: Locale },
    deps: Omit<BridgeDeps, 'settings' | 'locale' | 'onStatus'>,
    private readonly onStatus: (s: BridgeStatus) => void,
    keepAwake?: { start(): number; stop(id: number): void },
  ) {
    this.keepAwake = keepAwake ?? null;
    this.bridge = new DiscordBridge(transport, {
      ...deps,
      settings: () => this.settings().discord,
      locale: () => this.settings().locale,
      onStatus: (s) => {
        this.updateKeepAwake(s);
        this.onStatus(s);
      },
    });
  }

  hasToken(): boolean {
    return this.secrets.has();
  }

  keychainAvailable(): boolean {
    return this.secrets.available();
  }

  async setToken(token: string): Promise<void> {
    this.secrets.set(token);
    this.applied = '';
    await this.apply();
  }

  async clearToken(): Promise<void> {
    this.secrets.clear();
    this.applied = '';
    await this.bridge.stop();
  }

  /** (Re)connect according to settings. Cheap to call on every settings change. */
  async apply(force = false): Promise<void> {
    const s = this.settings().discord;
    const key = JSON.stringify([s.enabled, s.guildId, this.secrets.has(), this.settings().locale]);
    if (!force && key === this.applied) {
      this.updateKeepAwake(this.bridge.getStatus());
      return;
    }
    this.applied = key;
    await this.bridge.stop();
    const token = s.enabled ? this.secrets.get() : null;
    if (token) await this.bridge.start(token);
  }

  private updateKeepAwake(s: BridgeStatus): void {
    const want = s.state === 'connected' && this.settings().discord.keepAwake;
    if (want && this.blockerId === null && this.keepAwake) this.blockerId = this.keepAwake.start();
    if (!want && this.blockerId !== null && this.keepAwake) {
      this.keepAwake.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  async shutdown(): Promise<void> {
    await this.bridge.stop();
  }
}
