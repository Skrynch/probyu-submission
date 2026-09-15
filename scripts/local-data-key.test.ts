import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const helperUrl = new URL('./local-data-key.ts', import.meta.url).href;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'probyu-m3-key-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function runProbe(directory: string, timeout = 1_000) {
  const directoryUrl = pathToFileURL(directory).href;
  const source = `
    const { loadOrCreateLocalDataKey } = await import(${JSON.stringify(helperUrl)});
    const first = await loadOrCreateLocalDataKey(new URL(${JSON.stringify(directoryUrl)}));
    const second = await loadOrCreateLocalDataKey(new URL(${JSON.stringify(directoryUrl)}));
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  try {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { timeout },
    );
    return { ...result, timedOut: false };
  } catch (error) {
    const failure = error as Error & {
      killed?: boolean;
      signal?: string;
      stderr?: string;
      stdout?: string;
    };
    return {
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
      timedOut: Boolean(failure.killed || failure.signal === 'SIGTERM'),
    };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('M3 local research data key', () => {
  it('creates one owner-only regular key and reuses it', async () => {
    const directory = await temporaryDirectory();
    const result = await runProbe(directory);
    expect(result.timedOut).toBe(false);
    const values = JSON.parse(result.stdout) as { first: string; second: string };
    expect(values.first).toMatch(/^[a-f0-9]{64}$/);
    expect(values.second).toBe(values.first);
    expect((await readFile(join(directory, 'm3-research-data.key'), 'utf8')).trim()).toBe(
      values.first,
    );
    const info = await stat(join(directory, 'm3-research-data.key'));
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('rejects an owner-only FIFO promptly instead of blocking before type validation', async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, 'm3-research-data.key');
    await execFileAsync('mkfifo', [keyPath]);
    const result = await runProbe(directory);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('Invalid local M3 research data key file.');
  });
});
