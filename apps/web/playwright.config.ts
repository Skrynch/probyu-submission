import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 4173;
const API_PORT = 3100;

// Браузерная приёмка F-01 на production-сборке web и embedded synthetic fixture API.
// Внешняя сеть и реальный AI не нужны; DATABASE_URL не передаётся.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/web-e2e',
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @probyu/backend exec tsx src/entrypoints/api.ts',
      cwd: '../..',
      url: `http://127.0.0.1:${String(API_PORT)}/v1/health`,
      env: { HOST: '127.0.0.1', PORT: String(API_PORT) },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${String(WEB_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
