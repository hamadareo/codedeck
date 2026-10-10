import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

/** Output replayed to rebuild a screen: enough for the visible screen and the lines asked for. */
const REPLAY_CHARS = 256 * 1024;

/**
 * Clean screen text (no escape codes, TUI redraws resolved) for Discord summaries
 * and /status (§6). Built on demand from the session's recent output in a headless
 * terminal of the session's size, so busy sessions cost nothing while nobody asks
 * (§4: the main process stays free for keystrokes). Read-only; in memory only.
 */
export class ScreenMirror {
  private readonly sizes = new Map<string, { cols: number; rows: number }>();

  constructor(private readonly output: (id: string) => string) {}

  start(id: string, cols: number, rows: number): void {
    this.sizes.set(id, { cols: Math.max(cols, 2), rows: Math.max(rows, 1) });
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.sizes.has(id)) this.start(id, cols, rows);
  }

  /** The last `max` lines up to the cursor's screen (scrollback included). */
  async lines(id: string, max = 60): Promise<string[]> {
    const size = this.sizes.get(id);
    if (!size) return [];
    let data = this.output(id);
    if (data.length > REPLAY_CHARS) {
      // Start at a line boundary so no escape sequence is cut in half.
      data = data.slice(-REPLAY_CHARS);
      const nl = data.indexOf('\n');
      if (nl >= 0) data = data.slice(nl + 1);
    }
    const t = new Terminal({ ...size, scrollback: Math.max(max, 400), allowProposedApi: true });
    try {
      await new Promise<void>((r) => t.write(data, r));
      const b = t.buffer.active;
      const end = b.baseY + t.rows;
      const out: string[] = [];
      for (let i = Math.max(0, end - max); i < end; i++)
        out.push(b.getLine(i)?.translateToString(true) ?? '');
      return out;
    } finally {
      t.dispose();
    }
  }

  dispose(id: string): void {
    this.sizes.delete(id);
  }

  disposeAll(): void {
    this.sizes.clear();
  }
}
