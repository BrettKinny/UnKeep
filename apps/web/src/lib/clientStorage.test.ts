import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedDbClientStorage,
  upgradeClientStorageDatabase,
} from './clientStorage';

function successfulOpen(db: IDBDatabase): IDBOpenDBRequest {
  const request = { result: db, transaction: null } as unknown as IDBOpenDBRequest;
  queueMicrotask(() => request.onsuccess?.({} as Event));
  return request;
}

function transactionalStateDatabase(
  initial: Record<string, unknown>,
  legacyInitial?: Record<string, unknown>,
) {
  const values = new Map(Object.entries(initial));
  const tombstones = new Set<string>();
  const legacyValues = new Map(Object.entries(legacyInitial ?? {}));
  const transactionCalls: Array<{
    stores: string | string[];
    mode: IDBTransactionMode | undefined;
  }> = [];
  const db = {
    objectStoreNames: {
      contains: (name: string) =>
        name === 'client-state'
        || (name === 'device-keys' && legacyInitial !== undefined),
    },
    transaction: (
      stores: string | string[],
      mode?: IDBTransactionMode,
    ) => {
      transactionCalls.push({ stores, mode });
      const working = new Map(values);
      const workingTombstones = new Set(tombstones);
      const workingLegacy = new Map(legacyValues);
      let aborted = false;
      let completionQueued = false;
      let transaction!: IDBTransaction;
      const queueCompletion = () => {
        if (mode !== 'readwrite' || completionQueued) return;
        completionQueued = true;
        queueMicrotask(() => {
          if (aborted) return;
          values.clear();
          for (const [storedKey, value] of working) {
            values.set(storedKey, structuredClone(value));
          }
          tombstones.clear();
          for (const storedKey of workingTombstones) tombstones.add(storedKey);
          legacyValues.clear();
          for (const [storedKey, value] of workingLegacy) {
            legacyValues.set(storedKey, structuredClone(value));
          }
          transaction.oncomplete?.({} as Event);
        });
      };
      transaction = {
        error: null,
        abort: () => {
          if (aborted) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.({} as Event));
        },
        objectStore: (name: string) => name === 'device-keys' ? {
          get: (key: string) => {
            const request = {} as IDBRequest<unknown>;
            queueMicrotask(() => {
              Object.assign(request, {
                result: workingLegacy.has(key)
                  ? structuredClone(workingLegacy.get(key))
                  : undefined,
              });
              request.onsuccess?.({} as Event);
              queueCompletion();
            });
            return request;
          },
          delete: (key: string) => {
            workingLegacy.delete(key);
            queueCompletion();
            return {} as IDBRequest<undefined>;
          },
        } : ({
          get: (key: string) => {
            const request = {} as IDBRequest<unknown>;
            queueMicrotask(() => {
              Object.assign(request, {
                result: working.has(key)
                  ? { key, value: structuredClone(working.get(key)) }
                  : workingTombstones.has(key)
                    ? { key, deleted: true }
                  : undefined,
              });
              request.onsuccess?.({} as Event);
              queueCompletion();
            });
            return request;
          },
          put: (record: { key: string; value?: unknown; deleted?: true }) => {
            if (record.deleted) {
              working.delete(record.key);
              workingTombstones.add(record.key);
            } else {
              working.set(record.key, structuredClone(record.value));
              workingTombstones.delete(record.key);
            }
            queueCompletion();
            return {} as IDBRequest<IDBValidKey>;
          },
          delete: (key: string) => {
            working.delete(key);
            workingTombstones.delete(key);
            queueCompletion();
            return {} as IDBRequest<undefined>;
          },
        }),
      } as unknown as IDBTransaction;
      return transaction;
    },
    close: vi.fn(),
  } as unknown as IDBDatabase;
  return {
    db,
    values,
    tombstones,
    legacyValues,
    transactionCalls,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client storage migration', () => {
  it('moves the legacy device key into canonical state and deletes its source', () => {
    const canonicalRequest = {} as IDBRequest<unknown>;
    const legacyRequest = {} as IDBRequest<unknown>;
    const put = vi.fn();
    const deleteLegacy = vi.fn();
    const state = {
      get: vi.fn(() => canonicalRequest),
      put,
    } as unknown as IDBObjectStore;
    const legacy = {
      get: vi.fn(() => legacyRequest),
      delete: deleteLegacy,
    } as unknown as IDBObjectStore;
    const transaction = {
      objectStore: (name: string) => name === 'client-state' ? state : legacy,
    } as IDBTransaction;
    const db = {
      objectStoreNames: { contains: () => true },
    } as unknown as IDBDatabase;

    upgradeClientStorageDatabase(db, transaction);
    Object.assign(canonicalRequest, { result: undefined });
    canonicalRequest.onsuccess?.({} as Event);
    const wrappedKeys = { salt: 'legacy' };
    Object.assign(legacyRequest, { result: wrappedKeys });
    legacyRequest.onsuccess?.({} as Event);

    expect(put).toHaveBeenCalledWith({
      key: 'unkeep-device-keys',
      value: wrappedKeys,
    });
    expect(deleteLegacy).toHaveBeenCalledWith('current');
  });

  it('defensively deletes canonical and legacy device keys together', async () => {
    const state = transactionalStateDatabase(
      { 'unkeep-device-keys': { canonical: true } },
      { current: { legacy: true } },
    );
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', { removeItem: vi.fn() });

    await new IndexedDbClientStorage().delete('unkeep-device-keys');

    expect(state.values.has('unkeep-device-keys')).toBe(false);
    expect(state.tombstones.has('unkeep-device-keys')).toBe(true);
    expect(state.legacyValues.has('current')).toBe(false);
  });

  it('commits declared multi-key changes through one production IndexedDB transaction', async () => {
    const state = transactionalStateDatabase({
      first: { value: 1 },
      removed: { value: 2 },
    });
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });
    const storage = new IndexedDbClientStorage();

    await storage.transact(['first', 'second', 'removed'], transaction => {
      expect(transaction.get('first')).toEqual({ value: 1 });
      transaction.set('first', { value: 9 });
      transaction.set('second', { value: 2 });
      transaction.delete('removed');
    });

    expect(state.values).toEqual(new Map([
      ['first', { value: 9 }],
      ['second', { value: 2 }],
    ]));
    expect(state.transactionCalls.at(-1)).toEqual({
      stores: ['client-state'],
      mode: 'readwrite',
    });
  });

  it('aborts every production IndexedDB write when a transaction callback fails', async () => {
    const state = transactionalStateDatabase({
      first: { value: 1 },
      second: { value: 2 },
    });
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });
    const storage = new IndexedDbClientStorage();

    await expect(storage.transact(['first', 'second'], transaction => {
      transaction.set('first', { value: 9 });
      transaction.delete('second');
      throw new Error('abort all');
    })).rejects.toThrow('abort all');

    expect(state.values).toEqual(new Map([
      ['first', { value: 1 }],
      ['second', { value: 2 }],
    ]));
  });

  it('materializes a legacy localStorage value before an atomic update', async () => {
    const state = transactionalStateDatabase({});
    const legacy = new Map([
      ['legacy-session', JSON.stringify({ revision: 4 })],
    ]);
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => legacy.get(key) ?? null,
      removeItem: (key: string) => { legacy.delete(key); },
    });
    const storage = new IndexedDbClientStorage();

    await storage.update<{ revision: number }>('legacy-session', current => ({
      revision: (current?.revision ?? 0) + 1,
    }));

    expect(state.values.get('legacy-session')).toEqual({ revision: 5 });
    expect(legacy.has('legacy-session')).toBe(false);
  });

  it('does not resurrect stale localStorage after a concurrent clear wins', async () => {
    const state = transactionalStateDatabase({});
    const legacy = new Map([
      ['legacy-session', JSON.stringify({ revision: 4 })],
    ]);
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => legacy.get(key) ?? null,
      removeItem: (key: string) => { legacy.delete(key); },
    });
    const clearingTab = new IndexedDbClientStorage();
    const staleTab = new IndexedDbClientStorage();

    await clearingTab.delete('legacy-session');
    // Model a tab that captured the pre-migration value before the clear and
    // exposes it after the clear's localStorage cleanup.
    legacy.set('legacy-session', JSON.stringify({ revision: 4 }));
    await staleTab.update<{ revision: number }>('legacy-session', current => ({
      revision: (current?.revision ?? 0) + 1,
    }));

    expect(state.values.get('legacy-session')).toEqual({ revision: 1 });
    expect(legacy.has('legacy-session')).toBe(false);
  });

  it('does not restore a legacy device-key record after canonical clear', async () => {
    const state = transactionalStateDatabase(
      {},
      { current: { generation: 'legacy-generation' } },
    );
    vi.stubGlobal('indexedDB', { open: () => successfulOpen(state.db) });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });
    const clearingTab = new IndexedDbClientStorage();
    const staleTab = new IndexedDbClientStorage();

    await clearingTab.delete('unkeep-device-keys');
    // Model a legacy record becoming observable after the canonical clear.
    state.legacyValues.set('current', { generation: 'legacy-generation' });

    await expect(staleTab.get('unkeep-device-keys')).resolves.toBeNull();
    expect(state.values.has('unkeep-device-keys')).toBe(false);
    expect(state.tombstones.has('unkeep-device-keys')).toBe(true);
    expect(state.legacyValues.has('current')).toBe(false);
    expect(state.transactionCalls.at(-1)).toEqual({
      stores: ['client-state', 'device-keys'],
      mode: 'readwrite',
    });
  });
});
