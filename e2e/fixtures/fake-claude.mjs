// Stand-in for the claude CLI in E2E tests. Prints what it was launched with,
// echoes keystrokes, and "saves a transcript" on Enter like the real CLI does.
// Like the real CLI, it runs the hooks given with `--settings <file>` through
// the shell each hook names, so CodeDeck's status hooks are tested for real:
//   start → SessionStart; Enter → UserPromptSubmit, then Stop after a moment;
//   a line "perm" → Notification(permission_prompt); "fail" → StopFailure;
//   "limit" → the CLI's "5-hour limit reached" message.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cfg = process.env.CLAUDE_CONFIG_DIR ?? '(default)';

if (args[0] === '--version') {
  console.log('9.9.9 (Fake Claude)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(
    JSON.stringify({ loggedIn: true, email: `${path.basename(cfg)}@example.com`, configDirectory: cfg }),
  );
  process.exit(0);
}

// Like an account whose organization turned Remote Control off: profiles named "team".
if (args[0] === 'remote-control' && args[1] === '--help') {
  if (path.basename(cfg) === 'team') {
    console.error("Error: Remote Control is disabled by your organization's policy.");
    process.exit(1);
  }
  console.log('Remote Control - Control local sessions from claude.ai/code or the Claude mobile app');
  process.exit(0);
}

if (args[0] === 'mcp' && args[1] === 'list') {
  console.log('Checking MCP server health…\n');
  console.log('fake-docs: https://example.com/mcp - ✔ Connected');
  process.exit(0);
}

const settingsIdx = args.indexOf('--settings');
const settings =
  settingsIdx >= 0 ? JSON.parse(fs.readFileSync(args[settingsIdx + 1], 'utf8')) : { hooks: {} };

// Like claude, each hook gets the event's JSON on stdin, and hooks run one event after another:
// a slow hook (PowerShell on a busy runner) never reports a later event before an earlier one.
let hooks = Promise.resolve();
function fire(event, matchValue) {
  const input = JSON.stringify({ session_id: sessionId, hook_event_name: event, cwd: process.cwd() });
  hooks = hooks.then(() => Promise.all(runHooks(event, matchValue, input)));
  return hooks;
}

function runHooks(event, matchValue, input) {
  const runs = [];
  for (const group of settings.hooks?.[event] ?? []) {
    if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(matchValue ?? '')) continue;
    for (const h of group.hooks) {
      const [file, argv] =
        h.shell === 'powershell'
          ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', h.command]]
          : process.platform === 'win32'
            ? ['bash', ['-c', h.command]]
            : ['/bin/sh', ['-c', h.command]];
      const child = spawn(file, argv, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      runs.push(new Promise((resolve) => (child.on('exit', resolve), child.on('error', resolve))));
    }
  }
  return runs;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idIdx = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
// `--resume` without an id: claude's picker of past conversations.
const picker = args.includes('--resume') && !UUID.test(args[args.indexOf('--resume') + 1] ?? '');
const PAST = ['11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa'];
let sessionId = picker ? 'none' : idIdx >= 0 ? args[idIdx + 1] : 'none';
process.stdout.write(`FAKE-CLAUDE cfg=${cfg}\r\n`);
process.stdout.write(
  `FAKE-CLAUDE args=${args.filter((_, i) => i !== settingsIdx && i !== settingsIdx + 1).join(' ')}\r\n`,
);
process.stdout.write(`FAKE-CLAUDE hooks=${settingsIdx >= 0 ? 'yes' : 'no'}\r\n`);
process.stdout.write(
  `FAKE-CLAUDE nested=${process.env.CLAUDECODE ?? 'no'} color=${process.env.COLORTERM ?? ''}\r\n> `,
);
if (picker) process.stdout.write(`\r\nFAKE-CLAUDE picker: 1) ${PAST[0]}  2) ${PAST[1]}\r\n? `);
else fire('SessionStart', 'startup');

let line = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d === '\x03') process.exit(0);
  // On a slow machine the last keys and Enter can arrive in one chunk: handle them one by one.
  if (d.length > 1 && d.includes('\r') && !d.startsWith('\x1b')) {
    for (const part of d.split(/(\r)/)) if (part) onInput(part);
    return;
  }
  onInput(d);
});

function onInput(d) {
  if (d.includes('\r')) {
    const typed = line;
    line = '';
    if (sessionId === 'none' && picker) {
      const picked = PAST[Number(typed) - 1];
      if (!picked) return void process.stdout.write('\r\n? ');
      sessionId = picked;
      process.stdout.write(`\r\nFAKE-CLAUDE resumed ${picked}\r\n> `);
      fire('SessionStart', 'resume');
      return;
    }
    if (typed === 'perm') {
      fire('Notification', 'permission_prompt');
      process.stdout.write('\r\nFAKE-CLAUDE permission? (y/n)\r\n');
      return;
    }
    if (typed === 'spam') {
      // Heavy output for the performance test: ~30 KB/s of colored lines for 15 seconds
      // (well above claude's own streaming rate), in many small writes.
      const until = Date.now() + 15_000;
      let n = 0;
      const timer = setInterval(() => {
        let chunk = '';
        for (let i = 0; i < 6; i++)
          chunk += `\x1b[3${n % 7}m${String(++n).padStart(6, '0')} ${'lorem ipsum dolor sit amet '.repeat(3)}\x1b[0m\r\n`;
        process.stdout.write(chunk);
        if (Date.now() > until) {
          clearInterval(timer);
          process.stdout.write('FAKE-CLAUDE spam done\r\n> ');
        }
      }, 20);
      return;
    }
    if (typed === 'limit') {
      // As the real CLI prints it (colored, with cursor moves around it).
      process.stdout.write('\r\n\x1b[31m⎿  5-hour limit reached\x1b[39m ∙ resets 3pm (Asia/Tokyo)\r\n> ');
      fire('Stop');
      return;
    }
    if (typed === 'fail') {
      fire('StopFailure', 'server_error');
      process.stdout.write('\r\nFAKE-CLAUDE failed\r\n> ');
      return;
    }
    const dir = path.join(cfg, 'projects', 'fake-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    process.stdout.write('\r\nFAKE-CLAUDE saved\r\n');
    // claude works on the prompt only after its UserPromptSubmit hooks have finished.
    void fire('UserPromptSubmit').then(() =>
      setTimeout(() => {
        fire('Stop');
        process.stdout.write('FAKE-CLAUDE done\r\n> ');
      }, 1500),
    );
    return;
  }
  line += d;
  process.stdout.write(d);
}
