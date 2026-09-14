import type { FastifyInstance } from 'fastify';

import type { DemoRepository } from './repository.js';
import { responseSchemas } from './contract-schemas.js';

export function registerDemoRoutes(app: FastifyInstance, repository: DemoRepository): void {
  app.get(
    '/v1/demo/scenarios',
    { schema: { response: { 200: responseSchemas.demoScenarioList } } },
    async () => ({ items: await repository.list() }),
  );

  app.get<{ Params: { scenarioId: string } }>(
    '/v1/demo/scenarios/:scenarioId',
    {
      schema: {
        response: {
          200: responseSchemas.demoScenario,
          400: responseSchemas.error,
          404: responseSchemas.error,
        },
      },
    },
    async (request, reply) => {
      if (!/^[a-z0-9-]{1,64}$/.test(request.params.scenarioId)) {
        return reply.code(400).send({
          code: 'INVALID_REQUEST',
          message: 'Некорректный идентификатор сценария.',
        });
      }
      const scenario = await repository.getById(request.params.scenarioId);
      if (scenario === undefined) {
        return reply.code(404).send({
          code: 'DEMO_SCENARIO_NOT_FOUND',
          message: 'Сценарий демонстрации не найден.',
        });
      }
      return scenario;
    },
  );
}
