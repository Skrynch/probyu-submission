import { createHash } from 'node:crypto';
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
import type { DemoScenario } from '@probyu/contracts/types';

const componentSchemas = {
  DemoCompletion: DemoCompletionSchema,
  DemoObservation: DemoObservationSchema,
  DemoProbe: DemoProbeSchema,
  DemoReflection: DemoReflectionSchema,
  DemoResultOption: DemoResultOptionSchema,
  DemoScenarioSummary: DemoScenarioSummarySchema,
} as const;

export const responseSchemas = {
  health: HealthResponseSchema,
  error: ErrorResponseSchema,
  demoScenarioList: dereferenceSchema(DemoScenarioListSchema),
  demoScenario: dereferenceSchema(DemoScenarioSchema),
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateDemoScenario = ajv.compile(responseSchemas.demoScenario as AnySchema);

export function parseDemoScenarioContent(content: unknown, contentHash: string): DemoScenario {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Demo scenario content must be an object.');
  }

  const scenario = { ...(content as Record<string, unknown>), contentHash };
  if (!validateDemoScenario(scenario)) {
    throw new Error(
      `Demo scenario violates OpenAPI: ${ajv.errorsText(validateDemoScenario.errors)}`,
    );
  }

  if (hashCanonicalJson(content) !== contentHash) {
    throw new Error('Demo scenario content hash does not match its payload.');
  }

  return scenario as DemoScenario;
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function dereferenceSchema<T>(value: T): T {
  return dereferenceValue(value) as T;
}

function dereferenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dereferenceValue(item));
  }
  if (value === null || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const reference = record.$ref;
  if (typeof reference === 'string') {
    const name = reference.replace('#/components/schemas/', '');
    const component = componentSchemas[name as keyof typeof componentSchemas];
    if (component === undefined) throw new Error(`Unknown OpenAPI component: ${name}`);
    return dereferenceValue(component);
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, dereferenceValue(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
