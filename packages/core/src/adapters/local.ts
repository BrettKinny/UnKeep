import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';
import { validateNoteId } from '../validation.js';

const DB_NAME = 'unkeep';
const DB_VERSION = 1;
const STORE_NAME = 'notes';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('pinned', 'pinned', { unique: false });
        store.createIndex('archived', 'archived', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class LocalOnlyAdapter implements StorageAdapter {
  id = 'local';
  displayName = 'Local Only';
  description = 'Store notes in your browser. No sync, no account needed.';
  configSchema: ConfigField[] = [];

  private db: IDBDatabase | null = null;

  async init(_config: AdapterConfig): Promise<void> {
    this.db = await openDB();
  }

  async validate(_config: AdapterConfig): Promise<ValidationResult> {
    try {
      const db = await openDB();
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
    const notes = await txn<Note[]>(db, 'readonly', (store) => store.getAll());
    return notes.map((n) => ({
      id: n.id,
      updatedAt: n.updatedAt,
      deleted: n.deleted,
    }));
  }

  async getNote(id: string): Promise<Note> {
    validateNoteId(id);
    const db = this.getDB();
    const note = await txn<Note | undefined>(db, 'readonly', (store) => store.get(id));
    if (!note) throw new Error(`Note not found: ${id}`);
    return note;
  }

  async saveNote(note: Note): Promise<void> {
    validateNoteId(note.id);
    const db = this.getDB();
    await txn(db, 'readwrite', (store) => store.put(note));
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
    return txn<Note[]>(db, 'readonly', (store) => store.getAll());
  }

  async sync(): Promise<SyncResult> {
    // No remote sync for local-only
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
