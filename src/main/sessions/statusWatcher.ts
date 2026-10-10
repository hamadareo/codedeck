import fs from 'node:fs';
import path from 'node:path';
import { HOOK_WORDS, type HookWord } from '@shared/status';

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/**
 * Reads the words CodeDeck's hooks append to `<dir>/<sessionId>.log`.
 * fs.watch gives low latency; a slow poll covers platforms/filesystems where
 * watch events get lost.
 */
export class StatusWatcher {
  private readonly offsets = new Map<string, number>();
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly onWord: (sessionId: string, word: HookWord) => void,
    pollMs = 1000,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.watcher = fs.watch(dir, (_ev, name) => {
        const id = name ? String(name).replace(/\.log$/, '') : null;
        if (id && this.offsets.has(id)) this.read(id);
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => this.offsets.forEach((_o, id) => this.read(id)), pollMs);
    this.timer.unref?.();
  }

  fileFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.log`);
  }

  /** Start tracking a session from an empty file (called right before claude is spawned). */
  begin(sessionId: string): string {
    const file = this.fileFor(sessionId);
    fs.writeFileSync(file, '');
    this.offsets.set(sessionId, 0);
    return file;
  }

  /** Stop tracking; reads what is left first so a final "stop" is not lost. */
  end(sessionId: string): void {
    if (!this.offsets.has(sessionId)) return;
    this.read(sessionId);
    this.offsets.delete(sessionId);
  }

  remove(sessionId: string): void {
    this.offsets.delete(sessionId);
    try {
      fs.unlinkSync(this.fileFor(sessionId));
    } catch {
      // already gone, or still open by a hook: harmless leftover
    }
  }

  read(sessionId: string): void {
    const offset = this.offsets.get(sessionId);
    if (offset === undefined) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.fileFor(sessionId), 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      // Only consume whole lines; a partially written word is read next time.
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return;
      this.offsets.set(sessionId, offset + Buffer.byteLength(text.slice(0, lastNl + 1)));
      for (const line of text.slice(0, lastNl).split('\n')) {
        // PowerShell's Add-Content may write a BOM / CRLF depending on version.
        const word = line.replace(BOM, '').trim();
        if ((HOOK_WORDS as readonly string[]).includes(word)) this.onWord(sessionId, word as HookWord);
      }
    } catch {
      // file not there yet / removed
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  close(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    this.offsets.clear();
  }
}
