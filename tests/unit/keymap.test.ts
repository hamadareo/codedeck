import { describe, expect, it } from 'vitest';
import {
  appActionFor,
  decideTerminalKey,
  pasteDecision,
  SHIFT_ENTER_SEQUENCE,
  type KeyLike,
} from '@shared/keymap';

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('terminal key rules (Windows/Linux)', () => {
  it('passes plain Ctrl keys to the CLI (Ctrl+C without selection, Ctrl+W, Ctrl+K, Ctrl+U)', () => {
    for (const key of ['c', 'w', 'k', 'u', 'r', 'l']) {
      expect(decideTerminalKey(k(key, { ctrlKey: true }), 'other', false)).toEqual({ kind: 'pass' });
    }
  });

  it('copies with Ctrl+C only when there is a selection', () => {
    expect(decideTerminalKey(k('c', { ctrlKey: true }), 'other', true)).toEqual({ kind: 'copy' });
  });

  it('pastes with Ctrl+V', () => {
    expect(decideTerminalKey(k('v', { ctrlKey: true }), 'other', false)).toEqual({ kind: 'paste' });
  });

  it('Shift+Tab (permission mode) passes through', () => {
    expect(decideTerminalKey(k('Tab', { shiftKey: true }), 'other', false)).toEqual({ kind: 'pass' });
  });

  it('Shift+Enter sends the newline sequence', () => {
    expect(decideTerminalKey(k('Enter', { shiftKey: true }), 'other', false)).toEqual({
      kind: 'send',
      data: SHIFT_ENTER_SEQUENCE,
    });
  });

  it('app shortcuts are Ctrl+Shift+<key>', () => {
    expect(decideTerminalKey(k('T', { ctrlKey: true, shiftKey: true }), 'other', false)).toEqual({
      kind: 'app',
      action: 'newSession',
    });
    expect(appActionFor(k('W', { ctrlKey: true, shiftKey: true }), 'other')).toBe('closeTab');
    expect(appActionFor(k('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }), 'other')).toBe('tab1');
    expect(appActionFor(k('Tab', { ctrlKey: true }), 'other')).toBe('nextTab');
    expect(appActionFor(k('Tab', { ctrlKey: true, shiftKey: true }), 'other')).toBe('prevTab');
  });

  it('regression: Ctrl+T alone is not an app shortcut on Windows (belongs to the CLI)', () => {
    expect(appActionFor(k('t', { ctrlKey: true }), 'other')).toBeNull();
  });
});

describe('terminal key rules (macOS)', () => {
  it('Cmd shortcuts belong to the app; Ctrl keys go to the CLI', () => {
    expect(decideTerminalKey(k('t', { metaKey: true }), 'mac', false)).toEqual({
      kind: 'app',
      action: 'newSession',
    });
    expect(decideTerminalKey(k('c', { ctrlKey: true }), 'mac', true)).toEqual({ kind: 'pass' });
    expect(decideTerminalKey(k('v', { ctrlKey: true }), 'mac', false)).toEqual({ kind: 'pass' });
  });

  it('Cmd+C copies only with a selection, Cmd+V pastes', () => {
    expect(decideTerminalKey(k('c', { metaKey: true }), 'mac', true)).toEqual({ kind: 'copy' });
    expect(decideTerminalKey(k('c', { metaKey: true }), 'mac', false)).toEqual({ kind: 'pass' });
    expect(decideTerminalKey(k('v', { metaKey: true }), 'mac', false)).toEqual({ kind: 'paste' });
  });
});

describe('pasteDecision', () => {
  it('text goes through bracketed paste', () => {
    expect(pasteDecision({ text: 'hello', hasImage: false }, 'other')).toEqual({
      kind: 'text',
      text: 'hello',
    });
  });
  it('images are left for claude to read (Alt+V on Windows, Ctrl+V on macOS)', () => {
    expect(pasteDecision({ text: '', hasImage: true }, 'other')).toEqual({ kind: 'raw', data: '\x1bv' });
    expect(pasteDecision({ text: 'x', hasImage: true }, 'mac')).toEqual({ kind: 'raw', data: '\x16' });
  });
});
