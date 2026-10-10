import { useEffect, useState } from 'react';
import type { Schedule, ScheduleInput, ScheduleRule } from '@shared/schedule';
import type { SshHost, SshHostInput } from '@shared/ssh';
import type { UpdateState } from '@shared/ipc';
import type { Profile, Project } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { saveSettings, useSettingsValue } from '../settings';
import { Button, Field, Modal, inputCls } from './Modal';
import { ProfileSelect } from './dialogs';

function useList<T>(channel: 'schedules:list' | 'ssh:list', kind: 'schedules' | 'sshHosts'): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const load = () => void (api.invoke(channel) as Promise<T[]>).then(setItems);
    load();
    return api.on('state:changed', (what) => what === kind && load());
  }, [channel, kind]);
  return items;
}

export const useSshHosts = () => useList<SshHost>('ssh:list', 'sshHosts');

// ---------- schedules ----------

const DAYS = [0, 1, 2, 3, 4, 5, 6];

function ruleText(rule: ScheduleRule, t: (k: string, v?: Record<string, string | number>) => string): string {
  switch (rule.kind) {
    case 'daily':
      return t('schedule.rule.dailyAt', { time: rule.time });
    case 'weekdays':
      return t('schedule.rule.weekdaysAt', { time: rule.time });
    case 'weekly':
      return t('schedule.rule.weeklyAt', { day: t(`schedule.day.${rule.day}`), time: rule.time });
    case 'once':
      return t('schedule.rule.onceAt', { at: new Date(rule.at).toLocaleString() });
  }
}

/** Scheduled prompts (§5). States plainly that CodeDeck must be running. */
export function SchedulesDialog(props: { profiles: Profile[]; projects: Project[]; onClose(): void }) {
  const t = useT();
  const settings = useSettingsValue();
  const schedules = useList<Schedule>('schedules:list', 'schedules');
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anyEnabled = schedules.some((s) => s.enabled && s.nextRunAt);

  return (
    <Modal
      title={t('schedule.title')}
      onClose={props.onClose}
      width="w-[640px]"
      testId="schedules"
      footer={<Button onClick={props.onClose}>{t('common.close')}</Button>}
    >
      <p className="rounded border border-warn/60 bg-warn/10 p-2 text-xs leading-relaxed" role="note">
        ⏰ {t('schedule.residentNote')}
      </p>
      {anyEnabled && settings && !settings.stayInTray && (
        <div className="flex items-center gap-2 text-xs" data-testid="schedule-tray-hint">
          <span className="flex-1 text-warn">{t('schedule.trayHint')}</span>
          <Button onClick={() => void saveSettings({ stayInTray: true })}>{t('schedule.enableTray')}</Button>
        </div>
      )}
      {error && <p className="text-danger">{t(error)}</p>}
      {editing ? (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          profiles={props.profiles}
          projects={props.projects}
          onDone={() => setEditing(null)}
        />
      ) : (
        <>
          <Button
            variant="primary"
            onClick={() => setEditing('new')}
            disabled={!props.profiles.length}
            data-testid="schedule-new"
          >
            ＋ {t('schedule.new')}
          </Button>
          {schedules.length === 0 && <p className="text-muted">{t('schedule.empty')}</p>}
          <ul className="space-y-1.5" data-testid="schedule-list">
            {schedules.map((s) => (
              <li key={s.id} className="rounded border border-line p-2 text-xs">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    aria-label={`${t('schedule.enabled')}: ${s.name}`}
                    onChange={(e) =>
                      void api
                        .invoke('schedules:update', s.id, { ...toInput(s), enabled: e.target.checked })
                        .catch((err) => setError(errorKey(err)))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
                  <button
                    className="text-accent hover:underline"
                    onClick={() =>
                      void api.invoke('schedules:runNow', s.id).catch((err) => setError(errorKey(err)))
                    }
                    data-testid="schedule-run-now"
                  >
                    {t('schedule.runNow')}
                  </button>
                  <button className="text-muted hover:text-fg" onClick={() => setEditing(s)}>
                    {t('common.edit')}
                  </button>
                  <button
                    className="text-muted hover:text-danger"
                    onClick={() => void api.invoke('schedules:remove', s.id)}
                  >
                    {t('common.remove')}
                  </button>
                </div>
                <div className="text-muted">
                  {ruleText(s.rule, t)} · {props.profiles.find((p) => p.id === s.profileId)?.name ?? '?'}
                  {s.projectId && ` · ${props.projects.find((p) => p.id === s.projectId)?.name ?? ''}`}
                </div>
                <div className="text-muted">
                  {s.nextRunAt
                    ? t('schedule.next', { at: new Date(s.nextRunAt).toLocaleString() })
                    : t('schedule.noNext')}
                  {s.lastRunAt && ` · ${t('schedule.last', { at: new Date(s.lastRunAt).toLocaleString() })}`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

const toInput = (s: Schedule): ScheduleInput => ({
  name: s.name,
  rule: s.rule,
  profileId: s.profileId,
  projectId: s.projectId,
  prompt: s.prompt,
  enabled: s.enabled,
});

function localInput(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function ScheduleEditor(props: {
  schedule: Schedule | null;
  profiles: Profile[];
  projects: Project[];
  onDone(): void;
}) {
  const t = useT();
  const s = props.schedule;
  const [name, setName] = useState(s?.name ?? '');
  const [kind, setKind] = useState<ScheduleRule['kind']>(s?.rule.kind ?? 'daily');
  const [time, setTime] = useState(s && s.rule.kind !== 'once' ? s.rule.time : '09:00');
  const [day, setDay] = useState(s?.rule.kind === 'weekly' ? s.rule.day : 1);
  const [at, setAt] = useState(localInput(s?.rule.kind === 'once' ? s.rule.at : Date.now() + 3_600_000));
  const [projectId, setProjectId] = useState(s?.projectId ?? '');
  const [profileId, setProfileId] = useState(s?.profileId ?? props.profiles[0]?.id ?? '');
  const [prompt, setPrompt] = useState(s?.prompt ?? '');
  const [error, setError] = useState<string | null>(null);

  const rule = (): ScheduleRule =>
    kind === 'once'
      ? { kind, at: new Date(at).getTime() }
      : kind === 'weekly'
        ? { kind, day, time }
        : { kind, time };
  const save = async () => {
    const input: ScheduleInput = {
      name,
      rule: rule(),
      profileId,
      projectId: projectId || null,
      prompt,
      enabled: s?.enabled ?? true,
    };
    try {
      if (s) await api.invoke('schedules:update', s.id, input);
      else await api.invoke('schedules:create', input);
      props.onDone();
    } catch (e) {
      setError(errorKey(e));
    }
  };

  return (
    <div className="space-y-3 rounded border border-line p-3" data-testid="schedule-editor">
      <Field label={t('schedule.name')}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="schedule-name"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Field label={t('schedule.when')}>
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as ScheduleRule['kind'])}
            data-testid="schedule-kind"
          >
            {(['daily', 'weekdays', 'weekly', 'once'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`schedule.rule.${k}`)}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'weekly' && (
          <Field label={t('schedule.dayLabel')}>
            <select className={inputCls} value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {t(`schedule.day.${d}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind === 'once' ? (
          <Field label={t('schedule.at')}>
            <input
              type="datetime-local"
              className={inputCls}
              value={at}
              onChange={(e) => setAt(e.target.value)}
              data-testid="schedule-at"
            />
          </Field>
        ) : (
          <Field label={t('schedule.time')}>
            <input
              type="time"
              className={inputCls}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              data-testid="schedule-time"
            />
          </Field>
        )}
      </div>
      <Field label={t('session.profile')}>
        <ProfileSelect profiles={props.profiles} value={profileId} onChange={setProfileId} />
      </Field>
      <Field label={t('session.project')}>
        <select
          className={inputCls}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          data-testid="schedule-project"
        >
          <option value="">{t('schedule.noProject')}</option>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('schedule.prompt')}>
        <textarea
          className={`${inputCls} min-h-20 resize-y`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          data-testid="schedule-prompt"
        />
      </Field>
      {error && <p className="text-danger">{t(error)}</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={save}
          disabled={!name.trim() || !prompt.trim() || !profileId}
          data-testid="schedule-save"
        >
          {t('common.save')}
        </Button>
        <Button onClick={props.onDone}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// ---------- SSH hosts ----------

/** Remote machines for SSH sessions (§5). Only connection settings are stored. */
export function SshHostsDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const hosts = useSshHosts();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<SshHost | 'new' | null>(null);
  useEffect(() => {
    void api.invoke('ssh:available').then(setAvailable);
  }, []);
  return (
    <Modal
      title={t('ssh.title')}
      onClose={onClose}
      width="w-[600px]"
      testId="ssh-hosts"
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <p className="text-xs leading-relaxed text-muted">{t('ssh.intro')}</p>
      {available === false && <p className="text-xs text-danger">{t('ssh.error.noClient')}</p>}
      {editing ? (
        <SshHostEditor host={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <>
          <Button variant="primary" onClick={() => setEditing('new')} data-testid="ssh-new">
            ＋ {t('ssh.new')}
          </Button>
          {hosts.length === 0 && <p className="text-muted">{t('ssh.empty')}</p>}
          <ul className="space-y-1.5" data-testid="ssh-list">
            {hosts.map((h) => (
              <li key={h.id} className="flex items-center gap-2 rounded border border-line p-2 text-xs">
                <span className="font-medium">{h.name}</span>
                <code className="min-w-0 flex-1 truncate text-muted">
                  {h.destination}
                  {h.port ? `:${h.port}` : ''} {h.remoteDir && `· ${h.remoteDir}`}
                </code>
                <button className="text-muted hover:text-fg" onClick={() => setEditing(h)}>
                  {t('common.edit')}
                </button>
                <button
                  className="text-muted hover:text-danger"
                  onClick={() => void api.invoke('ssh:remove', h.id)}
                >
                  {t('common.remove')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

function SshHostEditor({ host, onDone }: { host: SshHost | null; onDone(): void }) {
  const t = useT();
  const [v, setV] = useState<SshHostInput>({
    name: host?.name ?? '',
    destination: host?.destination ?? '',
    port: host?.port ?? null,
    identityFile: host?.identityFile ?? '',
    remoteDir: host?.remoteDir ?? '',
    remoteConfigDir: host?.remoteConfigDir ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SshHostInput>) => setV((x) => ({ ...x, ...patch }));
  const save = async () => {
    try {
      if (host) await api.invoke('ssh:update', host.id, v);
      else await api.invoke('ssh:create', v);
      onDone();
    } catch (e) {
      setError(errorKey(e));
    }
  };
  return (
    <div className="space-y-3 rounded border border-line p-3" data-testid="ssh-editor">
      <Field label={t('ssh.name')}>
        <input
          className={inputCls}
          value={v.name}
          onChange={(e) => set({ name: e.target.value })}
          data-testid="ssh-name"
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Field label={t('ssh.destination')} hint={t('ssh.destinationHint')}>
            <input
              className={inputCls}
              value={v.destination}
              placeholder="user@example.com"
              onChange={(e) => set({ destination: e.target.value })}
              data-testid="ssh-destination"
            />
          </Field>
        </div>
        <Field label={t('ssh.port')}>
          <input
            className={inputCls}
            inputMode="numeric"
            value={v.port ?? ''}
            placeholder="22"
            onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
      </div>
      <Field label={t('ssh.identity')} hint={t('ssh.identityHint')}>
        <input
          className={inputCls}
          value={v.identityFile}
          placeholder="~/.ssh/id_ed25519"
          onChange={(e) => set({ identityFile: e.target.value })}
        />
      </Field>
      <Field label={t('ssh.remoteDir')}>
        <input
          className={inputCls}
          value={v.remoteDir}
          placeholder="~/work/app"
          onChange={(e) => set({ remoteDir: e.target.value })}
          data-testid="ssh-remote-dir"
        />
      </Field>
      <Field label={t('ssh.remoteConfigDir')} hint={t('ssh.remoteConfigDirHint')}>
        <input
          className={inputCls}
          value={v.remoteConfigDir}
          placeholder="~/.codedeck/profiles/team"
          onChange={(e) => set({ remoteConfigDir: e.target.value })}
        />
      </Field>
      {error && <p className="text-danger">{t(error)}</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={save}
          disabled={!v.name.trim() || !v.destination.trim()}
          data-testid="ssh-save"
        >
          {t('common.save')}
        </Button>
        <Button onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

// ---------- updates ----------

export function useUpdateState(): UpdateState | null {
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    void api.invoke('update:state').then(setS);
    return api.on('update:state', setS);
  }, []);
  return s;
}

/** "An update is ready: restart to install" (never installs on its own). */
export function UpdateBanner() {
  const t = useT();
  const s = useUpdateState();
  const [hidden, setHidden] = useState(false);
  if (!s || s.state !== 'downloaded' || hidden) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-line bg-accent/15 px-4 py-2"
      data-testid="update-banner"
    >
      <span className="flex-1">{t('update.ready', { version: s.version })}</span>
      <Button variant="primary" onClick={() => void api.invoke('update:install')}>
        {t('update.restart')}
      </Button>
      <button
        className="text-muted hover:text-fg"
        onClick={() => setHidden(true)}
        aria-label={t('common.close')}
      >
        ✕
      </button>
    </div>
  );
}

/** Settings section: residency, login launch, updates, version. */
export function AppSection() {
  const t = useT();
  const settings = useSettingsValue();
  const update = useUpdateState();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void api.invoke('app:version').then(setVersion);
  }, []);
  if (!settings) return null;
  const check = (key: 'stayInTray' | 'launchAtLogin' | 'autoUpdate', testId: string) => (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={settings[key]}
        onChange={(e) => void saveSettings({ [key]: e.target.checked })}
        data-testid={testId}
      />
      <span>
        {t(`settings.${key}`)}
        <span className="block text-xs text-muted">{t(`settings.${key}Hint`)}</span>
      </span>
    </label>
  );
  const updateText = !update
    ? ''
    : update.state === 'disabled'
      ? t(`update.disabled.${update.reason}`)
      : update.state === 'available' || update.state === 'downloaded'
        ? t(`update.${update.state}`, { version: update.version })
        : update.state === 'error'
          ? t('update.error', { error: t(update.error) })
          : t(`update.${update.state}`);
  return (
    <div className="space-y-2" data-testid="app-settings">
      {check('stayInTray', 'stay-in-tray')}
      {check('launchAtLogin', 'launch-at-login')}
      {check('autoUpdate', 'auto-update')}
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>
          CodeDeck {version} · {updateText}
        </span>
        <Button
          className="!px-2 !py-0.5 text-xs"
          disabled={update?.state === 'disabled' || update?.state === 'checking'}
          onClick={() => void api.invoke('update:check')}
        >
          {t('update.check')}
        </Button>
      </div>
    </div>
  );
}
