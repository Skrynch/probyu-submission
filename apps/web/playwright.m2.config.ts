import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
const proxyKey = randomBytes(32).toString('hex');
export default defineConfig({
  testDir: './e2e',
  testMatch: 'm2-family.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: '../../test-results/m2-e2e',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'chromium',
    trace: 'off',
    launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] },
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'm2-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'm2-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @probyu/backend exec tsx src/entrypoints/api.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:3104/v1/health',
      reuseExistingServer: false,
      env: {
        HOST: '127.0.0.1',
        PORT: '3104',
        NODE_ENV: 'test',
        FAMILY_AUTH_MODE: 'synthetic',
        FAMILY_ORIGIN: 'http://127.0.0.1:4174',
        FAMILY_SESSION_KEY: randomBytes(32).toString('base64url'),
        FAMILY_PROXY_KEY: proxyKey,
        FAMILY_DATABASE_URL: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_test',
      },
    },
    {
      command: 'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PROBYU_API_ORIGIN: 'http://127.0.0.1:3104', FAMILY_PROXY_KEY: proxyKey },
    },
  ],
});
