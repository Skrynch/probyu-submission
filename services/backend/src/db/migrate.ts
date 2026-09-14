import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { readConfig } from '../config.js';
import { createDatabase } from './client.js';

const config = readConfig();
const databaseUrl = config.databaseUrl ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';
const { db, pool } = createDatabase(databaseUrl);

try {
  await migrate(db, { migrationsFolder: 'migrations' });
  console.log('Database migrations applied.');
} finally {
  await pool.end();
}
