/**
 * Phase 2 (§4): onboarding speed, split panes, maximize, drag-and-drop, command
 * palette, themes and settings, notes, pop-out windows, and restoring all of it.
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  addProfile,
  addProject,
  expectTerminal,
  focusedTerminalText,
  isWin,
  launch,
  useSandbox,
  root,
  typeLine,
} from './helpers';

const sandbox = useSandbox('phase2');

const mod = isWin ? 'Control+Shift' : 'Meta';
const palette = async (page: Page) => {
  await page.keyboard.press(isWin ? 'Control+Shift+K' : 'Meta+K');
  await expect(page.getByTestId('command-palette')).toBeVisible();
};

/** Drag `source` onto the pane at `paneIndex` with real HTML5 drag events and a shared DataTransfer. */
async function dragAndDrop(page: Page, source: string, paneIndex: number) {
  const src = page.locator(source).first();
  const dst = page.getByTestId('pane').nth(paneIndex);
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent('dragstart', { dataTransfer: dt });
  await dst.dispatchEvent('dragover', { dataTransfer: dt });
  await dst.dispatchEvent('drop', { dataTransfer: dt });
  await src.dispatchEvent('dragend', { dataTransfer: dt });
}

test('first run: add a profile and get a running session in a few steps', async () => {
  const sb = sandbox();
  const { app, page } = await launch(sb);
  const started = Date.now();
  let actions = 0;
  const act = async (fn: () => Promise<void>) => {
    actions++;
    await fn();
  };
  // Everything needed is on screen: the onboarding's primary button leads the way.
  await act(() => page.getByTestId('onboarding').getByRole('button', { name: 'プロファイルを追加' }).click());
  await act(() => page.getByTestId('profile-name').fill('personal'));
  await act(() => page.getByRole('dialog').getByRole('button', { name: '作成', exact: true }).click());
  await expectTerminal(page, /FAKE-CLAUDE cfg=/);
  expect(actions).toBeLessThanOrEqual(3);
  expect(Date.now() - started).toBeLessThan(180_000);
  await app.close();
});

test('panes, palette, theme, notes, pop-out, and restore', async () => {
  const sb = sandbox();
  let { app, page } = await launch(sb);
  await addProfile(page, 'personal', '個人');
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');
  await expect(page.getByTestId('pane')).toHaveCount(1);

  // Split right: the new pane is focused and shows a session that was not on screen.
  await page.getByTestId('pane-split-right').click();
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect(page.getByTestId('pane').nth(1)).toHaveAttribute('data-focused', 'true');
  await expect(page.getByTestId('pane').nth(1)).toContainText('login: personal');
  // A third pane has nothing left to show: it offers the open sessions and "new session".
  await page.getByTestId('pane-split-down').nth(1).click();
  await expect(page.getByTestId('pane')).toHaveCount(3);
  await expect(
    page.locator('[data-testid="pane"][data-focused="true"]').getByTestId('pane-picker'),
  ).toBeVisible();
  await page.getByTestId('pane-close').nth(2).click();
  await expect(page.getByTestId('pane')).toHaveCount(2);
  // A new session opens in the focused pane.
  await page.keyboard.press(`${mod}+T`);
  await page.getByTestId('session-start').click();
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toContainText('my project #1');
  await expectTerminal(page, /hooks=yes/);
  await typeLine(page, 'in the right pane');
  await expectTerminal(page, /FAKE-CLAUDE saved/);
  const panes = page.getByTestId('pane');
  await expect(panes.nth(0).locator('.xterm-rows')).toContainText('FAKE-CLAUDE cfg=');
  await expect(panes.nth(1).locator('.xterm-rows')).toContainText('in the right pane');

  // Maximize the focused pane and restore it.
  await page.keyboard.press(isWin ? 'Control+Shift+Enter' : 'Meta+Shift+Enter');
  await expect(page.getByTestId('pane')).toHaveCount(1);
  await page.getByTestId('pane-maximize').click();
  await expect(page.getByTestId('pane')).toHaveCount(2);

  // Drag the first pane's header onto the second: they swap.
  // (HTML5 drag events are dispatched directly: Playwright's mouse drag does not drive them in Electron.)
  await expect(panes.nth(0)).toContainText('login: team');
  await dragAndDrop(page, '[data-testid="pane"]:nth-child(1) [data-testid="pane-header"]', 1);
  await expect(panes.nth(1).getByTestId('pane-header')).toContainText('login: team');
  await expect(panes.nth(0).getByTestId('pane-header')).toContainText('my project #1');
  // Dragging a tab onto a pane shows that session there.
  await dragAndDrop(page, '[data-testid="session-tab"]:has-text("login: personal")', 0);
  await expect(panes.nth(0).getByTestId('pane-header')).toContainText('login: personal');

  // Command palette from inside a terminal: switch the theme.
  await palette(page);
  await page.getByTestId('palette-input').fill('ダーク');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // ... and jump to a session by name.
  await palette(page);
  await page.getByTestId('palette-input').fill('login: team');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="pane"][data-focused="true"]')).toContainText('login: team');

  // Settings: light theme and a bigger terminal font apply at once.
  await page.getByTestId('open-settings').click();
  // The radio reflects the saved setting, which comes back from main a moment later.
  await page.getByTestId('theme-light').click();
  await expect(page.getByTestId('theme-light')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  await page.getByTestId('terminal-font-size').fill('16');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  await page.screenshot({ path: path.join(root, 'test-results', 'phase2-light.png') });

  // Notes for the focused session's project.
  await page.getByTestId('session-tab').filter({ hasText: 'my project' }).click();
  await page.getByTestId('toggle-right-panel').click();
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await page.getByTestId('notes').fill('メモ: レビューは明日');
  await expect(page.getByTestId('right-panel')).toContainText('保存済み');

  // Pop out the focused session: its own window replays the output and takes input.
  const popoutPromise = app.waitForEvent('window');
  await page.locator('[data-testid="pane"][data-focused="true"]').getByTestId('pane-popout').click();
  const pop = await popoutPromise;
  await expect(pop.getByTestId('popout')).toBeVisible();
  await expect.poll(() => focusedTerminalText(pop), { timeout: 20_000 }).toMatch(/in the right pane/);
  await pop.keyboard.type('from popout');
  await expect.poll(() => focusedTerminalText(pop)).toMatch(/from popout/);
  await expect(page.getByText('別ウィンドウで表示中').first()).toBeVisible();

  // Restart with the pop-out still open: layout, theme, notes and the window come back.
  await app.close();
  ({ app, page } = await launch(sb));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('pane')).toHaveCount(2);
  await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2);
  const restored = app.windows().find((w) => w !== page)!;
  await expect(restored.getByTestId('popout')).toBeVisible();
  await expect(page.getByTestId('right-panel')).toBeVisible();

  // Dock it back: the main window's pane shows the terminal again with its output.
  // The click closes the very window it happens in, so Playwright may report the target as closed.
  await restored
    .getByTestId('dock')
    .click()
    .catch(() => {});
  await expect.poll(() => app.windows().length).toBe(1);
  await page.getByTestId('session-tab').filter({ hasText: 'my project' }).click();
  await expectTerminal(page, /FAKE-CLAUDE cfg=/);
  await expect(page.getByTestId('notes')).toHaveValue('メモ: レビューは明日');
  await app.close();
});
