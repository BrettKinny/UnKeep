import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ClientStorage } from '@unkeep/client';

type StoredValues = Record<string, unknown>;

function isStoredValues(value: unknown): value is StoredValues {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A small, atomic JSON-file implementation of the SDK ClientStorage seam. */
export class JsonFileClientStorage implements ClientStorage {
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

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
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  private mutate(change: (values: StoredValues) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const values = await this.readFile();
      change(values);
      await this.writeFile(values);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async get<T>(key: string): Promise<T | null> {
    await this.pending;
    const values = await this.readFile();
    return Object.hasOwn(values, key) ? values[key] as T : null;
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.mutate(values => {
      values[key] = value;
    });
  }

  delete(key: string): Promise<void> {
    return this.mutate(values => {
      delete values[key];
    });
  }

  async entries(): Promise<Readonly<StoredValues>> {
    await this.pending;
    return this.readFile();
  }
}
