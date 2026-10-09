/**
 * Phase 1 completion flow with a fake claude:
 * two profiles → two sessions running at once in separate tabs, each with its
 * own CLAUDE_CONFIG_DIR, no switching → restart → both restored and resumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const fake = path.join(__dirname, 'fixtures', isWin ? 'fake-claude.cmd' : 'fake-claude.sh');

let tmp: string;
let home: string;
let userData: string;
let projectDir: string;

test.beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck e2e テスト '));
  home = path.join(tmp, 'home');
  userData = path.join(tmp, 'userData');
  projectDir = path.join(tmp, 'my project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  if (!isWin) fs.chmodSync(fake, 0o755);
});

let current: ElectronApplication | null = null;

test.afterAll(async () => {
  await current?.close().catch(() => {});
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // Windows may hold the dir a little longer after the app exits; the OS temp dir is cleaned anyway.
  }
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // CODEDECK_E2E_EXECUTABLE runs the same flow against a packaged build.
  const packaged = process.env.CODEDECK_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: packaged, args: [] }
      : { args: [path.join(root, 'out', 'main', 'index.js')] }),
    env: {
      ...process.env,
      CODEDECK_USER_DATA: userData,
      CODEDECK_HOME: home,
      CODEDECK_CLAUDE_PATH: fake,
      // Simulate being started from inside a Claude Code session: must not leak to the child.
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      NO_COLOR: '1',
    },
  });
  current = app;
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Text currently rendered by the visible terminal. */
async function activeTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panes = [...document.querySelectorAll<HTMLElement>('[data-testid^="terminal-"]')];
    const visible = panes.find((p) => getComputedStyle(p.parentElement!).visibility === 'visible');
    return visible?.querySelector('.xterm-rows')?.textContent ?? '';
  });
}

async function expectTerminal(page: Page, re: RegExp) {
  await expect.poll(() => activeTerminalText(page), { timeout: 20_000 }).toMatch(re);
}

async function addProfile(page: Page, name: string, kind: '個人' | 'チーム') {
  await page.getByTestId('add-profile').click();
  await page.getByTestId('profile-name').fill(name);
  await page.getByRole('dialog').getByText(kind, { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('two accounts side by side without switching, restored after restart', async () => {
  let { app, page } = await launch();
  await expect(page.getByTestId('onboarding')).toBeVisible();

  // Profiles: each opens a login session in its own config dir.
  await addProfile(page, 'personal', '個人');
  const personalDir = path.join(home, '.codedeck', 'profiles', 'personal');
  await expectTerminal(page, new RegExp(`cfg=${esc(personalDir)}`));
  await expectTerminal(page, /nested=no color=truecolor/);
  await addProfile(page, 'team', 'チーム');
  const teamDir = path.join(home, '.codedeck', 'profiles', 'team');
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  // Login detection via `claude auth status` (fake reports logged in).
  await expect(page.getByTestId('profile-list').getByText('接続済み')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText('team@example.com')).toBeVisible();

  // Project pinned to team.
  await page.getByTestId('add-project').click();
  await page.getByTestId('project-path').fill(projectDir);
  await page.getByRole('dialog').getByRole('textbox').nth(1).fill('my project');
  await page.getByTestId('project-pin').selectOption({ label: 'team(チーム)' });
  await page.getByRole('dialog').getByRole('button', { name: '追加', exact: true }).click();

  // New session in the project starts with the pinned profile, no switching.
  await page.getByTestId('new-session-my project').click();
  await expect(page.getByTestId('session-profile')).toHaveValue(/.+/);
  await page.getByTestId('session-start').click();
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  await expectTerminal(page, /args=--session-id [0-9a-f-]{36}/);
  // The new terminal takes keyboard focus by itself.
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid^="terminal-"]')))
    .toBe(true);
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expectTerminal(page, /FAKE-CLAUDE saved/);

  // A different profile in the same project requires confirmation (§3-5).
  await page.getByTestId('new-session-my project').click();
  await page.getByTestId('session-profile').selectOption({ label: 'personal(個人)' });
  await page.getByTestId('session-start').click();
  await expect(page.getByRole('dialog', { name: 'ピン留めと違うプロファイルで開始しますか?' })).toBeVisible();
  await page.getByRole('button', { name: '「personal」で開始する' }).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(personalDir)}`));

  // All four sessions run at the same time, each tab badged with its profile.
  await expect(page.getByTestId('session-tab')).toHaveCount(4);
  await expect(page.getByTestId('session-tab').filter({ hasText: '実行中' })).toHaveCount(4);
  await expect(page.getByTestId('session-tab').nth(2).getByTestId('profile-badge')).toHaveText('team');
  await expect(page.getByTestId('session-tab').nth(3).getByTestId('profile-badge')).toHaveText('personal');
  await page.screenshot({ path: path.join(root, 'test-results', 'phase1-main.png') });

  // Restart: tabs come back; the used session resumes, the unused one starts fresh under its id.
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByTestId('session-tab')).toHaveCount(4);
  await page.getByTestId('session-tab').nth(2).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  await expectTerminal(page, /args=--resume [0-9a-f-]{36}/);
  await page.getByTestId('session-tab').nth(3).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(personalDir)}`));
  await expectTerminal(page, /args=--session-id [0-9a-f-]{36}/);

  // Closing a tab moves it to history.
  await page.getByTestId('session-tab').nth(3).getByRole('button').click();
  await expect(page.getByTestId('session-tab')).toHaveCount(3);
  await app.close();
});
