import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { openDatabase } from './db/database';
import { CodeDeckService } from './service';
import { SettingsStore } from './settings';
import { registerIpc } from './ipc';
import { WindowManager } from './windows';

// E2E tests point userData at a temp dir so they never touch real data.
if (process.env.CODEDECK_USER_DATA) app.setPath('userData', process.env.CODEDECK_USER_DATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let windows: WindowManager | null = null;

  app.on('second-instance', () => {
    const w = windows?.main;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  void app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const db = openDatabase(path.join(userData, 'codedeck.db'));
    const settings = new SettingsStore(path.join(userData, 'settings.json'));
    const wm = new WindowManager((ids) => {
      settings.set({ popouts: ids });
      wm.broadcast('windows:changed', ids);
    });
    windows = wm;
    const svc = new CodeDeckService({
      db,
      settings,
      stateDir: userData,
      home: process.env.CODEDECK_HOME, // E2E only: keeps test profiles out of the real ~/.codedeck
      ptyEvents: {
        onData: (id, data, end) => wm.broadcast('pty:data', id, data, end),
        onState: (id, state, code) => wm.broadcast('pty:state', id, state, code),
      },
      onActivity: (id, activity) => wm.broadcast('activity:changed', id, activity),
      onChange: (what) => wm.broadcast('state:changed', what),
    });
    registerIpc(svc, settings, wm);
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

    app.on('before-quit', () => svc.shutdown());
    app.on('window-all-closed', () => {
      svc.shutdown();
      app.quit();
    });
  });
}
