import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.env.NODE_ENV === 'production') throw new Error('M2 local launcher refuses production.');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  M2_DATABASE_NAME: 'probyu_m2_dev',
  HOST: '127.0.0.1',
  PORT: '3102',
  FAMILY_AUTH_MODE: 'synthetic',
  FAMILY_ORIGIN: 'http://127.0.0.1:5174',
  FAMILY_SESSION_KEY: randomBytes(32).toString('hex'),
  FAMILY_PROXY_KEY: randomBytes(32).toString('hex'),
  FAMILY_DATABASE_URL: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_dev',
  PROBYU_API_ORIGIN: 'http://127.0.0.1:3102',
};
function run(args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
if ((await run(['db:m2:prepare'])) !== 0) throw new Error('M2 database preparation failed.');
process.exitCode = await run([
  'exec',
  'concurrently',
  '-k',
  '-n',
  'm2-api,m2-web',
  'pnpm dev:api',
  'pnpm --filter @probyu/web exec vite --host 127.0.0.1 --port 5174 --strictPort',
]);
