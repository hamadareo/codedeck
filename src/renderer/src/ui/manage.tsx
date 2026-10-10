import { useEffect, useMemo, useState } from 'react';
import { commandSlug, expandPrompt, promptVariables } from '@shared/prompts';
import { formatTokens, formatDuration } from '@shared/usage';
import type { ExtensionsInfo, Profile, Prompt, Session, Stats } from '@shared/types';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { useSettingsValue } from '../settings';
import { Button, Field, Modal, inputCls } from './Modal';
import { ProfileSelect } from './dialogs';

export function usePrompts(): Prompt[] {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(() => {
    const load = () => void api.invoke('prompts:list').then(setPrompts);
    load();
    return api.on('state:changed', (what) => what === 'prompts' && load());
  }, []);
  return prompts;
}

// ---------- prompt library ----------

/** Prompt library (§5): save, edit, Claude Code command, export / import. */
export function PromptLibraryDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const prompts = usePrompts();
  const [editing, setEditing] = useState<Prompt | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Modal
      title={t('prompts.title')}
      onClose={onClose}
      width="w-[640px]"
      testId="prompt-library"
      footer={
        <>
          <Button
            onClick={async () => {
              const n = await api.invoke('prompts:import').catch((e) => {
                setNotice(t(errorKey(e)));
                return null;
              });
              if (n !== null) setNotice(t('prompts.imported', { n }));
            }}
          >
            {t('prompts.import')}
          </Button>
          <Button
            onClick={async () => {
              const f = await api.invoke('prompts:export');
              if (f) setNotice(t('prompts.exported', { file: f }));
            }}
            disabled={prompts.length === 0}
          >
            {t('prompts.export')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      <p className="text-xs leading-relaxed text-muted">{t('prompts.intro')}</p>
      {notice && (
        <p role="status" className="break-all text-xs text-accent">
          {notice}
        </p>
      )}
      {editing ? (
        <PromptEditor prompt={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <>
          <Button variant="primary" onClick={() => setEditing('new')} data-testid="prompt-new">
            ＋ {t('prompts.new')}
          </Button>
          {prompts.length === 0 && <p className="text-muted">{t('prompts.empty')}</p>}
          <ul className="space-y-1.5" data-testid="prompt-list">
            {prompts.map((p) => (
              <li key={p.id} className="rounded border border-line p-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  {p.asCommand && (
                    <code className="rounded bg-panel-2 px-1 text-[11px]" title={t('prompts.asCommandOn')}>
                      /{commandSlug(p.name, p.id)}
                    </code>
                  )}
                  <button className="text-xs text-muted hover:text-fg" onClick={() => setEditing(p)}>
                    {t('common.edit')}
                  </button>
                  <button
                    className="text-xs text-muted hover:text-danger"
                    onClick={() => void api.invoke('prompts:remove', p.id)}
                  >
                    {t('common.remove')}
                  </button>
                </div>
                <div className="line-clamp-2 whitespace-pre-wrap text-xs text-muted">{p.body}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

function PromptEditor({ prompt, onDone }: { prompt: Prompt | null; onDone(): void }) {
  const t = useT();
  const [name, setName] = useState(prompt?.name ?? '');
  const [body, setBody] = useState(prompt?.body ?? '');
  const [asCommand, setAsCommand] = useState(prompt?.asCommand ?? false);
  const [error, setError] = useState<string | null>(null);
  const vars = promptVariables(body);
  const save = async () => {
    try {
      if (prompt) await api.invoke('prompts:update', prompt.id, { name, body, asCommand });
      else await api.invoke('prompts:create', { name, body, asCommand });
      onDone();
    } catch (e) {
      setError(errorKey(e));
    }
  };
  return (
    <div className="space-y-3 rounded border border-line p-3" data-testid="prompt-editor">
      <Field label={t('prompts.name')}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="prompt-name"
        />
      </Field>
      <Field label={t('prompts.body')} hint={t('prompts.bodyHint')}>
        <textarea
          className={`${inputCls} min-h-32 resize-y font-mono text-xs`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          data-testid="prompt-body"
        />
      </Field>
      {vars.length > 0 && (
        <p className="text-xs text-muted">
          {t('prompts.vars')}: {vars.map((v) => (v.default ? `${v.name} (${v.default})` : v.name)).join(', ')}
        </p>
      )}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={asCommand}
          onChange={(e) => setAsCommand(e.target.checked)}
          data-testid="prompt-as-command"
        />
        <span>
          {t('prompts.asCommand', { slug: commandSlug(name || 'prompt', prompt?.id ?? 'new00000') })}
          <span className="block text-muted">{t('prompts.asCommandHint')}</span>
        </span>
      </label>
      {error && <p className="text-danger">{t(error)}</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={save}
          disabled={!name.trim() || !body.trim()}
          data-testid="prompt-save"
        >
          {t('common.save')}
        </Button>
        <Button onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

/** Fill a prompt's variables, then paste it into the session (nothing is sent). */
export function PromptInsertDialog(props: {
  prompt: Prompt;
  context: { project: string; cwd: string; branch: string; profile: string };
  canPaste: boolean;
  onPaste(text: string): void;
  onClose(): void;
}) {
  const t = useT();
  const vars = useMemo(() => promptVariables(props.prompt.body), [props.prompt.body]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v.name, v.default])),
  );
  const text = expandPrompt(props.prompt.body, { ...props.context, ...values });
  const paste = () => {
    props.onPaste(text);
    props.onClose();
  };
  return (
    <Modal
      title={t('prompts.insertTitle', { name: props.prompt.name })}
      onClose={props.onClose}
      width="w-[560px]"
      testId="prompt-insert"
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={paste} disabled={!props.canPaste} data-testid="prompt-paste">
            {t('prompts.paste')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.canPaste) paste();
        }}
      >
        {vars.map((v) => (
          <Field key={v.name} label={v.name}>
            <input
              className={inputCls}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
              data-testid={`prompt-var-${v.name}`}
            />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
      <Field label={t('settings.preview')}>
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 text-xs"
          data-testid="prompt-preview"
        >
          {text}
        </pre>
      </Field>
      {!props.canPaste && <p className="text-xs text-warn">{t('prompts.noSession')}</p>}
    </Modal>
  );
}

// ---------- skills / MCP ----------

/** Skills / MCP per profile (§5). MCP changes go through Claude Code's own /mcp screen. */
export function ExtensionsDialog(props: {
  profiles: Profile[];
  initialProfileId: string | null;
  projectDir: string | null;
  sessions: Session[];
  onOpenMcp(profileId: string): void;
  onClose(): void;
}) {
  const t = useT();
  const [profileId, setProfileId] = useState(props.initialProfileId ?? props.profiles[0]?.id ?? '');
  const [info, setInfo] = useState<ExtensionsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (clear = true) => {
    if (!profileId) return;
    if (clear) setInfo(null);
    try {
      setInfo(await api.invoke('extensions:list', profileId, props.projectDir));
      setError(null);
    } catch (e) {
      setError(errorKey(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);
  const MCP_ICON = { connected: '●', failed: '✕', 'needs-auth': '⚠', unknown: '○' } as const;
  const MCP_TONE = {
    connected: 'text-ok',
    failed: 'text-danger',
    'needs-auth': 'text-warn',
    unknown: 'text-muted',
  } as const;

  return (
    <Modal
      title={t('ext.title')}
      onClose={props.onClose}
      width="w-[620px]"
      testId="extensions"
      footer={<Button onClick={props.onClose}>{t('common.close')}</Button>}
    >
      <Field label={t('session.profile')}>
        <ProfileSelect profiles={props.profiles} value={profileId} onChange={setProfileId} />
      </Field>
      {error && <p className="text-danger">{t(error)}</p>}
      <section className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-semibold">{t('ext.mcp')}</h3>
          <Button
            onClick={() => props.onOpenMcp(profileId)}
            title={t('ext.openMcpHint')}
            data-testid="open-mcp"
          >
            {t('ext.openMcp')}
          </Button>
        </div>
        {!info ? (
          <p className="text-xs text-muted">{t('ext.loading')}</p>
        ) : info.mcpError ? (
          <p className="text-xs text-danger">{t('ext.mcpError', { msg: t(info.mcpError) })}</p>
        ) : info.mcp.length === 0 ? (
          <p className="text-xs text-muted">{t('ext.noMcp')}</p>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="mcp-list">
            {info.mcp.map((m) => (
              <li key={m.name} className="flex items-center gap-2 rounded border border-line px-2 py-1">
                <span className={MCP_TONE[m.status]} aria-hidden>
                  {MCP_ICON[m.status]}
                </span>
                <span className="font-medium">{m.name}</span>
                <span className="font-path min-w-0 flex-1 truncate text-muted" title={m.target}>
                  {m.target}
                </span>
                <span className={MCP_TONE[m.status]}>{t(`ext.mcpStatus.${m.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted">{t('ext.openMcpHint')}</p>
      </section>
      <section className="space-y-1">
        <h3 className="font-semibold">{t('ext.skills')}</h3>
        {info && info.skills.length === 0 && <p className="text-xs text-muted">{t('ext.noSkills')}</p>}
        <ul className="space-y-1 text-xs" data-testid="skill-list">
          {info?.skills.map((s) => (
            <li
              key={`${s.scope}:${s.name}`}
              className="flex items-start gap-2 rounded border border-line px-2 py-1"
            >
              <label className="flex min-w-0 flex-1 items-start gap-2">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={s.scope !== 'profile'}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    // Show the new state at once; the reload below confirms (or reverts) it.
                    setInfo(
                      (cur) =>
                        cur && {
                          ...cur,
                          skills: cur.skills.map((x) =>
                            x.scope === s.scope && x.name === s.name ? { ...x, enabled } : x,
                          ),
                        },
                    );
                    try {
                      await api.invoke('skills:setEnabled', profileId, s.name, enabled);
                    } catch (err) {
                      setError(errorKey(err));
                    }
                    void load(false);
                  }}
                  aria-label={s.name}
                />
                <span className="min-w-0">
                  <span className="font-medium">{s.name}</span>
                  <span className="ml-1 text-muted">({t(`ext.scope.${s.scope}`)})</span>
                  {s.description && <span className="block text-muted">{s.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted">{t('ext.skillsHint')}</p>
      </section>
    </Modal>
  );
}

// ---------- statistics ----------

/** Statistics (§5): tokens, sessions, work time per project and profile; tokens per day. */
export function StatsDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const locale = useSettingsValue()?.locale ?? 'ja';
  const [days, setDays] = useState<7 | 30>(7);
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    void api.invoke('stats:get', days).then(setStats);
  }, [days]);
  const maxDaily = Math.max(1, ...(stats?.daily.map((d) => d.tokens) ?? [1]));

  const table = (title: string, rows: Stats['byProject'], testId: string) => {
    const max = Math.max(1, ...rows.map((r) => r.tokens));
    return (
      <section className="space-y-1">
        <h3 className="font-semibold">{title}</h3>
        {rows.length === 0 ? (
          <p className="text-xs text-muted">{t('stats.empty')}</p>
        ) : (
          <table className="w-full text-xs" data-testid={testId}>
            <thead className="text-muted">
              <tr>
                <th className="py-0.5 text-left font-normal">{t('stats.name')}</th>
                <th className="w-2/5 py-0.5 text-left font-normal">{t('stats.tokens')}</th>
                <th className="py-0.5 text-right font-normal">{t('stats.sessions')}</th>
                <th className="py-0.5 text-right font-normal">{t('stats.work')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line/60">
                  <td className="max-w-40 truncate py-1 pr-2">{r.label}</td>
                  <td className="py-1">
                    <div className="flex items-center gap-1">
                      <div
                        className="h-2 rounded bg-accent"
                        style={{ width: `${(r.tokens / max) * 100}%`, minWidth: r.tokens ? 2 : 0 }}
                      />
                      <span className="tabular-nums text-muted">{formatTokens(r.tokens)}</span>
                    </div>
                  </td>
                  <td className="py-1 text-right tabular-nums">{r.sessions}</td>
                  <td className="py-1 text-right tabular-nums">{formatDuration(r.workMs, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  };

  return (
    <Modal
      title={t('stats.title')}
      onClose={onClose}
      width="w-[680px]"
      testId="stats"
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex gap-2" role="radiogroup" aria-label={t('stats.range')}>
        {([7, 30] as const).map((d) => (
          <button
            key={d}
            role="radio"
            aria-checked={days === d}
            className={`rounded border px-3 py-1 ${days === d ? 'border-accent bg-panel-2' : 'border-line'}`}
            onClick={() => setDays(d)}
          >
            {t('stats.days', { n: d })}
          </button>
        ))}
      </div>
      {!stats ? (
        <p className="text-muted">…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center" data-testid="stats-totals">
            {[
              [t('stats.tokens'), formatTokens(stats.totalTokens)],
              [t('stats.sessions'), String(stats.totalSessions)],
              [t('stats.work'), formatDuration(stats.totalWorkMs, locale)],
            ].map(([k, v]) => (
              <div key={k} className="rounded border border-line p-2">
                <div className="text-lg font-semibold tabular-nums">{v}</div>
                <div className="text-xs text-muted">{k}</div>
              </div>
            ))}
          </div>
          <section>
            <h3 className="mb-1 font-semibold">{t('stats.daily')}</h3>
            <div className="flex h-24 items-end gap-0.5" role="img" aria-label={t('stats.daily')}>
              {stats.daily.map((d) => (
                <div
                  key={d.date}
                  className="flex-1 rounded-t bg-accent/80"
                  style={{ height: `${(d.tokens / maxDaily) * 100}%`, minHeight: d.tokens ? 2 : 0 }}
                  title={`${d.date}: ${formatTokens(d.tokens)}`}
                />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted">
              <span>{stats.daily[0]?.date}</span>
              <span>{stats.daily.at(-1)?.date}</span>
            </div>
          </section>
          {table(t('stats.byProject'), stats.byProject, 'stats-projects')}
          {table(t('stats.byProfile'), stats.byProfile, 'stats-profiles')}
          <p className="text-[11px] text-muted">{t('stats.note')}</p>
        </>
      )}
    </Modal>
  );
}
