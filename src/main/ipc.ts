import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitCommitAll, gitDiff, gitStatus } from './git';
import { listMcp, listSkills, setSkillEnabled } from './extensions';
import { computeStats } from '@shared/stats';
import { parsePromptExport, type PromptExport } from '@shared/prompts';
import { translate } from '@shared/i18n';
import type { Settings } from '@shared/types';
import type { Scheduler } from './schedule/scheduler';
import type { Updater } from './updater';
import { resolveSsh } from './ssh/sshRepo';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
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
  extra: {
    scheduler: Scheduler;
    updater: Updater;
    onSettingsChanged(before: Settings, next: Settings): void;
  },
): void {
  const { scheduler, updater } = extra;
  handle('schedules:list', () => scheduler.list());
  handle('schedules:create', (input) => scheduler.create(input));
  handle('schedules:update', (id, input) => scheduler.update(id, input));
  handle('schedules:remove', (id) => scheduler.remove(id));
  handle('schedules:runNow', (id) => scheduler.runNow(id));
  handle('ssh:list', () => svc.sshHosts.list());
  handle('ssh:create', (input) => svc.createSshHost(input));
  handle('ssh:update', (id, input) => svc.updateSshHost(id, input));
  handle('ssh:remove', (id) => svc.removeSshHost(id));
  handle('ssh:available', () => resolveSsh() !== null);
  handle('update:state', () => updater.get());
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.installNow());
  handle('app:version', () => (app.isPackaged ? app.getVersion() : __APP_VERSION__));

  // ---------- Phase 5 ----------
  handle('tasks:list', (projectId) => svc.tasks.list(projectId));
  handle('tasks:create', (projectId, title, body) => svc.createTask(projectId, title, body));
  handle('tasks:update', (id, patch) => svc.updateTask(id, patch));
  handle('tasks:remove', (id) => svc.removeTask(id));
  handle('tasks:move', (id, delta) => svc.moveTask(id, delta === -1 ? -1 : 1));
  handle('tasks:start', (id, profileId) => svc.startTask(id, profileId));

  // git runs only in folders CodeDeck knows (a project or a session's working directory).
  const knownDir = (cwd: string) => {
    const norm = (p: string) => path.resolve(p).toLowerCase();
    const ok =
      svc.projects.list().some((p) => norm(p.path) === norm(cwd)) ||
      svc.sessions.list().some((s) => norm(s.cwd) === norm(cwd));
    if (!ok) throw new Error('git.error.unknownDir');
    return cwd;
  };
  handle('git:status', (cwd) => gitStatus(knownDir(cwd)));
  handle('git:diff', (cwd, file) => gitDiff(knownDir(cwd), file));
  handle('git:commit', (cwd, message) => gitCommitAll(knownDir(cwd), message));
  handle('git:askCommitMessage', (sessionId) => svc.askCommitMessage(sessionId));

  handle('prompts:list', () => svc.prompts.list());
  handle('prompts:create', (input) => svc.createPrompt(input));
  handle('prompts:update', (id, patch) => svc.updatePrompt(id, patch));
  handle('prompts:remove', (id) => svc.removePrompt(id));
  handle('prompts:export', async function () {
    const win = BrowserWindow.fromWebContents(this.sender);
    const opts: Electron.SaveDialogOptions = {
      defaultPath: 'codedeck-prompts.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const data: PromptExport = {
      format: 'codedeck-prompts',
      version: 1,
      prompts: svc.prompts.list().map((p) => ({ name: p.name, body: p.body, asCommand: p.asCommand })),
    };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return r.filePath;
  });
  handle('prompts:import', async function () {
    const win = BrowserWindow.fromWebContents(this.sender);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    const incoming = parsePromptExport(fs.readFileSync(file, 'utf8'));
    const existing = new Set(svc.prompts.list().map((p) => p.name.toLowerCase()));
    let added = 0;
    for (const p of incoming) {
      // Same name already there: keep the user's version, add the import with a suffix.
      let name = p.name;
      for (let n = 2; existing.has(name.toLowerCase()); n++) name = `${p.name} (${n})`;
      svc.prompts.create({ ...p, name });
      existing.add(name.toLowerCase());
      added++;
    }
    svc.syncPromptCommands();
    wm.broadcast('state:changed', 'prompts');
    return added;
  });

  handle('extensions:list', async (profileId, projectDir) => {
    const p = svc.profiles.get(profileId);
    if (!p) throw new Error(`profile not found: ${profileId}`);
    const dir = projectDir ? knownDir(projectDir) : null;
    const mcp = await listMcp(p.configDir, dir ?? os.homedir());
    return { mcp: mcp.servers, mcpError: mcp.error, skills: listSkills(p.configDir, dir) };
  });
  handle('skills:setEnabled', (profileId, name, enabled) => {
    const p = svc.profiles.get(profileId);
    if (!p) throw new Error(`profile not found: ${profileId}`);
    setSkillEnabled(p.configDir, name, enabled);
  });

  handle('stats:get', (days) => {
    const d = days === 7 || days === 30 ? days : 7;
    const now = Date.now();
    const locale = settings.get().locale;
    return computeStats({
      days: d,
      now,
      tzOffsetMin: new Date().getTimezoneOffset(),
      entries: usage.allEntries(),
      sessions: svc.sessions.list(),
      projects: svc.projects.list(),
      profiles: svc.profiles.list(),
      work: svc.workSpans(now - d * 24 * 3_600_000),
      labels: {
        outside: translate(locale, 'stats.outside'),
        noProject: translate(locale, 'stats.noProject'),
      },
    });
  });

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
    extra.onSettingsChanged(before, next);
    return next;
  });

  handle('profiles:list', () => svc.profiles.list());
  handle('profiles:create', (input) => svc.createProfile(input));
  handle('profiles:update', (id, patch) => svc.updateProfile(id, patch));
  handle('profiles:remove', (id) => svc.removeProfile(id));
  handle('profiles:checkAuth', (id) => svc.checkAuth(id));
  handle('profiles:remoteControl', (id) => svc.remoteControlAvailability(id));

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
  handle('sessions:setRemoteControl', (id, on) => svc.setRemoteControl(id, on === true));

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
