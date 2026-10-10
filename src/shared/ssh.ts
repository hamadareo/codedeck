/**
 * SSH sessions (§5): claude runs on a remote machine through the OS `ssh`.
 * Only connection settings are stored; passwords and keys never are (the user
 * answers prompts in the terminal; key files stay where they are).
 */

export interface SshHost {
  id: string;
  name: string;
  /** user@host or a Host alias from ~/.ssh/config. */
  destination: string;
  port: number | null;
  /** Path to a private key file (only the path is stored). */
  identityFile: string;
  /** Remote working folder; empty = the remote home. */
  remoteDir: string;
  /** Remote CLAUDE_CONFIG_DIR, for separate accounts on one machine; empty = remote default. */
  remoteConfigDir: string;
  createdAt: number;
}

export type SshHostInput = Omit<SshHost, 'id' | 'createdAt'>;

/** POSIX single-quote for the remote shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A remote path: "~" and "~/x" keep the tilde unquoted so the remote shell expands it. */
function remotePath(p: string): string {
  if (p === '~') return '~';
  if (p.startsWith('~/')) return `~/${shQuote(p.slice(2))}`;
  return shQuote(p);
}

export function validateHost(h: SshHostInput): string | null {
  if (!h.name.trim()) return 'ssh.error.name';
  // No spaces or option-looking values: the destination is passed as one ssh argument.
  if (!/^[A-Za-z0-9._@%+-]+$/.test(h.destination.trim()) || h.destination.trim().startsWith('-'))
    return 'ssh.error.destination';
  if (h.port !== null && !(Number.isInteger(h.port) && h.port > 0 && h.port < 65536)) return 'ssh.error.port';
  return null;
}

/** The command run on the remote side: cd, optional config dir, then claude (resume or new). */
export function remoteCommand(
  host: Pick<SshHost, 'remoteDir' | 'remoteConfigDir'>,
  sessionId: string,
  resume: boolean,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('bad session id');
  const parts: string[] = [];
  if (host.remoteDir.trim()) parts.push(`cd ${remotePath(host.remoteDir.trim())}`);
  const env = host.remoteConfigDir.trim()
    ? `CLAUDE_CONFIG_DIR=${remotePath(host.remoteConfigDir.trim())} `
    : '';
  // The remote transcript cannot be checked from here: try to resume, else start fresh under the same id.
  parts.push(
    resume
      ? `{ ${env}claude --resume ${sessionId} || ${env}claude --session-id ${sessionId}; }`
      : `${env}claude --session-id ${sessionId}`,
  );
  return parts.join(' && ');
}

/** Arguments for the local `ssh` executable. */
export function sshArgs(
  host: Pick<SshHost, 'destination' | 'port' | 'identityFile' | 'remoteDir' | 'remoteConfigDir'>,
  sessionId: string,
  resume: boolean,
): string[] {
  const args = ['-t'];
  if (host.port) args.push('-p', String(host.port));
  if (host.identityFile.trim()) args.push('-i', host.identityFile.trim());
  args.push('--', host.destination.trim(), remoteCommand(host, sessionId, resume));
  return args;
}
