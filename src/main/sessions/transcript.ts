import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether claude has saved a conversation for this id under the profile's
 * config dir (<configDir>/projects/<encoded cwd>/<id>.jsonl). Only the file's
 * existence is checked. claude writes it after the first message, so a
 * session that was opened but never used has none and must be started fresh.
 */
export function transcriptExists(configDir: string, sessionId: string): boolean {
  const root = path.join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  const file = `${sessionId}.jsonl`;
  return dirs.some((d) => fs.existsSync(path.join(root, d, file)));
}

/** Restore rule: resume a saved conversation, otherwise start fresh under the same id. */
export function shouldResume(configDir: string, sessionId: string): boolean {
  return transcriptExists(configDir, sessionId);
}
