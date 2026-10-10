import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, FilePreview } from '@shared/types';

/** Entries shown per folder (a huge folder stays usable; the rest is counted). */
export const MAX_ENTRIES = 2000;
/** Preview size: enough to read a source file, small enough to stay fast. */
export const PREVIEW_BYTES = 256 * 1024;
/** Never listed: git internals. */
const HIDDEN = new Set(['.git']);

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Resolve `rel` inside `root`; throws when it would leave the folder (`..`, absolute paths,
 * or a link pointing elsewhere), or reach a protected folder (profile config dirs).
 */
export function resolveInside(root: string, rel: string, protectedDirs: string[]): string {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, rel || '.');
  if (!inside(base, target)) throw new Error('files.error.outside');
  const real = fs.realpathSync(target);
  if (!inside(base, real)) throw new Error('files.error.outside');
  if (isProtected(real, protectedDirs)) throw new Error('files.error.protected');
  return real;
}

/** Claude Code config dirs hold the account's credentials: CodeDeck never shows them (§8). */
export function isProtected(p: string, protectedDirs: string[]): boolean {
  const norm = (x: string) => {
    let r: string;
    try {
      r = fs.realpathSync(x);
    } catch {
      r = path.resolve(x);
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const target = norm(p);
  return protectedDirs.some((d) => {
    const dir = norm(d);
    return target === dir || inside(dir, target);
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** One folder's entries: folders first, then files, in natural order. */
export function listDir(
  root: string,
  rel: string,
  protectedDirs: string[],
): { entries: FileEntry[]; more: number } {
  const dir = resolveInside(root, rel, protectedDirs);
  const base = fs.realpathSync(root);
  const out: FileEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (HIDDEN.has(d.name)) continue;
    const abs = path.join(dir, d.name);
    if (isProtected(abs, protectedDirs)) continue;
    let isDir = d.isDirectory();
    let size: number | null = null;
    try {
      const st = fs.statSync(abs); // follows links
      isDir = st.isDirectory();
      size = isDir ? null : st.size;
    } catch {
      // broken link / no access: listed, not openable
    }
    out.push({
      name: d.name,
      path: path.relative(base, abs).split(path.sep).join('/'),
      kind: isDir ? 'dir' : 'file',
      size,
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return { entries: out.slice(0, MAX_ENTRIES), more: Math.max(0, out.length - MAX_ENTRIES) };
}

/** The start of a file as text; binary files are recognized (a NUL byte) and not shown. */
export function previewFile(root: string, rel: string, protectedDirs: string[]): FilePreview {
  const file = resolveInside(root, rel, protectedDirs);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('files.error.notFile');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, PREVIEW_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const data = buf.subarray(0, n);
    if (data.includes(0)) return { kind: 'binary', size: st.size };
    return { kind: 'text', text: data.toString('utf8'), size: st.size, truncated: st.size > n };
  } finally {
    fs.closeSync(fd);
  }
}
