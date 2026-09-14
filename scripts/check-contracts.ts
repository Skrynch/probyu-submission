import { readFile } from 'node:fs/promises';

import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';

const openApiPath = 'contracts/openapi/openapi.v1.yaml';
const eventCatalogPath = 'contracts/events/catalog.v1.yaml';
const forbiddenEventFields =
  /(?:child|parent|family)?(?:name|email|phone)|content|answer|question|prompt|credential|token/i;

type EventCatalog = {
  version: number;
  events: Array<{ name: string; owner: string; properties?: Record<string, unknown> }>;
};

await SwaggerParser.validate(openApiPath);

const eventCatalog = YAML.parse(await readFile(eventCatalogPath, 'utf8')) as EventCatalog;

if (eventCatalog.version !== 1 || !Array.isArray(eventCatalog.events)) {
  throw new Error('Event catalog must declare version 1 and an events array.');
}

const names = new Set<string>();
for (const event of eventCatalog.events) {
  if (!/^[a-z][a-z0-9_]*$/.test(event.name)) {
    throw new Error(`Invalid event name: ${event.name}`);
  }
  if (names.has(event.name)) {
    throw new Error(`Duplicate event name: ${event.name}`);
  }
  names.add(event.name);

  for (const propertyName of Object.keys(event.properties ?? {})) {
    if (forbiddenEventFields.test(propertyName)) {
      throw new Error(`Event ${event.name} contains forbidden payload field ${propertyName}.`);
    }
  }
}

console.log(`Validated OpenAPI and ${String(eventCatalog.events.length)} event names.`);
