/**
 * Keyboard rules (§2.5 key map layer, §2.6-3 terminal passthrough).
 *
 * While a terminal has focus, every key goes to the CLI unchanged except:
 *  - App shortcuts: Cmd+<key> on macOS, Ctrl+Shift+<key> on Windows/Linux
 *    (plain Ctrl+<key> belongs to the CLI there: Ctrl+C, Ctrl+W, Ctrl+K ...).
 *  - Terminal-emulator duties: copy with a selection, paste, Shift+Enter newline.
 * Outside a terminal, Windows also accepts Ctrl+K (palette) and Ctrl+, (settings) (§4).
 */

export type Platform = 'mac' | 'other';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code?: string;
}

export type AppAction =
  | 'newSession'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | `tab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'palette'
  | 'settings'
  | 'splitRight'
  | 'splitDown'
  | 'closePane'
  | 'maximize'
  | 'nextPane'
  | 'prevPane'
  | 'toggleRightPanel'
  | 'popout'
  | 'find';

export type TerminalKeyDecision =
  | { kind: 'pass' }
  | { kind: 'app'; action: AppAction }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'send'; data: string };

/** Shift+Enter: the sequence Claude Code's /terminal-setup configures for a newline. */
export const SHIFT_ENTER_SEQUENCE = '\x1b\r';

export function platformOf(p: string): Platform {
  return p === 'darwin' ? 'mac' : 'other';
}

/** The app-shortcut modifier label for hints ("⌘" / "Ctrl+Shift+"). */
export function modLabel(platform: Platform): string {
  return platform === 'mac' ? '⌘' : 'Ctrl+Shift+';
}

/**
 * Shortcut table. `shift` applies to macOS only (Windows shortcuts always hold Ctrl+Shift).
 * Keys are matched on `key` (lower-cased) so layouts keep their printed letters; symbols
 * list the shifted variants too ("]" / "}").
 */
const TABLE: { action: AppAction; keys: string[]; macShift: boolean }[] = [
  { action: 'newSession', keys: ['t'], macShift: false },
  { action: 'closeTab', keys: ['w'], macShift: false },
  { action: 'closePane', keys: ['w'], macShift: true },
  { action: 'palette', keys: ['k'], macShift: false },
  { action: 'palette', keys: ['p'], macShift: true },
  { action: 'splitRight', keys: ['d'], macShift: false },
  { action: 'splitDown', keys: ['d'], macShift: true },
  { action: 'maximize', keys: ['Enter'], macShift: true },
  { action: 'nextPane', keys: [']', '}'], macShift: false },
  { action: 'prevPane', keys: ['[', '{'], macShift: false },
  { action: 'toggleRightPanel', keys: ['b'], macShift: false },
  { action: 'settings', keys: [',', '<'], macShift: false },
  { action: 'popout', keys: ['o'], macShift: true },
  { action: 'find', keys: ['f'], macShift: false },
];

/** Windows/Linux: Ctrl+Shift+<key>. Shift is always held, so pick distinct keys where macOS uses Shift. */
const WIN_KEYS: Partial<Record<AppAction, string[]>> = {
  newSession: ['t'],
  closeTab: ['w'],
  closePane: ['x'],
  palette: ['k', 'p'],
  splitRight: ['d'],
  splitDown: ['e'],
  maximize: ['Enter'],
  nextPane: [']', '}'],
  prevPane: ['[', '{'],
  toggleRightPanel: ['b'],
  settings: [',', '<'],
  popout: ['o'],
  find: ['f'],
};

export function appActionFor(ev: KeyLike, platform: Platform, inTerminal = true): AppAction | null {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  // Ctrl+Tab / Ctrl+Shift+Tab switch tabs on both platforms (not used by the CLI).
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && k === 'Tab') return ev.shiftKey ? 'prevTab' : 'nextTab';

  if (platform === 'mac') {
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return null;
    // With Shift held, digits arrive as symbols depending on layout; use the physical key.
    const digit = /^Digit([1-9])$/.exec(ev.code ?? '')?.[1] ?? (/^[1-9]$/.test(k) ? k : null);
    if (digit && !ev.shiftKey) return `tab${digit}` as AppAction;
    return TABLE.find((r) => r.macShift === ev.shiftKey && r.keys.includes(k))?.action ?? null;
  }

  // Outside the terminal, the plain Ctrl shortcuts from §4 are free to use.
  if (!inTerminal && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
    if (k === 'k') return 'palette';
    if (k === ',') return 'settings';
  }
  if (!(ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey)) return null;
  const digit = /^Digit([1-9])$/.exec(ev.code ?? '')?.[1] ?? (/^[1-9]$/.test(k) ? k : null);
  if (digit) return `tab${digit}` as AppAction;
  for (const [action, keys] of Object.entries(WIN_KEYS)) if (keys.includes(k)) return action as AppAction;
  return null;
}

/** Human-readable shortcut for menus and the palette ("⌘D" / "Ctrl+Shift+D"). */
export function shortcutLabel(action: AppAction, platform: Platform): string {
  const show = (key: string) => (key === 'Enter' ? '↵' : key.toUpperCase());
  if (platform === 'mac') {
    const r = TABLE.find((x) => x.action === action);
    if (!r) return '';
    return `${r.macShift ? '⇧' : ''}⌘${show(r.keys[0]!)}`;
  }
  const keys = WIN_KEYS[action];
  return keys ? `Ctrl+Shift+${show(keys[0]!)}` : '';
}

export function decideTerminalKey(
  ev: KeyLike,
  platform: Platform,
  hasSelection: boolean,
): TerminalKeyDecision {
  const action = appActionFor(ev, platform, true);
  if (action) return { kind: 'app', action };

  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (k === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    return { kind: 'send', data: SHIFT_ENTER_SEQUENCE };
  }
  if (platform === 'mac') {
    if (ev.metaKey && !ev.shiftKey && k === 'c') return hasSelection ? { kind: 'copy' } : { kind: 'pass' };
    if (ev.metaKey && !ev.shiftKey && k === 'v') return { kind: 'paste' };
    return { kind: 'pass' };
  }
  // Windows/Linux: same behaviour as Windows Terminal.
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
    if (k === 'c' && hasSelection) return { kind: 'copy' };
    if (k === 'v') return { kind: 'paste' };
  }
  return { kind: 'pass' };
}

/**
 * Paste decision: text goes through xterm's bracketed paste; an image-only
 * clipboard sends the raw key so claude reads the clipboard itself.
 */
export function pasteDecision(
  clip: { text: string; hasImage: boolean },
  platform: Platform,
): { kind: 'text'; text: string } | { kind: 'raw'; data: string } {
  if (clip.hasImage || !clip.text) {
    // Claude Code reads images on Ctrl+V (macOS) / Alt+V (Windows).
    return { kind: 'raw', data: platform === 'mac' ? '\x16' : '\x1bv' };
  }
  return { kind: 'text', text: clip.text };
}
