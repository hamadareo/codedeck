// Stand-in for the OS ssh client in E2E tests: prints the arguments it got
// (one JSON line) and then behaves like a remote shell that echoes keys.
process.stdout.write(`FAKE-SSH args=${JSON.stringify(process.argv.slice(2))}\r\n$ `);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (d === '\x03' || d === '\x04') process.exit(0);
  process.stdout.write(d === '\r' ? '\r\n$ ' : d);
});
