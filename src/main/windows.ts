import path from 'node:path';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import type { EventChannel, EventContract, WindowContext } from '@shared/ipc';
import type { ThemeMode } from '@shared/types';

const BG = { dark: '#0b0d12', light: '#ffffff' };

/**
 * The main window plus one window per popped-out session (§4). Every window
 * loads the same renderer; `window:context` tells it which role it has.
 */
export class WindowManager {
  main: BrowserWindow | null = null;
  private readonly popouts = new Map<string, BrowserWindow>();
  private quitting = false;

  constructor(private readonly onPopoutsChanged: (ids: string[]) => void) {}

  broadcast<C extends EventChannel>(channel: C, ...args: EventContract[C]): void {
    for (const w of this.all()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }

  all(): BrowserWindow[] {
    return [...(this.main ? [this.main] : []), ...this.popouts.values()];
  }

  contextOf(webContentsId: number): WindowContext {
    for (const [sessionId, w] of this.popouts)
      if (!w.isDestroyed() && w.webContents.id === webContentsId) return { kind: 'popout', sessionId };
    return { kind: 'main' };
  }

  popoutIds(): string[] {
    return [...this.popouts.keys()];
  }

  applyTheme(theme: ThemeMode): void {
    nativeTheme.themeSource = theme;
    const bg = nativeTheme.shouldUseDarkColors ? BG.dark : BG.light;
    for (const w of this.all()) if (!w.isDestroyed()) w.setBackgroundColor(bg);
  }

  createMain(): BrowserWindow {
    const w = this.create({ width: 1400, height: 880, minWidth: 800, minHeight: 500, title: 'CodeDeck' });
    this.main = w;
    w.on('closed', () => {
      this.main = null;
      this.quitting = true;
      for (const p of this.popouts.values()) if (!p.isDestroyed()) p.close();
    });
    return w;
  }

  popout(sessionId: string, title: string): void {
    const existing = this.popouts.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const w = this.create({ width: 960, height: 640, minWidth: 420, minHeight: 280, title }, sessionId);
    this.popouts.set(sessionId, w);
    w.on('closed', () => {
      if (this.popouts.get(sessionId) !== w) return;
      this.popouts.delete(sessionId);
      // Closing the main window closes the pop-outs too; keep them listed so they come back on restart.
      if (!this.quitting) this.onPopoutsChanged(this.popoutIds());
    });
    this.onPopoutsChanged(this.popoutIds());
  }

  dock(sessionId: string): void {
    const w = this.popouts.get(sessionId);
    if (w && !w.isDestroyed()) w.close();
  }

  private create(
    opts: { width: number; height: number; minWidth: number; minHeight: number; title: string },
    popoutSessionId?: string,
  ): BrowserWindow {
    const w = new BrowserWindow({
      ...opts,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    w.once('ready-to-show', () => w.show());
    // Never navigate an app window away; open links in the OS browser.
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    // Keep the window title ours (the renderer's <title> is the same for every window).
    w.on('page-title-updated', (e) => e.preventDefault());
    const query = popoutSessionId ? { popout: popoutSessionId } : undefined;
    if (process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL);
      if (query) url.searchParams.set('popout', query.popout);
      void w.loadURL(url.toString());
    } else {
      void w.loadFile(path.join(__dirname, '../renderer/index.html'), { query });
    }
    return w;
  }
}
