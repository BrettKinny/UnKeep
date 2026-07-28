import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';
import { validateNoteId } from '../validation.js';
import { normalizeNoteRecord } from '../noteMigrations.js';

export const LEGACY_LOCAL_DATABASE_NAME = 'unkeep';
const VAULT_DATABASE_PREFIX = 'unkeep-vault-';
export const LOCAL_DATABASE_VERSION = 2;
const STORE_NAME = 'notes';

export function validateVaultNamespace(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Invalid vault namespace: expected 1-128 ASCII letters, numbers, dots, underscores, or hyphens, starting with a letter or number');
  }
  return value;
}

export function localDatabaseName(config: AdapterConfig = {}): string {
  if (config.vaultNamespace === undefined) return LEGACY_LOCAL_DATABASE_NAME;
  return `${VAULT_DATABASE_PREFIX}${validateVaultNamespace(config.vaultNamespace)}`;
}

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, LOCAL_DATABASE_VERSION);
    let upgradeError: unknown;
    request.onupgradeneeded = () => {
      try {
        if (!request.transaction) throw new Error('IndexedDB upgrade transaction is unavailable');
        upgradeLocalDatabase(request.result, request.transaction, error => { upgradeError = error; });
      } catch (error) {
        upgradeError = error;
        request.transaction?.abort();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(upgradeError ?? request.error);
  });
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

export function upgradeLocalDatabase(
  db: IDBDatabase,
  transaction: IDBTransaction,
  onError: (error: unknown) => void = () => {},
): void {
  const exists = db.objectStoreNames.contains(STORE_NAME);
  const store = exists
    ? transaction.objectStore(STORE_NAME)
    : db.createObjectStore(STORE_NAME, { keyPath: 'id' });
  ensureIndex(store, 'updatedAt', 'updatedAt');
  ensureIndex(store, 'pinned', 'pinned');
  ensureIndex(store, 'archived', 'archived');
  if (!exists) return;

  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    try {
      cursor.update(normalizeNoteRecord(cursor.value));
      cursor.continue();
    } catch (error) {
      onError(error);
      transaction.abort();
    }
  };
}

function txn<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    let result: T;
    request.onsuccess = () => {
      result = request.result;
      if (mode === 'readonly') resolve(result);
    };
    request.onerror = () => reject(request.error);
    if (mode !== 'readonly') {
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error('IndexedDB transaction was aborted'));
    }
  });
}

export class LocalOnlyAdapter implements StorageAdapter {
  id = 'local';
  displayName = 'Local Only';
  description = 'Store notes in your browser. No sync, no account needed.';
  configSchema: ConfigField[] = [];

  private db: IDBDatabase | null = null;

  async init(_config: AdapterConfig): Promise<void> {
    this.db = await openDB(localDatabaseName(_config));
  }

  async validate(_config: AdapterConfig): Promise<ValidationResult> {
    try {
      const db = await openDB(localDatabaseName(_config));
      db.close();
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `IndexedDB unavailable: ${e}` };
    }
  }

  private getDB(): IDBDatabase {
    if (!this.db) throw new Error('LocalOnlyAdapter not initialized. Call init() first.');
    return this.db;
  }

  async listNotes(): Promise<NoteMetadata[]> {
    const db = this.getDB();
    const records = await txn<unknown[]>(db, 'readonly', (store) => store.getAll());
    const notes = records.map(normalizeNoteRecord);
    return notes.map((n) => ({
      id: n.id,
      updatedAt: n.updatedAt,
      deleted: n.deleted,
    }));
  }

  async getNote(id: string): Promise<Note> {
    validateNoteId(id);
    const db = this.getDB();
    const record = await txn<unknown>(db, 'readonly', (store) => store.get(id));
    if (record === undefined) throw new Error(`Note not found: ${id}`);
    return normalizeNoteRecord(record);
  }

  async saveNote(note: Note): Promise<void> {
    validateNoteId(note.id);
    const db = this.getDB();
    await txn(db, 'readwrite', (store) => store.put(normalizeNoteRecord(note)));
  }

  async saveNotesAtomically(notes: Note[]): Promise<void> {
    const normalized = notes.map(note => {
      validateNoteId(note.id);
      return normalizeNoteRecord(note);
    });
    if (normalized.length === 0) return;

    const db = this.getDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let writeError: unknown;

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(writeError ?? transaction.error ?? new Error('Atomic note import failed'));
      transaction.onabort = () => reject(writeError ?? transaction.error ?? new Error('Atomic note import was aborted'));

      try {
        for (const note of normalized) {
          const request = store.put(note);
          request.onerror = () => {
            writeError = request.error ?? new Error(`Failed to import note ${note.id}`);
          };
        }
      } catch (error) {
        writeError = error;
        transaction.abort();
      }
    });
  }

  async deleteNote(id: string): Promise<void> {
    validateNoteId(id);
    const db = this.getDB();
    // Soft delete
    const note = await this.getNote(id);
    note.deleted = true;
    note.updatedAt = Date.now();
    await txn(db, 'readwrite', (store) => store.put(note));
  }

  async getAllNotes(): Promise<Note[]> {
    const db = this.getDB();
    const records = await txn<unknown[]>(db, 'readonly', (store) => store.getAll());
    return records.map(normalizeNoteRecord);
  }

  async sync(): Promise<SyncResult> {
    // No remote sync for local-only
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
