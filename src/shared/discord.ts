/**
 * Discord remote control (§6): settings and the pure safety rules shared by
 * the bridge, the UI and tests.
 */

export interface DiscordPermissions {
  /** /send: type an instruction into a session. */
  send: boolean;
  /** Allow / Deny buttons on approval prompts. */
  approve: boolean;
  /** /new: start a session. Off by default (§6). */
  newSession: boolean;
  /** /stop: interrupt (Esc). */
  stop: boolean;
}

export interface DiscordSettings {
  enabled: boolean;
  /** Server (guild) where the slash commands are registered. */
  guildId: string;
  /** Channel for per-session threads and usage alerts. */
  channelId: string;
  /** Only these Discord user ids may use the bot (§6 security). */
  allowedUserIds: string[];
  permissions: DiscordPermissions;
  /** Mention this user when a long task finishes (default: the first allowed user). */
  mentionUserId: string;
  /** A finished task is "long" (mention) after this many seconds of work. */
  mentionAfterSec: number;
  /** Re-notify an approval that is still waiting after this many minutes. */
  approvalReminderMin: number;
  /** While a progress update is due, post at most this often (seconds). */
  progressEverySec: number;
  /** Prevent system sleep while the bot is connected (§6: スリープ防止). */
  keepAwake: boolean;
  /** Also post usage alerts (§7) to the channel. */
  notifyUsage: boolean;
}

export const DEFAULT_DISCORD: DiscordSettings = {
  enabled: false,
  guildId: '',
  channelId: '',
  allowedUserIds: [],
  permissions: { send: true, approve: true, newSession: false, stop: false },
  mentionUserId: '',
  mentionAfterSec: 60,
  approvalReminderMin: 5,
  progressEverySec: 60,
  keepAwake: true,
  notifyUsage: true,
};

/** Discord ids are 17–20 digit snowflakes. */
export function isSnowflake(s: string): boolean {
  return /^\d{17,20}$/.test(s.trim());
}

export function parseIdList(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[\s,、]+/)
        .map((x) => x.trim())
        .filter(isSnowflake),
    ),
  ];
}

export function normalizeDiscord(raw: Partial<DiscordSettings> | undefined): DiscordSettings {
  const r = raw ?? {};
  const d = DEFAULT_DISCORD;
  const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
  const id = (v: unknown) => (typeof v === 'string' && isSnowflake(v) ? v.trim() : '');
  const p: Partial<DiscordPermissions> = r.permissions ?? {};
  return {
    enabled: bool(r.enabled, d.enabled),
    guildId: id(r.guildId),
    channelId: id(r.channelId),
    allowedUserIds: Array.isArray(r.allowedUserIds)
      ? r.allowedUserIds.filter((x) => typeof x === 'string' && isSnowflake(x))
      : [],
    permissions: {
      send: bool(p.send, d.permissions.send),
      approve: bool(p.approve, d.permissions.approve),
      newSession: bool(p.newSession, d.permissions.newSession),
      stop: bool(p.stop, d.permissions.stop),
    },
    mentionUserId: id(r.mentionUserId),
    mentionAfterSec: num(r.mentionAfterSec, 0, 86_400, d.mentionAfterSec),
    approvalReminderMin: num(r.approvalReminderMin, 1, 1440, d.approvalReminderMin),
    progressEverySec: num(r.progressEverySec, 15, 3600, d.progressEverySec),
    keepAwake: bool(r.keepAwake, d.keepAwake),
    notifyUsage: bool(r.notifyUsage, d.notifyUsage),
  };
}

// ---------- secrets ----------

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g, // Discord bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** `.env`-style assignments whose name looks secret: the value is masked, the name kept. */
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{4,})\3/gi;

export const MASK = '••••••';

/** Mask API keys, tokens and `.env`-like secrets before anything leaves the machine (§6). */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = text.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string, q: string) => {
    masked++;
    return `${name}${sep}${q}${MASK}${q}`;
  });
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, () => {
      masked++;
      return MASK;
    });
  return { text: out, masked };
}

// ---------- dangerous operations ----------

const DANGER: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r)\b/i, label: 'rm -r' },
  { re: /\bgit\s+push\b/i, label: 'git push' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: 'git clean -f' },
  { re: /--force\b|\s-f\s+origin\b/i, label: '--force' },
  { re: /\bRemove-Item\b[^\n]*-Recurse/i, label: 'Remove-Item -Recurse' },
  { re: /\b(del|erase)\s+\/[sq]/i, label: 'del /s' },
  { re: /\brmdir\s+\/s\b/i, label: 'rmdir /s' },
  { re: /\b(drop|truncate)\s+(table|database)\b/i, label: 'DROP / TRUNCATE' },
  { re: /\bformat\s+[a-z]:/i, label: 'format' },
  { re: /\bmkfs\b|\bdd\s+if=/i, label: 'disk write' },
  { re: /\bchmod\s+-R\s+777\b/i, label: 'chmod -R 777' },
  { re: /\bnpm\s+publish\b|\bgh\s+release\s+create\b/i, label: 'publish' },
  { re: /(ファイル|フォルダ|ディレクトリ)(を|の)?(全部|すべて)?削除/, label: '削除' },
  { re: /\bdelete\s+(all|every|the)\s+(files?|folders?|directories)\b/i, label: 'delete files' },
];

/** Labels of the dangerous operations found in an instruction or a permission prompt. */
export function findDanger(text: string): string[] {
  return [...new Set(DANGER.filter((d) => d.re.test(text)).map((d) => d.label))];
}

/**
 * The part of the screen that belongs to the current permission prompt: the lines
 * after the user's last input line ("> …" / "❯ …", not a menu item like "❯ 1. Yes").
 * Earlier instructions on screen must not make a harmless approval look dangerous.
 */
export function approvalRegion(lines: string[]): string {
  let start = 0;
  lines.forEach((l, i) => {
    if (/^\s*[>❯]\s+(?!\d+\.)\S/.test(l)) start = i + 1;
  });
  return lines.slice(start).join('\n');
}

// ---------- text for Discord ----------

export const DISCORD_LIMIT = 2000;

/** Recent screen lines, trimmed, blank runs collapsed, framed lines (borders) dropped. */
export function tidyScreen(lines: string[], max = 30): string {
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (/^[\s─━═╌┄-]{8,}$/.test(l)) continue; // input box borders
    if (!l.trim() && (!out.length || !out[out.length - 1]!.trim())) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out.slice(-max).join('\n');
}

/**
 * Message body for Discord: masked, fenced, and moved to an attachment when it
 * does not fit (§6: 長文はファイル添付).
 */
export function codeMessage(
  header: string,
  body: string,
): { content: string; file: { name: string; data: string } | null; masked: number } {
  const m = maskSecrets(body);
  const fenced = m.text.replace(/```/g, '`​``');
  const content = `${header}\n\`\`\`\n${fenced || ' '}\n\`\`\``;
  if (content.length <= DISCORD_LIMIT) return { content, file: null, masked: m.masked };
  const tail = fenced.split('\n').slice(-12).join('\n').slice(-1200);
  return {
    content: `${header}\n\`\`\`\n…\n${tail}\n\`\`\``,
    file: { name: 'output.txt', data: m.text },
    masked: m.masked,
  };
}

/** Pick a session from a /command option: exact title, id prefix, or a unique partial match. */
export function matchSession<T extends { id: string; title: string }>(
  sessions: T[],
  query: string,
): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = sessions.filter((s) => s.title.toLowerCase() === q || s.id === query.trim());
  if (exact.length === 1) return exact[0]!;
  const byId = sessions.filter((s) => s.id.startsWith(q));
  if (byId.length === 1) return byId[0]!;
  const partial = sessions.filter((s) => s.title.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0]! : null;
}

/** Thread names: ≤ 100 chars, no line breaks. */
export function threadName(title: string, profile: string): string {
  return `${title} · ${profile}`.replace(/\s+/g, ' ').slice(0, 100);
}
