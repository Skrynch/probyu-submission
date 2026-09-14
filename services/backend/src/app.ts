import { FamilyService, type FamilyConfig } from './modules/family/service.js';
import { registerFamilyRoutes } from './modules/family/routes.js';
import helmet from '@fastify/helmet';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

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
  family?: FamilyConfig;
  repository?: DemoRepository;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  if (options.family) {
    const family = new FamilyService(options.family);
    const prune = () =>
      family.pruneExpired().catch(() => app.log.warn('family cleanup unavailable'));
    app.addHook('onReady', async () => {
      await prune();
    });
    const maintenance = setInterval(() => {
      void prune();
    }, 5 * 60_000);
    maintenance.unref();
    app.addHook('onClose', async () => {
      clearInterval(maintenance);
      await family.pool.end();
    });
    registerFamilyRoutes(app, family);
  }
  await app.register(helmet, {
    frameguard: { action: 'deny' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
  });

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
