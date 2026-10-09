/**
 * Keyboard rules (§2.5 key map layer, §2.6-3 terminal passthrough).
 *
 * While a terminal has focus, every key goes to the CLI unchanged except:
 *  - App shortcuts: Cmd+<key> on macOS, Ctrl+Shift+<key> on Windows/Linux
 *    (plain Ctrl+<key> belongs to the CLI there: Ctrl+C, Ctrl+W, Ctrl+K ...).
 *  - Terminal-emulator duties: copy with a selection, paste, Shift+Enter newline.
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
  'newSession' | 'closeTab' | 'nextTab' | 'prevTab' | `tab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

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

export function appActionFor(ev: KeyLike, platform: Platform): AppAction | null {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  // Ctrl+Tab / Ctrl+Shift+Tab switch tabs on both platforms (not used by the CLI).
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && k === 'Tab') return ev.shiftKey ? 'prevTab' : 'nextTab';

  const isAppMod =
    platform === 'mac'
      ? ev.metaKey && !ev.ctrlKey && !ev.altKey
      : ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey;
  if (!isAppMod) return null;
  if (platform === 'mac' && ev.shiftKey) return null; // reserved for Cmd+Shift combos (Phase 2)
  if (k === 't') return 'newSession';
  if (k === 'w') return 'closeTab';
  // With Shift held, digits arrive as symbols ("!", "\"" ...) depending on layout; use the physical key.
  const digit = /^Digit([1-9])$/.exec(ev.code ?? '')?.[1] ?? (/^[1-9]$/.test(k) ? k : null);
  if (digit) return `tab${digit}` as AppAction;
  return null;
}

export function decideTerminalKey(
  ev: KeyLike,
  platform: Platform,
  hasSelection: boolean,
): TerminalKeyDecision {
  const action = appActionFor(ev, platform);
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
