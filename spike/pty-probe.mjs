// Phase 0 probe: run the real `claude` in a PTY, render it with @xterm/headless,
// send keys, and dump the screen after each step. Never submits a prompt to the model.
//
//   node pty-probe.mjs default            # uses ~/.claude (no CLAUDE_CONFIG_DIR)
//   node pty-probe.mjs <profile-name>     # uses ~/.codedeck/profiles/<name>
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { profileDir, claudeSpawnSpec } = require('./platform.js');
const { Terminal } = xtermHeadless;

const profile = process.argv[2] || 'default';
const configDir = profile === 'default' ? null : profileDir(profile);
if (configDir) fs.mkdirSync(configDir, { recursive: true });
const outDir = path.join(import.meta.dirname, 'probe-output', profile);
fs.mkdirSync(outDir, { recursive: true });

const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 2000 });
const spec = claudeSpawnSpec({ configDir });
const p = pty.spawn(spec.file, spec.args, {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  // The repo root: the one folder we accept the CLI's trust prompt for.
  cwd: path.resolve(import.meta.dirname, '..'),
  env: spec.env,
});
let raw = '';
p.onData((d) => {
  raw += d;
  term.write(d);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function screen() {
  const b = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  return lines.join('\n');
}
let step = 0;
function dump(name) {
  const s = screen();
  fs.writeFileSync(path.join(outDir, `${String(++step).padStart(2, '0')}-${name}.txt`), s);
  console.log(`\n===== ${step} ${name} =====\n${s}`);
  return s;
}

const steps = [
  ['startup', null, 6000],
  ['type-japanese', 'こんにちは世界', 1000],
  ['shift-enter-newline', '\x1b\r', 600],
  ['type-second-line', 'second line 🎉', 1000],
  ['shift-tab-1', '\x1b[Z', 1000],
  ['shift-tab-2', '\x1b[Z', 1000],
  ['clear-input-ctrl-u', '\x15\x15\x15', 800],
  ['slash-menu', '/', 1500],
  ['slash-resume-filter', 'resum', 1200],
  ['esc', '\x1b', 1000],
  ['resize-70x20', 'RESIZE:70x20', 1500],
  ['resize-120x35', 'RESIZE:120x35', 1500],
];

let exited = false;
p.onExit(({ exitCode }) => {
  exited = true;
  console.log(`\n[claude exited code=${exitCode}]`);
});

(async () => {
  await sleep(6000);
  if (/trust this folder/.test(dump('trust-prompt'))) {
    p.write('\x1b[B'); // select "Yes, I trust this folder"
    await sleep(300);
    p.write('\r');
  }
  for (const [name, input, wait] of steps) {
    if (exited) break;
    if (input?.startsWith('RESIZE:')) {
      const [c, r] = input.slice(7).split('x').map(Number);
      p.resize(c, r);
      term.resize(c, r);
    } else if (input) {
      p.write(input);
    }
    await sleep(wait);
    dump(name);
  }
  const truecolor = /\x1b\[[0-9;]*38;2;\d+;\d+;\d+/.test(raw);
  const color256 = /\x1b\[[0-9;]*38;5;\d+/.test(raw);
  console.log('\nSUMMARY', JSON.stringify({ profile, configDir, truecolor, color256, rawBytes: raw.length }));
  // Exit claude cleanly: Ctrl+C twice.
  p.write('\x03');
  await sleep(300);
  p.write('\x03');
  await sleep(1500);
  try { p.kill(); } catch {}
  process.exit(0);
})();
