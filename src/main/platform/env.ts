/**
 * Environment for child `claude` processes.
 *
 * CLAUDE_CONFIG_DIR is always passed through the spawn env, never via shell
 * profiles or aliases (§2.5). Variables that leak in when CodeDeck itself was
 * started from inside a Claude Code session are dropped: left in place they
 * make the child think it is nested (transcripts off → /resume breaks) and
 * NO_COLOR turns colors off (docs/phase0-report.md §3).
 */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) continue;
    if (k === 'NO_COLOR' || k === 'GIT_TERMINAL_PROMPT' || k === 'CLAUDE_CONFIG_DIR') continue;
    if (k.startsWith('CODEDECK_')) continue;
    out[k] = v;
  }
  return out;
}

export function claudeEnv(base: NodeJS.ProcessEnv, configDir: string | null): Record<string, string> {
  const env = sanitizeEnv(base);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
