import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  // CI runners occasionally kill the test worker itself (seen once on windows-latest:
  // 0xC0000409 before a test started). Retry once there; locally failures stay visible.
  retries: process.env.CI ? 1 : 0,
  // On CI, failures also become annotations on the run page (readable without downloading logs).
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' },
});
