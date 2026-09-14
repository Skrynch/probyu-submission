import { and, eq } from 'drizzle-orm';

import { readConfig } from '../config.js';
import { paperFallScenario } from '../modules/demo/fixtures/paper-fall.js';
import { createDatabase } from './client.js';
import { fixedDemoScenarios } from './schema.js';

const config = readConfig();
const databaseUrl = config.databaseUrl ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';
const { db, pool } = createDatabase(databaseUrl);

try {
  const [existing] = await db
    .select({ contentHash: fixedDemoScenarios.contentHash })
    .from(fixedDemoScenarios)
    .where(
      and(
        eq(fixedDemoScenarios.id, paperFallScenario.id),
        eq(fixedDemoScenarios.version, paperFallScenario.version),
      ),
    )
    .limit(1);

  if (existing !== undefined && existing.contentHash !== paperFallScenario.contentHash) {
    throw new Error('Refusing to overwrite a versioned demo with a different hash.');
  }

  const { contentHash, ...content } = paperFallScenario;
  await db
    .insert(fixedDemoScenarios)
    .values({
      id: paperFallScenario.id,
      version: paperFallScenario.version,
      locale: 'ru-RU',
      ageBand: paperFallScenario.ageBand,
      content,
      contentHash,
      publishedAt: new Date('2026-09-13T00:00:00.000Z'),
    })
    .onConflictDoNothing();
  console.log(`Seed verified: ${paperFallScenario.id}@${String(paperFallScenario.version)}`);
} finally {
  await pool.end();
}
