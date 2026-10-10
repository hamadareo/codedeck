import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;

/**
 * Plain append-only log in userData/logs (§8). Callers pass short, structured
 * facts only: never prompts, outputs, or tokens. Rotates at 1 MB (keeps one old file).
 */
export class Logger {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, 'codedeck.log');
  }

  write(scope: string, message: string, fields: Record<string, string | number | boolean | null> = {}): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch {
        // no file yet
      }
      const extra = Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      fs.appendFileSync(
        this.file,
        `${new Date().toISOString()} [${scope}] ${message}${extra ? ` ${extra}` : ''}\n`,
      );
    } catch {
      // logging must never break the app
    }
  }

  /** Last `n` lines (for tests and the settings screen). */
  tail(n = 50): string[] {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-n);
    } catch {
      return [];
    }
  }
}
