/**
 * Phase 6: scheduled prompts, SSH sessions, app settings, and typing latency
 * with 10 sessions producing heavy output at the same time (§4).
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addProfile, addProject, expectTerminal, launch, root, useSandbox } from './helpers';

const sandbox = useSandbox('phase6');
const focusedPane = (page: Page) => page.locator('[data-testid="pane"][data-focused="true"]');

test('schedules, SSH sessions, app settings', async () => {
  const sb = sandbox();
  const { app, page } = await launch(sb);
  await addProfile(page, 'team', 'チーム');
  await addProject(page, sb.projectDir, 'my project', 'team(チーム)');

  // ---------- scheduled prompt: create, then "run now" ----------
  await page.getByTestId('open-schedules').click();
  await expect(page.getByTestId('schedules')).toContainText('CodeDeck が起動している間だけ実行されます');
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-name').fill('morning check');
  await page.getByTestId('schedule-kind').selectOption('weekdays');
  await page.getByTestId('schedule-time').fill('09:00');
  await page.getByTestId('schedule-project').selectOption({ label: 'my project' });
  await page.getByTestId('schedule-prompt').fill('check the build');
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('schedule-list')).toContainText('平日 09:00');
  await expect(page.getByTestId('schedule-list')).toContainText('次回:');
  // Enabled schedules + no tray residency → the dialog offers it.
  await expect(page.getByTestId('schedule-tray-hint')).toBeVisible();
  await page.getByTestId('schedule-run-now').click();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  // A session for the schedule opens with the profile and receives the prompt.
  await expect(page.getByTestId('session-tab').filter({ hasText: '⏰ morning check' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId('session-tab').filter({ hasText: '⏰ morning check' }).click();
  await expectTerminal(page, /check the build/);
  await expectTerminal(page, /FAKE-CLAUDE done/);
  await expect(
    page.getByTestId('notify-banner').filter({ hasText: 'スケジュールを実行しました' }),
  ).toBeVisible();

  // ---------- SSH host and session ----------
  await page.getByTestId('new-session').click();
  await page.getByRole('dialog').getByRole('button', { name: '接続先…' }).click();
  await page.getByTestId('ssh-new').click();
  await page.getByTestId('ssh-name').fill('build box');
  await page.getByTestId('ssh-destination').fill('me@build.example');
  await page.getByTestId('ssh-remote-dir').fill('~/work/app');
  await page.getByTestId('ssh-save').click();
  await expect(page.getByTestId('ssh-list')).toContainText('me@build.example');
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByTestId('new-session').click();
  await page.getByTestId('session-where').selectOption({ label: 'SSH: build box (me@build.example)' });
  await page.getByTestId('session-start').click();
  await expectTerminal(page, /FAKE-SSH args=/);
  await expectTerminal(page, /"me@build\.example"/);
  await expectTerminal(page, /cd ~\/'work\/app' && claude --session-id [0-9a-f-]{36}/);
  await expect(focusedPane(page).getByTestId('pane-ssh')).toBeVisible();

  // ---------- app settings ----------
  await page.getByTestId('open-settings').click();
  // Development build: not checked; packaged build under test: switched off (no network in tests).
  await expect(page.getByTestId('app-settings')).toContainText(
    /開発版では更新を確認しません|更新の確認はオフです/,
  );
  // The checkbox shows the saved setting, which comes back from main a moment later.
  await page.getByTestId('stay-in-tray').click();
  await expect(page.getByTestId('stay-in-tray')).toBeChecked();
  await page.screenshot({ path: path.join(root, 'test-results', 'phase6-settings.png') });
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await app.close();
});

test('typing stays responsive with 10 busy sessions (§4)', async () => {
  const sb = sandbox();
  const { app, page } = await launch(sb);
  await addProfile(page, 'p', '個人');
  await expectTerminal(page, /hooks=yes/);
  // Nine more sessions, started in the background, each printing heavy output.
  const ids = await page.evaluate(async () => {
    const api = (window as unknown as { codedeck: { invoke(c: string, ...a: unknown[]): Promise<unknown> } })
      .codedeck;
    const profiles = (await api.invoke('profiles:list')) as { id: string }[];
    const out: string[] = [];
    for (let i = 0; i < 9; i++) {
      const s = (await api.invoke('sessions:create', {
        profileId: profiles[0]!.id,
        cwd: '.',
        title: `busy ${i}`,
      })) as {
        id: string;
      };
      await api.invoke('pty:start', s.id, 120, 30);
      out.push(s.id);
    }
    return out;
  });
  await page.waitForTimeout(2000);
  await page.evaluate((list) => {
    const api = (window as unknown as { codedeck: { send(c: string, ...a: unknown[]): void } }).codedeck;
    for (const id of list) api.send('pty:input', id, 'spam\r');
  }, ids);
  await page.waitForTimeout(1000);

  // Measure: key press → its echo is in the terminal buffer.
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const mark = `k${i}`;
    const t0 = Date.now();
    await page.keyboard.type(mark);
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() => {
              const pane = document.querySelector('[data-testid="pane"][data-focused="true"]');
              const id = pane
                ?.querySelector('[data-testid^="terminal-"]')
                ?.getAttribute('data-testid')
                ?.slice(9);
              const read = (window as unknown as { __codedeckTerminalText?: (id: string) => string })
                .__codedeckTerminalText;
              return id && read ? read(id).slice(-4000) : '';
            })
          ).includes(mark),
        { intervals: [5], timeout: 5000 },
      )
      .toBe(true);
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  console.log(`typing latency with 10 busy sessions: median ${median} ms, max ${samples.at(-1)} ms`);
  // "Not noticeable": a generous bound that still catches a blocked UI / IPC flood.
  expect(median).toBeLessThan(250);
  await app.close();
});
