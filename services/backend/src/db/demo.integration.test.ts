import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';
import { fixedDemoScenarios } from './schema.js';
import { hashCanonicalJson } from '../modules/demo/contract-schemas.js';
import { paperFallScenario } from '../modules/demo/fixtures/paper-fall.js';
import { PostgresDemoRepository } from '../modules/demo/repository.js';

describe('PostgreSQL demo repository', () => {
  it('reads the versioned fixture with the expected hash', async () => {
    const databaseUrl =
      process.env.DATABASE_URL ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';
    const { db, pool } = createDatabase(databaseUrl);
    try {
      const repository = new PostgresDemoRepository(db);
      const scenario = await repository.getById(paperFallScenario.id);
      expect(scenario).toEqual(paperFallScenario);
    } finally {
      await pool.end();
    }
  });

  it('lists and reads only the latest published version for each scenario id', async () => {
    const databaseUrl =
      process.env.DATABASE_URL ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';
    const { db, pool } = createDatabase(databaseUrl);
    const scenarioId = `version-test-${String(Date.now())}`;
    const makeContent = (version: number) => {
      const content = { ...paperFallScenario, id: scenarioId, version } as Record<string, unknown>;
      delete content.contentHash;
      return content;
    };
    const version1 = makeContent(1);
    const version2 = makeContent(2);
    const futureVersion = makeContent(3);

    try {
      await db.insert(fixedDemoScenarios).values([
        {
          id: scenarioId,
          version: 1,
          locale: 'ru-RU',
          ageBand: paperFallScenario.ageBand,
          content: version1,
          contentHash: hashCanonicalJson(version1),
          publishedAt: new Date('2026-09-13T00:00:00.000Z'),
        },
        {
          id: scenarioId,
          version: 2,
          locale: 'ru-RU',
          ageBand: paperFallScenario.ageBand,
          content: version2,
          contentHash: hashCanonicalJson(version2),
          publishedAt: new Date('2026-09-14T00:00:00.000Z'),
        },
        {
          id: scenarioId,
          version: 3,
          locale: 'ru-RU',
          ageBand: paperFallScenario.ageBand,
          content: futureVersion,
          contentHash: hashCanonicalJson(futureVersion),
          publishedAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      ]);

      const repository = new PostgresDemoRepository(db);
      const summaries = (await repository.list()).filter((item) => item.id === scenarioId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.version).toBe(2);
      expect((await repository.getById(scenarioId))?.version).toBe(2);
    } finally {
      await db.delete(fixedDemoScenarios).where(eq(fixedDemoScenarios.id, scenarioId));
      await pool.end();
    }
  });
});
