import { describe, expect, it } from 'vitest';

import { paperFallScenario } from './fixtures/paper-fall.js';
import { parseDemoScenarioContent } from './contract-schemas.js';

describe('demo runtime contract', () => {
  it('accepts the canonical fixture and rejects malformed or mismatched content', () => {
    const content = { ...paperFallScenario } as Record<string, unknown>;
    delete content.contentHash;

    expect(parseDemoScenarioContent(content, paperFallScenario.contentHash)).toEqual(
      paperFallScenario,
    );

    const malformed = { ...content };
    delete malformed.completion;
    expect(() => parseDemoScenarioContent(malformed, paperFallScenario.contentHash)).toThrow(
      /violates OpenAPI/,
    );

    expect(() => parseDemoScenarioContent(content, '0'.repeat(64))).toThrow(
      /content hash does not match/,
    );
  });
});
