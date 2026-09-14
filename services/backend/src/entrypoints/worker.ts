const intervalMs = 30_000;

export function runWorkerCycle(): { processed: number } {
  return { processed: 0 };
}

function main(): void {
  runWorkerCycle();
  const timer = setInterval(runWorkerCycle, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.env.VITEST === undefined) {
  main();
}
