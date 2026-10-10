/**
 * Phase 1 completion flow with a fake claude:
 * two profiles → two sessions running at once in separate tabs, each with its
 * own CLAUDE_CONFIG_DIR, no switching → restart → both restored and resumed.
 * Phase 2: the status shown for each session follows claude's hooks.
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addProfile,
  addProject,
  esc,
  expectTerminal,
  launch,
  useSandbox,
  root,
  tabStatus,
  typeLine,
} from './helpers';

const sandbox = useSandbox('e2e');

test('two accounts side by side without switching, restored after restart', async () => {
  const sb = sandbox();
  let { app, page } = await launch(sb);
  await expect(page.getByTestId('onboarding')).toBeVisible();

  // Profiles: each opens a login session in its own config dir.
  await addProfile(page, 'personal', '個人');
  const personalDir = path.join(sb.home, '.codedeck', 'profiles', 'personal');
  await expectTerminal(page, new RegExp(`cfg=${esc(personalDir)}`));
  await expectTerminal(page, /nested=no color=truecolor/);
  await expectTerminal(page, /hooks=yes/);
  await addProfile(page, 'team', 'チーム');
  const teamDir = path.join(sb.home, '.codedeck', 'profiles', 'team');
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  // Login detection via `claude auth status` (fake reports logged in).
  await expect(page.getByTestId('profile-list').getByText('接続済み')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByText('team@example.com')).toBeVisible();

  // Project pinned to team.
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');

  // New session in the project starts with the pinned profile, no switching.
  await page.getByTestId('new-session-my project').click();
  await expect(page.getByTestId('session-profile')).toHaveValue(/.+/);
  await page.getByTestId('session-start').click();
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  await expectTerminal(page, /args=--session-id [0-9a-f-]{36}/);
  // SessionStart hook → waiting for input.
  await expect(tabStatus(page, 2)).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });
  await typeLine(page, 'hello');
  await expectTerminal(page, /FAKE-CLAUDE saved/);
  // UserPromptSubmit → working; Stop → done; on screen, so it is seen at once → waiting.
  await expect(tabStatus(page, 2)).toHaveAttribute('data-status', 'working', { timeout: 20_000 });
  await expect(tabStatus(page, 2)).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });

  // A different profile in the same project requires confirmation (§3-5).
  await page.getByTestId('new-session-my project').click();
  await page.getByTestId('session-profile').selectOption({ label: 'personal(個人)' });
  await page.getByTestId('session-start').click();
  await expect(page.getByRole('dialog', { name: 'ピン留めと違うプロファイルで開始しますか?' })).toBeVisible();
  await page.getByRole('button', { name: '「personal」で開始する' }).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(personalDir)}`));

  // A turn that finishes while the session is not on screen stays "done" until it is viewed.
  await typeLine(page, 'background job');
  await page.getByTestId('session-tab').nth(2).click();
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(tabStatus(page, 3)).toContainText('完了');
  await page.getByTestId('session-tab').nth(3).click();
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });

  // Approval: Notification(permission_prompt) → needs approval; answering → working.
  await typeLine(page, 'perm');
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'approval', { timeout: 20_000 });
  await expect(tabStatus(page, 3)).toContainText('承認待ち');
  await page.keyboard.type('y');
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'working');
  await page.keyboard.press('Enter');
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });
  await typeLine(page, 'fail');
  await expect(tabStatus(page, 3)).toHaveAttribute('data-status', 'error', { timeout: 20_000 });

  // All four sessions run at the same time, each tab badged with its profile.
  await expect(page.getByTestId('session-tab')).toHaveCount(4);
  await expect(page.getByTestId('session-tab').nth(2).getByTestId('profile-badge')).toHaveText('team');
  await expect(page.getByTestId('session-tab').nth(3).getByTestId('profile-badge')).toHaveText('personal');
  for (let i = 0; i < 4; i++)
    await expect(tabStatus(page, i)).not.toHaveAttribute('data-status', /idle|exited/);
  await page.screenshot({ path: path.join(root, 'test-results', 'phase1-main.png') });

  // Restart: tabs come back; the used session resumes, the unused one starts fresh under its id.
  await app.close();
  ({ app, page } = await launch(sb));
  await expect(page.getByTestId('session-tab')).toHaveCount(4);
  await page.getByTestId('session-tab').nth(2).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  await expectTerminal(page, /args=--resume [0-9a-f-]{36}/);
  await page.getByTestId('session-tab').nth(1).click();
  await expectTerminal(page, new RegExp(`cfg=${esc(teamDir)}`));
  await expectTerminal(page, /args=--session-id [0-9a-f-]{36}/);

  // Closing a tab moves it to history.
  await page.getByTestId('session-tab').nth(3).getByRole('button').click();
  await expect(page.getByTestId('session-tab')).toHaveCount(3);
  await app.close();
});
