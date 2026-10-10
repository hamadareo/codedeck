import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

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
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {
        // Windows may hold the dir a little longer after the app exits; the OS temp dir is cleaned anyway.
      }
    },
  };
  fs.mkdirSync(sb.home, { recursive: true });
  fs.mkdirSync(sb.projectDir, { recursive: true });
  if (!isWin) fs.chmodSync(fake, 0o755);
  return sb;
}

export async function launch(
  sb: ReturnType<typeof makeSandbox>,
): Promise<{ app: ElectronApplication; page: Page }> {
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
    } as Record<string, string>,
  });
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

/** Text currently rendered by the terminal in the focused pane (or the only terminal in a pop-out). */
export async function focusedTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const pane =
      document.querySelector('[data-testid="pane"][data-focused="true"]') ??
      document.querySelector('[data-testid="popout"]');
    return pane?.querySelector('.xterm-rows')?.textContent ?? '';
  });
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
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

export function tabStatus(page: Page, index: number) {
  return page.getByTestId('session-tab').nth(index).getByTestId('session-status');
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
