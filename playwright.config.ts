import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    viewport: { width: 1380, height: 920 },
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }]],
  webServer: {
    command: 'pnpm exec tsx scripts/serve-test.ts',
    url: 'http://127.0.0.1:3100/healthz',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    timeout: 60000,
  },
  outputDir: 'test-results',
});
