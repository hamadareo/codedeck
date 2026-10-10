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

if (args[0] === 'mcp' && args[1] === 'list') {
  console.log('Checking MCP server health…\n');
  console.log('fake-docs: https://example.com/mcp - ✔ Connected');
  process.exit(0);
}

const settingsIdx = args.indexOf('--settings');
const settings =
  settingsIdx >= 0 ? JSON.parse(fs.readFileSync(args[settingsIdx + 1], 'utf8')) : { hooks: {} };

function fire(event, matchValue) {
  for (const group of settings.hooks?.[event] ?? []) {
    if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(matchValue ?? '')) continue;
    for (const h of group.hooks) {
      const [file, argv] =
        h.shell === 'powershell'
          ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', h.command]]
          : process.platform === 'win32'
            ? ['bash', ['-c', h.command]]
            : ['/bin/sh', ['-c', h.command]];
      spawn(file, argv, { stdio: 'ignore', windowsHide: true });
    }
  }
}

const idIdx = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
const sessionId = idIdx >= 0 ? args[idIdx + 1] : 'none';
process.stdout.write(`FAKE-CLAUDE cfg=${cfg}\r\n`);
process.stdout.write(
  `FAKE-CLAUDE args=${args.filter((_, i) => i !== settingsIdx && i !== settingsIdx + 1).join(' ')}\r\n`,
);
process.stdout.write(`FAKE-CLAUDE hooks=${settingsIdx >= 0 ? 'yes' : 'no'}\r\n`);
process.stdout.write(
  `FAKE-CLAUDE nested=${process.env.CLAUDECODE ?? 'no'} color=${process.env.COLORTERM ?? ''}\r\n> `,
);
fire('SessionStart', 'startup');

let line = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d === '\x03') process.exit(0);
  if (d.includes('\r')) {
    const typed = line;
    line = '';
    if (typed === 'perm') {
      fire('Notification', 'permission_prompt');
      process.stdout.write('\r\nFAKE-CLAUDE permission? (y/n)\r\n');
      return;
    }
    if (typed === 'spam') {
      // Heavy output for the performance test: ~150 KB/s of colored lines for 8 seconds.
      const until = Date.now() + 8000;
      let n = 0;
      const timer = setInterval(() => {
        let chunk = '';
        for (let i = 0; i < 30; i++)
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
    fire('UserPromptSubmit');
    const dir = path.join(cfg, 'projects', 'fake-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    process.stdout.write('\r\nFAKE-CLAUDE saved\r\n');
    setTimeout(() => {
      fire('Stop');
      process.stdout.write('FAKE-CLAUDE done\r\n> ');
    }, 1500);
    return;
  }
  line += d;
  process.stdout.write(d);
});
