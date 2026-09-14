import { expect, it } from 'vitest';

import { runWorkerCycle } from './worker.js';

it('runs a bounded idle worker cycle without external calls', () => {
  expect(runWorkerCycle()).toEqual({ processed: 0 });
});
