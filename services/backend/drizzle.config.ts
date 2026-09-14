import { defineConfig } from 'drizzle-kit';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
