import * as pty from 'node-pty';
import type { PtyState } from '@shared/types';
import type { SpawnSpec } from '../platform/claude';

interface Entry {
  proc: pty.IPty;
  state: PtyState;
}

export interface PtyEvents {
  onData(id: string, data: string): void;
  onState(id: string, state: PtyState, exitCode: number | null): void;
}

/**
 * Owns every PTY. Output is forwarded unmodified (the app only observes it);
 * the only writes are the user's keystrokes (§2.6-4).
 */
export class PtyManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly events: PtyEvents) {}

  state(id: string): PtyState {
    return this.entries.get(id)?.state ?? 'idle';
  }

  states(): Record<string, PtyState> {
    const out: Record<string, PtyState> = {};
    for (const [id, e] of this.entries) out[id] = e.state;
    return out;
  }

  isRunning(id: string): boolean {
    return this.entries.get(id)?.state === 'running';
  }

  start(id: string, spec: SpawnSpec, cwd: string, cols: number, rows: number): void {
    if (this.isRunning(id)) return;
    const proc = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd,
      env: spec.env,
      useConpty: true,
    });
    const entry: Entry = { proc, state: 'running' };
    this.entries.set(id, entry);
    proc.onData((d) => this.events.onData(id, d));
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(id) !== entry) return;
      entry.state = 'exited';
      this.events.onState(id, 'exited', exitCode);
    });
    this.events.onState(id, 'running', null);
  }

  write(id: string, data: string): void {
    const e = this.entries.get(id);
    if (e?.state === 'running') e.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (e?.state !== 'running') return;
    try {
      e.proc.resize(Math.max(cols, 2), Math.max(rows, 1));
    } catch {
      // the process exited between the check and the resize
    }
  }

  stop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.state === 'running') {
      try {
        e.proc.kill();
      } catch {
        // already gone
      }
    }
    this.events.onState(id, 'idle', null);
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }
}
