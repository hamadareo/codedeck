import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { InvokeChannel, InvokeContract, SendChannel, SendContract } from '@shared/ipc';
import type { CodeDeckService } from './service';
import { claudeVersion, resolveClaude } from './platform/claude';

type Handler<C extends InvokeChannel> = (
  ...args: InvokeContract[C]['args']
) => InvokeContract[C]['result'] | Promise<InvokeContract[C]['result']>;

function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeContract[C]['args'])));
}

function on<C extends SendChannel>(channel: C, fn: (...args: SendContract[C]) => void): void {
  ipcMain.on(channel, (_e, ...args) => fn(...(args as SendContract[C])));
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function registerIpc(svc: CodeDeckService, getWindow: () => BrowserWindow | null): void {
  handle('env:info', async () => ({
    platform: process.platform,
    claudePath: resolveClaude(),
    claudeVersion: await claudeVersion(),
    gitAvailable: gitAvailable(),
    homeDir: process.env.CODEDECK_HOME || os.homedir(),
  }));

  handle('profiles:list', () => svc.profiles.list());
  handle('profiles:create', (input) => svc.createProfile(input));
  handle('profiles:update', (id, patch) => svc.updateProfile(id, patch));
  handle('profiles:remove', (id) => svc.removeProfile(id));
  handle('profiles:checkAuth', (id) => svc.checkAuth(id));

  handle('projects:list', () => svc.projects.list());
  handle('projects:create', (input) => svc.createProject(input));
  handle('projects:update', (id, patch) => svc.updateProject(id, patch));
  handle('projects:remove', (id) => svc.removeProject(id));

  handle('dialog:pickFolder', async () => {
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle('sessions:list', () => svc.sessions.list());
  handle('sessions:create', (input) => svc.createSession(input));
  handle('sessions:close', (id) => svc.closeSession(id));
  handle('sessions:reopen', (id) => svc.reopenSession(id));
  handle('sessions:remove', (id) => svc.removeSession(id));
  handle('sessions:openExternal', (id) => svc.openExternal(id));
  handle('sessions:reclaim', (id) => svc.reclaim(id));

  handle('pty:start', (id, cols, rows) => {
    svc.startPty(id, cols, rows);
    return { state: svc.ptys.state(id) };
  });
  handle('pty:states', () => svc.ptys.states());
  on('pty:input', (id, data) => svc.ptys.write(id, data));
  on('pty:resize', (id, cols, rows) => svc.ptys.resize(id, cols, rows));

  // Electron 44's clipboard API is async (W3C-style).
  handle('clipboard:read', async () => {
    const [text, hasImage] = await Promise.all([clipboard.readText(), clipboard.has('image/png')]);
    return { text, hasImage };
  });
  on('clipboard:write', (text) => void clipboard.writeText(text));
  on('link:open', (url) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
}
