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

    expect(LOCAL_DATABASE_VERSION).toBe(4);
    upgradeLocalDatabase(db, transaction);

    expect(createObjectStore).toHaveBeenCalledWith('notes', { keyPath: 'id' });
    expect(createObjectStore).toHaveBeenCalledWith('pending-sync', { keyPath: 'id' });
    expect(createObjectStore).toHaveBeenCalledWith('note-creation-claims', { keyPath: 'id' });
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
      schemaVersion: 2,
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
  it('atomically queues the exact note snapshot and reports a quota-aborted transaction', async () => {
    const noteWrites: Note[] = [];
    const pendingWrites: Array<{ id: string; token: string; note: Note }> = [];
    const stores = {
      notes: {
        put: (value: Note) => {
          noteWrites.push(value);
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          pendingWrites.push(value);
          return {} as IDBRequest<IDBValidKey>;
        },
      },
    };
    const transaction = {
      objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
      error: new DOMException('Storage quota exceeded', 'QuotaExceededError'),
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
      const value = {
        id: 'atomic-note',
        content: 'Never untracked',
        createdAt: 1,
        updatedAt: 2,
        pinned: false,
        archived: false,
      };

      const beforeAttachments = { ...value, content: 'Safe predecessor' };
      const saving = adapter.saveNoteWithPendingSync(value, { beforeAttachments });

      expect(db.transaction).toHaveBeenCalledWith(['notes', 'pending-sync'], 'readwrite');
      expect(noteWrites).toEqual([expect.objectContaining({ ...value, schemaVersion: 2 })]);
      expect(pendingWrites).toEqual([{
        id: value.id,
        token: expect.any(String),
        note: expect.objectContaining({ ...value, schemaVersion: 2 }),
        beforeAttachments: expect.objectContaining({
          ...beforeAttachments,
          schemaVersion: 2,
        }),
      }]);
      transaction.onabort?.({} as Event);
      await expect(saving).rejects.toThrow('Storage quota exceeded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not clear a newer queued snapshot when an older cross-tab push finishes', async () => {
    const queued = {
      id: 'shared-note',
      token: 'newer-token',
      note: {
        id: 'shared-note',
        content: 'newer local edit',
        createdAt: 1,
        updatedAt: 3,
        pinned: false,
        archived: false,
      },
    };
    const remove = vi.fn(() => ({} as IDBRequest<undefined>));
    const store = {
      get: () => successfulRequest(queued),
      delete: remove,
    } as unknown as IDBObjectStore;
    const db = {
      transaction: () => {
        const transaction = {
          objectStore: () => store,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});

      await expect(adapter.completePendingNoteSync('shared-note', 'older-token')).resolves.toBe(false);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates an idempotent received note only once across adapter instances', async () => {
    const notes = new Map<string, Note>();
    const queued = new Map<string, { id: string; token: string; note: Note }>();
    const stores = {
      notes: {
        get: (id: string) => successfulRequest(notes.get(id)),
        put: (value: Note) => {
          notes.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          queued.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
    };
    const db = {
      transaction: () => {
        const transaction = {
          objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const firstTab = new LocalOnlyAdapter();
      const secondTab = new LocalOnlyAdapter();
      await Promise.all([firstTab.init({}), secondTab.init({})]);
      const value: Note = {
        id: 'shared_share-token',
        content: 'save me once',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        archived: false,
      };

      const first = await firstTab.createNoteWithPendingSyncIfAbsent(value);
      const second = await secondTab.createNoteWithPendingSyncIfAbsent(value);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(notes).toHaveLength(1);
      expect(queued).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('claims received-note creation before attachment staging across tabs', async () => {
    const notes = new Map<string, Note>();
    const claims = new Map<string, { id: string; token: string; claimedAt: number }>();
    const queued = new Map<string, { id: string; token: string; note: Note }>();
    const stores = {
      notes: {
        get: (id: string) => successfulRequest(notes.get(id)),
        put: (value: Note) => {
          notes.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'note-creation-claims': {
        get: (id: string) => successfulRequest(claims.get(id)),
        put: (value: { id: string; token: string; claimedAt: number }) => {
          claims.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
        delete: (id: string) => {
          claims.delete(id);
          return {} as IDBRequest<undefined>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          queued.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
    };
    const db = {
      transaction: () => {
        const transaction = {
          objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const firstTab = new LocalOnlyAdapter();
      const secondTab = new LocalOnlyAdapter();
      await Promise.all([firstTab.init({}), secondTab.init({})]);

      const first = await firstTab.claimNoteCreation('shared_claimed-note', 100);
      const second = await secondTab.claimNoteCreation('shared_claimed-note', 101);

      expect(first.status).toBe('claimed');
      expect(second).toEqual({ status: 'busy' });
      if (first.status !== 'claimed') throw new Error('Expected the first tab to own the claim');
      const finalized = await firstTab.finalizeClaimedNote({
        id: 'shared_claimed-note',
        content: 'with an attachment',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        archived: false,
      }, first.claim.token);
      const retry = await secondTab.claimNoteCreation('shared_claimed-note', 102);

      expect(finalized.created).toBe(true);
      expect(retry).toMatchObject({
        status: 'existing',
        note: { id: 'shared_claimed-note', content: 'with an attachment' },
      });
      expect(claims).toHaveLength(0);
      expect(notes).toHaveLength(1);
      expect(queued).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('durably re-queues a legacy pending note from its current stored snapshot', async () => {
    const stored: Note = {
      id: 'legacy-pending',
      content: 'recover this edit',
      createdAt: 1,
      updatedAt: 4,
      pinned: false,
      archived: false,
    };
    let queued: { id: string; token: string; note: Note } | undefined;
    const stores = {
      notes: { get: () => successfulRequest(stored) },
      'pending-sync': {
        get: () => successfulRequest(queued),
        put: (value: { id: string; token: string; note: Note }) => {
          queued = value;
          return {} as IDBRequest<IDBValidKey>;
        },
        getAll: () => successfulRequest(queued ? [queued] : []),
      },
    };
    const db = {
      transaction: () => {
        const transaction = {
          objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});

      const recovered = await adapter.queueNoteForSync(stored.id);
      const pending = await adapter.listPendingNoteSync();

      expect(recovered?.note).toMatchObject({ id: stored.id, content: stored.content });
      expect(pending).toEqual([expect.objectContaining({
        id: stored.id,
        token: recovered?.token,
        note: expect.objectContaining({ id: stored.id, content: stored.content }),
      })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

      expect(writes[0]).toMatchObject({ schemaVersion: 2, id: 'new-note' });
      await expect(adapter.getNote('legacy-note')).resolves.toEqual({
        schemaVersion: 2,
        id: 'legacy-note',
        content: 'Legacy',
        createdAt: 1,
        updatedAt: 2,
        pinned: false,
        archived: false,
      });
      expect(opened).toEqual([{ name: 'unkeep-vault-vault-one', version: 4 }]);
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
      expect(writes.every(note => note.schemaVersion === 2)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('commits an import batch and every matching outbox snapshot together', async () => {
    const noteWrites: Note[] = [];
    const pendingWrites: Array<{ id: string; token: string; note: Note }> = [];
    const stores = {
      notes: {
        put: (value: Note) => {
          noteWrites.push(value);
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          pendingWrites.push(value);
          return {} as IDBRequest<IDBValidKey>;
        },
      },
    };
    const transaction = {
      objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
      error: null,
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
      const values: Note[] = [
        { id: 'one', content: 'One', createdAt: 1, updatedAt: 1, pinned: false, archived: false },
        { id: 'two', content: 'Two', createdAt: 2, updatedAt: 2, pinned: false, archived: false },
      ];
      const committing = adapter.saveNotesWithPendingSyncAtomically(values);
      transaction.oncomplete?.({} as Event);
      const queued = await committing;

      expect(db.transaction).toHaveBeenCalledWith(['notes', 'pending-sync'], 'readwrite');
      expect(noteWrites.map(value => value.id)).toEqual(['one', 'two']);
      expect(pendingWrites.map(value => value.note.id)).toEqual(['one', 'two']);
      expect(queued.map(value => value.id)).toEqual(['one', 'two']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('commits an import receipt with its note batch and outbox snapshots', async () => {
    const noteWrites = new Map<string, Note>();
    const pendingWrites = new Map<string, { id: string; token: string; note: Note }>();
    const claims = new Map<string, unknown>();
    const stores = {
      notes: {
        put: (value: Note) => {
          noteWrites.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          pendingWrites.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'note-creation-claims': {
        get: (id: string) => successfulRequest(claims.get(id)),
        put: (value: { id: string }) => {
          claims.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
        delete: (id: string) => {
          claims.delete(id);
          return {} as IDBRequest<undefined>;
        },
      },
    };
    const db = {
      transaction: vi.fn(() => {
        const transaction = {
          objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      }),
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      await adapter.prepareImportCommit('commit-one');
      const values: Note[] = [
        { id: 'one', content: 'One', createdAt: 1, updatedAt: 1, pinned: false, archived: false },
        { id: 'two', content: 'Two', createdAt: 2, updatedAt: 2, pinned: false, archived: false },
      ];

      await adapter.saveNotesWithPendingSyncAtomically(values, {
        importCommitToken: 'commit-one',
      });

      expect(db.transaction).toHaveBeenLastCalledWith(
        ['notes', 'pending-sync', 'note-creation-claims'],
        'readwrite',
      );
      expect([...noteWrites.keys()]).toEqual(expect.arrayContaining(['one', 'two']));
      expect([...pendingWrites.keys()]).toEqual(expect.arrayContaining(['one', 'two']));
      expect(claims.get('import-commit:commit-one')).toEqual({
        id: 'import-commit:commit-one',
        token: 'commit-one',
        kind: 'import-commit',
        state: 'committed',
      });
      await expect(adapter.cancelImportCommit('commit-one')).resolves.toBe('committed');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fences a stale import writer after recovery cancels its receipt', async () => {
    const noteWrites: Note[] = [];
    const pendingWrites: Array<{ id: string; token: string; note: Note }> = [];
    const claims = new Map<string, unknown>();
    const stores = {
      notes: {
        put: (value: Note) => {
          noteWrites.push(structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'pending-sync': {
        put: (value: { id: string; token: string; note: Note }) => {
          pendingWrites.push(structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
      },
      'note-creation-claims': {
        get: (id: string) => successfulRequest(claims.get(id)),
        put: (value: { id: string }) => {
          claims.set(value.id, structuredClone(value));
          return {} as IDBRequest<IDBValidKey>;
        },
        delete: (id: string) => {
          claims.delete(id);
          return {} as IDBRequest<undefined>;
        },
      },
    };
    const db = {
      transaction: () => {
        const transaction = {
          objectStore: (name: keyof typeof stores) => stores[name] as unknown as IDBObjectStore,
          error: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.({} as Event), 0);
        return transaction;
      },
      close: vi.fn(),
    } as unknown as IDBDatabase;
    vi.stubGlobal('indexedDB', {
      open: () => successfulRequest(db) as unknown as IDBOpenDBRequest,
    });

    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      await adapter.prepareImportCommit('cancelled-import');
      await expect(adapter.cancelImportCommit('cancelled-import'))
        .resolves.toBe('cancelled');

      await expect(adapter.saveNotesWithPendingSyncAtomically([
        {
          id: 'must-not-commit',
          content: 'stale writer',
          createdAt: 1,
          updatedAt: 1,
          pinned: false,
          archived: false,
        },
      ], {
        importCommitToken: 'cancelled-import',
      })).rejects.toThrow('Import commit is cancelled');

      expect(noteWrites).toEqual([]);
      expect(pendingWrites).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
