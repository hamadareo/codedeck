/**
 * Phase 3 (§7): usage from transcripts, thresholds announced exactly once
 * (also across restarts), and "limit reached" detected from the terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addProfile, expectTerminal, launch, makeSandbox, root, tabStatus, typeLine } from './helpers';

const sb = makeSandbox('phase3');
test.afterAll(() => sb.cleanup());

/** Test data: one assistant message using `tokens` output tokens, a minute ago. */
function writeTranscript(profile: string, tokens: number, id: string) {
  const dir = path.join(sb.home, '.codedeck', 'profiles', profile, 'projects', 'C--test');
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    type: 'assistant',
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    requestId: `req_${id}`,
    message: {
      id,
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 0, output_tokens: tokens },
    },
  };
  fs.appendFileSync(path.join(dir, 'usage-test.jsonl'), `${JSON.stringify(line)}\n`);
}

async function thresholdBanners(page: Page) {
  return page.getByTestId('notify-banner').filter({ hasText: '使用量が' }).count();
}

test('threshold alert fires once, survives restarts without repeating; limit message is detected', async () => {
  let { app, page } = await launch(sb);
  await addProfile(page, 'team', 'チーム');
  writeTranscript('team', 750, 'm1');

  // Set a 5-hour limit of 1,000 tokens for the profile in the Usage panel.
  await page.getByTestId('toggle-right-panel').click();
  await page.getByTestId('panel-tab-usage').click();
  await page.getByTestId('usage-panel').locator('summary').first().click();
  await page.getByTestId('usage-limit5h').fill('1000');
  await page.getByTestId('usage-save').click();

  // 750 / 1000 = 75% → the 70% alert, as an in-app banner and in the history.
  await expect(page.getByTestId('notify-banner')).toContainText('team: 5時間の使用量が 70% を超えました', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('profile-usage').first().getByTestId('usage-percent').first()).toContainText(
    '75%',
  );
  await expect(page.getByTestId('usage-panel').getByText('手動で設定')).toBeVisible();

  // Recalculating again and again does not repeat it.
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '再計算' }).click();
  await page.waitForTimeout(2500); // several automatic refreshes (1s interval in tests)
  expect(await thresholdBanners(page)).toBe(1);
  await expect(page.getByTestId('notify-history').locator('li').filter({ hasText: '70%' })).toHaveCount(1);
  await page.screenshot({ path: path.join(root, 'test-results', 'phase3-usage.png') });

  // Restart: same usage, no second alert.
  await app.close();
  ({ app, page } = await launch(sb));
  await expect(page.getByTestId('profile-usage').first().getByTestId('usage-percent').first()).toContainText(
    '75%',
    {
      timeout: 20_000,
    },
  );
  await page.waitForTimeout(2500);
  expect(await thresholdBanners(page)).toBe(0);

  // More usage: 95% → the 90% alert, once.
  writeTranscript('team', 200, 'm2');
  await expect(page.getByTestId('notify-banner').filter({ hasText: '90%' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await page.waitForTimeout(2500);
  expect(await thresholdBanners(page)).toBe(1);

  // "Limit reached" in the terminal: the session shows it, and an alert is sent once.
  await page.getByTestId('session-tab').first().click();
  // The session was just resumed by the restart: wait until claude is ready for keys.
  await expectTerminal(page, /nested=no color=truecolor/);
  await typeLine(page, 'limit');
  await expect(tabStatus(page, 0)).toHaveAttribute('data-status', 'limit', { timeout: 20_000 });
  await expect(tabStatus(page, 0)).toContainText('上限到達');
  await expect(page.getByTestId('notify-banner').filter({ hasText: '上限に達しました' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('profile-usage').first()).toContainText('3pm (Asia/Tokyo)');
  await app.close();
});
