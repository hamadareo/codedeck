// CI smoke test (no claude needed): node-pty loads, env reaches the child,
// a path with spaces + Japanese works, resize works, exit is reported.
import pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const isWin = process.platform === 'win32';
const dir = path.join(os.tmpdir(), 'codedeck smoke テスト', 'profile a');
fs.mkdirSync(dir, { recursive: true });

const file = isWin ? 'powershell.exe' : '/bin/sh';
const args = isWin
  ? ['-NoProfile', '-Command', 'Write-Output "CFG=$env:CLAUDE_CONFIG_DIR"; Start-Sleep -Milliseconds 300; Write-Output "SIZE=$($Host.UI.RawUI.WindowSize.Width)"']
  : ['-c', 'echo "CFG=$CLAUDE_CONFIG_DIR"; sleep 0.3; echo "SIZE=$(stty size | cut -d" " -f2)"'];

let out = '';
const p = pty.spawn(file, args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: dir,
  env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
});
p.onData((d) => (out += d));
setTimeout(() => p.resize(100, 30), 100);

const timer = setTimeout(() => fail('timeout'), 20000);
p.onExit(({ exitCode }) => {
  clearTimeout(timer);
  const flat = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r?\n/g, '\n');
  const okEnv = flat.replace(/\n/g, '').includes(`CFG=${dir}`);
  const okSize = /SIZE=100/.test(flat);
  console.log({ platform: process.platform, exitCode, okEnv, okSize });
  if (exitCode !== 0 || !okEnv || !okSize) fail(flat);
  console.log('pty smoke OK');
  // node-pty on Windows can keep the event loop alive after exit (conpty agent); exit explicitly.
  process.exit(0);
});

function fail(msg) {
  console.error('pty smoke FAILED:', msg);
  process.exit(1);
}
