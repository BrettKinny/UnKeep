export interface ClientStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  update?<T>(key: string, change: (value: T | null) => T | null): Promise<void>;
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
}
