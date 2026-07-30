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
export const LOCAL_DATABASE_VERSION = 4;
const STORE_NAME = 'notes';
const PENDING_SYNC_STORE_NAME = 'pending-sync';
const NOTE_CREATION_CLAIM_STORE_NAME = 'note-creation-claims';
export const NOTE_CREATION_CLAIM_TTL_MS = 30_000;

export interface PendingNoteSync {
  id: string;
  token: string;
  note: Note;
  /** Safe predecessor pushed before attachment uploads (used by tombstone Undo). */
  beforeAttachments?: Note;
}

export type CreateNoteWithPendingSyncResult =
  | { created: true; note: Note; pending: PendingNoteSync }
  | { created: false; note: Note };

export interface NoteCreationClaim {
  id: string;
  token: string;
  claimedAt: number;
}

export type ImportCommitState = 'pending' | 'committed' | 'cancelled' | 'none';

interface ImportCommitRecord {
  id: string;
  token: string;
  kind: 'import-commit';
  state: Exclude<ImportCommitState, 'none'>;
}

export type ClaimNoteCreationResult =
  | { status: 'claimed'; claim: NoteCreationClaim }
  | { status: 'busy' }
  | { status: 'existing'; note: Note };

/**
 * A local working copy whose sync intent is committed in the same transaction
 * as each user-authored note mutation.
 */
export interface DurableNoteStorageAdapter extends StorageAdapter {
  saveNoteWithPendingSync(
    note: Note,
    options?: { beforeAttachments?: Note },
  ): Promise<PendingNoteSync>;
  saveNotesWithPendingSyncAtomically(
    notes: Note[],
    options?: { importCommitToken?: string },
  ): Promise<PendingNoteSync[]>;
  prepareImportCommit(token: string): Promise<void>;
  importCommitState(token: string): Promise<ImportCommitState>;
  cancelImportCommit(token: string): Promise<ImportCommitState>;
  clearImportCommit(token: string): Promise<void>;
  createNoteWithPendingSyncIfAbsent(note: Note): Promise<CreateNoteWithPendingSyncResult>;
  claimNoteCreation(id: string, now?: number): Promise<ClaimNoteCreationResult>;
  renewNoteCreationClaim(id: string, claimToken: string, now?: number): Promise<boolean>;
  finalizeClaimedNote(note: Note, claimToken: string): Promise<CreateNoteWithPendingSyncResult>;
  releaseNoteCreationClaim(id: string, claimToken: string): Promise<boolean>;
  queueNoteForSync(id: string): Promise<PendingNoteSync | null>;
  listPendingNoteSync(): Promise<PendingNoteSync[]>;
  completePendingNoteSync(id: string, token: string): Promise<boolean>;
}

function pendingNoteSync(note: Note, beforeAttachments?: Note): PendingNoteSync {
  const predecessor = beforeAttachments
    ? normalizeNoteRecord(beforeAttachments)
    : undefined;
  if (predecessor && predecessor.id !== note.id) {
    throw new Error('Pending note predecessor ID does not match its note');
  }
  return {
    id: note.id,
    token: crypto.randomUUID(),
    note: structuredClone(note),
    ...(predecessor ? { beforeAttachments: structuredClone(predecessor) } : {}),
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function normalizePendingNoteSync(value: unknown): PendingNoteSync {
  if (!value || typeof value !== 'object') throw new Error('Invalid pending note sync record');
  const candidate = value as Partial<PendingNoteSync>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.token !== 'string'
    || candidate.token.length === 0
    || !candidate.note
  ) {
    throw new Error('Invalid pending note sync record');
  }
  validateNoteId(candidate.id);
  const note = normalizeNoteRecord(candidate.note);
  if (note.id !== candidate.id) throw new Error('Pending note sync record ID does not match its note');
  const beforeAttachments = candidate.beforeAttachments
    ? normalizeNoteRecord(candidate.beforeAttachments)
    : undefined;
  if (beforeAttachments && beforeAttachments.id !== candidate.id) {
    throw new Error('Pending note predecessor ID does not match its note');
  }
  return {
    id: candidate.id,
    token: candidate.token,
    note,
    ...(beforeAttachments ? { beforeAttachments } : {}),
  };
}

function normalizeNoteCreationClaim(value: unknown): NoteCreationClaim {
  if (!value || typeof value !== 'object') throw new Error('Invalid note creation claim');
  const candidate = value as Partial<NoteCreationClaim>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.token !== 'string'
    || candidate.token.length === 0
    || typeof candidate.claimedAt !== 'number'
    || !Number.isFinite(candidate.claimedAt)
  ) {
    throw new Error('Invalid note creation claim');
  }
  validateNoteId(candidate.id);
  return {
    id: candidate.id,
    token: candidate.token,
    claimedAt: candidate.claimedAt,
  };
}

function importCommitKey(token: string): string {
  if (!token) throw new Error('Import commit token is required');
  return `import-commit:${token}`;
}

function normalizeImportCommit(value: unknown, token: string): ImportCommitRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid import commit record');
  const candidate = value as Partial<ImportCommitRecord>;
  if (
    candidate.id !== importCommitKey(token)
    || candidate.token !== token
    || candidate.kind !== 'import-commit'
    || (
      candidate.state !== 'pending'
      && candidate.state !== 'committed'
      && candidate.state !== 'cancelled'
    )
  ) {
    throw new Error('Invalid import commit record');
  }
  return candidate as ImportCommitRecord;
}

function transactionCompletion(
  transaction: IDBTransaction,
  fallbackMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(fallbackMessage));
    transaction.onabort = () => reject(transaction.error ?? new Error(fallbackMessage));
  });
}

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
  if (!db.objectStoreNames.contains(PENDING_SYNC_STORE_NAME)) {
    db.createObjectStore(PENDING_SYNC_STORE_NAME, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(NOTE_CREATION_CLAIM_STORE_NAME)) {
    db.createObjectStore(NOTE_CREATION_CLAIM_STORE_NAME, { keyPath: 'id' });
  }
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

export class LocalOnlyAdapter implements DurableNoteStorageAdapter {
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

  async saveNoteWithPendingSync(
    note: Note,
    { beforeAttachments }: { beforeAttachments?: Note } = {},
  ): Promise<PendingNoteSync> {
    validateNoteId(note.id);
    const normalized = normalizeNoteRecord(note);
    const pending = pendingNoteSync(normalized, beforeAttachments);
    const db = this.getDB();
    const transaction = db.transaction([STORE_NAME, PENDING_SYNC_STORE_NAME], 'readwrite');
    const completion = transactionCompletion(transaction, 'Atomic note and sync queue write failed');
    transaction.objectStore(STORE_NAME).put(normalized);
    transaction.objectStore(PENDING_SYNC_STORE_NAME).put(pending);
    await completion;
    return pending;
  }

  async createNoteWithPendingSyncIfAbsent(
    note: Note,
  ): Promise<CreateNoteWithPendingSyncResult> {
    validateNoteId(note.id);
    const normalized = normalizeNoteRecord(note);
    const db = this.getDB();
    const transaction = db.transaction([STORE_NAME, PENDING_SYNC_STORE_NAME], 'readwrite');
    const completion = transactionCompletion(transaction, 'Idempotent note creation failed');
    const notes = transaction.objectStore(STORE_NAME);
    const existing = await requestResult(notes.get(normalized.id));
    if (existing !== undefined) {
      const stored = normalizeNoteRecord(existing);
      await completion;
      return { created: false, note: stored };
    }
    const pending = pendingNoteSync(normalized);
    notes.put(normalized);
    transaction.objectStore(PENDING_SYNC_STORE_NAME).put(pending);
    await completion;
    return { created: true, note: normalized, pending };
  }

  async claimNoteCreation(
    id: string,
    now = Date.now(),
  ): Promise<ClaimNoteCreationResult> {
    validateNoteId(id);
    if (!Number.isFinite(now)) throw new Error('Note creation claim time must be finite');
    const db = this.getDB();
    const transaction = db.transaction(
      [STORE_NAME, NOTE_CREATION_CLAIM_STORE_NAME],
      'readwrite',
    );
    const completion = transactionCompletion(transaction, 'Note creation claim failed');
    const existing = await requestResult(transaction.objectStore(STORE_NAME).get(id));
    const claims = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    if (existing !== undefined) {
      claims.delete(id);
      const note = normalizeNoteRecord(existing);
      await completion;
      return { status: 'existing', note };
    }
    const storedClaim = await requestResult(claims.get(id));
    if (storedClaim !== undefined) {
      const claim = normalizeNoteCreationClaim(storedClaim);
      if (claim.claimedAt > now + NOTE_CREATION_CLAIM_TTL_MS) {
        throw new Error('Note creation claim timestamp is unexpectedly in the future');
      }
      if (now - claim.claimedAt < NOTE_CREATION_CLAIM_TTL_MS) {
        await completion;
        return { status: 'busy' };
      }
    }
    const claim: NoteCreationClaim = {
      id,
      token: crypto.randomUUID(),
      claimedAt: now,
    };
    claims.put(claim);
    await completion;
    return { status: 'claimed', claim };
  }

  async finalizeClaimedNote(
    note: Note,
    claimToken: string,
  ): Promise<CreateNoteWithPendingSyncResult> {
    validateNoteId(note.id);
    if (!claimToken) throw new Error('Note creation claim token is required');
    const normalized = normalizeNoteRecord(note);
    const db = this.getDB();
    const transaction = db.transaction(
      [STORE_NAME, PENDING_SYNC_STORE_NAME, NOTE_CREATION_CLAIM_STORE_NAME],
      'readwrite',
    );
    const completion = transactionCompletion(transaction, 'Claimed note finalization failed');
    const notes = transaction.objectStore(STORE_NAME);
    const existing = await requestResult(notes.get(normalized.id));
    const claims = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    if (existing !== undefined) {
      const claim = await requestResult(claims.get(normalized.id));
      if (claim !== undefined && normalizeNoteCreationClaim(claim).token === claimToken) {
        claims.delete(normalized.id);
      }
      const stored = normalizeNoteRecord(existing);
      await completion;
      return { created: false, note: stored };
    }
    const claim = await requestResult(claims.get(normalized.id));
    if (claim === undefined || normalizeNoteCreationClaim(claim).token !== claimToken) {
      throw new Error('Note creation claim was lost before finalization');
    }
    const pending = pendingNoteSync(normalized);
    notes.put(normalized);
    transaction.objectStore(PENDING_SYNC_STORE_NAME).put(pending);
    claims.delete(normalized.id);
    await completion;
    return { created: true, note: normalized, pending };
  }

  async renewNoteCreationClaim(
    id: string,
    claimToken: string,
    now = Date.now(),
  ): Promise<boolean> {
    validateNoteId(id);
    if (!claimToken) throw new Error('Note creation claim token is required');
    if (!Number.isFinite(now)) throw new Error('Note creation claim time must be finite');
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Note creation claim renewal failed');
    const claims = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    const value = await requestResult(claims.get(id));
    if (value === undefined || normalizeNoteCreationClaim(value).token !== claimToken) {
      await completion;
      return false;
    }
    claims.put({ id, token: claimToken, claimedAt: now } satisfies NoteCreationClaim);
    await completion;
    return true;
  }

  async releaseNoteCreationClaim(id: string, claimToken: string): Promise<boolean> {
    validateNoteId(id);
    if (!claimToken) throw new Error('Note creation claim token is required');
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Note creation claim release failed');
    const claims = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    const value = await requestResult(claims.get(id));
    if (value === undefined || normalizeNoteCreationClaim(value).token !== claimToken) {
      await completion;
      return false;
    }
    claims.delete(id);
    await completion;
    return true;
  }

  async completePendingNoteSync(id: string, token: string): Promise<boolean> {
    validateNoteId(id);
    if (!token) throw new Error('Pending note sync token is required');
    const db = this.getDB();
    const transaction = db.transaction(PENDING_SYNC_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Pending note sync completion failed');
    const store = transaction.objectStore(PENDING_SYNC_STORE_NAME);
    const value = await requestResult(store.get(id));
    if (value === undefined || normalizePendingNoteSync(value).token !== token) {
      await completion;
      return false;
    }
    store.delete(id);
    await completion;
    return true;
  }

  async queueNoteForSync(id: string): Promise<PendingNoteSync | null> {
    validateNoteId(id);
    const db = this.getDB();
    const transaction = db.transaction([STORE_NAME, PENDING_SYNC_STORE_NAME], 'readwrite');
    const completion = transactionCompletion(transaction, 'Pending note sync queue write failed');
    const pendingStore = transaction.objectStore(PENDING_SYNC_STORE_NAME);
    const existing = await requestResult(pendingStore.get(id));
    if (existing !== undefined) {
      const pending = normalizePendingNoteSync(existing);
      await completion;
      return pending;
    }
    const stored = await requestResult(transaction.objectStore(STORE_NAME).get(id));
    if (stored === undefined) {
      await completion;
      return null;
    }
    const pending = pendingNoteSync(normalizeNoteRecord(stored));
    pendingStore.put(pending);
    await completion;
    return pending;
  }

  async listPendingNoteSync(): Promise<PendingNoteSync[]> {
    const db = this.getDB();
    const transaction = db.transaction(PENDING_SYNC_STORE_NAME, 'readonly');
    const completion = transactionCompletion(transaction, 'Pending note sync read failed');
    const records = await requestResult<unknown[]>(
      transaction.objectStore(PENDING_SYNC_STORE_NAME).getAll(),
    );
    await completion;
    return records
      .map(normalizePendingNoteSync)
      .sort((left, right) => left.id.localeCompare(right.id));
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

  async prepareImportCommit(token: string): Promise<void> {
    const id = importCommitKey(token);
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Import commit preparation failed');
    const store = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    const existing = await requestResult(store.get(id));
    if (existing !== undefined) {
      const record = normalizeImportCommit(existing, token);
      if (record.state === 'cancelled') {
        throw new Error('Import commit was already cancelled');
      }
      await completion;
      return;
    }
    store.put({
      id,
      token,
      kind: 'import-commit',
      state: 'pending',
    } satisfies ImportCommitRecord);
    await completion;
  }

  async importCommitState(token: string): Promise<ImportCommitState> {
    const id = importCommitKey(token);
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readonly');
    const completion = transactionCompletion(transaction, 'Import commit inspection failed');
    const value = await requestResult(
      transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME).get(id),
    );
    await completion;
    return value === undefined ? 'none' : normalizeImportCommit(value, token).state;
  }

  async cancelImportCommit(token: string): Promise<ImportCommitState> {
    const id = importCommitKey(token);
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Import commit cancellation failed');
    const store = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    const value = await requestResult(store.get(id));
    if (value === undefined) {
      await completion;
      return 'none';
    }
    const record = normalizeImportCommit(value, token);
    if (record.state === 'pending') {
      store.put({ ...record, state: 'cancelled' } satisfies ImportCommitRecord);
      await completion;
      return 'cancelled';
    }
    await completion;
    return record.state;
  }

  async clearImportCommit(token: string): Promise<void> {
    const id = importCommitKey(token);
    const db = this.getDB();
    const transaction = db.transaction(NOTE_CREATION_CLAIM_STORE_NAME, 'readwrite');
    const completion = transactionCompletion(transaction, 'Import commit cleanup failed');
    const store = transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME);
    const value = await requestResult(store.get(id));
    if (value !== undefined) {
      normalizeImportCommit(value, token);
      store.delete(id);
    }
    await completion;
  }

  async saveNotesWithPendingSyncAtomically(
    notes: Note[],
    { importCommitToken }: { importCommitToken?: string } = {},
  ): Promise<PendingNoteSync[]> {
    const normalized = notes.map(note => {
      validateNoteId(note.id);
      return normalizeNoteRecord(note);
    });
    if (normalized.length === 0) return [];

    const pending = normalized.map(note => pendingNoteSync(note));
    const db = this.getDB();
    const transaction = db.transaction(
      [
        STORE_NAME,
        PENDING_SYNC_STORE_NAME,
        ...(importCommitToken ? [NOTE_CREATION_CLAIM_STORE_NAME] : []),
      ],
      'readwrite',
    );
    const completion = transactionCompletion(transaction, 'Atomic note import and sync queue write failed');
    const noteStore = transaction.objectStore(STORE_NAME);
    const pendingStore = transaction.objectStore(PENDING_SYNC_STORE_NAME);
    let importCommit: ImportCommitRecord | null = null;
    if (importCommitToken) {
      const value = await requestResult(
        transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME)
          .get(importCommitKey(importCommitToken)),
      );
      if (value === undefined) throw new Error('Import commit was not prepared');
      importCommit = normalizeImportCommit(value, importCommitToken);
      if (importCommit.state !== 'pending') {
        throw new Error(`Import commit is ${importCommit.state}`);
      }
    }
    for (let index = 0; index < normalized.length; index++) {
      noteStore.put(normalized[index]);
      pendingStore.put(pending[index]);
    }
    if (importCommit) {
      transaction.objectStore(NOTE_CREATION_CLAIM_STORE_NAME)
        .put({ ...importCommit, state: 'committed' } satisfies ImportCommitRecord);
    }
    await completion;
    return pending;
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
