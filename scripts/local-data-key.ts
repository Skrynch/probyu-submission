import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
type DirectoryIdentity = { dev: number; ino: number };

function validateLocalDataKey(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid local M3 research data key.');
  return value;
}

async function inspectLocalDirectory(
  directory: URL,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Invalid local M3 data directory.');
  if ((currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o777) !== 0o700)
    throw new Error('Local M3 data directory must be owned by the current user with mode 0700.');
  const identity = { dev: info.dev, ino: info.ino };
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino))
    throw new Error('Local M3 data directory changed during key access.');
  return identity;
}

async function inspectCurrentDirectory(expected: DirectoryIdentity): Promise<void> {
  const info = await lstat('.');
  if (
    !info.isDirectory() ||
    (currentUid !== undefined && info.uid !== currentUid) ||
    (info.mode & 0o777) !== 0o700 ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino
  )
    throw new Error('Local M3 data directory changed during key access.');
}

async function validateLocalDirectory(directory: URL): Promise<DirectoryIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return inspectLocalDirectory(directory);
}

async function readLocalDataKey(
  identity: DirectoryIdentity,
  filename: string,
  retries = 0,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      await inspectCurrentDirectory(identity);
      const handle = await open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        await inspectCurrentDirectory(identity);
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Invalid local M3 research data key file.');
        if ((currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o777) !== 0o600)
          throw new Error(
            'Local M3 research data key must be owned by the current user with mode 0600.',
          );
        const key = validateLocalDataKey((await handle.readFile('utf8')).trim());
        await inspectCurrentDirectory(identity);
        return key;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export async function loadOrCreateLocalDataKey(
  directory: URL,
  filename = 'm3-research-data.key',
): Promise<string> {
  if (filename.includes('/') || filename === '.' || filename === '..')
    throw new Error('Invalid local M3 research data key filename.');
  const identity = await validateLocalDirectory(directory);
  const previousDirectory = process.cwd();
  process.chdir(fileURLToPath(directory));
  try {
    await inspectCurrentDirectory(identity);
    try {
      return await readLocalDataKey(identity, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const created = randomBytes(32).toString('hex');
    try {
      await inspectCurrentDirectory(identity);
      const handle = await open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await inspectCurrentDirectory(identity);
        await handle.writeFile(`${created}\n`, 'utf8');
        await handle.sync();
        const info = await handle.stat();
        if (
          !info.isFile() ||
          (currentUid !== undefined && info.uid !== currentUid) ||
          (info.mode & 0o777) !== 0o600
        )
          throw new Error(
            'Local M3 research data key must be owned by the current user with mode 0600.',
          );
        await inspectCurrentDirectory(identity);
        return created;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return await readLocalDataKey(identity, filename, 5);
    }
  } finally {
    process.chdir(previousDirectory);
  }
}
