import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

export const root = path.resolve(__dirname, '..');
export const isWin = process.platform === 'win32';
export const fake = path.join(__dirname, 'fixtures', isWin ? 'fake-claude.cmd' : 'fake-claude.sh');

/** A throwaway home + userData (with spaces and Japanese in the path) for one test file. */
export function makeSandbox(label: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codedeck ${label} テスト `));
  const sb = {
    tmp,
    home: path.join(tmp, 'home'),
    userData: path.join(tmp, 'userData'),
    projectDir: path.join(tmp, 'my project'),
    cleanup() {
      // Not fs.rmSync in this process: on Windows, Node's native recursive delete can abort the
      // whole test worker (0xC0000409) when files are still held by exiting PTY/hook processes.
      // A detached helper deletes the folder once they let go; the OS temp dir catches the rest.
      const child = isWin
        ? // Verbatim: `cmd /s /c "<line>"` keeps the quoted path (spaces, Japanese) intact.
          spawn(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${tmp}""`],
            { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true },
          )
        : spawn('/bin/sh', ['-c', 'sleep 1; rm -rf "$0"', tmp], { detached: true, stdio: 'ignore' });
      child.unref();
    },
  };
  fs.mkdirSync(sb.home, { recursive: true });
  fs.mkdirSync(sb.projectDir, { recursive: true });
  if (!isWin) fs.chmodSync(fake, 0o755);
  return sb;
}

export type Sandbox = ReturnType<typeof makeSandbox>;

/** Registers a fresh sandbox per test (and per retry), so no state leaks between attempts. */
export function useSandbox(label: string): () => Sandbox {
  let sb: Sandbox | null = null;
  test.beforeEach(() => {
    sb = makeSandbox(label);
  });
  // Playwright requires the fixtures argument to be destructured; no fixtures are used here.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(({}, info) => {
    // On failure, show what the app printed (main process output): CI-only crashes need it.
    if (info.status !== info.expectedStatus && appOutput.length) {
      console.log(`--- app output (last ${Math.min(appOutput.length, 60)} lines) ---`);
      console.log(appOutput.slice(-60).join('\n'));
    }
    appOutput.length = 0;
    sb?.cleanup();
  });
  return () => sb!;
}

const appOutput: string[] = [];

export async function launch(sb: Sandbox): Promise<{ app: ElectronApplication; page: Page }> {
  // CODEDECK_E2E_EXECUTABLE runs the same flow against a packaged build.
  const packaged = process.env.CODEDECK_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: packaged, args: [] }
      : { args: [path.join(root, 'out', 'main', 'index.js')] }),
    env: {
      ...process.env,
      CODEDECK_USER_DATA: sb.userData,
      CODEDECK_HOME: sb.home,
      CODEDECK_CLAUDE_PATH: fake,
      // Simulate being started from inside a Claude Code session: must not leak to the child.
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      NO_COLOR: '1',
      // Record notifications without putting real toasts on the desktop; recompute usage often.
      CODEDECK_NO_OS_NOTIFY: '1',
      CODEDECK_USAGE_INTERVAL_MS: '1000',
      CODEDECK_DISCORD_OFFLINE: '1',
      CODEDECK_SSH_PATH: path.join(__dirname, 'fixtures', isWin ? 'fake-ssh.cmd' : 'fake-ssh.sh'),
      CODEDECK_SCHEDULE_INTERVAL_MS: '1000',
      CODEDECK_DISABLE_UPDATES: '1',
    } as Record<string, string>,
  });
  const keep = (prefix: string) => (b: Buffer) =>
    appOutput.push(
      ...b
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => `${prefix} ${l}`),
    );
  app.process().stdout?.on('data', keep('[out]'));
  app.process().stderr?.on('data', keep('[err]'));
  app.process().on('exit', (code, signal) => appOutput.push(`[exit] code=${code} signal=${signal}`));
  // Restored pop-out windows open right after the main one and may come first: pick the main window.
  const isMain = async (w: Page) => {
    await w.waitForLoadState('domcontentloaded');
    return !w.url().includes('popout=');
  };
  let page = await app.firstWindow();
  if (!(await isMain(page))) {
    page = await new Promise<Page>((resolve) => {
      const check = async (w: Page) => (await isMain(w)) && resolve(w);
      app.windows().forEach((w) => void check(w));
      app.on('window', (w) => void check(w));
    });
  }
  return { app, page };
}

/**
 * Text of the terminal in the focused pane (or the only terminal in a pop-out), read from
 * the terminal buffer: with GPU rendering the text is drawn on a canvas, not in the DOM.
 */
export async function focusedTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pane =
      document.querySelector('[data-testid="pane"][data-focused="true"]') ??
      document.querySelector('[data-testid="popout"]');
    return paneText(pane);
    function paneText(el: Element | null): string {
      const id = el
        ?.querySelector('[data-testid^="terminal-"]')
        ?.getAttribute('data-testid')
        ?.slice('terminal-'.length);
      const read = (window as unknown as { __codedeckTerminalText?: (id: string) => string })
        .__codedeckTerminalText;
      return id && read ? read(id) : '';
    }
  });
}

/** Text of the terminal in the n-th pane. */
export async function paneTerminalText(page: Page, index: number): Promise<string> {
  return page.evaluate((i) => {
    const el = document.querySelectorAll('[data-testid="pane"]')[i];
    const id = el
      ?.querySelector('[data-testid^="terminal-"]')
      ?.getAttribute('data-testid')
      ?.slice('terminal-'.length);
    const read = (window as unknown as { __codedeckTerminalText?: (id: string) => string })
      .__codedeckTerminalText;
    return id && read ? read(id) : '';
  }, index);
}

export async function expectTerminal(page: Page, re: RegExp) {
  await expect.poll(() => focusedTerminalText(page), { timeout: 20_000 }).toMatch(re);
}

export async function addProfile(page: Page, name: string, kind: '個人' | 'チーム') {
  await page.getByTestId('add-profile').click();
  await page.getByTestId('profile-name').fill(name);
  await page.getByRole('dialog').getByText(kind, { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function addProject(page: Page, dir: string, name: string, pinLabel: string) {
  await page.getByTestId('add-project').click();
  await page.getByTestId('project-path').fill(dir);
  await page.getByRole('dialog').getByRole('textbox').nth(1).fill(name);
  await page.getByTestId('project-pin').selectOption({ label: pinLabel });
  await page.getByRole('dialog').getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Wait until the focused terminal accepts keys, then type a line. */
export async function typeLine(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid^="terminal-"]')))
    .toBe(true);
  // Focus can land before the PTY has drawn its prompt on a slow runner.
  await page.waitForTimeout(150);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

export function tabStatus(page: Page, index: number) {
  return page.getByTestId('session-tab').nth(index).getByTestId('session-status');
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
