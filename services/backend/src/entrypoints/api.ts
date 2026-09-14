import { buildApp } from '../app.js';
import { readConfig } from '../config.js';

const config = readConfig();
const app = await buildApp({
  ...(config.databaseUrl === undefined ? {} : { databaseUrl: config.databaseUrl }),
  logger: true,
});

const stop = async () => {
  await app.close();
  process.exitCode = 0;
};

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
