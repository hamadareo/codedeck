// Phase 2 probe: do hooks passed with `--settings` run, and can they report a session's
// state to CodeDeck through a plain file (no node/electron needed inside the hook)?
//
//   node spike/hook-probe.mjs <configDir> [--trust] [--prompt]
//
// cwd is this repo; --trust accepts the folder-trust prompt for it (and only it).
// Without --prompt nothing is sent to the model: it checks SessionStart and SessionEnd, then /exit.
// With --prompt it sends one tiny prompt ("Reply with just: OK") to check UserPromptSubmit and Stop.
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { Terminal } = xtermHeadless;
const isWin = process.platform === 'win32';
const configDir = process.argv[2];
if (!configDir) throw new Error('usage: hook-probe.mjs <configDir> [--trust]');
const cwd = path.resolve(import.meta.dirname, '..');

const claude = isWin
  ? execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => l.endsWith('.exe'))
  : execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck hook テスト '));
const statusFile = path.join(outDir, 'status.log');
const append = (word, shell) =>
  shell === 'powershell'
    ? `Add-Content -LiteralPath $env:CODEDECK_STATUS_FILE -Value '${word}'`
    : `printf '%s\\n' '${word}' >> "$CODEDECK_STATUS_FILE"`;
const hook = (word, shell) => ({ type: 'command', command: append(word, shell), ...(isWin ? { shell } : {}), async: true });
const both = (word) => (isWin ? [hook(`${word}-ps`, 'powershell'), hook(`${word}-bash`, 'bash')] : [hook(word, 'bash')]);
const settings = {
  hooks: {
    SessionStart: [{ hooks: both('start') }],
    SessionEnd: [{ hooks: both('end') }],
    UserPromptSubmit: [{ hooks: both('prompt') }],
    Stop: [{ hooks: both('stop') }],
    Notification: [{ matcher: 'permission_prompt|idle_prompt', hooks: both('notify') }],
  },
};

const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|NO_COLOR)/.test(k)) delete env[k];
Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, CODEDECK_STATUS_FILE: statusFile, TERM: 'xterm-256color' });

const term = new Terminal({ cols: 110, rows: 30, allowProposedApi: true });
const p = pty.spawn(claude, ['--settings', JSON.stringify(settings)], { name: 'xterm-256color', cols: 110, rows: 30, cwd, env });
let raw = '';
p.onData((d) => {
  raw += d;
  term.write(d);
});
term.onData((d) => p.write(d)); // terminal query replies (DA, XTVERSION ...)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = () => {
  const b = term.buffer.active;
  return Array.from({ length: term.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
    .join('\n')
    .replace(/\n+$/, '');
};
const status = () => (fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8').trim().split(/\r?\n/) : []);

(async () => {
  await sleep(6000);
  if (/trust this folder/i.test(screen())) {
    if (!process.argv.includes('--trust')) {
      console.log(screen());
      console.log('trust prompt shown; rerun with --trust');
      process.exit(1);
    }
    if (!/❯\s*1\.\s*Yes/.test(screen())) p.write('\x1b[B');
    await sleep(300);
    p.write('\r');
    await sleep(5000);
  }
  // Dismiss one-time dialogs (e.g. the Chrome extension notice) with Esc = keep the default.
  if (/Enter to confirm|Esc to/i.test(screen())) {
    p.write('\x1b');
    await sleep(1500);
  }
  console.log('===== screen =====\n' + screen());
  const afterStart = status();
  let afterPrompt = [];
  if (process.argv.includes('--prompt')) {
    p.write('Reply with just: OK');
    await sleep(500);
    p.write('\r');
    for (let i = 0; i < 60 && !status().some((w) => w.startsWith('stop')); i++) await sleep(1000);
    await sleep(2000);
    afterPrompt = status();
    console.log('===== after prompt =====\n' + screen());
  }
  p.write('/exit');
  await sleep(500);
  p.write('\r');
  await sleep(5000);
  const titles = [...raw.matchAll(/\x1b\][02];([^\x07\x1b]*)/g)].map((m) => m[1]);
  console.log('\nSUMMARY', JSON.stringify({ afterStart, afterPrompt, final: status(), titles: [...new Set(titles)] }));
  try { p.kill(); } catch {}
  process.exit(0);
})();
