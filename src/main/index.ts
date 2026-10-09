import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { openDatabase } from './db/database';
import { CodeDeckService } from './service';
import { SettingsStore } from './settings';
import { registerIpc } from './ipc';
import type { EventChannel, EventContract } from '@shared/ipc';

// E2E tests point userData at a temp dir so they never touch real data.
if (process.env.CODEDECK_USER_DATA) app.setPath('userData', process.env.CODEDECK_USER_DATA);

let win: BrowserWindow | null = null;

function emit<C extends EventChannel>(channel: C, ...args: EventContract[C]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'CodeDeck',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.once('ready-to-show', () => w.show());
  // Never navigate the app window away; open links in the OS browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'));
  return w;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const db = openDatabase(path.join(userData, 'codedeck.db'));
    const settings = new SettingsStore(path.join(userData, 'settings.json'));
    const svc = new CodeDeckService({
      db,
      settings,
      home: process.env.CODEDECK_HOME, // E2E only: keeps test profiles out of the real ~/.codedeck
      ptyEvents: {
        onData: (id, data) => emit('pty:data', id, data),
        onState: (id, state, code) => emit('pty:state', id, state, code),
      },
      onChange: (what) => emit('state:changed', what),
    });
    registerIpc(svc, () => win);
    win = createWindow();
    win.on('closed', () => (win = null));
    void svc.checkAllAuth();

    app.on('before-quit', () => svc.shutdown());
    app.on('window-all-closed', () => {
      svc.shutdown();
      app.quit();
    });
  });
}
