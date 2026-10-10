import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appActionFor, modLabel, platformOf, shortcutLabel, type AppAction } from '@shared/keymap';
import {
  closePane,
  focusRelative,
  focusedPane,
  paneOfSession,
  panes,
  resizeSplit,
  retainSessions,
  setFocus,
  showSession,
  singlePane,
  splitPane,
  swapPanes,
  toggleMaximize,
} from '@shared/layout';
import { displayStatus } from '@shared/status';
import type { Layout, Profile, Project, Session, SessionStatus, SplitDir } from '@shared/types';
import { api, errorKey } from './api';
import { LocaleContext, useT } from './i18n';
import { saveSettings, SettingsContext, useSettings, useSettingsValue } from './settings';
import { useAppData, useSeen } from './useAppData';
import { disposeTerminal, setAppActionHandler, setPlatform } from './terminal/registry';
import { Sidebar } from './ui/Sidebar';
import { TabBar } from './ui/TabBar';
import { PaneArea } from './ui/PaneArea';
import { RightPanel } from './ui/RightPanel';
import { CommandPalette, type PaletteEntry } from './ui/CommandPalette';
import { SettingsDialog } from './ui/SettingsDialog';
import {
  AddProfileDialog,
  AddProjectDialog,
  EditProfileDialog,
  NewSessionDialog,
  ProjectSettingsDialog,
  RenameSessionDialog,
} from './ui/dialogs';
import { Button, ConfirmDialog } from './ui/Modal';

type Dialog =
  | { kind: 'addProfile' }
  | { kind: 'editProfile'; profile: Profile }
  | { kind: 'addProject' }
  | { kind: 'editProject'; project: Project }
  | { kind: 'newSession'; projectId: string | null; profileId?: string }
  | { kind: 'removeProfile'; profile: Profile }
  | { kind: 'removeProject'; project: Project }
  | { kind: 'openExternal'; sessionId: string }
  | { kind: 'rename'; session: Session }
  | { kind: 'palette' }
  | { kind: 'settings' }
  | null;

const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup';
const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win';

export function App() {
  const { settings } = useSettings();
  return (
    <SettingsContext.Provider value={settings}>
      <LocaleContext.Provider value={settings?.locale ?? 'ja'}>
        <Shell />
      </LocaleContext.Provider>
    </SettingsContext.Provider>
  );
}

function useStatusOf(data: ReturnType<typeof useAppData>) {
  const { sessions, ptyStates, activities, exitCodes } = data;
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  return useCallback(
    (id: string): SessionStatus => {
      const s = byId.get(id);
      if (!s) return 'idle';
      return displayStatus(s, ptyStates[id] ?? 'idle', activities[id] ?? 'unknown', exitCodes[id] ?? null);
    },
    [byId, ptyStates, activities, exitCodes],
  );
}

function Shell() {
  const t = useT();
  const data = useAppData();
  const settings = useSettingsValue();
  const { env, profiles, projects, sessions, popouts } = data;
  const platform = platformOf(env?.platform ?? '');
  const [layout, setLayoutState] = useState<Layout | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const statusOf = useStatusOf(data);

  const tabs = useMemo(() => sessions.filter((s) => s.open), [sessions]);
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  useEffect(() => setPlatform(platform), [platform]);

  // ---------- layout (restored from settings, saved on change) ----------
  const saveTimer = useRef<number | null>(null);
  const setLayout = useCallback((fn: (l: Layout) => Layout) => {
    setLayoutState((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      if (next !== prev) {
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => void saveSettings({ layout: next }), 400);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (layout || !settings || !data.loaded) return;
    const open = new Set(tabs.map((s) => s.id));
    const restored = settings.layout ? retainSessions(settings.layout, open) : null;
    const hasShown = restored && panes(restored.root).some((p) => p.sessionId);
    setLayoutState(hasShown ? restored : singlePane(tabs[tabs.length - 1]?.id ?? null));
  }, [layout, settings, data.loaded, tabs]);

  // Panes forget sessions that are no longer open tabs.
  useEffect(() => {
    if (!data.loaded) return;
    setLayout((l) => retainSessions(l, new Set(tabs.map((s) => s.id))));
  }, [tabs, data.loaded, setLayout]);

  // A session shown in its own window must not keep a second xterm here.
  useEffect(() => popouts.forEach((id) => disposeTerminal(id)), [popouts]);

  const focused = layout ? focusedPane(layout) : null;
  const activeId = focused?.sessionId ?? null;
  const active = activeId ? (sessionById.get(activeId) ?? null) : null;
  useSeen(activeId, activeId ? data.activities[activeId] : undefined);
  const shownIds = useMemo(
    () =>
      new Set(
        [...(layout ? panes(layout.root).map((p) => p.sessionId) : []), ...popouts].filter(
          Boolean,
        ) as string[],
      ),
    [layout, popouts],
  );

  /** Bring a session on screen: its pane, its window, or the focused pane. */
  const selectSession = useCallback(
    (id: string) => {
      if (popouts.includes(id)) return void api.invoke('window:popout', id); // focuses that window
      setLayout((l) => {
        const at = paneOfSession(l, id);
        return at ? setFocus(l, at.id) : showSession(l, l.focusedPaneId, id);
      });
    },
    [popouts, setLayout],
  );

  const firstHidden = useCallback(
    (l: Layout) => {
      const shown = new Set(panes(l.root).map((p) => p.sessionId));
      return tabs.find((s) => !shown.has(s.id) && !popouts.includes(s.id))?.id ?? null;
    },
    [tabs, popouts],
  );

  const split = useCallback(
    (paneId: string, dir: SplitDir) => setLayout((l) => splitPane(l, paneId, dir, firstHidden(l))),
    [setLayout, firstHidden],
  );

  const closeTab = useCallback(async (id: string) => {
    await api.invoke('sessions:close', id);
    disposeTerminal(id);
  }, []);

  const popout = useCallback(
    async (id: string) => {
      try {
        await api.invoke('window:popout', id);
      } catch (e) {
        setNotice(t('session.startFailed', { msg: t(errorKey(e)) }));
      }
    },
    [t],
  );

  const toggleRightPanel = useCallback(() => {
    if (!settings) return;
    void saveSettings({ rightPanel: { ...settings.rightPanel, open: !settings.rightPanel.open } });
  }, [settings]);

  const runAction = useCallback(
    (action: AppAction) => {
      if (!layout) return;
      switch (action) {
        case 'newSession':
          return setDialog({ kind: 'newSession', projectId: active?.projectId ?? null });
        case 'closeTab':
          return activeId && void closeTab(activeId);
        case 'palette':
          return setDialog({ kind: 'palette' });
        case 'settings':
          return setDialog({ kind: 'settings' });
        case 'splitRight':
          return split(layout.focusedPaneId, 'row');
        case 'splitDown':
          return split(layout.focusedPaneId, 'col');
        case 'closePane':
          return setLayout((l) => closePane(l, l.focusedPaneId));
        case 'maximize':
          return setLayout((l) => toggleMaximize(l));
        case 'nextPane':
          return setLayout((l) => focusRelative(l, 1));
        case 'prevPane':
          return setLayout((l) => focusRelative(l, -1));
        case 'toggleRightPanel':
          return toggleRightPanel();
        case 'popout':
          return activeId && void popout(activeId);
      }
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((s) => s.id === activeId);
      if (action === 'nextTab') return selectSession(tabs[(idx + 1) % tabs.length]!.id);
      if (action === 'prevTab') return selectSession(tabs[(idx - 1 + tabs.length) % tabs.length]!.id);
      const n = Number(action.slice(3));
      const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (target) selectSession(target.id);
    },
    [layout, tabs, activeId, active, closeTab, split, setLayout, toggleRightPanel, popout, selectSession],
  );

  // Terminal-focused shortcuts come through the registry; everything else through window.
  useEffect(() => {
    setAppActionHandler(runAction);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || dialog) return;
      const inTerminal = !!(e.target as HTMLElement | null)?.closest?.('.xterm');
      const a = appActionFor(e, platform, inTerminal);
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
      // Load the new row first; otherwise the pane would be emptied as "not an open tab".
      await data.refresh('sessions');
      setLayout((l) => showSession(l, l.focusedPaneId, s.id));
    } catch (e) {
      setNotice(t(errorKey(e)));
    }
  };

  const paletteEntries = useMemo((): PaletteEntry[] => {
    if (!settings) return [];
    const out: PaletteEntry[] = [];
    for (const s of tabs) {
      const p = profileById.get(s.profileId);
      out.push({
        id: `session:${s.id}`,
        group: 'session',
        label: s.title,
        detail: p?.name,
        hint: t(`status.${statusOf(s.id)}`),
        color: p?.color,
        keywords: s.cwd,
        run: () => selectSession(s.id),
      });
    }
    const cmd = (id: string, label: string, run: () => void, action?: AppAction): PaletteEntry => ({
      id: `cmd:${id}`,
      group: 'command',
      label,
      hint: action ? shortcutLabel(action, platform) : undefined,
      run,
    });
    out.push(
      cmd('new', t('cmd.newSession'), () => runAction('newSession'), 'newSession'),
      cmd('addProfile', t('cmd.addProfile'), () => setDialog({ kind: 'addProfile' })),
      cmd('addProject', t('cmd.addProject'), () => setDialog({ kind: 'addProject' })),
      cmd('splitRight', t('pane.splitRight'), () => runAction('splitRight'), 'splitRight'),
      cmd('splitDown', t('pane.splitDown'), () => runAction('splitDown'), 'splitDown'),
      cmd('closePane', t('pane.close'), () => runAction('closePane'), 'closePane'),
      cmd('maximize', t('pane.maximize'), () => runAction('maximize'), 'maximize'),
      cmd('panel', t('cmd.toggleRightPanel'), toggleRightPanel, 'toggleRightPanel'),
      cmd('checkAuth', t('cmd.checkAuth'), () =>
        profiles.forEach((p) => void api.invoke('profiles:checkAuth', p.id)),
      ),
    );
    if (active) {
      out.push(
        cmd('closeTab', t('cmd.closeTab'), () => runAction('closeTab'), 'closeTab'),
        cmd('rename', t('cmd.rename'), () => setDialog({ kind: 'rename', session: active })),
      );
      if (active.location === 'embedded') {
        out.push(
          cmd('popout', t('pane.popout'), () => runAction('popout'), 'popout'),
          cmd('external', t('session.openExternal'), () =>
            setDialog({ kind: 'openExternal', sessionId: active.id }),
          ),
        );
      }
    }
    for (const pr of projects) {
      out.push({
        id: `project:${pr.id}`,
        group: 'project',
        label: t('cmd.newSessionIn', { name: pr.name }),
        detail: pr.path,
        color: profileById.get(pr.pinnedProfileId ?? '')?.color,
        run: () => setDialog({ kind: 'newSession', projectId: pr.id }),
      });
      out.push({
        id: `project-edit:${pr.id}`,
        group: 'project',
        label: t('cmd.editProject', { name: pr.name }),
        run: () => setDialog({ kind: 'editProject', project: pr }),
      });
    }
    for (const p of profiles) {
      out.push({
        id: `profile:${p.id}`,
        group: 'profile',
        label: t('cmd.newSessionWith', { name: p.name }),
        detail: p.accountEmail ?? t(`auth.${p.authStatus}`),
        color: p.color,
        run: () => setDialog({ kind: 'newSession', projectId: active?.projectId ?? null, profileId: p.id }),
      });
      out.push({
        id: `profile-edit:${p.id}`,
        group: 'profile',
        label: t('cmd.editProfile', { name: p.name }),
        color: p.color,
        run: () => setDialog({ kind: 'editProfile', profile: p }),
      });
    }
    const setting = (id: string, label: string, run: () => void, hint?: string): PaletteEntry => ({
      id: `setting:${id}`,
      group: 'setting',
      label,
      hint,
      run,
    });
    out.push(
      setting(
        'open',
        t('cmd.settings'),
        () => setDialog({ kind: 'settings' }),
        shortcutLabel('settings', platform),
      ),
      ...(['system', 'light', 'dark'] as const).map((m) =>
        setting(
          `theme-${m}`,
          t('cmd.theme', { name: t(`settings.theme.${m}`) }),
          () => void saveSettings({ theme: m }),
          settings.theme === m ? '✓' : undefined,
        ),
      ),
      setting('ja', t('cmd.locale', { name: '日本語' }), () => void saveSettings({ locale: 'ja' })),
      setting('en', t('cmd.locale', { name: 'English' }), () => void saveSettings({ locale: 'en' })),
      setting(
        'bigger',
        t('cmd.fontBigger'),
        () =>
          void saveSettings({
            uiFontSize: settings.uiFontSize + 1,
            terminalFontSize: settings.terminalFontSize + 1,
          }),
      ),
      setting(
        'smaller',
        t('cmd.fontSmaller'),
        () =>
          void saveSettings({
            uiFontSize: settings.uiFontSize - 1,
            terminalFontSize: settings.terminalFontSize - 1,
          }),
      ),
      ...(['notes', 'diff', 'tasks', 'usage'] as const).map((tab) =>
        setting(
          `panel-${tab}`,
          t('cmd.panel', { name: t(`panel.${tab}`) }),
          () => void saveSettings({ rightPanel: { ...settings.rightPanel, open: true, tab } }),
        ),
      ),
    );
    return out;
  }, [
    settings,
    tabs,
    profiles,
    projects,
    profileById,
    statusOf,
    active,
    platform,
    t,
    runAction,
    selectSession,
    toggleRightPanel,
  ]);

  const showOnboarding = data.loaded && (profiles.length === 0 || tabs.length === 0);
  const rightPanel = settings?.rightPanel;
  const activeProject = active?.projectId ? (projects.find((p) => p.id === active.projectId) ?? null) : null;

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
          width={settings?.sidebarWidth ?? 288}
          profiles={profiles}
          projects={projects}
          sessions={sessions}
          statusOf={statusOf}
          activeId={activeId}
          onAddProfile={() => setDialog({ kind: 'addProfile' })}
          onEditProfile={(profile) => setDialog({ kind: 'editProfile', profile })}
          onRemoveProfile={(profile) => setDialog({ kind: 'removeProfile', profile })}
          onAddProject={() => setDialog({ kind: 'addProject' })}
          onEditProject={(project) => setDialog({ kind: 'editProject', project })}
          onRemoveProject={(project) => setDialog({ kind: 'removeProject', project })}
          onNewSession={(projectId, profileId) => setDialog({ kind: 'newSession', projectId, profileId })}
          onSelectSession={selectSession}
          onRenameSession={(session) => setDialog({ kind: 'rename', session })}
          onReopenSession={async (id) => {
            await api.invoke('sessions:reopen', id);
            await data.refresh('sessions');
            selectSession(id);
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-stretch">
            <div className="min-w-0 flex-1">
              <TabBar
                tabs={tabs}
                profiles={profiles}
                statusOf={statusOf}
                activeId={activeId}
                shownIds={shownIds}
                popouts={popouts}
                newSessionHint={`${modLabel(platform)}T`}
                onSelect={selectSession}
                onClose={(id) => void closeTab(id)}
                onNew={() => setDialog({ kind: 'newSession', projectId: active?.projectId ?? null })}
              />
            </div>
            <div className="flex items-center gap-1 border-b border-l border-line bg-panel px-2">
              <button
                className="rounded px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg"
                onClick={() => setDialog({ kind: 'palette' })}
                title={`${t('palette.title')} (${shortcutLabel('palette', platform)})`}
                aria-label={t('palette.title')}
                data-testid="open-palette"
              >
                ⌕
              </button>
              <button
                className={`rounded px-2 py-1 hover:bg-panel-2 hover:text-fg ${rightPanel?.open ? 'text-accent' : 'text-muted'}`}
                onClick={toggleRightPanel}
                title={`${rightPanel?.open ? t('panel.close') : t('panel.open')} (${shortcutLabel('toggleRightPanel', platform)})`}
                aria-label={rightPanel?.open ? t('panel.close') : t('panel.open')}
                aria-pressed={!!rightPanel?.open}
                data-testid="toggle-right-panel"
              >
                ▥
              </button>
              <button
                className="rounded px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg"
                onClick={() => setDialog({ kind: 'settings' })}
                title={`${t('settings.title')} (${shortcutLabel('settings', platform)})`}
                aria-label={t('settings.title')}
                data-testid="open-settings"
              >
                ⚙
              </button>
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1">
            {layout && !showOnboarding && (
              <PaneArea
                layout={layout}
                sessions={sessionById}
                profiles={profileById}
                tabs={tabs}
                statusOf={statusOf}
                ptyStates={data.ptyStates}
                exitCodes={data.exitCodes}
                popouts={popouts}
                platform={platform}
                onFocusPane={(id) => setLayout((l) => setFocus(l, id))}
                onShow={(paneId, sid) => setLayout((l) => showSession(l, paneId, sid))}
                onSwap={(a, b) => setLayout((l) => swapPanes(l, a, b))}
                onSplit={split}
                onClosePane={(id) => setLayout((l) => closePane(l, id))}
                onToggleMax={(id) => setLayout((l) => toggleMaximize(l, id))}
                onPopout={(id) => void popout(id)}
                onDock={(id) => void api.invoke('window:dock', id)}
                onOpenExternal={(id) => setDialog({ kind: 'openExternal', sessionId: id })}
                onReclaim={(id) => void api.invoke('sessions:reclaim', id)}
                onResize={(sid, sizes) => setLayout((l) => resizeSplit(l, sid, sizes))}
                onNewSession={() => setDialog({ kind: 'newSession', projectId: active?.projectId ?? null })}
              />
            )}
            {showOnboarding && (
              <Onboarding
                hasProfile={profiles.length > 0}
                hasProject={projects.length > 0}
                paletteKey={shortcutLabel('palette', platform)}
                onAddProfile={() => setDialog({ kind: 'addProfile' })}
                onAddProject={() => setDialog({ kind: 'addProject' })}
                onNewSession={() => setDialog({ kind: 'newSession', projectId: projects[0]?.id ?? null })}
              />
            )}
            {rightPanel?.open && settings && (
              <RightPanel
                tab={rightPanel.tab}
                width={rightPanel.width}
                project={activeProject}
                activeSessionId={activeId}
                onTab={(tab) => void saveSettings({ rightPanel: { ...rightPanel, tab } })}
                onClose={toggleRightPanel}
                onResize={(width) => void saveSettings({ rightPanel: { ...rightPanel, width } })}
              />
            )}
          </div>
        </main>
      </div>

      {dialog?.kind === 'palette' && (
        <CommandPalette entries={paletteEntries} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'settings' && settings && (
        <SettingsDialog settings={settings} platform={platform} onClose={() => setDialog(null)} />
      )}
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
      {dialog?.kind === 'editProfile' && (
        <EditProfileDialog profile={dialog.profile} profiles={profiles} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'addProject' && (
        <AddProjectDialog
          profiles={profiles}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'editProject' && (
        <ProjectSettingsDialog project={dialog.project} profiles={profiles} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'rename' && (
        <RenameSessionDialog session={dialog.session} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'newSession' && (
        <NewSessionDialog
          profiles={profiles}
          projects={projects}
          initialProjectId={dialog.projectId}
          initialProfileId={dialog.profileId}
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
  paletteKey: string;
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
                  s.done ? 'bg-ok text-on-ok' : 'border border-line'
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
        <p className="text-xs text-muted">{t('empty.paletteHint', { key: props.paletteKey })}</p>
      </div>
    </div>
  );
}
