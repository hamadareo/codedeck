/**
 * Opt-in check against the real claude CLI (not run in CI: needs claude installed).
 *   REAL_CLAUDE=1 npx playwright test real-claude
 * Uses a throwaway home, so the new profile is not logged in and claude shows
 * its first-run screen. Nothing is sent to the model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { focusedTerminalText } from './helpers';

test.skip(!process.env.REAL_CLAUDE, 'set REAL_CLAUDE=1 to run against the installed claude');

test('real claude renders inside the app with the profile config dir', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck real '));
  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEDECK_USER_DATA: path.join(tmp, 'ud'),
    CODEDECK_HOME: path.join(tmp, 'home'),
  };
  delete env.CODEDECK_CLAUDE_PATH;
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..', 'out', 'main', 'index.js')],
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('add-profile').click();
    await page.getByTestId('profile-name').fill('real-check');
    await page.getByRole('dialog').getByRole('button', { name: '作成', exact: true }).click();
    // First-run screen of a fresh config dir (theme picker), i.e. not the user's own login.
    await expect
      .poll(() => focusedTerminalText(page), { timeout: 30_000 })
      .toMatch(/text style|Let's get started|テーマ/i);
    await expect(page.getByTestId('profile-list').getByText('未ログイン')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.resolve(__dirname, '..', 'test-results', 'real-claude.png') });
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
