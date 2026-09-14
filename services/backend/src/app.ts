import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';

import { createDatabase } from './db/client.js';
import { registerDemoRoutes } from './modules/demo/routes.js';
import {
  EmbeddedDemoRepository,
  FallbackDemoRepository,
  PostgresDemoRepository,
  type DemoRepository,
} from './modules/demo/repository.js';
import { responseSchemas } from './modules/demo/contract-schemas.js';

export type BuildAppOptions = {
  databaseUrl?: string;
  repository?: DemoRepository;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(helmet, { contentSecurityPolicy: false });

  let repository = options.repository;
  if (repository === undefined && options.databaseUrl !== undefined) {
    const { db, pool } = createDatabase(options.databaseUrl);
    app.addHook('onClose', async () => pool.end());
    repository = new FallbackDemoRepository(
      new PostgresDemoRepository(db),
      new EmbeddedDemoRepository(),
      () => app.log.warn('demo repository fallback used'),
    );
  }
  repository ??= new EmbeddedDemoRepository();

  app.get('/v1/health', { schema: { response: { 200: responseSchemas.health } } }, () => ({
    status: 'ok',
    service: 'probyu-api',
  }));
  registerDemoRoutes(app, repository);
  return app;
}
