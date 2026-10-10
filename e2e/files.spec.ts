/**
 * File explorer (right panel "Files"): the session's folder as a tree, a read-only preview,
 * and "hand to claude" (@path into the terminal), by button or drag and drop. Find in terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { addProfile, addProject, expectTerminal, launch, useSandbox } from './helpers';

const sandbox = useSandbox('files');

test('browse the session folder, preview a file, hand it to claude as @path', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.projectDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sb.projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(sb.projectDir, 'src', 'app.ts'), 'export const greeting = "hello";\n');
  fs.writeFileSync(path.join(sb.projectDir, 'README.md'), '# demo\n');
  const { app, page } = await launch(sb);
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');
  await page.getByTestId('new-session-my project').click();
  await page.getByTestId('session-start').click();
  await expectTerminal(page, /hooks=yes/);

  await page.getByTestId('toggle-right-panel').click();
  await page.getByTestId('panel-tab-files').click();
  const entries = page.getByTestId('files-panel').getByTestId('file-entry');
  // Folders first; .git is not listed.
  await expect(entries).toHaveText([/src/, /README\.md/]);

  await entries.filter({ hasText: 'src' }).click();
  await page.locator('[data-path="src/app.ts"]').click();
  await expect(page.getByTestId('file-preview-text')).toHaveText('export const greeting = "hello";');

  // A file claude creates shows up after a refresh.
  fs.writeFileSync(path.join(sb.projectDir, 'src', 'new.ts'), '');
  await page.getByTestId('files-refresh').click();
  await expect(page.locator('[data-path="src/new.ts"]')).toBeVisible();

  // Filter by name.
  await page.getByTestId('files-filter').fill('new');
  await expect(entries).toHaveText([/src/, /new\.ts/]);
  await page.getByTestId('files-filter').fill('');

  await page.getByTestId('file-mention').click();
  await expectTerminal(page, /@src\/app\.ts/);

  // Drag a file from the panel onto the terminal: "@path" goes in, nothing is sent.
  const terminal = page.locator('[data-testid="pane"][data-focused="true"] [data-testid^="terminal-"]');
  await page.locator('[data-path="README.md"]').dragTo(terminal);
  await expectTerminal(page, /@src\/app\.ts @README\.md/);

  // Find in the terminal (scrollback included): every match counted, Esc back to typing.
  await terminal.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+Shift+F');
  await expect(page.getByTestId('find-input')).toBeFocused();
  await page.getByTestId('find-input').fill('FAKE-CLAUDE');
  await expect(page.getByTestId('find-count')).toHaveText(/^\d+ \/ [4-9]\d*$/);
  await page.getByTestId('find-input').fill('no such text anywhere');
  await expect(page.getByTestId('find-count')).toHaveText('見つかりません');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);
  await app.close();
});
