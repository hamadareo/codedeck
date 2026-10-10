import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

/**
 * A headless terminal per session, fed with the same PTY output as the
 * on-screen xterm. Gives clean screen text (no escape codes, TUI redraws
 * resolved) for Discord summaries and /status (§6). Read-only; in memory only.
 */
export class ScreenMirror {
  private readonly terms = new Map<string, HeadlessTerminal>();

  private get(id: string, cols = 120, rows = 40): HeadlessTerminal {
    let t = this.terms.get(id);
    if (!t) {
      t = new Terminal({ cols, rows, scrollback: 400, allowProposedApi: true });
      this.terms.set(id, t);
    }
    return t;
  }

  start(id: string, cols: number, rows: number): void {
    this.get(id, cols, rows);
    this.resize(id, cols, rows);
  }

  write(id: string, data: string): void {
    this.get(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id);
    if (t && (t.cols !== cols || t.rows !== rows)) t.resize(Math.max(cols, 2), Math.max(rows, 1));
  }

  /** The last `max` lines up to the cursor's screen (scrollback included). Resolves after pending writes. */
  async lines(id: string, max = 60): Promise<string[]> {
    const t = this.terms.get(id);
    if (!t) return [];
    await new Promise<void>((r) => t.write('', r));
    const b = t.buffer.active;
    const end = b.baseY + t.rows;
    const out: string[] = [];
    for (let i = Math.max(0, end - max); i < end; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out;
  }

  dispose(id: string): void {
    this.terms.get(id)?.dispose();
    this.terms.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.terms.keys()]) this.dispose(id);
  }
}
