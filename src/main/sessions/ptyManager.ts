import * as pty from 'node-pty';
import type { PtyState } from '@shared/types';
import type { SpawnSpec } from '../platform/claude';

/** Recent output kept per session so another window can attach mid-session (§4 pop-out). */
export const SCROLLBACK_CHARS = 1_000_000;

interface Entry {
  proc: pty.IPty | null;
  state: PtyState;
  chunks: string[];
  kept: number;
  /** Total chars ever produced by this session's current process; the stream offset. */
  total: number;
}

export interface PtyEvents {
  /** `end` is the stream offset right after `data`. */
  onData(id: string, data: string, end: number): void;
  onState(id: string, state: PtyState, exitCode: number | null): void;
}

export interface Snapshot {
  data: string;
  /** Stream offset right after `data`. */
  end: number;
  state: PtyState;
}

/**
 * Owns every PTY. Output is forwarded unmodified (the app only observes it);
 * the only writes are the user's keystrokes (§2.6-4).
 */
export class PtyManager {
  private readonly entries = new Map<string, Entry>();
  /** Stream offsets survive a stop, so a window's dedupe never mistakes new output for old. */
  private readonly lastTotals = new Map<string, number>();

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
    const prev = this.entries.get(id);
    const proc = pty.spawn(spec.file, spec.commandLine ?? spec.args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 1),
      cwd,
      env: spec.env,
      useConpty: true,
    });
    // A restart continues the same stream (the old screen stays above the new one).
    const entry: Entry = {
      proc,
      state: 'running',
      chunks: prev?.chunks ?? [],
      kept: prev?.kept ?? 0,
      total: prev?.total ?? this.lastTotals.get(id) ?? 0,
    };
    this.entries.set(id, entry);
    proc.onData((d) => {
      if (this.entries.get(id) !== entry) return;
      this.append(entry, d);
      this.events.onData(id, d, entry.total);
    });
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(id) !== entry) return;
      entry.state = 'exited';
      entry.proc = null;
      this.events.onState(id, 'exited', exitCode);
    });
    this.events.onState(id, 'running', null);
  }

  /** Output that is not the PTY's own (e.g. the restart separator), recorded so every window shows it. */
  note(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.append(e, data);
    this.events.onData(id, data, e.total);
  }

  private append(e: Entry, d: string): void {
    e.chunks.push(d);
    e.kept += d.length;
    e.total += d.length;
    while (e.kept > SCROLLBACK_CHARS && e.chunks.length > 1) e.kept -= e.chunks.shift()!.length;
  }

  snapshot(id: string): Snapshot {
    const e = this.entries.get(id);
    if (!e) return { data: '', end: this.lastTotals.get(id) ?? 0, state: 'idle' };
    return { data: e.chunks.join(''), end: e.total, state: e.state };
  }

  write(id: string, data: string): void {
    const e = this.entries.get(id);
    if (e?.state === 'running') e.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (e?.state !== 'running') return;
    try {
      e.proc?.resize(Math.max(cols, 2), Math.max(rows, 1));
    } catch {
      // the process exited between the check and the resize
    }
  }

  stop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.lastTotals.set(id, e.total);
    if (e.state === 'running') {
      try {
        e.proc?.kill();
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
