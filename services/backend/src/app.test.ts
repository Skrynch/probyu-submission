import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { paperFallScenario } from './modules/demo/fixtures/paper-fall.js';
import type { DemoRepository } from './modules/demo/repository.js';

describe('public fixed demo API', () => {
  it('serves health without environment details', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'probyu-api' });
    await app.close();
  });

  it('lists and reads the deterministic scenario', async () => {
    const app = await buildApp();
    const list = await app.inject({ method: 'GET', url: '/v1/demo/scenarios' });
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/demo/scenarios/${paperFallScenario.id}`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(paperFallScenario);
    await app.close();
  });

  it('returns a bounded error for an unknown scenario', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/demo/scenarios/unknown',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'DEMO_SCENARIO_NOT_FOUND',
      message: 'Сценарий демонстрации не найден.',
    });
    await app.close();
  });

  it('rejects an invalid scenario identifier without echoing it', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/demo/scenarios/not_valid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Некорректный идентификатор сценария.',
    });
    await app.close();
  });

  it('does not serialize a repository payload that violates OpenAPI', async () => {
    const malformed = { ...paperFallScenario } as Record<string, unknown>;
    delete malformed.completion;
    const repository: DemoRepository = {
      list: () => Promise.resolve([]),
      getById: () => Promise.resolve(malformed as typeof paperFallScenario),
    };
    const app = await buildApp({ repository });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/demo/scenarios/${paperFallScenario.id}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(paperFallScenario.observation.label);
    await app.close();
  });
});
