import { useEffect, useState } from 'react';
import type { Profile } from '@shared/types';
import type { NotificationRecord } from '@shared/notify';
import {
  formatDuration,
  formatTokens,
  usageLevel,
  type Plan,
  type ProfileUsage,
  type WindowUsage,
} from '@shared/usage';
import { api } from '../api';
import { useT } from '../i18n';
import { useSettingsValue } from '../settings';
import { Button, Field, inputCls } from './Modal';

/** Re-render every `ms` so "resets in …" stays current. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const BAR = { none: 'bg-muted/50', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' };
const TEXT = { none: 'text-muted', ok: 'text-muted', warn: 'text-warn', danger: 'text-danger' };
const ICON = { none: '', ok: '', warn: '▲', danger: '●' };

/** One usage bar with percent text (never color alone) and time to reset. */
export function UsageBar({
  label,
  w,
  now,
  kind,
}: {
  label: string;
  w: WindowUsage;
  now: number;
  kind: '5h' | '7d';
}) {
  const t = useT();
  const locale = useSettingsValue()?.locale ?? 'ja';
  const level = usageLevel(w.percent);
  const pct = w.percent === null ? null : Math.round(w.percent);
  const reset =
    w.resetAt && w.resetAt > now
      ? t(kind === '5h' ? 'usage.resetIn' : 'usage.freesIn', {
          time: formatDuration(w.resetAt - now, locale),
        })
      : '';
  const detail = w.limit
    ? t('usage.tokens', { used: formatTokens(w.used), limit: formatTokens(w.limit) })
    : t('usage.tokensNoLimit', { used: formatTokens(w.used) });
  return (
    <div
      className="text-[11px]"
      title={`${label}: ${detail}${reset ? ` · ${reset}` : ''}`}
      data-testid={`usage-${kind}`}
    >
      <div className="flex items-center gap-1">
        <span className="w-8 shrink-0 text-muted">{label}</span>
        <div
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-panel-2"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={pct === null ? detail : `${pct}% · ${detail}`}
        >
          <div className={`h-full ${BAR[level]}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <span className={`w-11 shrink-0 text-right tabular-nums ${TEXT[level]}`} data-testid="usage-percent">
          {ICON[level] && <span aria-hidden>{ICON[level]} </span>}
          {pct === null ? '—' : `${pct}%`}
        </span>
      </div>
      {reset && <div className="pl-9 text-muted">{reset}</div>}
    </div>
  );
}

/** Compact 5h / 7d bars for the sidebar's profile rows. */
export function ProfileUsageBars({ usage }: { usage: ProfileUsage | undefined }) {
  const t = useT();
  const now = useNow();
  if (!usage) return null;
  return (
    <div className="space-y-0.5" data-testid="profile-usage">
      {usage.limitHit && (
        <div className="text-[11px] font-semibold text-danger" role="status">
          ⏸{' '}
          {t('usage.limitHit', {
            window: t(`usage.window.${usage.limitHit.window}`),
            reset: usage.limitHit.resetText ?? '-',
          })}
        </div>
      )}
      <UsageBar label={t('usage.window.5h')} w={usage.fiveHour} now={now} kind="5h" />
      <UsageBar label={t('usage.window.7d')} w={usage.sevenDay} now={now} kind="7d" />
    </div>
  );
}

const PLANS: Plan[] = ['auto', 'pro', 'max5', 'max20', 'team', 'enterprise', 'custom'];

/** Right panel "Usage" tab: details, limits and thresholds per profile, and the alert history. */
export function UsagePanel({ profiles, usage }: { profiles: Profile[]; usage: ProfileUsage[] }) {
  const t = useT();
  const [history, setHistory] = useState<NotificationRecord[]>([]);
  useEffect(() => {
    const load = () => void api.invoke('notify:history').then(setHistory);
    load();
    return api.on('usage:changed', load);
  }, []);

  return (
    <div className="space-y-4" data-testid="usage-panel">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-semibold">{t('usage.title')}</h3>
        <Button onClick={() => void api.invoke('usage:refresh')}>{t('usage.refresh')}</Button>
      </div>
      {profiles.length === 0 && <p className="text-muted">{t('usage.none')}</p>}
      {profiles.map((p) => {
        const u = usage.find((x) => x.profileId === p.id);
        return (
          <section
            key={p.id}
            className="space-y-2 rounded border border-line p-2"
            style={{ borderLeft: `3px solid ${p.color}` }}
          >
            <div className="font-medium">{p.name}</div>
            {u ? (
              <>
                <ProfileUsageBars usage={u} />
                <p className="text-[11px] text-muted">{t(`usage.source.${u.config.limitSource}`)}</p>
                <UsageConfigForm profile={p} usage={u} />
              </>
            ) : (
              <p className="text-muted">…</p>
            )}
          </section>
        );
      })}
      <p className="text-[11px] leading-relaxed text-muted">{t('usage.estimateNote')}</p>
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
          {t('usage.history')}
        </h4>
        {history.length === 0 && <p className="text-xs text-muted">{t('usage.historyEmpty')}</p>}
        <ul className="space-y-1" data-testid="notify-history">
          {history.slice(0, 30).map((h) => (
            <li key={h.id} className="rounded bg-panel-2 px-2 py-1 text-xs">
              <div className="font-medium">{h.title}</div>
              <div className="text-muted">
                {new Date(h.at).toLocaleString()} · {h.body}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function UsageConfigForm({ profile, usage }: { profile: Profile; usage: ProfileUsage }) {
  const t = useT();
  const cfg = usage.config;
  const manual = cfg.limitSource === 'manual';
  const [plan, setPlan] = useState<Plan>(cfg.plan);
  const [l5, setL5] = useState(manual && cfg.limit5h ? String(cfg.limit5h) : '');
  const [l7, setL7] = useState(manual && cfg.limit7d ? String(cfg.limit7d) : '');
  const [th, setTh] = useState(cfg.thresholds.join(', '));
  const num = (s: string) => {
    const n = Number(s.replace(/[,_\s]/g, ''));
    return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };
  const save = () => {
    const limits = l5.trim() || l7.trim() ? { limit5h: num(l5), limit7d: num(l7) } : {};
    void api.invoke('usage:setConfig', profile.id, {
      plan,
      ...limits,
      thresholds: th
        .split(/[,、\s]+/)
        .filter(Boolean)
        .map(Number),
    });
  };
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        {t('usage.settingsFor', { name: profile.name })}
      </summary>
      <div className="mt-2 space-y-2">
        <Field label={t('usage.plan')}>
          <select
            className={inputCls}
            value={plan}
            onChange={(e) => setPlan(e.target.value as Plan)}
            data-testid="usage-plan"
          >
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {p === 'auto'
                  ? t('usage.plan.auto', { detected: usage.detectedPlan ?? t('usage.plan.unknown') })
                  : t(`usage.plan.${p}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('usage.limit5h')}>
          <input
            className={inputCls}
            inputMode="numeric"
            value={l5}
            placeholder={t('usage.limitPlaceholder')}
            onChange={(e) => setL5(e.target.value)}
            data-testid="usage-limit5h"
          />
        </Field>
        <Field label={t('usage.limit7d')}>
          <input
            className={inputCls}
            inputMode="numeric"
            value={l7}
            placeholder={t('usage.limitPlaceholder')}
            onChange={(e) => setL7(e.target.value)}
            data-testid="usage-limit7d"
          />
        </Field>
        <Field label={t('usage.thresholds')}>
          <input
            className={inputCls}
            value={th}
            onChange={(e) => setTh(e.target.value)}
            data-testid="usage-thresholds"
          />
        </Field>
        <Button variant="primary" onClick={save} data-testid="usage-save">
          {t('common.save')}
        </Button>
      </div>
    </details>
  );
}

const BANNER: Partial<Record<NotificationRecord['kind'], { icon: string; border: string }>> = {
  usageThreshold: { icon: '▲', border: 'border-warn' },
  limitReached: { icon: '⏸', border: 'border-danger' },
  usageReset: { icon: '✓', border: 'border-ok' },
  scheduleRan: { icon: '⏰', border: 'border-accent' },
  scheduleMissed: { icon: '⏰', border: 'border-warn' },
  scheduleFailed: { icon: '✕', border: 'border-danger' },
  updateReady: { icon: '⬆', border: 'border-accent' },
};

/** In-app banners for usage alerts (§7 アプリ内バナー) and schedules. */
export function NotificationBanners() {
  const t = useT();
  const [items, setItems] = useState<NotificationRecord[]>([]);
  useEffect(
    () => api.on('notify:show', (r) => setItems((xs) => [...xs.filter((x) => x.id !== r.id), r].slice(-4))),
    [],
  );
  if (items.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-40 flex w-[360px] max-w-[90vw] flex-col gap-2"
      aria-live="polite"
    >
      {items.map((n) => (
        <div
          key={n.id}
          role="status"
          className={`pointer-events-auto rounded-lg border bg-panel p-3 shadow-xl ${BANNER[n.kind]?.border ?? 'border-line'}`}
          data-testid="notify-banner"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden>{BANNER[n.kind]?.icon ?? '•'}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{n.title}</div>
              <div className="text-xs text-muted">{n.body}</div>
            </div>
            <button
              className="text-muted hover:text-fg"
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== n.id))}
              aria-label={t('common.close')}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
