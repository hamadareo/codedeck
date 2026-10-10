import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '@shared/types';
import { isLayout } from '@shared/layout';

export type { Settings };

export const DEFAULT_SETTINGS: Settings = {
  externalTerminal: 'auto',
  theme: 'system',
  locale: 'ja',
  uiFontSize: 13,
  terminalFontSize: 14,
  terminalFontFamily: '',
  layout: null,
  rightPanel: { open: false, tab: 'notes', width: 320 },
  popouts: [],
  sidebarWidth: 288,
};

const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

/** Accept only known keys with sane values (settings.json may be hand-edited or from an older version). */
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  const r = raw ?? {};
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    allowed.includes(v as T) ? (v as T) : dflt;
  const rp: Partial<Settings['rightPanel']> = r.rightPanel ?? {};
  return {
    externalTerminal: oneOf(
      r.externalTerminal,
      ['auto', 'windows-terminal', 'powershell', 'terminal-app', 'iterm'],
      d.externalTerminal,
    ),
    theme: oneOf(r.theme, ['system', 'light', 'dark'], d.theme),
    locale: oneOf(r.locale, ['ja', 'en'], d.locale),
    uiFontSize: clamp(r.uiFontSize, 11, 20, d.uiFontSize),
    terminalFontSize: clamp(r.terminalFontSize, 9, 28, d.terminalFontSize),
    terminalFontFamily: typeof r.terminalFontFamily === 'string' ? r.terminalFontFamily.slice(0, 200) : '',
    layout: isLayout(r.layout) ? r.layout : null,
    rightPanel: {
      open: rp.open === true,
      tab: oneOf(rp.tab, ['notes', 'diff', 'tasks', 'usage'], d.rightPanel.tab),
      width: clamp(rp.width, 240, 640, d.rightPanel.width),
    },
    popouts: Array.isArray(r.popouts) ? r.popouts.filter((x): x is string => typeof x === 'string') : [],
    sidebarWidth: clamp(r.sidebarWidth, 200, 480, d.sidebarWidth),
  };
}

/** Plain JSON settings next to the database (§2: settings are JSON). */
export class SettingsStore {
  private value: Settings;

  constructor(private readonly file: string) {
    this.value = normalizeSettings(this.read());
  }

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>): Settings {
    this.value = normalizeSettings({ ...this.value, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
    return this.value;
  }

  private read(): Partial<Settings> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>;
    } catch {
      return {};
    }
  }
}
