/**
 * Phase 4 (§6) UI: Discord setup. The bridge logic (allow-list, /send, approval
 * buttons, confirmations, masking) is covered by tests/unit/discord.test.ts
 * against real sessions; here: the token is stored encrypted and never shown,
 * written in plain text, or logged. Discord itself is never contacted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, useSandbox } from './helpers';

const sandbox = useSandbox('phase4');

const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAw.GfAkE1.this-is-a-test-token-not-real-0123456789';

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? filesUnder(p) : [p];
  });
}

test('Discord setup: token kept in the keychain only; settings validated', async () => {
  const sb = sandbox();
  let { app, page } = await launch(sb);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('open-discord').click();
  const dlg = page.getByTestId('discord-dialog');
  await expect(dlg).toContainText('準備');
  await expect(page.getByTestId('discord-token-state')).toHaveText('未設定');

  await page.getByTestId('discord-guild').fill('123456789012345678');
  await page.getByTestId('discord-channel').fill('223456789012345678');
  await page.getByTestId('discord-allowed').fill('323456789012345678, not-an-id');
  // A user name instead of an ID is pointed out, not silently dropped.
  await expect(page.getByTestId('discord-allowed-invalid')).toContainText('not-an-id');
  await page.getByTestId('discord-token').fill(TOKEN);
  await page.getByTestId('discord-token-save').click();

  await expect(page.getByTestId('discord-token-state')).toContainText('保存済み');
  await expect(page.getByTestId('discord-token')).toHaveValue('');
  // Offline in tests: the connection fails and says so.
  await expect(page.getByTestId('discord-status')).toContainText('接続できませんでした', { timeout: 20_000 });
  // Safe defaults: /new and /stop off.
  await expect(page.getByTestId('discord-perm-newSession')).not.toBeChecked();
  await expect(page.getByTestId('discord-perm-stop')).not.toBeChecked();
  await expect(page.getByTestId('discord-perm-send')).toBeChecked();

  await app.close();
  // The token is nowhere in plain text: not in settings, database, logs or any other file.
  const settings = JSON.parse(fs.readFileSync(path.join(sb.userData, 'settings.json'), 'utf8'));
  expect(settings.discord).toMatchObject({
    enabled: true,
    guildId: '123456789012345678',
    channelId: '223456789012345678',
    allowedUserIds: ['323456789012345678'],
  });
  for (const f of filesUnder(sb.userData)) {
    const content = fs.readFileSync(f);
    expect(content.includes(Buffer.from('this-is-a-test-token')), f).toBe(false);
  }
  expect(fs.existsSync(path.join(sb.userData, 'discord-token.bin'))).toBe(true);

  // After a restart the token is still there (decrypted from the keychain), still not shown.
  ({ app, page } = await launch(sb));
  await page.getByTestId('open-settings').click();
  await page.getByTestId('open-discord').click();
  await expect(page.getByTestId('discord-token-state')).toContainText('保存済み');
  await page.getByText('トークンを削除').click();
  await expect(page.getByTestId('discord-token-state')).toHaveText('未設定');
  // Closing with Esc right after typing still saves the field being edited.
  await page.getByTestId('discord-allowed').fill('323456789012345678, 423456789012345678');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('discord-allowed')).toHaveCount(0);
  await app.close();
  expect(fs.existsSync(path.join(sb.userData, 'discord-token.bin'))).toBe(false);
  expect(
    JSON.parse(fs.readFileSync(path.join(sb.userData, 'settings.json'), 'utf8')).discord.allowedUserIds,
  ).toEqual(['323456789012345678', '423456789012345678']);
});
