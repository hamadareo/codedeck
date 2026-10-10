/**
 * Light / dark palettes (§4). Every text/background pair the UI uses is
 * checked against WCAG AA (4.5:1) in tests/unit/theme.test.ts.
 */
export type ResolvedTheme = 'light' | 'dark';

export interface Palette {
  bg: string;
  panel: string;
  'panel-2': string;
  line: string;
  fg: string;
  muted: string;
  accent: string;
  danger: string;
  ok: string;
  warn: string;
  /** Text on accent / danger / ok fills (buttons, badges). */
  'on-accent': string;
  'on-danger': string;
  'on-ok': string;
}

export const PALETTES: Record<ResolvedTheme, Palette> = {
  dark: {
    bg: '#0b0d12',
    panel: '#12151c',
    'panel-2': '#191d26',
    line: '#2a2f3b',
    fg: '#e6e8ee',
    muted: '#a3aab8',
    accent: '#60a5fa',
    danger: '#f87171',
    ok: '#4ade80',
    warn: '#fbbf24',
    'on-accent': '#000000',
    'on-danger': '#000000',
    'on-ok': '#000000',
  },
  light: {
    bg: '#ffffff',
    panel: '#f5f6f8',
    'panel-2': '#e9ebf0',
    line: '#cfd4dd',
    fg: '#16181d',
    muted: '#4f5664',
    accent: '#1d4ed8',
    danger: '#b91c1c',
    ok: '#15703a',
    warn: '#8a4b07',
    'on-accent': '#ffffff',
    'on-danger': '#ffffff',
    'on-ok': '#ffffff',
  },
};

/** Text tokens × surfaces that must reach AA. */
export const CONTRAST_PAIRS: [keyof Palette, keyof Palette][] = [
  ...(['fg', 'muted', 'accent', 'danger', 'ok', 'warn'] as const).flatMap((text) =>
    (['bg', 'panel', 'panel-2'] as const).map((surface): [keyof Palette, keyof Palette] => [text, surface]),
  ),
  ['on-accent', 'accent'],
  ['on-danger', 'danger'],
  ['on-ok', 'ok'],
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function resolveTheme(mode: 'system' | 'light' | 'dark', systemDark: boolean): ResolvedTheme {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

/** xterm.js colors. claude mostly draws in truecolor; the ANSI set matters for shells and older output. */
export const TERMINAL_THEMES: Record<ResolvedTheme, Record<string, string>> = {
  dark: {
    background: '#0b0d12',
    foreground: '#e6e8ee',
    cursor: '#e6e8ee',
    cursorAccent: '#0b0d12',
    selectionBackground: '#334155',
  },
  light: {
    background: '#ffffff',
    foreground: '#16181d',
    cursor: '#16181d',
    cursorAccent: '#ffffff',
    selectionBackground: '#bfdbfe',
    black: '#16181d',
    red: '#b91c1c',
    green: '#15703a',
    yellow: '#8a5a00',
    blue: '#1d4ed8',
    magenta: '#9d174d',
    cyan: '#0e7490',
    white: '#6b7280',
    brightBlack: '#4f5664',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#a16207',
    brightBlue: '#2563eb',
    brightMagenta: '#c026d3',
    brightCyan: '#0891b2',
    brightWhite: '#374151',
  },
};

export const DEFAULT_TERMINAL_FONT =
  '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "SF Mono", "BIZ UDGothic", "MS Gothic", "Osaka-Mono", monospace';

/** Offered in Settings; any installed font name can also be typed. */
export const TERMINAL_FONT_CHOICES = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Menlo',
  'SF Mono',
  'Monaco',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'BIZ UDGothic',
  'MS Gothic',
  'Osaka-Mono',
];

/** The CSS font-family for the terminal: the chosen font first, then the default stack as fallback. */
export function terminalFontFamily(choice: string): string {
  const c = choice.trim().replace(/["\\;{}]/g, '');
  return c ? `"${c}", ${DEFAULT_TERMINAL_FONT}` : DEFAULT_TERMINAL_FONT;
}
