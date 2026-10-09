// OS-dependent bits for the spike. In the real app this becomes src/platform/.
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const isWin = process.platform === 'win32';

/** Default config dir for a CodeDeck profile: ~/.codedeck/profiles/<name> */
function profileDir(name) {
  return path.join(os.homedir(), '.codedeck', 'profiles', name);
}

/** Resolve the absolute path of the `claude` executable via PATH. */
function resolveClaude() {
  try {
    if (isWin) {
      const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
      const candidates = out.split(/\r?\n/).filter(Boolean);
      // Prefer a real .exe, then .cmd (npm global install), then anything.
      return (
        candidates.find((c) => c.toLowerCase().endsWith('.exe')) ||
        candidates.find((c) => c.toLowerCase().endsWith('.cmd')) ||
        candidates[0] ||
        null
      );
    }
    // GUI apps on macOS do not inherit the login shell PATH, so ask the login shell.
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'command -v claude'], { encoding: 'utf8' });
    const line = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    return line && fs.existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

/**
 * Drop variables that leak in when CodeDeck itself was launched from inside
 * a Claude Code session (or a no-color shell). Left in place they make the
 * child claude think it is a nested session (transcripts off) and disable color.
 */
function sanitizeEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) delete out[k];
  }
  delete out.NO_COLOR;
  delete out.GIT_TERMINAL_PROMPT;
  return out;
}

/**
 * Build the spawn command for claude inside a PTY.
 * CLAUDE_CONFIG_DIR is passed via env (never via shell profiles or aliases).
 */
function claudeSpawnSpec({ configDir, extraArgs = [] }) {
  const claude = resolveClaude();
  if (!claude) throw new Error('claude CLI not found on PATH');
  const env = { ...sanitizeEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;

  if (isWin && /\.(cmd|bat)$/i.test(claude)) {
    // Batch shims must run through cmd.exe.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', claude, ...extraArgs], env };
  }
  return { file: claude, args: extraArgs, env };
}

module.exports = { isWin, profileDir, resolveClaude, sanitizeEnv, claudeSpawnSpec };
