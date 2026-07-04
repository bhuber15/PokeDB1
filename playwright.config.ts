import { defineConfig } from '@playwright/test'

// Smoke tests drive the real app in a browser against a throwaway SQLite
// file seeded by tests/e2e/global-setup.ts. Run with `npm run test:e2e`.
// The server runs with NODE_ENV=test so Next.js loads .env.test and skips
// .env.local (which would otherwise override everything, real DB included).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/e2e/seed.ts && npm run dev -- --port 3100',
    url: 'http://localhost:3100/login',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
})
