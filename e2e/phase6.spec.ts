/**
 * Phase 6: scheduled prompts, SSH sessions, app settings, and typing latency
 * with 10 sessions producing heavy output at the same time (§4).
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import * as pty from 'node-pty';
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
  const idle = await typingLatency(page, 'i');
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

  const busy = await typingLatency(page, 'b');
  // Control, under the same load: the same CLI in a bare PTY outside CodeDeck. What the OS
  // itself takes to echo a key (on a 2-core CI runner, mostly waiting for a free CPU).
  const bare = await bareEchoLatency(sb.tmp);
  console.log(
    `typing latency: idle median ${idle.median} ms; with 10 busy sessions median ${busy.median} ms, max ${busy.max} ms; bare PTY under the same load median ${bare.median} ms`,
  );
  // "Not noticeable": a generous bound that still catches a blocked UI / IPC flood. On a machine
  // that is itself saturated, CodeDeck may add at most 100 ms to what a bare PTY takes.
  expect(busy.median).toBeLessThan(Math.max(250, bare.median + 100));
  await app.close();
});

/**
 * Key press → its echo is in the focused terminal's buffer, timed inside the window
 * (from the keydown event) so the test driver's own round trips are not counted.
 */
async function typingLatency(page: Page, prefix: string): Promise<{ median: number; max: number }> {
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const mark = `${prefix}${i}`;
    await page.evaluate((m) => {
      const w = window as unknown as {
        __codedeckTerminalText?: (id: string) => string;
        __latency?: Promise<number>;
      };
      const id = document
        .querySelector('[data-testid="pane"][data-focused="true"] [data-testid^="terminal-"]')
        ?.getAttribute('data-testid')
        ?.slice(9);
      w.__latency = new Promise<number>((resolve, reject) => {
        let t0 = 0;
        const onKey = () => {
          if (!t0) t0 = performance.now();
        };
        window.addEventListener('keydown', onKey, true);
        const done = (fn: () => void) => {
          clearInterval(timer);
          clearTimeout(limit);
          window.removeEventListener('keydown', onKey, true);
          fn();
        };
        const timer = setInterval(() => {
          if (t0 && id && w.__codedeckTerminalText?.(id).slice(-4000).includes(m))
            done(() => resolve(performance.now() - t0));
        }, 2);
        const limit = setTimeout(() => done(() => reject(new Error(`no echo of ${m}`))), 5000);
      });
    }, mark);
    await page.keyboard.type(mark);
    samples.push(
      Math.round(await page.evaluate(() => (window as unknown as { __latency: Promise<number> }).__latency)),
    );
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)]!, max: samples.at(-1)! };
}

/** Key → echo through a bare PTY running the fake CLI, timed in the test process. */
async function bareEchoLatency(dir: string): Promise<{ median: number }> {
  const proc = pty.spawn(process.execPath, [path.join(root, 'e2e', 'fixtures', 'fake-claude.mjs')], {
    cols: 120,
    rows: 30,
    cwd: dir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'bare') } as Record<string, string>,
    useConpty: true,
    useConptyDll: process.platform === 'win32',
  });
  let out = '';
  proc.onData((d) => (out += d));
  const waitFor = (text: string, ms = 10_000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (out.includes(text)) resolve();
        else if (Date.now() - t0 > ms) reject(new Error(`bare PTY: no ${text}`));
        else setTimeout(tick, 2);
      };
      tick();
    });
  try {
    await waitFor('> ');
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const mark = `c${i}`;
      const t0 = performance.now();
      proc.write(mark);
      await waitFor(mark);
      samples.push(Math.round(performance.now() - t0));
    }
    samples.sort((a, b) => a - b);
    return { median: samples[Math.floor(samples.length / 2)]! };
  } finally {
    proc.kill();
  }
}
