import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Remove a test folder that real PTYs / hook shells used. Not fs.rmSync on Windows: Node's
 * native recursive delete can abort the whole test worker (0xC0000409) while files are still
 * held by exiting processes. A detached helper deletes it once they let go (as in e2e/helpers.ts).
 */
export function removeDir(dir: string): void {
  if (process.platform !== 'win32') {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const child = spawn(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}""`],
    { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
  );
  child.unref();
}
