import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';
import { DOCUMENT } from '../modules/family/policy.js';

// Own synthetic database only; never use DATABASE_URL or a user/production database.
const adminUrl =
  process.env.M2_ADMIN_DATABASE_URL ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/postgres';
const url = new URL(adminUrl);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('M2 preparation is loopback-only.');
const name = process.env.M2_DATABASE_NAME ?? 'probyu_m2_test';
if (!/^probyu_m2_(test|dev)$/.test(name)) throw new Error('Unsupported synthetic database.');
const admin = new Pool({ connectionString: adminUrl });
try {
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
    await admin.query(`CREATE DATABASE ${name}`);
} finally {
  await admin.end();
}
url.pathname = `/${name}`;
const { db, pool } = createDatabase(url.toString());
try {
  await migrate(db, { migrationsFolder: 'migrations' });
  await pool.query(
    'INSERT INTO family.consent_documents(version,text_body,history_body,content_hash,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      DOCUMENT.version,
      DOCUMENT.text,
      DOCUMENT.history,
      createHash('sha256').update(JSON.stringify(DOCUMENT)).digest('hex'),
      '2099-01-01',
    ],
  );
  console.log(`Prepared isolated synthetic database ${name}.`);
} finally {
  await pool.end();
}
