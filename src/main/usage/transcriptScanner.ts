import fs from 'node:fs';
import path from 'node:path';
import type { UsageEntry } from '@shared/usage';

/** Entries older than this are dropped from memory (30-day statistics + margin). */
const KEEP_MS = 31 * 24 * 3_600_000;
const MAX_DEPTH = 4;

interface FileState {
  offset: number;
  /** A trailing line not yet terminated by "\n". */
  partial: string;
  mtimeMs: number;
}

/**
 * Incrementally reads `<configDir>/projects/**\/*.jsonl` and keeps only
 * (timestamp, tokens) of assistant messages. Message text, prompts and tool
 * input are never kept (§8): each line is parsed, the usage numbers copied, and
 * the line discarded.
 */
export class TranscriptScanner {
  private readonly files = new Map<string, FileState>();
  private readonly seen = new Set<string>();
  private entries: UsageEntry[] = [];

  constructor(private readonly configDir: string) {}

  /** Read what was appended since the last scan; returns all kept entries. */
  scan(now = Date.now()): UsageEntry[] {
    const root = path.join(this.configDir, 'projects');
    for (const file of listJsonl(root, MAX_DEPTH)) this.readFile(file, now);
    this.entries = this.entries.filter((e) => e.ts > now - KEEP_MS);
    return this.entries;
  }

  private readFile(file: string, now: number): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.files.delete(file);
      return;
    }
    // Files untouched for longer than the window cannot contribute.
    if (stat.mtimeMs < now - KEEP_MS && !this.files.has(file)) return;
    let st = this.files.get(file);
    if (!st || stat.size < st.offset) st = { offset: 0, partial: '', mtimeMs: 0 };
    if (stat.size === st.offset) {
      this.files.set(file, st);
      return;
    }
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - st.offset);
      fs.readSync(fd, buf, 0, buf.length, st.offset);
      const text = st.partial + buf.toString('utf8');
      const lines = text.split('\n');
      const partial = lines.pop() ?? '';
      const session = path.basename(file, '.jsonl');
      for (const line of lines) this.take(line, now, session);
      this.files.set(file, { offset: stat.size, partial, mtimeMs: stat.mtimeMs });
    } catch {
      // being written / removed: try again next scan
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private take(line: string, now: number, session: string): void {
    // Cheap pre-filter before JSON.parse; most lines are not assistant messages.
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
    const e = parseUsageLine(line);
    if (!e || e.ts <= now - KEEP_MS) return;
    if (e.key) {
      if (this.seen.has(e.key)) return;
      this.seen.add(e.key);
    }
    this.entries.push({ ts: e.ts, tokens: e.tokens, session });
  }
}

/** One transcript line → usage numbers only. Returns null for anything else. */
export function parseUsageLine(line: string): { ts: number; tokens: number; key: string | null } | null {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as {
    type?: unknown;
    timestamp?: unknown;
    requestId?: unknown;
    message?: { id?: unknown; usage?: Record<string, unknown> };
  };
  if (o.type !== 'assistant' || !o.message?.usage) return null;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const u = o.message.usage;
  const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
  const tokens = n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens');
  const id = typeof o.message.id === 'string' ? o.message.id : '';
  const req = typeof o.requestId === 'string' ? o.requestId : '';
  return { ts, tokens, key: id || req ? `${id}:${req}` : null };
}

function listJsonl(dir: string, depth: number): string[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth > 0) out.push(...listJsonl(p, depth - 1));
    else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
