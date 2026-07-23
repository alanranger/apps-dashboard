// @ts-check
import { defineConfig } from '@playwright/test';

const baseURL = process.env.MC_BASE_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
