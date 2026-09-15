export * from './family-schema.js';
export * from './research-schema.js';
import { check, integer, jsonb, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const contentSchema = pgSchema('content');

export const fixedDemoScenarios = contentSchema.table(
  'fixed_demo_scenarios',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    locale: text('locale').notNull(),
    ageBand: text('age_band').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: timestamp('published_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    check('fixed_demo_scenarios_version_positive', sql`${table.version} >= 1`),
    check('fixed_demo_scenarios_content_hash_format', sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
);
