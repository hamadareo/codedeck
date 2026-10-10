/**
 * Resuming a past conversation with claude's own picker (`claude --resume`): the pick
 * is reported by the SessionStart hook, and that conversation is resumed after a restart.
 */
import { expect, test } from '@playwright/test';
import { addProfile, addProject, expectTerminal, launch, tabStatus, typeLine, useSandbox } from './helpers';

const sandbox = useSandbox('resume');
const PICKED = '66666666-7777-4888-8999-aaaaaaaaaaaa';

test('pick a past conversation with claude --resume; it is resumed again after a restart', async () => {
  const sb = sandbox();
  let { app, page } = await launch(sb);
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');

  await page.getByTestId('new-session-my project').click();
  await page.getByTestId('session-resume-picker').click();
  await expect(page.getByTestId('session-resume-picker')).toBeChecked();
  await page.getByTestId('session-start').click();

  // claude's picker, not a fixed id; the pane says a conversation is being chosen.
  await expectTerminal(page, /args=--resume$/m);
  await expectTerminal(page, /FAKE-CLAUDE picker/);
  await expect(page.getByTestId('pane-resume-picker')).toBeVisible();
  await typeLine(page, '2');
  await expectTerminal(page, new RegExp(`resumed ${PICKED}`));
  await expect(tabStatus(page, 1)).toHaveAttribute('data-status', 'waiting', { timeout: 20_000 });
  await expect(page.getByTestId('pane-resume-picker')).toHaveCount(0, { timeout: 20_000 });
  await typeLine(page, 'continue from here');
  await expectTerminal(page, /FAKE-CLAUDE saved/);
  await app.close();

  // After a restart the picked conversation is resumed directly — no picker.
  ({ app, page } = await launch(sb));
  await page.getByTestId('session-tab').nth(1).click();
  await expectTerminal(page, new RegExp(`args=--resume ${PICKED}`));
  await expect(page.getByTestId('pane-resume-picker')).toHaveCount(0);
  await app.close();
});
