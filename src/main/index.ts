import path from 'node:path';
import { app, BrowserWindow, nativeTheme, Notification } from 'electron';
import { openDatabase } from './db/database';
import { CodeDeckService } from './service';
import { SettingsStore } from './settings';
import { registerIpc } from './ipc';
import { WindowManager } from './windows';
import { Notifier } from './notifier';
import { UsageService } from './usage/usageService';
import { AppTray } from './tray';

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
    const tray = new AppTray({ show: showMain, quit: () => app.quit() }, () => settings.get().locale);
    const usage = new UsageService({
      db,
      profiles: () => svc?.profiles.list() ?? [],
      notify: (kind, vars, profileId) => notifier.notify(kind, vars, { profileId }),
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
        onData: (id, data, end) => wm.broadcast('pty:data', id, data, end),
        onState: (id, state, code) => wm.broadcast('pty:state', id, state, code),
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
      },
      onPlan: (profileId, sub) => usage.setDetectedPlan(profileId, sub),
      onLimit: (_sessionId, profileId, msg) => usage.onLimitMessage(profileId, msg),
      onChange: (what) => {
        wm.broadcast('state:changed', what);
        if (what === 'profiles') usage.refreshAll();
      },
    });
    registerIpc(svc, settings, wm, usage, notifier);
    wm.applyTheme(settings.get().theme);
    nativeTheme.on('updated', () => wm.applyTheme(settings.get().theme));
    wm.createMain();

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

    const shutdown = () => {
      usage.stop();
      tray.destroy();
      svc?.shutdown();
    };
    app.on('before-quit', shutdown);
    app.on('window-all-closed', () => {
      shutdown();
      app.quit();
    });
  });
}
