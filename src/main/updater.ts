import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '@shared/ipc';

const { autoUpdater } = electronUpdater;

const SIX_HOURS = 6 * 3_600_000;

/**
 * A short reason for the Settings screen. 404 means there is no public release to
 * check (no release yet, or the repository is private): say that instead of a stack.
 */
export function describeError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/\b404\b|Not Found/i.test(msg)) return 'update.noRelease';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'update.offline';
  return msg.split('\n')[0]!.slice(0, 200);
}

/**
 * Auto-update from GitHub Releases (§2.5). Only in the packaged app and when
 * enabled in Settings. Downloads in the background; installing waits for the
 * user ("再起動して更新"). Nothing about the user is sent besides the request itself.
 */
export class Updater {
  private status: UpdateState = { state: 'idle' };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly enabled: () => boolean,
    private readonly onState: (s: UpdateState) => void,
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-available', (i) => this.set({ state: 'available', version: i.version }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }));
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'downloaded', version: i.version }));
    autoUpdater.on('error', (e) => this.set({ state: 'error', error: describeError(e) }));
  }

  get(): UpdateState {
    if (!app.isPackaged) return { state: 'disabled', reason: 'dev' };
    // E2E runs of the packaged app must not reach the network.
    if (!this.enabled() || process.env.CODEDECK_DISABLE_UPDATES) return { state: 'disabled', reason: 'off' };
    return this.status;
  }

  private set(s: UpdateState): void {
    this.status = s;
    this.onState(this.get());
  }

  start(): void {
    this.stop();
    if (this.get().state === 'disabled') return this.onState(this.get());
    void this.check();
    this.timer = setInterval(() => void this.check(), SIX_HOURS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<UpdateState> {
    if (this.get().state === 'disabled') return this.get();
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set({ state: 'error', error: describeError(e) });
    }
    return this.get();
  }

  /** Quit and install a downloaded update (user-initiated). */
  installNow(): void {
    if (this.status.state === 'downloaded') autoUpdater.quitAndInstall(false, true);
  }
}
