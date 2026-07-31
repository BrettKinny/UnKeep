import { spawn } from 'node:child_process';
import { access, chmod, link, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveConfiguration, unkeepConfigDirectory } from './config.js';
import { ensurePrivateDirectory, JsonFileClientStorage } from './storage.js';

const temporaryDirectories: string[] = [];
const storageModuleUrl = new URL('./storage.ts', import.meta.url).href;
const storageWorker = fileURLToPath(new URL('../test/storage-process-worker.mjs', import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for worker signal ${path}`);
}

function runStorageWorker(arguments_: readonly string[]): Promise<void> {
  return startStorageWorker(arguments_).done;
}

function startStorageWorker(arguments_: readonly string[]): {
  child: ReturnType<typeof spawn>;
  done: Promise<void>;
} {
  const child = spawn(process.execPath, [
    '--experimental-transform-types',
    '--no-warnings',
    storageWorker,
    storageModuleUrl,
    ...arguments_,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const done = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Storage worker exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
  return { child, done };
}

function storageLockOwnerPath(file: string, token: string): string {
  return join(dirname(file), `.${basename(file)}.lock-owner-${token}`);
}

async function writeSyntheticLock(
  file: string,
  owner: Readonly<Record<string, unknown>>,
): Promise<void> {
  const token = String(owner.token);
  const ownerPath = storageLockOwnerPath(file, token);
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await link(ownerPath, `${file}.lock`);
}

async function currentPidNamespace(): Promise<string> {
  return readlink('/proc/self/ns/pid');
}

test('resolves flags over environment over config file', () => {
  const file = {
    endpoint: 'https://file.example',
    credential: 'file-credential',
    vaultKey: 'file-key',
  };
  const environment = {
    UNKEEP_ENDPOINT: 'https://env.example',
    UNKEEP_CREDENTIAL: 'env-credential',
    UNKEEP_VAULT_KEY: 'env-key',
  };
  expect(resolveConfiguration({}, {}, file)).toEqual(file);
  expect(resolveConfiguration({}, environment, file)).toEqual({
    endpoint: 'https://env.example',
    credential: 'env-credential',
    vaultKey: 'env-key',
  });
  expect(resolveConfiguration({
    endpoint: 'https://flag.example',
    credential: 'flag-credential',
    vaultKey: 'flag-key',
  }, environment, file)).toEqual({
    endpoint: 'https://flag.example',
    credential: 'flag-credential',
    vaultKey: 'flag-key',
  });
});

test('uses the saved SDK session as file configuration', () => {
  expect(resolveConfiguration({}, {}, {
    vault_key: 'saved-key',
    'unkeep-relay-session': {
      endpoint: 'https://saved.example',
      credential: 'saved-credential',
      instanceId: 'instance',
      deviceId: 'device',
    },
  })).toEqual({
    endpoint: 'https://saved.example',
    credential: 'saved-credential',
    vaultKey: 'saved-key',
  });
});

describe('JsonFileClientStorage', () => {
  test('creates missing private directory components and durably records each parent entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-durable-directory-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const first = join(directory, 'xdg');
    const target = join(first, 'unkeep');
    const synced: string[] = [];

    await ensurePrivateDirectory(target, async parent => {
      synced.push(parent);
    });

    expect((await stat(first)).mode & 0o777).toBe(0o700);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(synced).toEqual([
      dirname(directory),
      directory,
      first,
    ]);
  });

  test('stops before deeper config creation when a new directory parent cannot be synced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-directory-sync-fault-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'xdg');
    const target = join(first, 'unkeep');

    await expect(ensurePrivateDirectory(target, async parent => {
      if (parent === directory) throw new Error('injected parent fsync failure');
    })).rejects.toThrow('injected parent fsync failure');

    expect((await stat(first)).mode & 0o777).toBe(0o700);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('persists SDK values atomically in a private config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-storage-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, 'nested');
    await mkdir(configDirectory, { mode: 0o755 });
    const file = join(configDirectory, 'config.json');
    const storage = new JsonFileClientStorage(file);
    await storage.set('credential', 'secret');
    await storage.set('cursor', 3);
    expect(await storage.get('credential')).toBe('secret');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ credential: 'secret', cursor: 3 });
    await storage.setMany({ endpoint: 'https://relay.example', vaultKey: 'vault-key' });
    const snapshot = await storage.entries();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      credential: 'secret',
      cursor: 3,
      endpoint: 'https://relay.example',
      vaultKey: 'vault-key',
    });
    await storage.set('credential', 'replacement');
    await storage.replaceAll(snapshot);
    expect(await storage.get('credential')).toBe('secret');
    expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await storage.delete('credential');
    expect(await storage.get('credential')).toBeNull();
  });

  test('commits declared SDK transaction keys in one durable config rewrite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-storage-transaction-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const storage = new JsonFileClientStorage(file);
    await storage.setMany({ retained: 'yes', pending: 'intent', note: { id: 'old' } });

    await storage.transact?.(['pending', 'note'], transaction => {
      expect(transaction.get('pending')).toBe('intent');
      transaction.delete('pending');
      transaction.set('note', { id: 'new' });
    });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      retained: 'yes',
      note: { id: 'new' },
    });
  });

  test('fails a storage transaction closed when it touches an undeclared key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-storage-transaction-guard-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const storage = new JsonFileClientStorage(file);
    await storage.setMany({ pending: 'intent', note: { id: 'old' } });

    await expect(storage.transact(['pending'], transaction => {
      transaction.delete('pending');
      transaction.set('note', { id: 'new' });
    })).rejects.toThrow('Client storage transaction did not declare key: note');

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      pending: 'intent',
      note: { id: 'old' },
    });
  });

  test('preserves every concurrent process config mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-process-storage-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const start = join(directory, 'start');
    const workers = Array.from({ length: 8 }, (_, index) => {
      const ready = join(directory, `ready-${index}`);
      return {
        ready,
        done: runStorageWorker([file, ready, start, 'increment']),
      };
    });

    await Promise.all(workers.map(worker => waitForFile(worker.ready)));
    await writeFile(start, '');
    await Promise.all(workers.map(worker => worker.done));

    expect(await new JsonFileClientStorage(file).get('counter')).toBe(8);
  });

  test('serializes multi-call config transactions across processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-process-transaction-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const start = join(directory, 'start');
    const workers = Array.from({ length: 8 }, (_, index) => {
      const ready = join(directory, `ready-${index}`);
      return {
        ready,
        done: runStorageWorker([file, ready, start, 'transaction']),
      };
    });

    await Promise.all(workers.map(worker => waitForFile(worker.ready)));
    await writeFile(start, '');
    await Promise.all(workers.map(worker => worker.done));

    expect(await new JsonFileClientStorage(file).get('transactionCounter')).toBe(8);
  });

  test('recovers a config lock abandoned by a dead process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-dead-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const ready = join(directory, 'ready');
    const start = join(directory, 'start');
    const locked = join(directory, 'locked');
    const worker = startStorageWorker([file, ready, start, 'hold', locked, '30000']);

    await waitForFile(ready);
    await writeFile(start, '');
    await waitForFile(locked);
    worker.child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    await expect(worker.done).rejects.toThrow(/Storage worker exited/);

    const recovered = new JsonFileClientStorage(file, {
      lockRetryMs: 10,
      lockTimeoutMs: 500,
    });
    await recovered.set('afterRecovery', true);
    expect(await recovered.get('afterRecovery')).toBe(true);
  });

  test('does not steal a same-PID legacy lock whose namespace cannot be verified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-reused-pid-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const staleToken = globalThis.crypto.randomUUID();
    await writeSyntheticLock(file, {
      version: 1,
      pid: process.pid,
      token: staleToken,
    });

    const contender = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 50,
    });
    await expect(contender.set('mustNotSteal', true)).rejects.toThrow(
      /Automatic recovery is disabled; after confirming no other UnKeep CLI process or container is using this config/,
    );
    expect(JSON.parse(await readFile(`${file}.lock`, 'utf8'))).toEqual({
      version: 1,
      pid: process.pid,
      token: staleToken,
    });
  });

  test('does not steal a live same-PID lock from another container process identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-reused-pid-token-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const staleToken = globalThis.crypto.randomUUID();
    await writeSyntheticLock(file, {
      version: 2,
      pid: process.pid,
      processToken: globalThis.crypto.randomUUID(),
      processStartTime: null,
      token: staleToken,
    });

    const contender = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 50,
    });
    await expect(contender.set('mustNotSteal', true)).rejects.toThrow(
      /Timed out after 50 ms waiting for UnKeep config lock/,
    );
    expect(JSON.parse(await readFile(`${file}.lock`, 'utf8'))).toMatchObject({
      version: 2,
      pid: process.pid,
      token: staleToken,
    });
  });

  test.runIf(process.platform === 'linux')('does not steal a live same-PID lock from another PID namespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-cross-namespace-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const staleToken = globalThis.crypto.randomUUID();
    await writeSyntheticLock(file, {
      version: 3,
      pid: process.pid,
      processToken: globalThis.crypto.randomUUID(),
      processStartTime: '0',
      processNamespace: 'pid:[1]',
      token: staleToken,
    });

    const contender = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 50,
    });
    await expect(contender.set('mustNotSteal', true)).rejects.toThrow(
      /Timed out after 50 ms waiting for UnKeep config lock/,
    );
    expect(JSON.parse(await readFile(`${file}.lock`, 'utf8'))).toMatchObject({
      version: 3,
      pid: process.pid,
      token: staleToken,
    });
  });

  test.runIf(process.platform === 'linux')('recovers a lock whose live PID has a different Linux start time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-reused-start-time-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const staleToken = globalThis.crypto.randomUUID();
    await writeSyntheticLock(file, {
      version: 3,
      pid: process.ppid,
      processToken: globalThis.crypto.randomUUID(),
      processStartTime: '0',
      processNamespace: await currentPidNamespace(),
      token: staleToken,
    });

    const recovered = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 100,
    });
    await recovered.set('afterStartTimeReuse', true);

    expect(await recovered.get('afterStartTimeReuse')).toBe(true);
  });

  test('does not mistake a concurrent lock in this process for a reused PID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-same-process-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const holder = new JsonFileClientStorage(file);
    const contender = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 50,
    });
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    let acquired!: () => void;
    const lockAcquired = new Promise<void>(resolve => {
      acquired = resolve;
    });
    const holding = holder.runExclusive(async () => {
      acquired();
      await released;
    });
    await lockAcquired;

    await expect(contender.set('overlap', true)).rejects.toThrow(
      /Timed out after 50 ms waiting for UnKeep config lock held by live process/,
    );
    release();
    await holding;

    await contender.set('afterRelease', true);
    expect(await contender.entries()).toEqual({ afterRelease: true });
  });

  test('stale recovery does not delete a different owner record that reuses a lock token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-lock-identity-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const reusedToken = globalThis.crypto.randomUUID();
    const staleOwner = {
      version: 3,
      pid: 2_147_483_647,
      processToken: globalThis.crypto.randomUUID(),
      processStartTime: '0',
      processNamespace: process.platform === 'linux' ? await currentPidNamespace() : null,
      token: reusedToken,
    };
    const differentOwner = {
      version: 3,
      pid: process.pid,
      processToken: globalThis.crypto.randomUUID(),
      processStartTime: null,
      processNamespace: process.platform === 'linux' ? await currentPidNamespace() : null,
      token: reusedToken,
    };
    await writeFile(`${file}.lock`, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    const differentOwnerPath = storageLockOwnerPath(file, reusedToken);
    await writeFile(differentOwnerPath, `${JSON.stringify(differentOwner)}\n`, { mode: 0o600 });

    const recovered = new JsonFileClientStorage(file, {
      lockRetryMs: 5,
      lockTimeoutMs: 100,
    });
    await recovered.set('afterIdentityCheck', true);

    expect(JSON.parse(await readFile(differentOwnerPath, 'utf8'))).toEqual(differentOwner);
  });

  test('times out clearly without deleting a live process lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-live-lock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'config.json');
    const ready = join(directory, 'ready');
    const start = join(directory, 'start');
    const locked = join(directory, 'locked');
    const worker = startStorageWorker([file, ready, start, 'hold', locked, '600']);

    await waitForFile(ready);
    await writeFile(start, '');
    await waitForFile(locked);
    const owner = JSON.parse(await readFile(`${file}.lock`, 'utf8')) as Record<string, unknown>;
    expect(owner).toMatchObject({
      version: 3,
      pid: worker.child.pid,
    });
    expect(owner.processToken).toMatch(/^[0-9a-f-]{36}$/i);
    if (process.platform === 'linux') {
      expect(owner.processStartTime).toMatch(/^\d+$/);
      expect(owner.processNamespace).toMatch(/^pid:\[\d+\]$/);
    }

    const contender = new JsonFileClientStorage(file, {
      lockRetryMs: 10,
      lockTimeoutMs: 100,
    });
    await expect(contender.set('mustWait', true)).rejects.toThrow(
      /Timed out after 100 ms waiting for UnKeep config lock held by live process \d+/,
    );

    await worker.done;
    await contender.set('afterOwnerExit', true);
    expect(await contender.entries()).toMatchObject({
      holder: 'held',
      afterOwnerExit: true,
    });
  });
});

test('places state below XDG_CONFIG_HOME when configured', () => {
  expect(unkeepConfigDirectory({ XDG_CONFIG_HOME: '/tmp/example-xdg' })).toBe('/tmp/example-xdg/unkeep');
  expect(unkeepConfigDirectory({}, '/tmp/explicit-unkeep')).toBe('/tmp/explicit-unkeep');
});
