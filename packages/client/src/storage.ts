export interface ClientStorageTransaction {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface ClientStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Atomic single-key read/modify/write. Security-sensitive session
   * finalization requires this capability and fails closed when it is absent.
   */
  update?<T>(key: string, change: (value: T | null) => T | null): Promise<void>;
  /**
   * Atomic multi-key read/modify/write over one storage transaction domain.
   * Device-key installation, rollback, and destructive access clearing require
   * this capability; the SDK does not emulate them with separate writes.
   */
  transact?(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void>;
}

export class MemoryClientStorage implements ClientStorage {
  private readonly values = new Map<string, unknown>();
  private updates: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  update<T>(key: string, change: (value: T | null) => T | null): Promise<void> {
    const operation = this.updates.then(() => {
      const current = (this.values.get(key) as T | undefined) ?? null;
      const next = change(current);
      if (next === null) this.values.delete(key);
      else this.values.set(key, next);
    });
    this.updates = operation.then(() => undefined, () => undefined);
    return operation;
  }

  transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    const allowed = new Set(keys);
    const operation = this.updates.then(() => {
      const next = new Map<string, unknown>();
      for (const key of allowed) {
        if (this.values.has(key)) next.set(key, structuredClone(this.values.get(key)));
      }
      const assertAllowed = (key: string) => {
        if (!allowed.has(key)) throw new Error(`Client storage transaction did not declare key: ${key}`);
      };
      const returned = change({
        get: <T>(key: string) => {
          assertAllowed(key);
          return (next.get(key) as T | undefined) ?? null;
        },
        set: <T>(key: string, value: T) => {
          assertAllowed(key);
          next.set(key, structuredClone(value));
        },
        delete: (key: string) => {
          assertAllowed(key);
          next.delete(key);
        },
      }) as unknown;
      if (
        returned
        && typeof (returned as { then?: unknown }).then === 'function'
      ) {
        throw new Error('Client storage transaction callback must be synchronous');
      }
      for (const key of allowed) {
        if (next.has(key)) this.values.set(key, next.get(key));
        else this.values.delete(key);
      }
    });
    this.updates = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
