import { and, eq, sql } from 'drizzle-orm';

import { readConfig } from '../config.js';
import { paperFallScenario } from '../modules/demo/fixtures/paper-fall.js';
import { createDatabase } from './client.js';
import { fixedDemoScenarios } from './schema.js';

const databaseUrl =
  readConfig().databaseUrl ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';
const { db, pool } = createDatabase(databaseUrl);

try {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, contentHash: fixedDemoScenarios.contentHash })
    .from(fixedDemoScenarios)
    .where(
      and(
        eq(fixedDemoScenarios.id, paperFallScenario.id),
        eq(fixedDemoScenarios.version, paperFallScenario.version),
      ),
    )
    .groupBy(fixedDemoScenarios.contentHash);

  if (row?.count !== 1 || row.contentHash !== paperFallScenario.contentHash) {
    throw new Error('Database demo fixture count or hash is invalid.');
  }
  console.log(`Database fixture verified: count=${String(row.count)} hash=${row.contentHash}`);
} finally {
  await pool.end();
}
