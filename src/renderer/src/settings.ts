import { createContext, useContext, useEffect, useState } from 'react';
import type { Settings } from '@shared/types';
import { PALETTES, resolveTheme, type ResolvedTheme } from '@shared/theme';
import { api } from './api';
import { applyTerminalAppearance } from './terminal/registry';

export const SettingsContext = createContext<Settings | null>(null);

export function useSettingsValue(): Settings | null {
  return useContext(SettingsContext);
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Loads settings, follows changes from any window, and applies theme + font sizes to the page. */
export function useSettings(): { settings: Settings | null; resolved: ResolvedTheme } {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [systemDark, setSystemDark] = useState(darkQuery.matches);

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings);
    const off = api.on('settings:changed', setSettings);
    const onScheme = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener('change', onScheme);
    return () => {
      off();
      darkQuery.removeEventListener('change', onScheme);
    };
  }, []);

  const resolved = resolveTheme(settings?.theme ?? 'system', systemDark);

  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(PALETTES[resolved])) root.style.setProperty(`--color-${k}`, v);
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    if (settings) {
      root.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
      root.lang = settings.locale;
    }
    applyTerminalAppearance({
      theme: resolved,
      fontSize: settings?.terminalFontSize ?? 14,
      fontFamily: settings?.terminalFontFamily ?? '',
    });
  }, [resolved, settings]);

  return { settings, resolved };
}

/** Persist a settings change (main broadcasts it back to every window). */
export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return api.invoke('settings:set', patch);
}
