import { expect, it } from 'vitest';

import { runWorkerCycle } from './worker.js';

it('runs a bounded idle worker cycle without external calls', async () => {
  await expect(runWorkerCycle()).resolves.toEqual({ processed: 0 });
});
