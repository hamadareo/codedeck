// Stand-in for the claude CLI in E2E tests. Prints what it was launched with,
// echoes keystrokes, and "saves a transcript" on Enter like the real CLI does.
import fs from 'node:fs';
import path from 'node:path';

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

const idIdx = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
const sessionId = idIdx >= 0 ? args[idIdx + 1] : 'none';
process.stdout.write(`FAKE-CLAUDE cfg=${cfg}\r\n`);
process.stdout.write(`FAKE-CLAUDE args=${args.join(' ')}\r\n`);
process.stdout.write(
  `FAKE-CLAUDE nested=${process.env.CLAUDECODE ?? 'no'} color=${process.env.COLORTERM ?? ''}\r\n> `,
);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d === '\x03') process.exit(0);
  if (d.includes('\r')) {
    const dir = path.join(cfg, 'projects', 'fake-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
    process.stdout.write('\r\nFAKE-CLAUDE saved\r\n> ');
    return;
  }
  process.stdout.write(d);
});
