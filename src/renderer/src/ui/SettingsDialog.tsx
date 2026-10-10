import { useState } from 'react';
import type { Settings, ThemeMode } from '@shared/types';
import { TERMINAL_FONT_CHOICES, terminalFontFamily } from '@shared/theme';
import { shortcutLabel, type AppAction, type Platform } from '@shared/keymap';
import { saveSettings } from '../settings';
import { useT } from '../i18n';
import { Button, Field, Modal, inputCls } from './Modal';

const SHORTCUTS: { action: AppAction; key: string }[] = [
  { action: 'palette', key: 'palette.title' },
  { action: 'newSession', key: 'cmd.newSession' },
  { action: 'closeTab', key: 'cmd.closeTab' },
  { action: 'splitRight', key: 'pane.splitRight' },
  { action: 'splitDown', key: 'pane.splitDown' },
  { action: 'closePane', key: 'pane.close' },
  { action: 'maximize', key: 'pane.maximize' },
  { action: 'nextPane', key: 'pane.focusNext' },
  { action: 'popout', key: 'pane.popout' },
  { action: 'toggleRightPanel', key: 'cmd.toggleRightPanel' },
  { action: 'settings', key: 'cmd.settings' },
];

/** Settings (§4): theme, text sizes, terminal font, language, external terminal. Changes apply at once. */
export function SettingsDialog(props: { settings: Settings; platform: Platform; onClose(): void }) {
  const t = useT();
  const s = props.settings;
  const [font, setFont] = useState(s.terminalFontFamily);
  const set = (patch: Partial<Settings>) => void saveSettings(patch);
  const radio = 'flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5';

  return (
    <Modal
      title={t('settings.title')}
      onClose={props.onClose}
      width="w-[560px]"
      testId="settings"
      footer={<Button onClick={props.onClose}>{t('common.close')}</Button>}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {t('settings.appearance')}
      </h3>
      <fieldset>
        <legend className="mb-1 text-muted">{t('settings.theme')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
            <label
              key={m}
              className={`${radio} ${s.theme === m ? 'border-accent bg-panel-2' : 'border-line'}`}
            >
              <input
                type="radio"
                name="theme"
                checked={s.theme === m}
                onChange={() => set({ theme: m })}
                data-testid={`theme-${m}`}
              />
              {t(`settings.theme.${m}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={`${t('settings.uiFontSize')}: ${s.uiFontSize}px`}>
        <input
          type="range"
          min={11}
          max={20}
          value={s.uiFontSize}
          onChange={(e) => set({ uiFontSize: Number(e.target.value) })}
          className="w-full"
          data-testid="ui-font-size"
        />
      </Field>
      <fieldset>
        <legend className="mb-1 text-muted">{t('settings.locale')}</legend>
        <div className="flex gap-2">
          {(['ja', 'en'] as const).map((l) => (
            <label
              key={l}
              className={`${radio} ${s.locale === l ? 'border-accent bg-panel-2' : 'border-line'}`}
            >
              <input
                type="radio"
                name="locale"
                checked={s.locale === l}
                onChange={() => set({ locale: l })}
              />
              {l === 'ja' ? '日本語' : 'English'}
            </label>
          ))}
        </div>
      </fieldset>

      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {t('settings.terminal')}
      </h3>
      <Field label={`${t('settings.terminalFontSize')}: ${s.terminalFontSize}px`}>
        <input
          type="range"
          min={9}
          max={28}
          value={s.terminalFontSize}
          onChange={(e) => set({ terminalFontSize: Number(e.target.value) })}
          className="w-full"
          data-testid="terminal-font-size"
        />
      </Field>
      <Field label={t('settings.terminalFont')} hint={t('settings.terminalFontHint')}>
        <input
          className={inputCls}
          list="terminal-fonts"
          value={font}
          placeholder={t('settings.terminalFontDefault')}
          onChange={(e) => setFont(e.target.value)}
          onBlur={() => set({ terminalFontFamily: font.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && set({ terminalFontFamily: font.trim() })}
          data-testid="terminal-font"
        />
        <datalist id="terminal-fonts">
          {TERMINAL_FONT_CHOICES.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      <div
        className="rounded border border-line bg-bg px-3 py-2"
        style={{ fontFamily: terminalFontFamily(font), fontSize: s.terminalFontSize }}
        aria-label={t('settings.preview')}
      >
        claude &gt; こんにちは 0O1lI {'{}'} C:\Users\you
      </div>
      <Field label={t('settings.externalTerminal')}>
        <select
          className={inputCls}
          value={s.externalTerminal}
          onChange={(e) => set({ externalTerminal: e.target.value as Settings['externalTerminal'] })}
        >
          <option value="auto">{t('settings.externalTerminal.auto')}</option>
          {props.platform === 'mac' ? (
            <>
              <option value="terminal-app">Terminal.app</option>
              <option value="iterm">iTerm2</option>
            </>
          ) : (
            <>
              <option value="windows-terminal">Windows Terminal</option>
              <option value="powershell">PowerShell</option>
            </>
          )}
        </select>
      </Field>

      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {t('settings.shortcuts')}
      </h3>
      <table className="w-full text-xs">
        <tbody>
          {SHORTCUTS.map((r) => (
            <tr key={r.action} className="border-b border-line/60">
              <td className="py-1">{t(r.key)}</td>
              <td className="py-1 text-right">
                <kbd className="font-path rounded border border-line px-1.5">
                  {shortcutLabel(r.action, props.platform)}
                  {r.action === 'nextPane' ? ` / ${shortcutLabel('prevPane', props.platform)}` : ''}
                </kbd>
                {r.action === 'palette' && props.platform !== 'mac' && (
                  <kbd className="font-path ml-1 rounded border border-line px-1.5">Ctrl+K</kbd>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
