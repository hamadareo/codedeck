/**
 * Resuming a past conversation with claude's own picker (`claude --resume`): the pick
 * is reported by the SessionStart hook, and that conversation is resumed after a restart.
 * Also claude's Remote Control: launched with `--remote-control <name>`, switchable per session.
 */
import { expect, test } from '@playwright/test';
import {
  addProfile,
  addProject,
  expectTerminal,
  focusedTerminalText,
  launch,
  tabStatus,
  typeLine,
  useSandbox,
} from './helpers';

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

test('Remote Control: on for a new session, unavailable where the organization turned it off, switchable', async () => {
  const sb = sandbox();
  const { app, page } = await launch(sb);
  await addProfile(page, 'personal', '個人');
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');

  // team: the organization turned Remote Control off → the option is greyed out with the reason.
  await page.getByTestId('new-session-my project').click();
  await expect(page.getByTestId('session-remote-control-hint')).toContainText('組織の設定で');
  await expect(page.getByTestId('session-remote-control')).toBeDisabled();
  // personal: available.
  await page.getByTestId('session-profile').selectOption({ label: 'personal(個人)' });
  await expect(page.getByTestId('session-remote-control')).toBeEnabled();
  await page.getByTestId('session-remote-control').click();
  await expect(page.getByTestId('session-remote-control')).toBeChecked();
  await page.getByTestId('session-start').click();
  // A different profile than the pinned one asks first (§3-5).
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /personal/ })
    .click();

  await expectTerminal(page, /args=--session-id [0-9a-f-]{36} --remote-control my project #1$/m);
  await expect(page.getByTestId('pane-remote-control')).toBeVisible();

  // Off: claude restarts and continues; the new launch has no --remote-control.
  const lastArgs = async () => (await focusedTerminalText(page)).match(/FAKE-CLAUDE args=.*/g)?.at(-1) ?? '';
  await page.getByTestId('pane-remote-control-toggle').click();
  await page.getByRole('dialog').getByRole('button', { name: '再起動する' }).click();
  await expect(page.getByTestId('pane-remote-control')).toHaveCount(0);
  await expect.poll(lastArgs, { timeout: 20_000 }).not.toContain('--remote-control');
  await expect
    .poll(async () => (await focusedTerminalText(page)).match(/FAKE-CLAUDE args=/g)?.length)
    .toBe(2);
  await app.close();
});
