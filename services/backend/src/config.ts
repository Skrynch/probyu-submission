import type { FamilyConfig } from './modules/family/service.js';
import type { ResearchConfig } from './modules/research/service.js';
import 'dotenv/config';

export type AppConfig = {
  family?: FamilyConfig;
  host: string;
  port: number;
  databaseUrl: string | undefined;
  research?: ResearchConfig;
};

export function readConfig(): AppConfig {
  const family = readFamilyConfig();
  const research = readResearchConfig(family);
  return {
    ...(family ? { family } : {}),
    ...(research ? { research } : {}),
    host: process.env.HOST ?? '127.0.0.1',
    port: parsePort(process.env.PORT),
    databaseUrl: process.env.DATABASE_URL,
  };
}

function readResearchConfig(family: FamilyConfig | undefined): ResearchConfig | undefined {
  if (!process.env.RESEARCH_MODE || process.env.RESEARCH_MODE === 'disabled') return undefined;
  if (!family) throw new Error('Research requires the family access boundary.');
  const environment = process.env.NODE_ENV;
  const dataKey = process.env.RESEARCH_DATA_KEY;
  if (
    process.env.RESEARCH_MODE !== 'fake' ||
    (environment !== 'development' && environment !== 'test') ||
    !dataKey
  )
    throw new Error('Only explicit synthetic fake research is configured.');
  return { mode: 'fake', environment, dataKey };
}

export function readResearchWorkerConfig() {
  const environment = process.env.NODE_ENV;
  const databaseUrl = process.env.FAMILY_DATABASE_URL;
  const dataKey = process.env.RESEARCH_DATA_KEY;
  if (
    process.env.RESEARCH_MODE !== 'fake' ||
    (environment !== 'development' && environment !== 'test') ||
    !databaseUrl ||
    !dataKey
  )
    throw new Error('Explicit synthetic research worker configuration is required.');
  return { databaseUrl, dataKey };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3100;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function readFamilyConfig(): FamilyConfig | undefined {
  if (!process.env.FAMILY_AUTH_MODE || process.env.FAMILY_AUTH_MODE === 'disabled')
    return undefined;
  const environment = process.env.NODE_ENV;
  if (
    process.env.FAMILY_AUTH_MODE !== 'synthetic' ||
    (environment !== 'development' && environment !== 'test')
  )
    throw new Error('Live family auth is not configured; synthetic requires development/test.');
  const origin = process.env.FAMILY_ORIGIN;
  const key = process.env.FAMILY_SESSION_KEY;
  const databaseUrl = process.env.FAMILY_DATABASE_URL;
  if (!origin || !key || !databaseUrl)
    throw new Error('Explicit synthetic family configuration is required.');
  return {
    mode: 'synthetic',
    environment,
    origin,
    key,
    databaseUrl,
    ...(process.env.FAMILY_PROXY_KEY !== undefined
      ? { proxyKey: process.env.FAMILY_PROXY_KEY }
      : {}),
  };
}
