// node-pty's macOS prebuilds ship `spawn-helper` without the execute bit when
// installed from the npm tarball, so every PTY spawn fails with
// "posix_spawnp failed". Restore it after install (and before packaging, which
// copies the file mode into the app bundle). No-op on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  let root;
  try {
    root = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    process.exit(0);
  }
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
    const helper = path.join(root, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`fix-node-pty: chmod 755 ${path.relative(process.cwd(), helper)}`);
    }
  }
}
