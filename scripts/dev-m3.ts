import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadOrCreateLocalDataKey } from './local-data-key.js';

// Keep the final path component slash-free: lstat follows a directory symlink
// when its URL ends in `/`, which would defeat the boundary check below.
const localDataKeyDirectory = new URL('../.local', import.meta.url);

if (process.env.NODE_ENV === 'production') throw new Error('M3 local launcher refuses production.');
const researchDataKey =
  process.env.RESEARCH_DATA_KEY ?? (await loadOrCreateLocalDataKey(localDataKeyDirectory));
const env = {
  ...process.env,
  NODE_ENV: 'development',
  M3_DATABASE_NAME: 'probyu_m3_dev',
  HOST: '127.0.0.1',
  PORT: '3106',
  FAMILY_AUTH_MODE: 'synthetic',
  FAMILY_ORIGIN: 'http://127.0.0.1:5176',
  FAMILY_SESSION_KEY: randomBytes(32).toString('hex'),
  FAMILY_PROXY_KEY: randomBytes(32).toString('hex'),
  FAMILY_DATABASE_URL: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m3_dev',
  RESEARCH_MODE: 'fake',
  RESEARCH_DATA_KEY: researchDataKey,
  PROBYU_API_ORIGIN: 'http://127.0.0.1:3106',
};

function run(args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

if ((await run(['db:m3:prepare'])) !== 0) throw new Error('M3 database preparation failed.');
process.exitCode = await run([
  'exec',
  'concurrently',
  '-k',
  '-n',
  'm3-api,m3-web,m3-worker',
  'pnpm dev:api',
  'pnpm --filter @probyu/web exec vite --host 127.0.0.1 --port 5176 --strictPort',
  'pnpm dev:worker',
]);
