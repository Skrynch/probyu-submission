import 'dotenv/config';

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string | undefined;
};

export function readConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: parsePort(process.env.PORT),
    databaseUrl: process.env.DATABASE_URL,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3100;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}
