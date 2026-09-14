import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 750,
    max: 5,
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];
