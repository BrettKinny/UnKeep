import {
  DeviceKeyStore,
  RelaySessionStore,
  type ClientStorage,
  type ClientStorageTransaction,
} from '@unkeep/client';

const DB_NAME = 'unkeep-keys';
const DB_VERSION = 3;
const STATE_STORE = 'client-state';
const LEGACY_KEY_STORE = 'device-keys';
const DEVICE_KEYS_KEY = 'unkeep-device-keys';

interface StateRecord {
  key: string;
  value?: unknown;
  deleted?: true;
}

function openDb():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      if (!request.transaction) {
        return;
      }
      upgradeClientStorageDatabase(request.result, request.transaction);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

export function upgradeClientStorageDatabase(
  db: IDBDatabase,
  transaction: IDBTransaction,
): void {
  const state = db.objectStoreNames.contains(STATE_STORE)
    ? transaction.objectStore(STATE_STORE)
    : db.createObjectStore(STATE_STORE, { keyPath: 'key' });
  if (!db.objectStoreNames.contains(LEGACY_KEY_STORE)) return;
  const legacy = transaction.objectStore(LEGACY_KEY_STORE);
  const canonicalRequest = state.get(DEVICE_KEYS_KEY);
  canonicalRequest.onsuccess = () => {
    const legacyRequest = legacy.get('current');
    legacyRequest.onsuccess = () => {
      if (canonicalRequest.result === undefined && legacyRequest.result !== undefined) {
        state.put({
          key: DEVICE_KEYS_KEY,
          value: legacyRequest.result,
        } satisfies StateRecord);
      }
      legacy.delete('current');
    };
  };
}

function legacyLocalValue(key: string): { found: boolean; value?: unknown } {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return { found: false };
    try {
      return { found: true, value: JSON.parse(stored) };
    } catch {
      return { found: true, value: stored };
    }
  } catch {
    return { found: false };
  }
}

export class IndexedDbClientStorage implements ClientStorage {
  async get<T>(key:string):Promise<T|null> {
    let value: T | null = null;
    await this.transact([key], transaction => {
      value = transaction.get<T>(key);
    });
    return value;
  }

  async set<T>(key:string,value:T):Promise<void> {
    await this.transact([key], transaction => {
      transaction.set(key, value);
    });
  }

  async delete(key:string):Promise<void> {
    await this.transact([key], transaction => {
      transaction.delete(key);
    });
  }

  async update<T>(key:string,change:(value:T|null)=>T|null):Promise<void> {
    await this.transact([key], transaction => {
      const next = change(transaction.get<T>(key));
      if (next === null) transaction.delete(key);
      else transaction.set(key, next);
    });
  }

  async transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    const declared = [...new Set(keys)];
    if (!declared.length) throw new Error('Client storage transaction requires at least one key');
    const localLegacy = new Map(
      declared.map(key => [key, legacyLocalValue(key)] as const),
    );
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const includesLegacyDeviceKey = declared.includes(DEVICE_KEYS_KEY)
          && db.objectStoreNames.contains(LEGACY_KEY_STORE);
        const transaction = db.transaction(
          includesLegacyDeviceKey
            ? [STATE_STORE, LEGACY_KEY_STORE]
            : [STATE_STORE],
          'readwrite',
        );
        const store = transaction.objectStore(STATE_STORE);
        const legacyStore = includesLegacyDeviceKey
          ? transaction.objectStore(LEGACY_KEY_STORE)
          : undefined;
        const values = new Map<string, unknown>();
        const records = new Map<string, StateRecord | undefined>();
        let legacyDeviceKeys: unknown;
        let remaining = declared.length + (legacyStore ? 1 : 0);
        let operationError: unknown;
        const assertDeclared = (key: string) => {
          if (!declared.includes(key)) {
            throw new Error(`Client storage transaction did not declare key: ${key}`);
          }
        };
        const apply = () => {
          try {
            for (const key of declared) {
              const record = records.get(key);
              if (record !== undefined) {
                if (!record.deleted) values.set(key, record.value);
                continue;
              }
              if (key === DEVICE_KEYS_KEY && legacyDeviceKeys !== undefined) {
                values.set(key, legacyDeviceKeys);
                continue;
              }
              const legacy = localLegacy.get(key);
              if (legacy?.found) values.set(key, legacy.value);
            }
            const returned = change({
              get: <T>(key: string) => {
                assertDeclared(key);
                return (values.get(key) as T | undefined) ?? null;
              },
              set: <T>(key: string, value: T) => {
                assertDeclared(key);
                values.set(key, value);
              },
              delete: (key: string) => {
                assertDeclared(key);
                values.delete(key);
              },
            }) as unknown;
            if (
              returned
              && typeof (returned as { then?: unknown }).then === 'function'
            ) {
              throw new Error('Client storage transaction callback must be synchronous');
            }
            for (const key of declared) {
              if (values.has(key)) {
                store.put({ key, value: values.get(key) } satisfies StateRecord);
              } else {
                // A durable tombstone makes canonical absence authoritative.
                // Without it, another tab could re-materialize stale
                // localStorage after a concurrent clear commits.
                store.put({ key, deleted: true } satisfies StateRecord);
              }
            }
            legacyStore?.delete('current');
          } catch (error) {
            operationError = error;
            try { transaction.abort(); } catch { reject(error); }
          }
        };
        for (const key of declared) {
          const request = store.get(key);
          request.onsuccess = () => {
            records.set(key, request.result as StateRecord | undefined);
            remaining -= 1;
            if (remaining === 0) apply();
          };
          request.onerror = () => {
            operationError = request.error;
          };
        }
        if (legacyStore) {
          const request = legacyStore.get('current');
          request.onsuccess = () => {
            legacyDeviceKeys = request.result;
            remaining -= 1;
            if (remaining === 0) apply();
          };
          request.onerror = () => {
            operationError = request.error;
          };
        }
        transaction.oncomplete = () => {
          for (const key of declared) {
            try { localStorage.removeItem(key); } catch {
              // IndexedDB is authoritative once the transaction commits.
            }
          }
          resolve();
        };
        transaction.onerror = () => reject(
          operationError ?? transaction.error ?? new Error('Client storage transaction failed'),
        );
        transaction.onabort = () => reject(
          operationError ?? transaction.error ?? new Error('Client storage transaction aborted'),
        );
      });
    } finally {
      db.close();
    }
  }
}

export const clientStorage=new IndexedDbClientStorage();
export const deviceKeyStore=new DeviceKeyStore(clientStorage);
export const relaySessionStore=new RelaySessionStore(clientStorage);
