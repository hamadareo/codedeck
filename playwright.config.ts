import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  // CI runners occasionally kill the test worker itself (seen once on windows-latest:
  // 0xC0000409 before a test started). Retry once there; locally failures stay visible.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
