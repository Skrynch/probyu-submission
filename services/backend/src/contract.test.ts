import Ajv, { type AnySchema } from 'ajv';
import {
  DemoCompletionSchema,
  DemoObservationSchema,
  DemoProbeSchema,
  DemoReflectionSchema,
  DemoResultOptionSchema,
  DemoScenarioListSchema,
  DemoScenarioSchema,
  DemoScenarioSummarySchema,
  ErrorResponseSchema,
  HealthResponseSchema,
} from '@probyu/contracts/schemas';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const components = {
  DemoCompletion: DemoCompletionSchema,
  DemoObservation: DemoObservationSchema,
  DemoProbe: DemoProbeSchema,
  DemoReflection: DemoReflectionSchema,
  DemoResultOption: DemoResultOptionSchema,
  DemoScenarioSummary: DemoScenarioSummarySchema,
};

for (const [name, schema] of Object.entries(components)) {
  ajv.addSchema(schema, name);
}

const scenarioSchema = rewriteComponentRefs(DemoScenarioSchema);
const listSchema = rewriteComponentRefs(DemoScenarioListSchema);

describe('generated OpenAPI schemas match Fastify responses', () => {
  it('validates health, list, detail and bounded 404', async () => {
    const app = await buildApp();
    const cases = [
      ['/v1/health', 200, HealthResponseSchema],
      ['/v1/demo/scenarios', 200, listSchema],
      ['/v1/demo/scenarios/paper-fall', 200, scenarioSchema],
      ['/v1/demo/scenarios/not_valid', 400, ErrorResponseSchema],
      ['/v1/demo/scenarios/unknown', 404, ErrorResponseSchema],
    ] as const;

    for (const [url, statusCode, schema] of cases) {
      const response = await app.inject({ method: 'GET', url });
      const validate = ajv.compile(schema as AnySchema);
      const payload: unknown = response.json();
      expect(response.statusCode).toBe(statusCode);
      expect(validate(payload), `${url}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
    await app.close();
  });
});

function rewriteComponentRefs<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', '')) as T;
}
