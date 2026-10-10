/**
 * claude's file reference ("@path") for a file handed over from the explorer or dropped
 * from the OS: relative (with "/") when it is inside the session's folder, absolute otherwise;
 * quoted when the path has spaces.
 */
export function fileReference(cwd: string, file: string): string {
  const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(file);
  const windows = /^([A-Za-z]:[\\/]|\\\\)/.test(cwd);
  const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const c = norm(cwd);
  const f = norm(file);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let ref: string;
  if (!absolute) ref = f;
  else if (f.length > c.length && f[c.length] === '/' && same(f.slice(0, c.length), c))
    ref = f.slice(c.length + 1);
  else ref = file;
  return /\s/.test(ref) ? `@"${ref}"` : `@${ref}`;
}

/** Several files at once: one reference each, separated by spaces, with a trailing space. */
export function fileReferences(cwd: string, files: string[]): string {
  return files.length ? `${files.map((f) => fileReference(cwd, f)).join(' ')} ` : '';
}
