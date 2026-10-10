/**
 * Phase 5 (§5): task backlog → git diff / commit / AI commit message → prompt
 * library (palette + Claude Code command) → skills / MCP → statistics.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { addProfile, addProject, expectTerminal, isWin, launch, root, typeLine, useSandbox } from './helpers';

const sandbox = useSandbox('phase5');

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' });

const focusedPane = (page: Page) => page.locator('[data-testid="pane"][data-focused="true"]');

test('tasks, diff and commit, prompts, skills / MCP, statistics', async () => {
  const sb = sandbox();
  // The project is a git repository with one commit and pending changes.
  g(sb.projectDir, 'init', '-q', '-b', 'main');
  g(sb.projectDir, 'config', 'user.email', 'e2e@example.com');
  g(sb.projectDir, 'config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(sb.projectDir, 'app.txt'), 'hello\n');
  g(sb.projectDir, 'add', '.');
  g(sb.projectDir, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(sb.projectDir, 'app.txt'), 'hello\nworld\n');

  const { app, page } = await launch(sb);
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');
  await page.getByTestId('new-session-my project').click();
  await page.getByTestId('session-start').click();
  await expectTerminal(page, /hooks=yes/);
  // Branch in the pane header.
  await expect(focusedPane(page).getByTestId('pane-branch')).toHaveText('⎇ main', { timeout: 20_000 });

  // ---------- task backlog ----------
  await page.getByTestId('toggle-right-panel').click();
  await page.getByTestId('panel-tab-tasks').click();
  await page.getByTestId('task-title').fill('Fix the greeting');
  await page.getByTestId('task-add').click();
  await expect(page.getByTestId('task')).toContainText('Fix the greeting');
  await page.getByTestId('task-start').click();
  // A new session opens with the pinned profile and receives the task as its first instruction.
  await expect(page.getByTestId('session-tab')).toHaveCount(3, { timeout: 20_000 });
  await expect(focusedPane(page)).toContainText('Fix the greeting', { timeout: 20_000 });
  await expectTerminal(page, /Fix the greeting/);
  await expectTerminal(page, /FAKE-CLAUDE done/);
  await expect(page.getByTestId('task')).toContainText('進行中');

  // ---------- git: review, ask Claude Code for a message, commit ----------
  await page.getByTestId('panel-tab-diff').click();
  await expect(page.getByTestId('diff-branch')).toHaveText('⎇ main');
  await expect(page.getByTestId('diff-files')).toContainText('app.txt');
  await page.getByTestId('diff-files').getByText('app.txt').click();
  await expect(page.getByTestId('diff-view')).toContainText('+world');
  await page.getByTestId('ask-commit-message').click();
  await expectTerminal(page, /コミットメッセージを1つ提案/);
  await page.getByTestId('commit-message').fill('Add world to the greeting');
  await page.getByTestId('commit').click();
  await page.getByRole('dialog').getByRole('button', { name: 'コミット', exact: true }).click();
  await expect(page.getByTestId('commit-result')).toContainText('Add world to the greeting');
  await expect(page.getByTestId('diff-panel')).toContainText('変更はありません');
  expect(g(sb.projectDir, 'log', '-1', '--format=%s').trim()).toBe('Add world to the greeting');

  // ---------- prompt library ----------
  await page.getByTestId('open-prompts').click();
  await page.getByTestId('prompt-new').click();
  await page.getByTestId('prompt-name').fill('Review');
  await page.getByTestId('prompt-body').fill('Review {{file:app.txt}} on {{branch}}');
  await page.getByTestId('prompt-as-command').check();
  await page.getByTestId('prompt-save').click();
  await expect(page.getByTestId('prompt-list')).toContainText('/review');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  // Written as a Claude Code custom command into the profile: /review inside claude.
  const cmd = path.join(sb.home, '.codedeck', 'profiles', 'team', 'commands', 'codedeck', 'review.md');
  expect(fs.readFileSync(cmd, 'utf8')).toContain('Review $1 on the current git branch');
  // From the palette: fill variables, paste into the session (not sent).
  await page.keyboard.press(isWin ? 'Control+Shift+K' : 'Meta+K');
  await page.getByTestId('palette-input').fill('プロンプト: Review');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('prompt-preview')).toHaveText('Review app.txt on main');
  await page.getByTestId('prompt-paste').click();
  await expectTerminal(page, /Review app\.txt on main/);
  await typeLine(page, '');

  // ---------- skills / MCP ----------
  const skills = path.join(sb.home, '.codedeck', 'profiles', 'team', 'skills', 'review-helper');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(
    path.join(skills, 'SKILL.md'),
    '---\nname: review-helper\ndescription: Helps review\n---\n',
  );
  await page.getByTestId('open-extensions').click();
  await expect(page.getByTestId('mcp-list')).toContainText('fake-docs', { timeout: 30_000 });
  await expect(page.getByTestId('mcp-list')).toContainText('接続済み');
  await expect(page.getByTestId('skill-list')).toContainText('review-helper');
  await page.getByTestId('skill-list').getByRole('checkbox', { name: 'review-helper' }).uncheck();
  await expect(
    page.getByTestId('skill-list').getByRole('checkbox', { name: 'review-helper' }),
  ).not.toBeChecked();
  expect(
    fs.existsSync(path.join(sb.home, '.codedeck', 'profiles', 'team', 'skills-disabled', 'review-helper')),
  ).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();

  // ---------- statistics ----------
  await page.getByTestId('open-stats').click();
  await expect(page.getByTestId('stats-totals')).toBeVisible();
  await expect(page.getByTestId('stats-projects')).toContainText('my project');
  await expect(page.getByTestId('stats-profiles')).toContainText('team');
  await page.screenshot({ path: path.join(root, 'test-results', 'phase5-stats.png') });
  await app.close();
});
