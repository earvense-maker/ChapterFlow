import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'set CHAPTERFLOW_SKIP_OPEN=1&& set CHAPTERFLOW_DATA_DIR=.tmp/e2e-data&& set PORT=3002&& set CHAPTERFLOW_API_PORT=3002&& set VITE_DEV_PORT=5174&& npm run dev',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
  },
});
