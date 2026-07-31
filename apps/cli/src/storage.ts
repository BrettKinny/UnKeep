import { AsyncLocalStorage } from 'node:async_hooks';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readlink, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ClientStorage, ClientStorageTransaction } from '@unkeep/client';

type StoredValues = Record<string, unknown>;

interface LegacyLockOwner {
  version: 1;
  pid: number;
  token: string;
}

interface ProcessTokenLockOwner {
  version: 2;
  pid: number;
  processToken: string;
  processStartTime: string | null;
  token: string;
}

interface CurrentLockOwner {
  version: 3;
  pid: number;
  processToken: string;
  processStartTime: string | null;
  processNamespace: string | null;
  token: string;
}

type LockOwner = LegacyLockOwner | ProcessTokenLockOwner | CurrentLockOwner;
type LockOwnerStatus = 'live' | 'stale' | 'ambiguous';

export interface JsonFileClientStorageOptions {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const heldConfigLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const currentProcessToken = globalThis.crypto.randomUUID();
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

function isStoredValues(value: unknown): value is StoredValues {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!validPid(candidate.pid) || !validToken(candidate.token)) return false;
  if (candidate.version === 1) return true;
  if (
    (candidate.version !== 2 && candidate.version !== 3)
    || !validToken(candidate.processToken)
    || !(
      candidate.processStartTime === null
      || (
        typeof candidate.processStartTime === 'string'
        && /^\d+$/.test(candidate.processStartTime)
      )
    )
  ) return false;
  return candidate.version === 2
    || candidate.processNamespace === null
    || (
      typeof candidate.processNamespace === 'string'
      && /^pid:\[\d+\]$/.test(candidate.processNamespace)
    );
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    return isLockOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameLockOwner(left: LockOwner, right: LockOwner): boolean {
  if (left.version !== right.version || left.pid !== right.pid || left.token !== right.token) {
    return false;
  }
  if (left.version === 1 || right.version === 1) {
    return left.version === 1 && right.version === 1;
  }
  if (
    left.processToken !== right.processToken
    || left.processStartTime !== right.processStartTime
  ) return false;
  if (left.version === 2 || right.version === 2) {
    return left.version === 2 && right.version === 2;
  }
  return left.processNamespace === right.processNamespace;
}

function processResponds(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function linuxProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }

  // Field two is a parenthesized process name and can contain spaces. Counting
  // from the last closing parenthesis makes field 22 (starttime) index 19 in
  // the remaining fields, beginning with field three (state).
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

async function linuxProcessNamespace(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const namespace = await readlink(`/proc/${pid}/ns/pid`);
    return /^pid:\[\d+\]$/.test(namespace) ? namespace : undefined;
  } catch {
    return undefined;
  }
}

const currentProcessStartTime = linuxProcessStartTime(process.pid);
const currentProcessNamespace = linuxProcessNamespace(process.pid);

async function createLockOwner(token: string): Promise<CurrentLockOwner> {
  return {
    version: 3,
    pid: process.pid,
    processToken: currentProcessToken,
    processStartTime: await currentProcessStartTime ?? null,
    processNamespace: await currentProcessNamespace ?? null,
    token,
  };
}

async function lockOwnerStatus(
  owner: LockOwner,
  contender: CurrentLockOwner,
): Promise<LockOwnerStatus> {
  // Older records do not identify their PID namespace. A matching numeric PID
  // may therefore belong to another concurrently-live container, so fail
  // closed instead of inferring death from this namespace's /proc view.
  if (owner.version !== 3) return 'ambiguous';

  if (process.platform === 'linux') {
    if (
      owner.processNamespace === null
      || contender.processNamespace === null
      || owner.processNamespace !== contender.processNamespace
    ) return 'ambiguous';

    const observedNamespace = await linuxProcessNamespace(owner.pid);
    if (observedNamespace !== undefined) {
      if (observedNamespace !== owner.processNamespace) return 'ambiguous';
      const observedStartTime = await linuxProcessStartTime(owner.pid);
      if (
        owner.processStartTime !== null
        && observedStartTime !== undefined
        && owner.processStartTime !== observedStartTime
      ) return 'stale';
      return 'live';
    }
    return processResponds(owner.pid) ? 'live' : 'stale';
  }

  // Non-Linux platforms do not expose Linux PID namespaces. Never reclaim a
  // same-number PID based on a random token alone; different PIDs retain the
  // portable kill(0) liveness fallback.
  if (owner.pid === contender.pid) return 'ambiguous';
  return processResponds(owner.pid) ? 'live' : 'stale';
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows and a small number of filesystems do not permit opening or
    // syncing directories. File fsync still protects the contents there.
    if (
      process.platform === 'win32'
      || ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

type DirectorySync = (directory: string) => Promise<void>;

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
      throw new Error(`UnKeep config path component is not a directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Creates a private config directory one component at a time. Each new
 * directory entry is fsynced through its parent before a deeper component can
 * be created, so a successful first login cannot outlive an uncommitted
 * `$XDG_CONFIG_HOME/unkeep` entry.
 *
 * The sync seam is exported only for deterministic durability fault tests;
 * the CLI package does not expose this module as public API.
 */
export async function ensurePrivateDirectory(
  directory: string,
  syncParent: DirectorySync = syncDirectory,
): Promise<void> {
  const target = resolve(directory);
  if (dirname(target) === target) {
    throw new Error(`UnKeep config directory cannot be a filesystem root: ${target}`);
  }

  const missing: string[] = [];
  let anchor = target;
  while (!await existingDirectory(anchor)) {
    missing.unshift(anchor);
    const parent = dirname(anchor);
    if (parent === anchor) {
      throw new Error(`Unable to find an existing parent for UnKeep config directory: ${target}`);
    }
    anchor = parent;
  }

  // This also makes a retry durable if a previous attempt created `anchor`
  // but failed while syncing its parent before creating the next component.
  await syncParent(dirname(anchor));

  for (const component of missing) {
    try {
      await mkdir(component, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A concurrent creator may have won. Refuse files and links, then
      // apply the same private permissions before relying on the component.
      const metadata = await lstat(component);
      if (!metadata.isDirectory()) {
        throw new Error(`UnKeep config path component is not a directory: ${component}`);
      }
    }
    await chmod(component, 0o700);
    await syncParent(dirname(component));
  }

  if (missing.length === 0) await chmod(target, 0o700);
}

/** A small, atomic JSON-file implementation of the SDK ClientStorage seam. */
export class JsonFileClientStorage implements ClientStorage {
  private pending: Promise<void> = Promise.resolve();
  private directoryReady: Promise<void> | undefined;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    readonly filePath: string,
    options: JsonFileClientStorageOptions = {},
  ) {
    this.lockRetryMs = positiveMilliseconds(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS);
    this.lockTimeoutMs = positiveMilliseconds(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  }

  private lockOwnerPath(token: string): string {
    return join(dirname(this.filePath), `.${basename(this.filePath)}.lock-owner-${token}`);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return this.directoryReady;
    const attempt = ensurePrivateDirectory(dirname(this.filePath));
    this.directoryReady = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.directoryReady === attempt) this.directoryReady = undefined;
      throw error;
    }
  }

  private async removeOwnedLock(path: string, expected: LockOwner): Promise<boolean> {
    const current = await readLockOwner(path);
    if (!current || !sameLockOwner(current, expected)) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async removeOwnerRecord(expected: LockOwner): Promise<void> {
    await this.removeOwnedLock(this.lockOwnerPath(expected.token), expected);
  }

  private async recoverStaleLock(
    lockPath: string,
    contender: CurrentLockOwner,
  ): Promise<boolean> {
    const observed = await readLockOwner(lockPath);
    if (!observed || await lockOwnerStatus(observed, contender) !== 'stale') return false;

    const recoveryPath = `${lockPath}.recovery`;
    const recoveryToken = globalThis.crypto.randomUUID();
    const recoveryOwnerPath = this.lockOwnerPath(recoveryToken);
    const recoveryOwner = await createLockOwner(recoveryToken);
    await writeFile(
      recoveryOwnerPath,
      `${JSON.stringify(recoveryOwner)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    try {
      try {
        await link(recoveryOwnerPath, recoveryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const abandonedRecovery = await readLockOwner(recoveryPath);
        if (
          abandonedRecovery
          && await lockOwnerStatus(abandonedRecovery, recoveryOwner) === 'stale'
          && await this.removeOwnedLock(recoveryPath, abandonedRecovery)
        ) {
          await this.removeOwnerRecord(abandonedRecovery);
        }
        return false;
      }

      // The recovery lock serializes stale-owner cleanup. Compare the complete
      // acquisition and process identity again immediately before unlinking;
      // a token-only check could remove a replacement owner after PID reuse.
      const current = await readLockOwner(lockPath);
      if (
        !current
        || !sameLockOwner(current, observed)
        || await lockOwnerStatus(current, contender) !== 'stale'
      ) return false;
      if (!await this.removeOwnedLock(lockPath, current)) return false;
      await this.removeOwnerRecord(current);
      return true;
    } finally {
      await this.removeOwnedLock(recoveryPath, recoveryOwner);
      await this.removeOwnerRecord(recoveryOwner);
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const token = globalThis.crypto.randomUUID();
    const owner = await createLockOwner(token);
    const lockPath = `${this.filePath}.lock`;
    const ownerPath = this.lockOwnerPath(token);
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const deadline = Date.now() + this.lockTimeoutMs;

    try {
      while (true) {
        try {
          await link(ownerPath, lockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await this.recoverStaleLock(lockPath, owner)) continue;
          if (Date.now() >= deadline) {
            const currentOwner = await readLockOwner(lockPath);
            const currentStatus = currentOwner
              ? await lockOwnerStatus(currentOwner, owner)
              : undefined;
            const ownership = currentOwner
              ? currentStatus === 'live'
                ? `live process ${currentOwner.pid}`
                : `process ${currentOwner.pid} with unverifiable PID namespace`
              : 'an unreadable owner';
            const manualRecovery = currentStatus === 'ambiguous'
              ? ' Automatic recovery is disabled; after confirming no other UnKeep CLI process or container is using this config, remove the lock file manually.'
              : '';
            throw new Error(
              `Timed out after ${this.lockTimeoutMs} ms waiting for UnKeep config lock held by ${ownership}: ${lockPath}.${manualRecovery}`,
            );
          }
          await delay(this.lockRetryMs);
        }
      }

      try {
        return await operation();
      } finally {
        if (!await this.removeOwnedLock(lockPath, owner)) {
          throw new Error(`UnKeep config lock ownership changed unexpectedly: ${lockPath}`);
        }
      }
    } finally {
      await this.removeOwnerRecord(owner);
    }
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const identity = resolve(this.filePath);
    const held = heldConfigLocks.getStore();
    if (held?.has(identity)) return operation();

    const next = new Set(held);
    next.add(identity);
    return this.withFileLock(() => heldConfigLocks.run(next, operation));
  }

  private async readFile(): Promise<StoredValues> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error(`Invalid JSON in UnKeep config file: ${this.filePath}`);
    }
    if (!isStoredValues(parsed)) throw new Error(`UnKeep config file must contain a JSON object: ${this.filePath}`);
    return parsed;
  }

  private async writeFile(values: StoredValues): Promise<void> {
    const directory = dirname(this.filePath);
    await this.ensureDirectory();
    const temporary = `${this.filePath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(values, null, 2)}\n`, 'utf8');
      // Pairing finalization and sync cursor acknowledgement rely on this
      // promise meaning the new credential/key/checkpoint is durable.
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      await syncDirectory(directory);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private mutate(change: (values: StoredValues) => void): Promise<void> {
    const operation = this.pending.then(() => this.runExclusive(async () => {
      const values = await this.readFile();
      change(values);
      await this.writeFile(values);
    }));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async get<T>(key: string): Promise<T | null> {
    await this.pending;
    return this.runExclusive(async () => {
      const values = await this.readFile();
      return Object.hasOwn(values, key) ? values[key] as T : null;
    });
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.mutate(values => {
      values[key] = value;
    });
  }

  update<T>(key: string, change: (value: T | null) => T | null): Promise<void> {
    return this.mutate(values => {
      const current = Object.hasOwn(values, key) ? values[key] as T : null;
      const next = change(current);
      if (next === null) delete values[key];
      else values[key] = next;
    });
  }

  transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    const allowed = new Set(keys);
    return this.mutate(values => {
      const next = Object.create(null) as StoredValues;
      for (const key of allowed) {
        if (Object.hasOwn(values, key)) next[key] = structuredClone(values[key]);
      }
      const assertAllowed = (key: string) => {
        if (!allowed.has(key)) {
          throw new Error(`Client storage transaction did not declare key: ${key}`);
        }
      };
      const returned = change({
        get: <T>(key: string) => {
          assertAllowed(key);
          return Object.hasOwn(next, key) ? next[key] as T : null;
        },
        set: <T>(key: string, value: T) => {
          assertAllowed(key);
          next[key] = structuredClone(value);
        },
        delete: (key: string) => {
          assertAllowed(key);
          delete next[key];
        },
      }) as unknown;
      if (
        returned
        && typeof (returned as { then?: unknown }).then === 'function'
      ) {
        throw new Error('Client storage transaction callback must be synchronous');
      }
      for (const key of allowed) {
        if (Object.hasOwn(next, key)) values[key] = next[key];
        else delete values[key];
      }
    });
  }

  setMany(values: Readonly<StoredValues>): Promise<void> {
    return this.mutate(current => {
      Object.assign(current, values);
    });
  }

  /** Atomically installs several values and removes several keys. */
  setAndDelete(
    values: Readonly<StoredValues>,
    deletedKeys: readonly string[],
  ): Promise<void> {
    return this.mutate(current => {
      Object.assign(current, values);
      for (const key of deletedKeys) delete current[key];
    });
  }

  replaceAll(values: Readonly<StoredValues>): Promise<void> {
    const operation = this.pending.then(() => this.runExclusive(() => this.writeFile({ ...values })));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  delete(key: string): Promise<void> {
    return this.mutate(values => {
      delete values[key];
    });
  }

  async entries(): Promise<Readonly<StoredValues>> {
    await this.pending;
    return this.runExclusive(() => this.readFile());
  }
}
