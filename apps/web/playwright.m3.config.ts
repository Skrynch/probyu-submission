import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const proxyKey = randomBytes(32).toString('hex');
const dataKey = randomBytes(32).toString('hex');
const runtimeEnv = {
  NODE_ENV: 'test',
  FAMILY_AUTH_MODE: 'synthetic',
  FAMILY_ORIGIN: 'http://127.0.0.1:4178',
  FAMILY_SESSION_KEY: randomBytes(32).toString('base64url'),
  FAMILY_PROXY_KEY: proxyKey,
  FAMILY_DATABASE_URL: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m3_test',
  RESEARCH_MODE: 'fake',
  RESEARCH_DATA_KEY: dataKey,
};

export default defineConfig({
  testDir: './e2e',
  testMatch: 'm3-research.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: '../../test-results/m3-e2e',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    channel: 'chromium',
    trace: 'off',
    launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] },
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'm3-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'm3-mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command:
        'pnpm exec concurrently -k -n m3-api,m3-worker "pnpm --filter @probyu/backend exec tsx src/entrypoints/api.ts" "pnpm --filter @probyu/backend exec tsx src/entrypoints/worker.ts"',
      cwd: '../..',
      url: 'http://127.0.0.1:3108/v1/health',
      reuseExistingServer: false,
      env: { ...runtimeEnv, HOST: '127.0.0.1', PORT: '3108' },
    },
    {
      command: 'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4178 --strictPort',
      url: 'http://127.0.0.1:4178',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { PROBYU_API_ORIGIN: 'http://127.0.0.1:3108', FAMILY_PROXY_KEY: proxyKey },
    },
  ],
});
