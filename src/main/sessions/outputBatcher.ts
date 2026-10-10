/**
 * Coalesces PTY output per session before it crosses IPC (§4 パフォーマンス):
 * with 10 busy sessions, thousands of tiny chunks per second become at most one
 * message per session every few milliseconds. Order and offsets are preserved.
 */
export class OutputBatcher {
  private readonly pending = new Map<string, { data: string; end: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly send: (id: string, data: string, end: number) => void,
    private readonly delayMs = 8,
    private readonly maxChars = 64 * 1024,
  ) {}

  push(id: string, data: string, end: number): void {
    const cur = this.pending.get(id);
    if (cur) {
      cur.data += data;
      cur.end = end;
    } else {
      this.pending.set(id, { data, end });
    }
    if ((cur?.data.length ?? data.length) >= this.maxChars) return this.flush(id);
    if (!this.timer) this.timer = setTimeout(() => this.flushAll(), this.delayMs);
  }

  /** Send one session's buffered output now (e.g. before its state change is announced). */
  flush(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.send(id, p.data, p.end);
  }

  flushAll(): void {
    this.timer = null;
    for (const id of [...this.pending.keys()]) this.flush(id);
  }
}
