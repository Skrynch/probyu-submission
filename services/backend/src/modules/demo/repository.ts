import { and, desc, eq, lte } from 'drizzle-orm';
import type { DemoScenario } from '@probyu/contracts/types';

import type { Database } from '../../db/client.js';
import { fixedDemoScenarios } from '../../db/schema.js';
import { parseDemoScenarioContent } from './contract-schemas.js';
import { paperFallScenario } from './fixtures/paper-fall.js';

export type DemoScenarioSummary = Pick<
  DemoScenario,
  'id' | 'version' | 'kind' | 'title' | 'question' | 'ageBand' | 'durationMinutes' | 'contentHash'
>;

export interface DemoRepository {
  list(): Promise<DemoScenarioSummary[]>;
  getById(id: string): Promise<DemoScenario | undefined>;
}

function summarize(scenario: DemoScenario): DemoScenarioSummary {
  const { id, version, kind, title, question, ageBand, durationMinutes, contentHash } = scenario;
  return {
    id,
    version,
    kind,
    title,
    question,
    ageBand,
    durationMinutes,
    contentHash,
  };
}

export class EmbeddedDemoRepository implements DemoRepository {
  list(): Promise<DemoScenarioSummary[]> {
    return Promise.resolve([summarize(paperFallScenario)]);
  }

  getById(id: string): Promise<DemoScenario | undefined> {
    return Promise.resolve(id === paperFallScenario.id ? paperFallScenario : undefined);
  }
}

export class PostgresDemoRepository implements DemoRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<DemoScenarioSummary[]> {
    const rows = await this.db
      .selectDistinctOn([fixedDemoScenarios.id])
      .from(fixedDemoScenarios)
      .where(lte(fixedDemoScenarios.publishedAt, new Date()))
      .orderBy(fixedDemoScenarios.id, desc(fixedDemoScenarios.version))
      .limit(10);
    return rows.map((row) => summarize(parseRow(row)));
  }

  async getById(id: string): Promise<DemoScenario | undefined> {
    const [row] = await this.db
      .select()
      .from(fixedDemoScenarios)
      .where(and(eq(fixedDemoScenarios.id, id), lte(fixedDemoScenarios.publishedAt, new Date())))
      .orderBy(desc(fixedDemoScenarios.version))
      .limit(1);
    return row === undefined ? undefined : parseRow(row);
  }
}

export class FallbackDemoRepository implements DemoRepository {
  constructor(
    private readonly primary: DemoRepository,
    private readonly fallback: DemoRepository,
    private readonly onFallback: (error: unknown) => void,
  ) {}

  async list(): Promise<DemoScenarioSummary[]> {
    try {
      return await this.primary.list();
    } catch (error) {
      this.onFallback(error);
      return this.fallback.list();
    }
  }

  async getById(id: string): Promise<DemoScenario | undefined> {
    try {
      return await this.primary.getById(id);
    } catch (error) {
      this.onFallback(error);
      return this.fallback.getById(id);
    }
  }
}

function parseRow(row: typeof fixedDemoScenarios.$inferSelect): DemoScenario {
  const parsed = parseDemoScenarioContent(row.content, row.contentHash);
  if (parsed.id !== row.id || parsed.version !== row.version || parsed.ageBand !== row.ageBand) {
    throw new Error('Demo scenario columns do not match its payload.');
  }
  return parsed;
}
