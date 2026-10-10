import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterPalette, fold, fuzzyScore, type PaletteItem } from '@shared/palette';
import { CONTRAST_PAIRS, PALETTES, contrastRatio, resolveTheme, terminalFontFamily } from '@shared/theme';
import { DEFAULT_SETTINGS, normalizeSettings, SettingsStore } from '../../src/main/settings';
import { singlePane } from '@shared/layout';

describe('command palette matching', () => {
  const items: PaletteItem[] = [
    { id: '1', group: 'session', label: 'my project #1', detail: 'team' },
    { id: '2', group: 'session', label: 'login: personal', detail: 'personal' },
    { id: '3', group: 'command', label: '右に分割' },
    { id: '4', group: 'setting', label: 'テーマ: ダーク' },
  ];

  it('substring and in-order fuzzy matches; label beats detail', () => {
    expect(fuzzyScore('mp1', 'my project #1')).not.toBeNull();
    expect(fuzzyScore('xyz', 'my project #1')).toBeNull();
    expect(filterPalette(items, 'ダーク').map((i) => i.id)).toEqual(['4']);
    expect(filterPalette(items, 'team').map((i) => i.id)).toEqual(['1']);
    expect(filterPalette(items, 'personal')[0]!.id).toBe('2');
  });

  it('full-width input from an IME matches (ＭＹ → my)', () => {
    expect(fold('ＭＹ　Ｐ')).toBe('my p');
    expect(filterPalette(items, 'ＭＹ').map((i) => i.id)).toEqual(['1']);
  });

  it('empty query lists sessions first', () => {
    expect(filterPalette(items, '')[0]!.group).toBe('session');
  });
});

describe('themes (§4: WCAG AA)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every text/surface pair is at least 4.5:1`, () => {
      const p = PALETTES[theme];
      for (const [text, surface] of CONTRAST_PAIRS) {
        const ratio = contrastRatio(p[text], p[surface]);
        expect(ratio, `${theme} ${text} on ${surface} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('system mode follows the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('terminal font: chosen font first, default stack as fallback, no CSS injection', () => {
    expect(terminalFontFamily('')).toContain('Cascadia Mono');
    expect(terminalFontFamily('JetBrains Mono').startsWith('"JetBrains Mono", ')).toBe(true);
    expect(terminalFontFamily('x"; } body { color: red')).not.toMatch(/[;{}]/);
  });
});

describe('settings', () => {
  it('normalizes unknown / out-of-range values from a hand-edited file', () => {
    const s = normalizeSettings({
      theme: 'neon' as never,
      uiFontSize: 99,
      terminalFontSize: -3,
      layout: { broken: true } as never,
      rightPanel: { open: true, tab: 'x' as never, width: 5 },
      popouts: ['a', 3 as never],
    });
    expect(s.theme).toBe('system');
    expect(s.uiFontSize).toBe(20);
    expect(s.terminalFontSize).toBe(9);
    expect(s.layout).toBeNull();
    expect(s.rightPanel).toEqual({ open: true, tab: 'notes', width: 240 });
    expect(s.popouts).toEqual(['a']);
  });

  it('persists and reloads (layout included)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd settings '));
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const layout = singlePane('abc', 'p1');
    store.set({ theme: 'light', layout, locale: 'en' });
    const again = new SettingsStore(file);
    expect(again.get().theme).toBe('light');
    expect(again.get().locale).toBe('en');
    expect(again.get().layout).toEqual(layout);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
