import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_LOCAL_DATABASE_NAME,
  LOCAL_DATABASE_VERSION,
  localDatabaseName,
  upgradeLocalDatabase,
  validateVaultNamespace,
  LocalOnlyAdapter,
} from './local.js';
import type { Note } from '../types.js';
import { UnsupportedNoteSchemaVersionError } from '../noteMigrations.js';

function successfulRequest<T>(result: T): IDBRequest<T> {
  const request = { result } as unknown as IDBRequest<T>;
  queueMicrotask(() => request.onsuccess?.({} as Event));
  return request;
}

describe('local database naming', () => {
  it('preserves the legacy database for unscoped callers and isolates named vaults deterministically', () => {
    expect(localDatabaseName({})).toBe(LEGACY_LOCAL_DATABASE_NAME);
    expect(localDatabaseName({ vaultNamespace: 'relay-01.example' })).toBe(
      'unkeep-vault-relay-01.example',
    );
    expect(localDatabaseName({ vaultNamespace: 'relay-01.example' })).toBe(
      localDatabaseName({ vaultNamespace: 'relay-01.example' }),
    );
    expect(localDatabaseName({ vaultNamespace: 'relay-02.example' })).not.toBe(
      localDatabaseName({ vaultNamespace: 'relay-01.example' }),
    );
  });

  it('rejects unsafe or ambiguous namespace values', () => {
    for (const value of ['', ' has-space', 'vault/name', 'café', '.hidden', 'x'.repeat(129)]) {
      expect(() => validateVaultNamespace(value)).toThrow('Invalid vault namespace');
    }
    expect(() => localDatabaseName({ vaultNamespace: 42 })).toThrow('Invalid vault namespace');
  });
});

describe('local database upgrades', () => {
  it('creates the versioned notes store and indexes for a new database', () => {
    const indexes: Array<{ name: string; keyPath: string }> = [];
    const store = {
      indexNames: { contains: () => false },
      createIndex: (name: string, keyPath: string) => {
        indexes.push({ name, keyPath });
      },
    } as unknown as IDBObjectStore;
    const createObjectStore = vi.fn(() => store);
    const db = {
      objectStoreNames: { contains: () => false },
      createObjectStore,
    } as unknown as IDBDatabase;
    const transaction = { objectStore: vi.fn() } as unknown as IDBTransaction;

    expect(LOCAL_DATABASE_VERSION).toBe(2);
    upgradeLocalDatabase(db, transaction);

    expect(createObjectStore).toHaveBeenCalledWith('notes', { keyPath: 'id' });
    expect(indexes).toEqual([
      { name: 'updatedAt', keyPath: 'updatedAt' },
      { name: 'pinned', keyPath: 'pinned' },
      { name: 'archived', keyPath: 'archived' },
    ]);
  });

  it('normalizes every legacy record while upgrading an existing database', () => {
    const cursorRequest = {} as IDBRequest<IDBCursorWithValue | null>;
    const update = vi.fn();
    const continueCursor = vi.fn();
    const store = {
      indexNames: { contains: () => true },
      createIndex: vi.fn(),
      openCursor: vi.fn(() => cursorRequest),
    } as unknown as IDBObjectStore;
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
    } as unknown as IDBDatabase;
    const transaction = {
      objectStore: vi.fn(() => store),
      abort: vi.fn(),
    } as unknown as IDBTransaction;

    upgradeLocalDatabase(db, transaction);
    Object.defineProperty(cursorRequest, 'result', { value: {
      value: {
        id: 'legacy-note',
        content: 'Legacy',
        createdAt: 1,
        updatedAt: 2,
      },
      update,
      continue: continueCursor,
    } as unknown as IDBCursorWithValue });
    cursorRequest.onsuccess?.call(cursorRequest, {} as Event);

    expect(update).toHaveBeenCalledWith({
      id: 'legacy-note',
      content: 'Legacy',
      createdAt: 1,
      updatedAt: 2,
      schemaVersion: 1,
      pinned: false,
      archived: false,
    });
    expect(continueCursor).toHaveBeenCalledOnce();
  });

  it('aborts an upgrade instead of downgrading a future-version record', () => {
    const cursorRequest = {} as IDBRequest<IDBCursorWithValue | null>;
    const update = vi.fn();
    const store = {
      indexNames: { contains: () => true },
      openCursor: () => cursorRequest,
    } as unknown as IDBObjectStore;
    const abort = vi.fn();
    const transaction = {
      objectStore: () => store,
      abort,
    } as unknown as IDBTransaction;
    const db = {
      objectStoreNames: { contains: () => true },
    } as unknown as IDBDatabase;
    const onError = vi.fn();

    upgradeLocalDatabase(db, transaction, onError);
    Object.defineProperty(cursorRequest, 'result', { value: {
      value: {
        schemaVersion: 999,
        id: 'future-note',
        content: '',
        createdAt: 1,
        updatedAt: 2,
        pinned: false,
        archived: false,
      },
      update,
      continue: vi.fn(),
    } as unknown as IDBCursorWithValue });
    cursorRequest.onsuccess?.call(cursorRequest, {} as Event);

    expect(update).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(UnsupportedNoteSchemaVersionError));
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe('LocalOnlyAdapter schema boundaries', () => {
  it('does not report a note saved until its IndexedDB transaction commits', async () => {
    const writeRequest = {} as IDBRequest<IDBValidKey>;
    const store = {
      put: () => writeRequest,
    } as unknown as IDBObjectStore;
    const transaction = {
      objectStore: () => store,
      error: null,
    } as unknown as IDBTransaction;
    const db = {
      transaction: () => transaction,
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      const saving = adapter.saveNote({
        id: 'durable-note',
        content: 'Wait for commit',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        archived: false,
      });

      writeRequest.onsuccess?.({} as Event);
      const outcome = await Promise.race([
        saving.then(() => 'saved'),
        new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 0)),
      ]);

      expect(outcome).toBe('pending');
      transaction.oncomplete?.({} as Event);
      await saving;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a save failure when IndexedDB aborts after accepting the write request', async () => {
    const writeRequest = {} as IDBRequest<IDBValidKey>;
    const store = { put: () => writeRequest } as unknown as IDBObjectStore;
    const transaction = {
      objectStore: () => store,
      error: new DOMException('Storage quota exceeded', 'QuotaExceededError'),
    } as unknown as IDBTransaction;
    const db = {
      transaction: () => transaction,
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      const saving = adapter.saveNote({
        id: 'aborted-note',
        content: 'Must not appear durable',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        archived: false,
      });

      writeRequest.onsuccess?.({} as Event);
      transaction.onabort?.({} as Event);

      await expect(saving).rejects.toThrow('Storage quota exceeded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('writes current records and normalizes legacy records read from IndexedDB', async () => {
    const records = new Map<string, unknown>([[
      'legacy-note',
      { id: 'legacy-note', content: 'Legacy', createdAt: 1, updatedAt: 2 },
    ]]);
    const writes: unknown[] = [];
    const store = {
      put: (value: Note) => {
        writes.push(value);
        records.set(value.id, value);
        return successfulRequest(value.id);
      },
      get: (id: string) => successfulRequest(records.get(id)),
    } as unknown as IDBObjectStore;
    const db = {
      transaction: () => {
        const transaction = { objectStore: () => store } as unknown as IDBTransaction;
        queueMicrotask(() => transaction.oncomplete?.({} as Event));
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    const opened: Array<{ name: string; version: number }> = [];
    vi.stubGlobal('indexedDB', {
      open: (name: string, version: number) => {
        opened.push({ name, version });
        return successfulRequest(db) as unknown as IDBOpenDBRequest;
      },
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({ vaultNamespace: 'vault-one' });
      await adapter.saveNote({
        id: 'new-note',
        content: 'New',
        createdAt: 3,
        updatedAt: 4,
        pinned: false,
        archived: false,
      });

      expect(writes[0]).toMatchObject({ schemaVersion: 1, id: 'new-note' });
      await expect(adapter.getNote('legacy-note')).resolves.toEqual({
        schemaVersion: 1,
        id: 'legacy-note',
        content: 'Legacy',
        createdAt: 1,
        updatedAt: 2,
        pinned: false,
        archived: false,
      });
      expect(opened).toEqual([{ name: 'unkeep-vault-vault-one', version: 2 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('writes an import batch through one IndexedDB transaction and waits for commit', async () => {
    const writes: Note[] = [];
    const store = {
      put: (value: Note) => {
        writes.push(value);
        return {} as IDBRequest<IDBValidKey>;
      },
    } as unknown as IDBObjectStore;
    const transaction = {
      objectStore: () => store,
      error: null,
      abort: vi.fn(),
    } as unknown as IDBTransaction;
    const db = {
      transaction: vi.fn(() => transaction),
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      const pending = adapter.saveNotesAtomically([
        { id: 'one', content: 'One', createdAt: 1, updatedAt: 1, pinned: false, archived: false },
        { id: 'two', content: 'Two', createdAt: 2, updatedAt: 2, pinned: false, archived: false },
      ]);
      let committed = false;
      void pending.then(() => { committed = true; });
      await Promise.resolve();
      expect(committed).toBe(false);
      transaction.oncomplete?.({} as Event);
      await pending;

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(writes).toHaveLength(2);
      expect(writes.every(note => note.schemaVersion === 1)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
