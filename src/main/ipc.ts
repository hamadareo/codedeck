import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel, InvokeContract, SendChannel, SendContract } from '@shared/ipc';
import type { CodeDeckService } from './service';
import type { SettingsStore } from './settings';
import type { WindowManager } from './windows';
import type { UsageService } from './usage/usageService';
import type { Notifier } from './notifier';
import type { DiscordController } from './discord/controller';
import type { DiscordInfo } from '@shared/ipc';
import { claudeVersion, resolveClaude } from './platform/claude';

type Handler<C extends InvokeChannel> = (
  this: IpcMainInvokeEvent,
  ...args: InvokeContract[C]['args']
) => InvokeContract[C]['result'] | Promise<InvokeContract[C]['result']>;

function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, (e, ...args) => fn.apply(e, args as InvokeContract[C]['args']));
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

export function registerIpc(
  svc: CodeDeckService,
  settings: SettingsStore,
  wm: WindowManager,
  usage: UsageService,
  notifier: Notifier,
  discord: DiscordController,
  discordInfo: () => DiscordInfo,
): void {
  handle('discord:info', () => discordInfo());
  handle('discord:setToken', async (token) => {
    await discord.setToken(token);
    return discordInfo();
  });
  handle('discord:clearToken', async () => {
    await discord.clearToken();
    return discordInfo();
  });
  handle('discord:reconnect', async () => {
    await discord.apply(true);
    return discordInfo();
  });
  handle('usage:list', () => usage.list());
  handle('usage:refresh', () => usage.refreshAll());
  handle('usage:setConfig', (profileId, patch) => usage.setConfig(profileId, patch));
  handle('notify:history', () => notifier.list());

  handle('env:info', async () => ({
    platform: process.platform,
    claudePath: resolveClaude(),
    claudeVersion: await claudeVersion(),
    gitAvailable: gitAvailable(),
    homeDir: process.env.CODEDECK_HOME || os.homedir(),
  }));
  handle('window:context', function () {
    return wm.contextOf(this.sender.id);
  });

  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => {
    const before = settings.get();
    const next = settings.set(patch);
    if (next.theme !== before.theme) wm.applyTheme(next.theme);
    wm.broadcast('settings:changed', next);
    if (patch.discord || patch.locale) void discord.apply();
    return next;
  });

  handle('profiles:list', () => svc.profiles.list());
  handle('profiles:create', (input) => svc.createProfile(input));
  handle('profiles:update', (id, patch) => svc.updateProfile(id, patch));
  handle('profiles:remove', (id) => svc.removeProfile(id));
  handle('profiles:checkAuth', (id) => svc.checkAuth(id));

  handle('projects:list', () => svc.projects.list());
  handle('projects:create', (input) => svc.createProject(input));
  handle('projects:update', (id, patch) => svc.updateProject(id, patch));
  handle('projects:remove', (id) => svc.removeProject(id));
  handle('notes:get', (projectId) => svc.getNote(projectId));
  handle('notes:set', (projectId, body) => svc.setNote(projectId, body));

  handle('dialog:pickFolder', async function () {
    const win = BrowserWindow.fromWebContents(this.sender);
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle('sessions:list', () => svc.sessions.list());
  handle('sessions:create', (input) => svc.createSession(input));
  handle('sessions:close', (id) => {
    wm.dock(id);
    svc.closeSession(id);
  });
  handle('sessions:reopen', (id) => svc.reopenSession(id));
  handle('sessions:remove', (id) => {
    wm.dock(id);
    svc.removeSession(id);
  });
  handle('sessions:rename', (id, title) => svc.renameSession(id, title));
  handle('sessions:openExternal', async (id) => {
    wm.dock(id);
    return svc.openExternal(id);
  });
  handle('sessions:reclaim', (id) => svc.reclaim(id));

  handle('pty:start', (id, cols, rows) => {
    svc.startPty(id, cols, rows);
    return { state: svc.ptys.state(id) };
  });
  handle('pty:states', () => svc.ptys.states());
  handle('pty:snapshot', (id) => svc.ptys.snapshot(id));
  handle('activity:list', () => svc.allActivities());
  on('pty:input', (id, data) => svc.input(id, data));
  on('pty:resize', (id, cols, rows) => svc.resize(id, cols, rows));
  on('session:seen', (id) => svc.seen(id));

  handle('window:popout', (id) => {
    const s = svc.sessions.get(id);
    if (!s || !s.open || s.location !== 'embedded') throw new Error(`session not available: ${id}`);
    wm.popout(id, `${s.title} — CodeDeck`);
  });
  handle('window:dock', (id) => wm.dock(id));
  handle('window:popouts', () => wm.popoutIds());

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
