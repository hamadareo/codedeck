import { useEffect, useState } from 'react';
import { parseIdList, type DiscordSettings } from '@shared/discord';
import type { DiscordInfo, RemoteInput } from '@shared/ipc';
import type { Session } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { saveSettings } from '../settings';
import { Button, Field, Modal, inputCls } from './Modal';

const PORTAL_URL = 'https://discord.com/developers/applications';

export function useDiscordInfo(): DiscordInfo | null {
  const [info, setInfo] = useState<DiscordInfo | null>(null);
  useEffect(() => {
    void api.invoke('discord:info').then(setInfo);
    return api.on('discord:status', setInfo);
  }, []);
  return info;
}

/** Discord setup (§6): step-by-step guide, token (stored in the OS keychain), ids, permissions. */
export function DiscordDialog({ settings, onClose }: { settings: DiscordSettings; onClose(): void }) {
  const t = useT();
  const info = useDiscordInfo();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guildId, setGuildId] = useState(settings.guildId);
  const [channelId, setChannelId] = useState(settings.channelId);
  const [allowed, setAllowed] = useState(settings.allowedUserIds.join(', '));
  const [mention, setMention] = useState(settings.mentionUserId);
  const set = (patch: Partial<DiscordSettings>) => void saveSettings({ discord: { ...settings, ...patch } });
  const saveIds = () =>
    set({
      guildId: guildId.trim(),
      channelId: channelId.trim(),
      allowedUserIds: parseIdList(allowed),
      mentionUserId: mention.trim(),
    });

  const status = info?.status ?? { state: 'off' as const };
  const statusText =
    status.state === 'connected'
      ? t('discord.status.connected', { bot: status.botTag })
      : status.state === 'error'
        ? t('discord.status.error', { error: status.error })
        : t(`discord.status.${status.state}`);
  const statusTone =
    status.state === 'connected' ? 'text-ok' : status.state === 'error' ? 'text-danger' : 'text-muted';
  const check = (label: string, value: boolean, onChange: (v: boolean) => void, testId?: string) => (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      {label}
    </label>
  );

  return (
    <Modal
      title={t('discord.title')}
      onClose={onClose}
      width="w-[620px]"
      testId="discord-dialog"
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <p className="leading-relaxed">{t('discord.intro')}</p>
      <div
        className={`flex items-center gap-2 rounded border border-line px-3 py-2 ${statusTone}`}
        role="status"
        data-testid="discord-status"
      >
        <span aria-hidden>{status.state === 'connected' ? '●' : status.state === 'error' ? '✕' : '○'}</span>
        <span className="min-w-0 flex-1 break-all">{statusText}</span>
        {info?.hasToken && (
          <Button onClick={() => void api.invoke('discord:reconnect')}>{t('discord.reconnect')}</Button>
        )}
      </div>

      <details open={!info?.hasToken}>
        <summary className="cursor-pointer font-semibold">{t('discord.steps')}</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
          {[1, 2, 3, 4].map((n) => (
            <li key={n}>{t(`discord.step${n}`)}</li>
          ))}
        </ol>
        <button
          className="mt-1 text-xs text-accent underline"
          onClick={() => api.send('link:open', PORTAL_URL)}
        >
          {t('discord.portal')}
        </button>
      </details>

      <Field label={t('discord.token')} hint={t('discord.tokenHint')}>
        <p className="mb-1 text-xs text-muted" data-testid="discord-token-state">
          {info?.hasToken ? t('discord.tokenSet') : t('discord.tokenNone')}
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="discord-token"
          />
          <Button
            variant="primary"
            className="shrink-0"
            disabled={!token.trim()}
            onClick={async () => {
              setError(null);
              try {
                // Enable at the same time so the first save connects.
                saveIds();
                await saveSettings({
                  discord: {
                    ...settings,
                    enabled: true,
                    guildId: guildId.trim(),
                    channelId: channelId.trim(),
                    allowedUserIds: parseIdList(allowed),
                    mentionUserId: mention.trim(),
                  },
                });
                await api.invoke('discord:setToken', token);
                setToken('');
              } catch (e) {
                setError(errorKey(e));
              }
            }}
            data-testid="discord-token-save"
          >
            {t('discord.tokenSave')}
          </Button>
        </div>
        {info?.hasToken && (
          <button
            className="mt-1 text-xs text-danger underline"
            onClick={() => void api.invoke('discord:clearToken')}
          >
            {t('discord.tokenClear')}
          </button>
        )}
        {error && (
          <p role="alert" className="mt-1 text-danger">
            {t(error)}
          </p>
        )}
      </Field>

      {check(t('discord.enabled'), settings.enabled, (v) => set({ enabled: v }), 'discord-enabled')}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('discord.guildId')}>
          <input
            className={inputCls}
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            onBlur={saveIds}
            inputMode="numeric"
            data-testid="discord-guild"
          />
        </Field>
        <Field label={t('discord.channelId')}>
          <input
            className={inputCls}
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            onBlur={saveIds}
            inputMode="numeric"
            data-testid="discord-channel"
          />
        </Field>
      </div>
      <Field label={t('discord.allowed')} hint={t('discord.allowedHint')}>
        <input
          className={inputCls}
          value={allowed}
          onChange={(e) => setAllowed(e.target.value)}
          onBlur={saveIds}
          data-testid="discord-allowed"
        />
      </Field>

      <fieldset className="space-y-1">
        <legend className="mb-1 text-muted">{t('discord.perms')}</legend>
        {(['send', 'approve', 'newSession', 'stop'] as const).map((k) =>
          check(
            t(`discord.perm.${k}`),
            settings.permissions[k],
            (v) => set({ permissions: { ...settings.permissions, [k]: v } }),
            `discord-perm-${k}`,
          ),
        )}
        <p className="text-xs text-muted">{t('discord.dangerHint')}</p>
      </fieldset>

      <Field label={t('discord.mention')}>
        <input
          className={inputCls}
          value={mention}
          onChange={(e) => setMention(e.target.value)}
          onBlur={saveIds}
          inputMode="numeric"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('discord.mentionAfter')}>
          <input
            className={inputCls}
            type="number"
            min={0}
            value={settings.mentionAfterSec}
            onChange={(e) => set({ mentionAfterSec: Number(e.target.value) })}
          />
        </Field>
        <Field label={t('discord.reminder')}>
          <input
            className={inputCls}
            type="number"
            min={1}
            value={settings.approvalReminderMin}
            onChange={(e) => set({ approvalReminderMin: Number(e.target.value) })}
          />
        </Field>
      </div>
      {check(t('discord.keepAwake'), settings.keepAwake, (v) => set({ keepAwake: v }))}
      {check(t('discord.notifyUsage'), settings.notifyUsage, (v) => set({ notifyUsage: v }))}
    </Modal>
  );
}

/** "From Discord" toasts (§6: input sent from Discord is shown in the app too). */
export function RemoteInputToasts({
  sessions,
  onSelect,
}: {
  sessions: Session[];
  onSelect(id: string): void;
}) {
  const t = useT();
  const [items, setItems] = useState<(RemoteInput & { key: number })[]>([]);
  useEffect(
    () =>
      api.on('remote:input', (r) => {
        const key = Date.now() + Math.random();
        setItems((xs) => [...xs, { ...r, key }].slice(-4));
        setTimeout(() => setItems((xs) => xs.filter((x) => x.key !== key)), 15_000);
      }),
    [],
  );
  if (!items.length) return null;
  return (
    <div
      className="pointer-events-none fixed left-1/2 top-12 z-40 flex w-[440px] max-w-[90vw] -translate-x-1/2 flex-col gap-2"
      aria-live="polite"
    >
      {items.map((r) => {
        const s = sessions.find((x) => x.id === r.sessionId);
        return (
          <button
            key={r.key}
            className="pointer-events-auto rounded-lg border border-accent bg-panel p-2 text-left shadow-xl hover:bg-panel-2"
            onClick={() => onSelect(r.sessionId)}
            data-testid="remote-toast"
          >
            <div className="text-xs font-semibold text-accent">
              {t('remote.from', { user: r.user })} · {s?.title ?? ''}
            </div>
            <div className="truncate text-xs">{t(`remote.kind.${r.kind}`, { preview: r.preview })}</div>
          </button>
        );
      })}
    </div>
  );
}
