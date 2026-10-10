import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, Notification, powerSaveBlocker, safeStorage } from 'electron';
import type { DiscordInfo } from '@shared/ipc';
import { displayStatus } from '@shared/status';
import { Logger } from './log';
import { DiscordController, gitDiffSummary, ThreadRepo } from './discord/controller';
import { DiscordJsTransport } from './discord/discordJsTransport';
import { OfflineTransport } from './discord/transport';
import { SecretStore } from './discord/secretStore';
import { openDatabase } from './db/database';
import { CodeDeckService } from './service';
import { SettingsStore } from './settings';
import { registerIpc } from './ipc';
import { WindowManager } from './windows';
import { Notifier } from './notifier';
import { UsageService } from './usage/usageService';
import { AppTray } from './tray';
import { Scheduler } from './schedule/scheduler';
import { Updater } from './updater';
import { OutputBatcher } from './sessions/outputBatcher';

// E2E tests point userData at a temp dir so they never touch real data.
if (process.env.CODEDECK_USER_DATA) app.setPath('userData', process.env.CODEDECK_USER_DATA);
// Windows toasts are attributed to this id (must match electron-builder's appId).
if (process.platform === 'win32') app.setAppUserModelId('dev.codedeck.app');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let windows: WindowManager | null = null;
  const showMain = () => {
    const w = windows?.main;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  };

  app.on('second-instance', showMain);

  void app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const db = openDatabase(path.join(userData, 'codedeck.db'));
    const settings = new SettingsStore(path.join(userData, 'settings.json'));
    const wm = new WindowManager((ids) => {
      settings.set({ popouts: ids });
      wm.broadcast('windows:changed', ids);
    });
    windows = wm;

    const notifier = new Notifier({
      settings: () => settings.get(),
      appFocused: () => BrowserWindow.getFocusedWindow() !== null,
      showOs: (title, body, onClick) => {
        // E2E runs record the notification without putting toasts on the desktop.
        if (process.env.CODEDECK_NO_OS_NOTIFY || !Notification.isSupported()) return;
        const n = new Notification({ title, body });
        n.on('click', onClick);
        n.show();
      },
      showInApp: (record) => wm.broadcast('notify:show', record),
      onClick: (record) => {
        showMain();
        if (record.sessionId) wm.broadcast('app:focusSession', record.sessionId);
      },
    });

    let svc: CodeDeckService | null = null;
    let discord: DiscordController | null = null;
    const output = new OutputBatcher((id, data, end) => wm.broadcast('pty:data', id, data, end));
    const log = new Logger(path.join(userData, 'logs'));
    const tray = new AppTray({ show: showMain, quit: () => app.quit() }, () => settings.get().locale);
    const usage = new UsageService({
      db,
      profiles: () => svc?.profiles.list() ?? [],
      notify: (kind, vars, profileId) => {
        const r = notifier.notify(kind, vars, { profileId });
        if (r) discord?.bridge.onNotification(r);
      },
      onChanged: (list) => {
        wm.broadcast('usage:changed', list);
        tray.update(list, svc?.profiles.list() ?? []);
      },
    });

    svc = new CodeDeckService({
      db,
      settings,
      stateDir: userData,
      home: process.env.CODEDECK_HOME, // E2E only: keeps test profiles out of the real ~/.codedeck
      ptyEvents: {
        onData: (id, data, end) => output.push(id, data, end),
        onState: (id, state, code) => {
          // The last output must arrive before "exited" is shown.
          output.flush(id);
          wm.broadcast('pty:state', id, state, code);
        },
      },
      onActivity: (id, activity, prev) => {
        wm.broadcast('activity:changed', id, activity);
        const s = svc?.sessions.get(id);
        if (!s) return;
        const profile = svc?.profiles.get(s.profileId);
        const vars = { session: s.title, profile: profile?.name ?? '' };
        if (activity === 'done' && prev === 'working')
          notifier.notify('sessionDone', vars, { sessionId: id });
        if (activity === 'approval') notifier.notify('sessionApproval', vars, { sessionId: id });
        if (activity === 'error') notifier.notify('sessionError', vars, { sessionId: id });
        // A finished turn has written new usage to its transcript.
        if (activity === 'done' || activity === 'error') usage.scheduleRefresh(s.profileId);
        discord?.bridge.onActivity(id, activity, prev);
      },
      onPlan: (profileId, sub) => usage.setDetectedPlan(profileId, sub),
      onLimit: (_sessionId, profileId, msg) => usage.onLimitMessage(profileId, msg),
      onChange: (what) => {
        wm.broadcast('state:changed', what);
        if (what === 'profiles') usage.refreshAll();
      },
    });
    const core = svc;
    const discordInfo = (): DiscordInfo => ({
      status: discord?.bridge.getStatus() ?? { state: 'off' },
      hasToken: discord?.hasToken() ?? false,
      keychainAvailable: discord?.keychainAvailable() ?? false,
    });
    discord = new DiscordController(
      // E2E: never contact Discord (a test token must not leave the machine).
      process.env.CODEDECK_DISCORD_OFFLINE ? new OfflineTransport() : new DiscordJsTransport(),
      new SecretStore(userData, safeStorage),
      () => settings.get(),
      {
        sessions: () => core.sessions.list(),
        profiles: () => core.profiles.list(),
        projects: () => core.projects.list(),
        homeDir: () => process.env.CODEDECK_HOME || os.homedir(),
        statusOf: (id) => {
          const s = core.sessions.get(id);
          return s ? displayStatus(s, core.ptys.state(id), core.activity(id)) : 'idle';
        },
        isRunning: (id) => core.ptys.isRunning(id),
        screenLines: (id, max) => core.screens.lines(id, max),
        createSession: (input) => core.createSession(input),
        startPty: (id) => core.startPty(id, 120, 32),
        submitText: (id, text) => core.submitText(id, text),
        input: (id, data) => core.input(id, data),
        usage: () => usage.list(),
        diffSummary: gitDiffSummary,
        threads: new ThreadRepo(db),
        log: (message, fields) => log.write('discord', message, fields),
        onRemoteInput: (sessionId, user, kind, preview) =>
          wm.broadcast('remote:input', { sessionId, user, kind, preview, at: Date.now() }),
      },
      () => wm.broadcast('discord:status', discordInfo()),
      {
        start: () => powerSaveBlocker.start('prevent-app-suspension'),
        stop: (id) => powerSaveBlocker.stop(id),
      },
    );
    const scheduler = new Scheduler({
      db,
      run: async (s) => {
        const project = s.projectId ? core.projects.get(s.projectId) : null;
        const session = core.createSession({
          profileId: s.profileId,
          projectId: project?.id ?? null,
          cwd: project?.path ?? (process.env.CODEDECK_HOME || os.homedir()),
          title: `⏰ ${s.name}`,
        });
        core.startPty(session.id, 120, 32);
        await core.waitForInput(session.id);
        await core.submitText(session.id, s.prompt);
        return session;
      },
      notify: (kind, vars, sessionId) => notifier.notify(kind, vars, { sessionId }),
      onChanged: () => wm.broadcast('state:changed', 'schedules'),
    });

    let updateAnnounced = '';
    const updater = new Updater(
      () => settings.get().autoUpdate,
      (st) => {
        wm.broadcast('update:state', st);
        if (st.state === 'downloaded' && updateAnnounced !== st.version) {
          updateAnnounced = st.version;
          notifier.notify('updateReady', { version: st.version });
        }
      },
    );

    const applyLoginItem = () => {
      // Only the installed app registers itself; a dev build would register electron.exe.
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin });
    };

    registerIpc(svc, settings, wm, usage, notifier, discord, discordInfo, {
      scheduler,
      updater,
      onSettingsChanged: (before, next) => {
        if (before.launchAtLogin !== next.launchAtLogin) applyLoginItem();
        if (before.autoUpdate !== next.autoUpdate) updater.start();
      },
    });
    wm.applyTheme(settings.get().theme);
    nativeTheme.on('updated', () => wm.applyTheme(settings.get().theme));
    const mainWindow = wm.createMain();
    // "Stay in tray": closing the window hides it; quitting is done from the tray menu.
    let quitting = false;
    mainWindow.on('close', (e) => {
      if (!quitting && settings.get().stayInTray) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // Pop-out windows come back after a restart (sessions that are still open tabs).
    const open = new Set(
      svc.sessions
        .list()
        .filter((s) => s.open && s.location === 'embedded')
        .map((s) => s.id),
    );
    const restore = settings.get().popouts.filter((id) => open.has(id));
    settings.set({ popouts: [] });
    for (const id of restore) wm.popout(id, svc.sessions.get(id)?.title ?? 'CodeDeck');

    void svc.checkAllAuth();
    usage.start(Number(process.env.CODEDECK_USAGE_INTERVAL_MS) || 60_000);
    void discord.apply();
    scheduler.start(Number(process.env.CODEDECK_SCHEDULE_INTERVAL_MS) || 30_000);
    updater.start();
    applyLoginItem();

    const shutdown = () => {
      usage.stop();
      scheduler.stop();
      updater.stop();
      void discord?.shutdown();
      tray.destroy();
      svc?.shutdown();
    };
    app.on('before-quit', () => {
      quitting = true;
      // Keep the list of pop-outs as it is now, so they come back after the restart.
      wm.setQuitting();
      shutdown();
    });
    app.on('window-all-closed', () => {
      shutdown();
      app.quit();
    });
  });
}
