import { useCallback, useEffect, useMemo, useState } from 'react';
import { appActionFor, modLabel, platformOf, type AppAction } from '@shared/keymap';
import type { Profile, Project } from '@shared/types';
import { api, errorKey } from './api';
import { LocaleContext, useT } from './i18n';
import { useAppData } from './useAppData';
import { disposeTerminal, setAppActionHandler, setPlatform } from './terminal/registry';
import { TerminalView } from './terminal/TerminalView';
import { Sidebar } from './ui/Sidebar';
import { TabBar } from './ui/TabBar';
import { AddProfileDialog, AddProjectDialog, NewSessionDialog } from './ui/dialogs';
import { Button, ConfirmDialog } from './ui/Modal';
import { ProfileBadge } from './ui/badges';

type Dialog =
  | { kind: 'addProfile' }
  | { kind: 'addProject' }
  | { kind: 'newSession'; projectId: string | null }
  | { kind: 'removeProfile'; profile: Profile }
  | { kind: 'removeProject'; project: Project }
  | { kind: 'openExternal'; sessionId: string }
  | null;

const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win';

export function App() {
  return (
    <LocaleContext.Provider value="ja">
      <Shell />
    </LocaleContext.Provider>
  );
}

function Shell() {
  const t = useT();
  const data = useAppData();
  const { env, profiles, projects, sessions, ptyStates, exitCodes } = data;
  const platform = platformOf(env?.platform ?? '');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tabs = useMemo(() => sessions.filter((s) => s.open), [sessions]);
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const active = tabs.find((s) => s.id === activeId) ?? null;

  useEffect(() => setPlatform(platform), [platform]);

  // Keep a valid active tab (restored sessions included).
  useEffect(() => {
    if (!active && tabs.length > 0) setActiveId(tabs[tabs.length - 1]!.id);
  }, [active, tabs]);

  const closeTab = useCallback(async (id: string) => {
    await api.invoke('sessions:close', id);
    disposeTerminal(id);
  }, []);

  const runAction = useCallback(
    (action: AppAction) => {
      const idx = tabs.findIndex((s) => s.id === activeId);
      if (action === 'newSession')
        return setDialog({ kind: 'newSession', projectId: active?.projectId ?? null });
      if (action === 'closeTab') return activeId && void closeTab(activeId);
      if (tabs.length === 0) return;
      if (action === 'nextTab') return setActiveId(tabs[(idx + 1) % tabs.length]!.id);
      if (action === 'prevTab') return setActiveId(tabs[(idx - 1 + tabs.length) % tabs.length]!.id);
      const n = Number(action.slice(3));
      const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (target) setActiveId(target.id);
    },
    [tabs, activeId, active, closeTab],
  );

  // Terminal-focused shortcuts come through the registry; everything else through window.
  useEffect(() => {
    setAppActionHandler(runAction);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || dialog) return;
      const a = appActionFor(e, platform);
      if (a) {
        e.preventDefault();
        runAction(a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runAction, platform, dialog]);

  const startSession = async (input: {
    profileId: string;
    projectId: string | null;
    cwd: string;
    title?: string;
  }) => {
    setDialog(null);
    try {
      const s = await api.invoke('sessions:create', input);
      // Load the new row first; otherwise the "keep a valid tab" effect snaps back to the old tab.
      await data.refresh('sessions');
      setActiveId(s.id);
    } catch (e) {
      setNotice(t(errorKey(e)));
    }
  };

  const showOnboarding = data.loaded && (profiles.length === 0 || tabs.length === 0);

  return (
    <div className="flex h-full flex-col">
      {env && !env.claudePath && (
        <div role="alert" className="flex items-center gap-3 border-b border-line bg-danger/15 px-4 py-2">
          <span>{t('claude.notFound')}</span>
          <button className="text-accent underline" onClick={() => api.send('link:open', CLAUDE_SETUP_URL)}>
            {t('claude.installGuide')}
          </button>
        </div>
      )}
      {env && env.platform === 'win32' && !env.gitAvailable && (
        <div role="alert" className="flex items-center gap-3 border-b border-line bg-warn/15 px-4 py-2">
          <span>{t('git.missing')}</span>
          <button
            className="text-accent underline"
            onClick={() => api.send('link:open', GIT_FOR_WINDOWS_URL)}
          >
            {t('git.installGuide')}
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-center gap-3 border-b border-line bg-panel-2 px-4 py-2">
          <span className="min-w-0 flex-1 break-all">{notice}</span>
          <button
            className="text-muted hover:text-fg"
            onClick={() => setNotice(null)}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          profiles={profiles}
          projects={projects}
          sessions={sessions}
          ptyStates={ptyStates}
          activeId={activeId}
          onAddProfile={() => setDialog({ kind: 'addProfile' })}
          onRemoveProfile={(profile) => setDialog({ kind: 'removeProfile', profile })}
          onAddProject={() => setDialog({ kind: 'addProject' })}
          onRemoveProject={(project) => setDialog({ kind: 'removeProject', project })}
          onNewSession={(projectId) => setDialog({ kind: 'newSession', projectId })}
          onSelectSession={setActiveId}
          onReopenSession={async (id) => {
            await api.invoke('sessions:reopen', id);
            await data.refresh('sessions');
            setActiveId(id);
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            tabs={tabs}
            profiles={profiles}
            ptyStates={ptyStates}
            activeId={activeId}
            newSessionHint={`${modLabel(platform)}T`}
            onSelect={setActiveId}
            onClose={(id) => void closeTab(id)}
            onNew={() => setDialog({ kind: 'newSession', projectId: active?.projectId ?? null })}
          />
          {active && (
            <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 text-xs">
              <ProfileBadge profile={profileById.get(active.profileId)} small />
              <span className="font-path min-w-0 flex-1 truncate text-muted" title={active.cwd}>
                {active.cwd}
              </span>
              {active.location === 'embedded' && (
                <button
                  className="rounded border border-line px-2 py-0.5 hover:bg-panel-2"
                  onClick={() => setDialog({ kind: 'openExternal', sessionId: active.id })}
                >
                  ↗ {t('session.openExternal')}
                </button>
              )}
            </div>
          )}
          <div
            className="relative min-h-0 flex-1"
            style={{
              borderLeft: `3px solid ${active ? profileById.get(active.profileId)?.color : 'transparent'}`,
            }}
          >
            {tabs.map((s) => (
              <TerminalView
                key={s.id}
                session={s}
                active={s.id === activeId}
                ptyState={ptyStates[s.id] ?? 'idle'}
                exitCode={exitCodes[s.id] ?? null}
              />
            ))}
            {active?.location === 'external' && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/95">
                <div className="max-w-md space-y-3 rounded-lg border border-line bg-panel p-6 text-center">
                  <p className="text-base font-semibold">↗ {t('session.external.banner')}</p>
                  <p className="text-muted">{t('session.external.limits')}</p>
                  <Button variant="primary" onClick={() => void api.invoke('sessions:reclaim', active.id)}>
                    {t('session.reclaim')}
                  </Button>
                </div>
              </div>
            )}
            {showOnboarding && !active && (
              <Onboarding
                hasProfile={profiles.length > 0}
                hasProject={projects.length > 0}
                onAddProfile={() => setDialog({ kind: 'addProfile' })}
                onAddProject={() => setDialog({ kind: 'addProject' })}
                onNewSession={() => setDialog({ kind: 'newSession', projectId: projects[0]?.id ?? null })}
              />
            )}
          </div>
        </main>
      </div>

      {dialog?.kind === 'addProfile' && (
        <AddProfileDialog
          env={env}
          profiles={profiles}
          onClose={() => setDialog(null)}
          onCreated={(p) =>
            // Open a session with the new profile right away so the user can /login (§3-2).
            void startSession({
              profileId: p.id,
              projectId: null,
              cwd: env?.homeDir ?? '',
              title: `login: ${p.name}`,
            })
          }
        />
      )}
      {dialog?.kind === 'addProject' && (
        <AddProjectDialog
          profiles={profiles}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'newSession' && (
        <NewSessionDialog
          profiles={profiles}
          projects={projects}
          initialProjectId={dialog.projectId}
          homeDir={env?.homeDir ?? ''}
          onClose={() => setDialog(null)}
          onStart={(input) => void startSession(input)}
        />
      )}
      {dialog?.kind === 'removeProfile' && (
        <ConfirmDialog
          title={t('profile.remove.title', { name: dialog.profile.name })}
          body={t('profile.remove.body', { dir: dialog.profile.configDir })}
          confirmLabel={t('common.remove')}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const id = dialog.profile.id;
            setDialog(null);
            sessions.filter((s) => s.profileId === id).forEach((s) => disposeTerminal(s.id));
            const { configDir } = await api.invoke('profiles:remove', id);
            setNotice(t('profile.removed', { dir: configDir }));
          }}
        />
      )}
      {dialog?.kind === 'removeProject' && (
        <ConfirmDialog
          title={t('project.remove.title', { name: dialog.project.name })}
          body={t('project.remove.body')}
          confirmLabel={t('common.remove')}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            void api.invoke('projects:remove', dialog.project.id);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'openExternal' && (
        <ConfirmDialog
          title={t('session.openExternal.title')}
          body={t('session.openExternal.body')}
          confirmLabel={t('session.openExternal')}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const id = dialog.sessionId;
            setDialog(null);
            try {
              await api.invoke('sessions:openExternal', id);
            } catch (e) {
              setNotice(t('session.startFailed', { msg: t(errorKey(e)) }));
            }
          }}
        />
      )}
    </div>
  );
}

function Onboarding(props: {
  hasProfile: boolean;
  hasProject: boolean;
  onAddProfile(): void;
  onAddProject(): void;
  onNewSession(): void;
}) {
  const t = useT();
  const steps = [
    {
      done: props.hasProfile,
      label: t('empty.step1'),
      action: props.onAddProfile,
      cta: t('sidebar.addProfile'),
    },
    {
      done: props.hasProject,
      label: t('empty.step2'),
      action: props.onAddProject,
      cta: t('sidebar.addProject'),
    },
    { done: false, label: t('empty.step3'), action: props.onNewSession, cta: t('session.new') },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <div className="absolute inset-0 flex items-center justify-center" data-testid="onboarding">
      <div className="w-[460px] max-w-[92%] space-y-4">
        <h1 className="text-xl font-semibold">
          {props.hasProfile ? t('empty.noSession') : t('empty.welcome')}
        </h1>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li
              key={i}
              className={`flex items-center gap-3 rounded border px-3 py-2 ${
                i === current ? 'border-accent bg-panel' : 'border-line'
              }`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                  s.done ? 'bg-ok text-black' : 'border border-line'
                }`}
                aria-hidden
              >
                {s.done ? '✓' : i + 1}
              </span>
              <span className={`flex-1 ${s.done ? 'text-muted line-through' : ''}`}>{s.label}</span>
              {i === current && (
                <Button variant="primary" onClick={s.action} disabled={i === 2 && !props.hasProfile}>
                  {s.cta}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
