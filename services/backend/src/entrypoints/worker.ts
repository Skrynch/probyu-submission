import { readResearchWorkerConfig } from '../config.js';
import { ResearchWorker } from '../modules/research/worker.js';

export async function runWorkerCycle(worker?: ResearchWorker): Promise<{ processed: number }> {
  if (!worker) return { processed: 0 };
  return worker.cycle();
}

async function main(): Promise<void> {
  if (!process.env.RESEARCH_MODE || process.env.RESEARCH_MODE === 'disabled') {
    const timer = setInterval(() => void runWorkerCycle(), 30_000);
    const stop = () => {
      clearInterval(timer);
      process.exitCode = 0;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const config = readResearchWorkerConfig();
  const worker = new ResearchWorker(config.databaseUrl, config.dataKey);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await worker.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  while (!stopped) {
    const result = await runWorkerCycle(worker);
    if (!result.processed) await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

if (process.env.VITEST === undefined) void main();
