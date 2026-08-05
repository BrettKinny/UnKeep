import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Note,
  NoteAttachment,
  NoteMetadata,
} from '@unkeep/core';
import type {
  ConfigField,
  DurableNoteStorageAdapter,
  ImportCommitState,
  PendingNoteSync,
  StorageAdapter,
  SyncResult,
  ValidationResult,
} from '@unkeep/core/experimental';
import {
  MemoryClientStorage,
  PendingMutationCredentialMismatchError,
  PendingMutationRebaseRequiresPullError,
  RecordConflictError,
  type ClientStorage,
  type RelaySession,
} from '@unkeep/client';
import {
  AttachmentStore,
  AttachmentUrlCache,
  STAGED_UPLOAD_TTL_MS,
} from './attachmentStorage';
import { IndexedDbClientStorage } from './clientStorage';

interface TestVaultResources {
  attachments: AttachmentStore;
  urls: AttachmentUrlCache;
  pendingKey: string;
  importJournalKey: string;
}

let NoteStore: new (readVaultResources?: () => TestVaultResources) => {
  adapter: StorageAdapter | null;
  notes: Note[];
  syncStatus: 'synced' | 'syncing' | 'offline' | 'error';
  syncQuarantineCount: number;
  initWithAdapter(adapter: DurableNoteStorageAdapter, config: Record<string, unknown>): Promise<void>;
  enableEncryptedSync(
    session: RelaySession,
    masterKey: Uint8Array<ArrayBuffer>,
  ): Promise<void>;
  disableEncryptedSync(): Promise<void>;
  prepareQuickSend(note: Note): Promise<{ attachments?: Array<{ bytes: Uint8Array<ArrayBuffer> }> }>;
  createReceivedNote(draft: {
    content: string;
    attachments?: Array<{ name: string; mimeType: string; size: number; bytes: Uint8Array<ArrayBuffer> }>;
  }, options?: { idempotencyKey?: string; createdAt?: number }): Promise<Note>;
  updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt'>>): void;
  addAttachment(noteId: string, file: File): Promise<void>;
  removeAttachment(noteId: string, attachmentId: string): Promise<void>;
  trashNote(noteId: string): Promise<boolean>;
  restoreTrashedNote(noteId: string): Promise<boolean>;
  permanentlyDeleteNote(noteId: string): Promise<boolean>;
  deleteNote(noteId: string): Promise<unknown | null>;
  undoDelete(token: unknown): Promise<void>;
  sync(): Promise<void>;
};

const localValues = new Map<string, string>();

beforeAll(async () => {
  const state = Object.assign(<T>(value: T) => value, {
    snapshot: <T>(value: T) => structuredClone(value),
  });
  const derived = Object.assign(<T>(value: T) => value, {
    by: <T>(read: () => T) => read(),
  });
  vi.stubGlobal('$state', state);
  vi.stubGlobal('$derived', derived);
  vi.stubGlobal('localStorage', {
    get length() { return localValues.size; },
    clear: () => localValues.clear(),
    getItem: (key: string) => localValues.get(key) ?? null,
    key: (index: number) => [...localValues.keys()][index] ?? null,
    removeItem: (key: string) => { localValues.delete(key); },
    setItem: (key: string, value: string) => { localValues.set(key, value); },
  } satisfies Storage);
  ({ NoteStore } = await import('./noteStore.svelte'));
});

beforeEach(() => {
  localValues.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function cloneNote(note: Note): Note {
  return structuredClone(note);
}

class TestAdapter implements DurableNoteStorageAdapter {
  readonly id = 'test';
  readonly displayName = 'Test';
  readonly description = 'Test adapter';
  readonly configSchema: ConfigField[] = [];
  private readonly values = new Map<string, Note>();
  private readonly pending = new Map<string, PendingNoteSync>();
  private readonly claims = new Map<string, { id: string; token: string; claimedAt: number }>();
  private readonly importCommits = new Map<string, Exclude<ImportCommitState, 'none'>>();
  private tokenSequence = 0;
  failNextSave = false;

  constructor(notes: readonly Note[] = [], private readonly initialize?: () => Promise<void>) {
    for (const note of notes) this.values.set(note.id, cloneNote(note));
  }

  async init(): Promise<void> { await this.initialize?.(); }
  async validate(): Promise<ValidationResult> { return { valid: true }; }
  async listNotes(): Promise<NoteMetadata[]> {
    return [...this.values.values()].map(({ id, updatedAt, deleted }) => ({ id, updatedAt, deleted }));
  }
  async getNote(id: string): Promise<Note> {
    const note = this.values.get(id);
    if (!note) throw new Error(`Note not found: ${id}`);
    return cloneNote(note);
  }
  async getAllNotes(): Promise<Note[]> { return [...this.values.values()].map(cloneNote); }
  async saveNote(note: Note): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('note persistence failed');
    }
    this.values.set(note.id, cloneNote(note));
  }
  async saveNoteWithPendingSync(
    note: Note,
    { beforeAttachments }: { beforeAttachments?: Note } = {},
  ): Promise<PendingNoteSync> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('note persistence failed');
    }
    const stored = cloneNote(note);
    const pending = {
      id: stored.id,
      token: `token-${++this.tokenSequence}`,
      note: cloneNote(stored),
      ...(beforeAttachments
        ? { beforeAttachments: cloneNote(beforeAttachments) }
        : {}),
    };
    this.values.set(stored.id, stored);
    this.pending.set(stored.id, pending);
    return structuredClone(pending);
  }
  async saveNotesWithPendingSyncAtomically(
    notes: Note[],
    { importCommitToken }: { importCommitToken?: string } = {},
  ): Promise<PendingNoteSync[]> {
    if (importCommitToken && this.importCommits.get(importCommitToken) !== 'pending') {
      throw new Error('Import commit is not pending');
    }
    const pending: PendingNoteSync[] = [];
    for (const note of notes) pending.push(await this.saveNoteWithPendingSync(note));
    if (importCommitToken) this.importCommits.set(importCommitToken, 'committed');
    return pending;
  }
  async prepareImportCommit(token: string): Promise<void> {
    if (this.importCommits.get(token) === 'cancelled') {
      throw new Error('Import commit was cancelled');
    }
    if (!this.importCommits.has(token)) this.importCommits.set(token, 'pending');
  }
  async importCommitState(token: string): Promise<ImportCommitState> {
    return this.importCommits.get(token) ?? 'none';
  }
  async cancelImportCommit(token: string): Promise<ImportCommitState> {
    const state = this.importCommits.get(token);
    if (!state) return 'none';
    if (state === 'pending') {
      this.importCommits.set(token, 'cancelled');
      return 'cancelled';
    }
    return state;
  }
  async clearImportCommit(token: string): Promise<void> {
    this.importCommits.delete(token);
  }
  async createNoteWithPendingSyncIfAbsent(note: Note) {
    const existing = this.values.get(note.id);
    if (existing) return { created: false as const, note: cloneNote(existing) };
    const pending = await this.saveNoteWithPendingSync(note);
    return { created: true as const, note: cloneNote(note), pending };
  }
  async claimNoteCreation(id: string, now = Date.now()) {
    const existing = this.values.get(id);
    if (existing) return { status: 'existing' as const, note: cloneNote(existing) };
    const claim = this.claims.get(id);
    if (claim && now - claim.claimedAt < 30_000) return { status: 'busy' as const };
    const created = {
      id,
      token: `claim-${++this.tokenSequence}`,
      claimedAt: now,
    };
    this.claims.set(id, created);
    return { status: 'claimed' as const, claim: structuredClone(created) };
  }
  async finalizeClaimedNote(note: Note, claimToken: string) {
    const existing = this.values.get(note.id);
    if (existing) return { created: false as const, note: cloneNote(existing) };
    const claim = this.claims.get(note.id);
    if (!claim || claim.token !== claimToken) throw new Error('note creation claim lost');
    const pending = await this.saveNoteWithPendingSync(note);
    this.claims.delete(note.id);
    return { created: true as const, note: cloneNote(note), pending };
  }
  async renewNoteCreationClaim(id: string, claimToken: string, now = Date.now()): Promise<boolean> {
    const claim = this.claims.get(id);
    if (!claim || claim.token !== claimToken) return false;
    claim.claimedAt = now;
    return true;
  }
  async releaseNoteCreationClaim(id: string, claimToken: string): Promise<boolean> {
    const claim = this.claims.get(id);
    if (!claim || claim.token !== claimToken) return false;
    this.claims.delete(id);
    return true;
  }
  async queueNoteForSync(id: string): Promise<PendingNoteSync | null> {
    const existing = this.pending.get(id);
    if (existing) return structuredClone(existing);
    const note = this.values.get(id);
    if (!note) return null;
    const pending = {
      id,
      token: `token-${++this.tokenSequence}`,
      note: cloneNote(note),
    };
    this.pending.set(id, pending);
    return structuredClone(pending);
  }
  async listPendingNoteSync(): Promise<PendingNoteSync[]> {
    return [...this.pending.values()].map(value => structuredClone(value));
  }
  async completePendingNoteSync(id: string, token: string): Promise<boolean> {
    const pending = this.pending.get(id);
    if (!pending || pending.token !== token) return false;
    this.pending.delete(id);
    return true;
  }
  async deleteNote(id: string): Promise<void> {
    const note = await this.getNote(id);
    await this.saveNote({ ...note, deleted: true });
  }
  async sync(): Promise<SyncResult> { return { pushed: 0, pulled: 0, conflicts: 0, errors: [] }; }
}

function note(id: string, content: string): Note {
  return { id, content, createdAt: 1, updatedAt: 1, pinned: false, archived: false };
}

function resources(
  name: string,
  attachments = new AttachmentStore(new MemoryClientStorage()),
  revoked: string[] = [],
): TestVaultResources {
  return {
    attachments,
    urls: new AttachmentUrlCache(attachments, {
      create: () => `blob:${name}`,
      revoke: url => { revoked.push(url); },
    }),
    pendingKey: `pending:${name}`,
    importJournalKey: `import:${name}`,
  };
}

class RevisionedSyncDouble {
  readonly events: string[] = [];
  attachmentPresent = true;
  failNextAttachmentDelete = false;
  failNextPush = false;
  pullCalls = 0;
  acknowledgeCalls = 0;

  constructor(
    private readonly conflictingNoteId: string | null,
    private readonly winningNote: Note,
    private readonly attachment: { id: string; name: string; mimeType: string; size: number },
    private readonly bytes: Uint8Array<ArrayBuffer>,
  ) {}

  async push(value: Note): Promise<number> {
    this.events.push(`push:${value.id}`);
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error('relay temporarily unavailable');
    }
    if (value.id === this.conflictingNoteId) throw new RecordConflictError(2);
    return 3;
  }

  async uploadAttachment(_noteId: string, value: { id: string }): Promise<void> {
    this.events.push(`upload:${value.id}`);
  }

  async deleteAttachment(_noteId: string, value: { id: string }): Promise<void> {
    this.events.push(`delete:${value.id}`);
    if (this.failNextAttachmentDelete) {
      this.failNextAttachmentDelete = false;
      throw new Error('relay temporarily unavailable');
    }
    this.attachmentPresent = false;
  }

  async pull() {
    this.pullCalls += 1;
    return {
      notes: [cloneNote(this.winningNote)],
      deletedIds: [],
      attachments: this.attachmentPresent
        ? [{ noteId: this.winningNote.id, attachment: this.attachment, bytes: this.bytes }]
        : [],
      deletedAttachments: this.attachmentPresent
        ? []
        : [{ noteId: this.winningNote.id, attachmentId: this.attachment.id }],
      cursor: 3,
      revisions: [],
    };
  }

  async acknowledge(): Promise<void> {
    this.acknowledgeCalls += 1;
  }
}

function useTestSync(store: object, sync: object): void {
  if (!Reflect.has(sync, 'getQuarantinedRecords')) {
    Reflect.set(sync, 'getQuarantinedRecords', async () => []);
  }
  if (!Reflect.has(sync, 'pendingCompoundCommits')) {
    Reflect.set(sync, 'pendingCompoundCommits', async () => []);
  }
  if (!Reflect.has(sync, 'pendingCompoundCommit')) {
    Reflect.set(sync, 'pendingCompoundCommit', async () => null);
  }
  if (!Reflect.has(sync, 'completeCompoundCommit')) {
    Reflect.set(sync, 'completeCompoundCommit', async () => true);
  }
  if (!Reflect.has(sync, 'resumePendingCompoundCommit')) {
    Reflect.set(sync, 'resumePendingCompoundCommit', async () => null);
  }
  if (!Reflect.has(sync, 'cancelPendingCompoundCommit')) {
    Reflect.set(sync, 'cancelPendingCompoundCommit', async () => true);
  }
  if (!Reflect.has(sync, 'commitNoteWithAttachments')) {
    Reflect.set(sync, 'commitNoteWithAttachments', async (
      value: Note,
      uploads: Array<{
        attachment: NoteAttachment;
        loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
      }>,
    ) => {
      const attachmentRevisions = [];
      const push = Reflect.get(sync, 'push') as (note: Note) => Promise<number>;
      const revision = await push.call(sync, value);
      for (const upload of uploads) {
        const bytes = await upload.loadBytes();
        const uploadAttachment = Reflect.get(sync, 'uploadAttachment') as
          | ((noteId: string, attachment: NoteAttachment, bytes: Uint8Array<ArrayBuffer>) => Promise<void>)
          | undefined;
        await uploadAttachment?.call(sync, value.id, upload.attachment, bytes);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        attachmentRevisions.push({
          id: upload.attachment.id,
          revision: 3,
          contentHash: [...digest]
            .map(byte => byte.toString(16).padStart(2, '0')).join(''),
        });
      }
      return {
        noteId: value.id,
        mutationId: crypto.randomUUID(),
        fingerprint: 'test-fingerprint',
        revision,
        attachmentRevisions,
      };
    });
  }
  Reflect.set(store, 'encryptedSync', sync);
}

describe('NoteStore vault lifecycle', () => {
  it('authenticates and replays an ordinary pending note after credential replacement', async () => {
    const local = note('credential-handoff', 'durable local edit');
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync(local);
    const store = new NoteStore(() => resources('credential-handoff'));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    let firstPush = true;
    const sync = {
      async push(value: Note) {
        events.push(`push:${value.id}`);
        if (firstPush) {
          firstPush = false;
          throw new PendingMutationCredentialMismatchError();
        }
        return 3;
      },
      async resumePendingMutationAfterCredentialChange(kind: string, id: string) {
        events.push(`handoff:${kind}:${id}`);
        return 2;
      },
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 3,
          revisions: [],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(events).toEqual([
      `push:${local.id}`,
      `handoff:note:${local.id}`,
      `push:${local.id}`,
    ]);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    expect(store.syncStatus).toBe('synced');
  });

  it('retires only a proven stale foreign note retry before the desired push', async () => {
    const local = note('credential-rebase', 'durable rebased edit');
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync(local);
    const store = new NoteStore(() => resources('credential-rebase'));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    let firstPush = true;
    const sync = {
      async push(value: Note) {
        events.push(`push:${value.id}`);
        if (firstPush) {
          firstPush = false;
          throw new PendingMutationCredentialMismatchError();
        }
        return 5;
      },
      async resumePendingMutationAfterCredentialChange() {
        events.push('foreign-retry');
        throw new RecordConflictError(4);
      },
      async rebasePendingNoteAfterCredentialChange() {
        events.push('atomic-credential-rebase');
        return 5;
      },
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 5,
          revisions: [],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(events).toEqual([
      `push:${local.id}`,
      'foreign-retry',
      'atomic-credential-rebase',
    ]);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    expect(store.syncStatus).toBe('synced');
  });

  it('preserves a stale full note as a copy before pulling unseen remote fields', async () => {
    const local = {
      ...note('credential-unseen-remote', 'durable local edit'),
      title: 'Local title',
      labels: ['local'],
    };
    const winner = {
      ...note(local.id, 'unseen remote edit'),
      title: 'Remote title',
      labels: ['remote'],
      updatedAt: 4,
    };
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync(local);
    const store = new NoteStore(() => resources('credential-unseen-remote'));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    let originalAttempt = true;
    const sync = {
      async push(value: Note) {
        events.push(`push:${value.id}`);
        if (value.id === local.id && originalAttempt) {
          originalAttempt = false;
          throw new PendingMutationCredentialMismatchError();
        }
        return 5;
      },
      async resumePendingMutationAfterCredentialChange() {
        events.push('foreign-conflict');
        throw new RecordConflictError(4);
      },
      async rebasePendingNoteAfterCredentialChange() {
        events.push('reject-blind-rebase');
        throw new PendingMutationRebaseRequiresPullError(4);
      },
      async abandonPendingMutationAfterCredentialChange() {
        events.push('retire-proven-stale-root');
        return true;
      },
      async pull() {
        events.push('pull-remote-winner');
        return {
          notes: [winner],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 5,
          revisions: [{ kind: 'note' as const, id: winner.id, revision: 4 }],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();
    await vi.waitFor(() => {
      expect(events).toContain('pull-remote-winner');
      expect(store.syncStatus).toBe('synced');
    });
    const preserved = store.notes.find(value => value.id !== local.id);
    expect(preserved).toMatchObject({
      content: local.content,
      title: 'Local title (conflict copy)',
      labels: local.labels,
    });

    expect(events).toEqual([
      `push:${local.id}`,
      'foreign-conflict',
      'reject-blind-rebase',
      'retire-proven-stale-root',
      `push:${preserved!.id}`,
      'pull-remote-winner',
    ]);
    expect(store.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: winner.id,
        content: winner.content,
        title: winner.title,
        labels: winner.labels,
      }),
      expect.objectContaining({
        id: preserved!.id,
        content: local.content,
        title: 'Local title (conflict copy)',
        labels: local.labels,
      }),
    ]));
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    expect(store.syncStatus).toBe('synced');
  });

  it('publishes only new bytes through a compound note commit', async () => {
    const existing = { id: 'existing', name: 'existing.png', mimeType: 'image/png', size: 2 };
    const fresh = { id: 'fresh', name: 'fresh.png', mimeType: 'image/png', size: 3 };
    const freshBytes = new Uint8Array([4, 5, 6]);
    const local = { ...note('mixed-attachments', 'mixed'), images: [existing, fresh] };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'mixed-compound');
    await attachments.save(local.id, existing, new Uint8Array([1, 2]));
    await attachments.save(local.id, fresh, freshBytes, { pendingUpload: true });
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync(local);
    const store = new NoteStore(() => resources('mixed-compound', attachments));
    await store.initWithAdapter(adapter, {});
    const committedUploads: string[][] = [];
    const completed: string[] = [];
    const sync = {
      async pendingCompoundCommits() { return []; },
      async commitNoteWithAttachments(value: Note, uploads: Array<{
        attachment: NoteAttachment;
        loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
      }>) {
        committedUploads.push(uploads.map(upload => upload.attachment.id));
        const bytes = await uploads[0].loadBytes();
        expect(bytes).toEqual(freshBytes);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          noteId: value.id,
          mutationId: 'mixed-mutation',
          fingerprint: 'mixed-fingerprint',
          revision: 2,
          attachmentRevisions: [{
            id: fresh.id,
            revision: 2,
            contentHash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
          }],
        };
      },
      async completeCompoundCommit(handle: { mutationId: string }) {
        completed.push(handle.mutationId);
        return true;
      },
      async push() { throw new Error('ordinary note push must not publish a new attachment'); },
      async uploadAttachment() { throw new Error('direct attachment upload is forbidden'); },
      async deleteAttachment() {},
      async pull() {
        return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(committedUploads).toEqual([[fresh.id]]);
    expect(completed).toEqual(['mixed-mutation']);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
  });

  it('preserves an attachment-ID collision as a fresh conflict copy and resumes pulling', async () => {
    const colliding = {
      id: 'shared-attachment-id',
      name: 'local.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const local = { ...note('collision-note', 'local edit'), images: [colliding] };
    const winner = { ...note(local.id, 'remote winner'), updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'attachment-collision');
    await attachments.save(local.id, colliding, bytes, { pendingUpload: true });
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync(local);
    const store = new NoteStore(() => resources('attachment-collision', attachments));
    await store.initWithAdapter(adapter, {});
    let pullCalls = 0;
    const committedCopies: Note[] = [];
    const sync = {
      async pendingCompoundCommits() { return []; },
      async commitNoteWithAttachments(value: Note, uploads: Array<{
        attachment: NoteAttachment;
        loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
      }>) {
        if (value.id === local.id) {
          throw Object.assign(new Error('attachment_id_unavailable'), {
            status: 409,
            code: 'attachment_id_unavailable',
          });
        }
        committedCopies.push(value);
        const attachmentRevisions = [];
        for (const upload of uploads) {
          const valueBytes = await upload.loadBytes();
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', valueBytes));
          attachmentRevisions.push({
            id: upload.attachment.id,
            revision: 2,
            contentHash: [...digest]
              .map(byte => byte.toString(16).padStart(2, '0')).join(''),
          });
        }
        return {
          noteId: value.id,
          mutationId: `copy-${value.id}`,
          fingerprint: 'copy-fingerprint',
          revision: 3,
          attachmentRevisions,
        };
      },
      async completeCompoundCommit() { return true; },
      async push() { return 3; },
      async deleteAttachment() {},
      async pull() {
        pullCalls++;
        return {
          notes: [winner],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 3,
          revisions: [{ kind: 'note' as const, id: winner.id, revision: 3 }],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(committedCopies).toHaveLength(1);
    expect(committedCopies[0].id).not.toBe(local.id);
    expect(committedCopies[0].images?.[0].id).not.toBe(colliding.id);
    expect(pullCalls).toBeGreaterThan(0);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent(local.id)).resolves.toBeNull();
    await expect(attachments.get(local.id, colliding.id)).resolves.toBeNull();
    expect(store.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: winner.id, content: winner.content }),
      expect.objectContaining({ id: committedCopies[0].id }),
    ]));
  });

  it('rebuilds a foreign compound retry only after a write-capable handoff', async () => {
    const reserved = {
      id: 'credential-reserved-attachment',
      name: 'local.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const local = { ...note('credential-compound', 'local edit'), images: [reserved] };
    const winner = { ...note(local.id, 'remote winner'), updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'credential-compound');
    await attachments.save(local.id, reserved, bytes, { pendingUpload: true });
    const adapter = new TestAdapter();
    const pending = await adapter.saveNoteWithPendingSync(local);
    await attachments.prepareUploads(local.id, local.images);
    const exactSources = await attachments.pendingUploadSources(
      local.id,
      [reserved.id],
    );
    await attachments.beginCompoundUploadIntent(
      local.id,
      pending.token,
      exactSources.map(value => value.handle),
    );
    const store = new NoteStore(() => resources('credential-compound', attachments));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    const committedCopies: Note[] = [];
    let foreignRoot = true;
    const sync = {
      async resumePendingCompoundCommit() {
        events.push('defer-startup-foreign-root');
        if (foreignRoot) throw new PendingMutationCredentialMismatchError();
        return null;
      },
      async commitNoteWithAttachments(value: Note, uploads: Array<{
        attachment: NoteAttachment;
        loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
      }>) {
        if (value.id === local.id) {
          events.push('reserved-id-collision');
          throw Object.assign(new Error('attachment_id_unavailable'), {
            status: 409,
            code: 'attachment_id_unavailable',
          });
        }
        events.push('commit-copy');
        committedCopies.push(value);
        const valueBytes = await uploads[0].loadBytes();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', valueBytes));
        return {
          noteId: value.id,
          mutationId: 'replacement-copy',
          fingerprint: 'replacement-copy',
          revision: 3,
          attachmentRevisions: [{
            id: uploads[0].attachment.id,
            revision: 3,
            contentHash: [...digest]
              .map(byte => byte.toString(16).padStart(2, '0')).join(''),
          }],
        };
      },
      async resumePendingCompoundCommitAfterCredentialChange() {
        events.push('authenticated-handoff');
        throw Object.assign(new Error('attachment_stage_missing'), {
          status: 409,
          code: 'attachment_stage_missing',
        });
      },
      async abandonPendingCompoundAfterCredentialChange() {
        events.push('abandon-foreign-root');
        foreignRoot = false;
        return true;
      },
      async completeCompoundCommit() { return true; },
      async push() { return 3; },
      async deleteAttachment() {},
      async pull() {
        return {
          notes: [winner],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 3,
          revisions: [{ kind: 'note' as const, id: winner.id, revision: 3 }],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(events).toEqual([
      'defer-startup-foreign-root',
      'authenticated-handoff',
      'abandon-foreign-root',
      'reserved-id-collision',
      'commit-copy',
    ]);
    expect(committedCopies).toHaveLength(1);
    expect(committedCopies[0].id).not.toBe(local.id);
    expect(committedCopies[0].images?.[0].id).not.toBe(reserved.id);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    expect(store.syncStatus).toBe('synced');
  });

  it('recovers an accepted compound without clearing a newer local generation', async () => {
    const value = { id: 'replaceable', name: 'value.bin', mimeType: 'application/octet-stream', size: 3 };
    const oldBytes = new Uint8Array([1, 2, 3]);
    const newBytes = new Uint8Array([7, 8, 9]);
    const oldNote = { ...note('compound-recovery', 'old'), images: [value] };
    const newNote = { ...oldNote, content: 'newer', updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'compound-recovery');
    await attachments.save(oldNote.id, value, oldBytes, { pendingUpload: true });
    await attachments.prepareUploads(oldNote.id, [value]);
    const [oldSource] = await attachments.pendingUploadSources(oldNote.id, [value.id]);
    const adapter = new TestAdapter();
    const oldPending = await adapter.saveNoteWithPendingSync(oldNote);
    await attachments.beginCompoundUploadIntent(oldNote.id, oldPending.token, [oldSource.handle]);
    const oldHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', oldBytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const oldHandle = {
      noteId: oldNote.id,
      mutationId: 'old-mutation',
      fingerprint: 'old-fingerprint',
      revision: 2,
      attachmentRevisions: [{ id: value.id, revision: 2, contentHash: oldHash }],
    };
    await attachments.stageUpload(oldNote.id, value, newBytes);
    await adapter.saveNoteWithPendingSync(newNote);
    const store = new NoteStore(() => resources('compound-recovery', attachments));
    await store.initWithAdapter(adapter, {});
    let acceptedPending = true;
    let newerGenerationSurvivedOldCompletion = false;
    const completed: string[] = [];
    const sync = {
      async pendingCompoundCommits() { return acceptedPending ? [oldHandle] : []; },
      async completeCompoundCommit(handle: { mutationId: string }) {
        completed.push(handle.mutationId);
        if (handle.mutationId === 'old-mutation') {
          newerGenerationSurvivedOldCompletion = (await attachments.stagedUploads()).length === 1;
          acceptedPending = false;
        }
        return true;
      },
      async commitNoteWithAttachments(noteValue: Note, uploads: Array<{
        attachment: NoteAttachment;
        loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
      }>) {
        const bytes = await uploads[0].loadBytes();
        expect(bytes).toEqual(newBytes);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        return {
          noteId: noteValue.id,
          mutationId: 'new-mutation',
          fingerprint: 'new-fingerprint',
          revision: 3,
          attachmentRevisions: [{ id: value.id, revision: 3, contentHash: hash }],
        };
      },
      async push() { throw new Error('replacement must remain a compound commit'); },
      async deleteAttachment() {},
      async pull() {
        return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(newerGenerationSurvivedOldCompletion).toBe(true);
    expect(completed).toEqual(['old-mutation', 'new-mutation']);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    await expect(attachments.get(oldNote.id, value.id)).resolves.toEqual({ attachment: value, bytes: newBytes });
  });

  it('finishes a reconciled SDK root without reconfirming local attachment state', async () => {
    const value = { id: 'reconciled-value', name: 'value.bin', mimeType: 'application/octet-stream', size: 1 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'reconciled-root');
    await attachments.save('reconciled-note', value, new Uint8Array([1]), { pendingUpload: true });
    const [source] = await attachments.pendingUploadSources('reconciled-note', [value.id]);
    await attachments.beginCompoundUploadIntent('reconciled-note', 'old-token', [source.handle]);
    await attachments.markCompoundUploadIntentReconciled('reconciled-note', 'old-token');
    // Simulate local confirmation having already retired the exact generation.
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([1])))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    await attachments.confirmCompoundUpload(source.handle, hash);
    const handle = {
      noteId: 'reconciled-note', mutationId: 'reconciled-mutation', fingerprint: 'fingerprint', revision: 2,
      attachmentRevisions: [{ id: value.id, revision: 2, contentHash: hash }],
    };
    const adapter = new TestAdapter();
    const store = new NoteStore(() => resources('reconciled-root', attachments));
    await store.initWithAdapter(adapter, {});
    let completed = false;
    useTestSync(store, {
      async pendingCompoundCommits() { return [handle]; },
      async completeCompoundCommit() { completed = true; return true; },
      async resumePendingCompoundCommit() { throw new Error('reconciled roots are not resumed'); },
      async cancelPendingCompoundCommit() { return false; },
      async pull() { return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] }; },
      async acknowledge() {},
    });

    await store.sync();

    expect(completed).toBe(true);
    await expect(attachments.compoundUploadIntent(handle.noteId)).resolves.toBeNull();
  });

  it('removes a reconciled stale intent before publishing a newer edit', async () => {
    const value = { id: 'stale-value', name: 'value.bin', mimeType: 'application/octet-stream', size: 1 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'stale-reconciled');
    await attachments.save('stale-note', value, new Uint8Array([1]), { pendingUpload: true });
    const [oldSource] = await attachments.pendingUploadSources('stale-note', [value.id]);
    await attachments.beginCompoundUploadIntent('stale-note', 'old-token', [oldSource.handle]);
    await attachments.markCompoundUploadIntentReconciled('stale-note', 'old-token');
    const newerBytes = new Uint8Array([2]);
    await attachments.stageUpload('stale-note', value, newerBytes);
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync({ ...note('stale-note', 'newer'), images: [value] });
    const store = new NoteStore(() => resources('stale-reconciled', attachments));
    await store.initWithAdapter(adapter, {});
    let committed = 0;
    const sync = {
      async pendingCompoundCommits() { return []; },
      async resumePendingCompoundCommit() { throw new Error('stale reconciled intent must be removed'); },
      async cancelPendingCompoundCommit() { return false; },
      async commitNoteWithAttachments(noteValue: Note, uploads: Array<{ attachment: NoteAttachment; loadBytes: () => Promise<Uint8Array<ArrayBuffer>> }>) {
        committed += 1;
        const bytes = await uploads[0].loadBytes();
        expect(bytes).toEqual(newerBytes);
        const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { noteId: noteValue.id, mutationId: 'new', fingerprint: 'new', revision: 3, attachmentRevisions: [{ id: value.id, revision: 3, contentHash }] };
      },
      async completeCompoundCommit() { return true; },
      async pull() { return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] }; },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(committed).toBe(1);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent('stale-note')).resolves.toBeNull();
  });

  it('progresses after crashing between SDK completion and intent deletion', async () => {
    class CrashAfterSdkCompletionStore extends AttachmentStore {
      failCleanup = true;

      override async completeCompoundUploadIntent(noteId: string, noteToken: string) {
        const intent = await this.compoundUploadIntent(noteId);
        if (this.failCleanup && intent?.phase === 'reconciled') {
          this.failCleanup = false;
          throw new Error('browser stopped after SDK completion');
        }
        return super.completeCompoundUploadIntent(noteId, noteToken);
      }
    }
    const value = { id: 'crash-value', name: 'value.bin', mimeType: 'application/octet-stream', size: 1 };
    const attachments = new CrashAfterSdkCompletionStore(
      new MemoryClientStorage(),
      'post-sdk-crash',
    );
    await attachments.save('crash-note', value, new Uint8Array([1]), { pendingUpload: true });
    const adapter = new TestAdapter();
    await adapter.saveNoteWithPendingSync({ ...note('crash-note', 'first'), images: [value] });
    const store = new NoteStore(() => resources('post-sdk-crash', attachments));
    await store.initWithAdapter(adapter, {});
    let commits = 0;
    const sync = {
      async pendingCompoundCommits() { return []; },
      async pendingCompoundCommit() { return null; },
      async resumePendingCompoundCommit() { return null; },
      async cancelPendingCompoundCommit() { return true; },
      async commitNoteWithAttachments(noteValue: Note, uploads: Array<{ attachment: NoteAttachment; loadBytes: () => Promise<Uint8Array<ArrayBuffer>> }>) {
        commits += 1;
        const bytes = await uploads[0].loadBytes();
        const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { noteId: noteValue.id, mutationId: `mutation-${commits}`, fingerprint: `fingerprint-${commits}`, revision: commits, attachmentRevisions: [{ id: value.id, revision: commits, contentHash }] };
      },
      async completeCompoundCommit() { return true; },
      async pull() { return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] }; },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();
    await expect(attachments.compoundUploadIntent('crash-note'))
      .resolves.toMatchObject({ phase: 'reconciled' });
    await attachments.stageUpload('crash-note', value, new Uint8Array([2]));
    await adapter.saveNoteWithPendingSync({
      ...note('crash-note', 'second'),
      images: [value],
      updatedAt: 2,
    });

    await store.sync();

    expect(commits).toBe(2);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent('crash-note')).resolves.toBeNull();
  });

  it('cancels an irrecoverable partial old root before starting a newer generation', async () => {
    const value = { id: 'partial-value', name: 'value.bin', mimeType: 'application/octet-stream', size: 1 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'partial-root');
    await attachments.save('partial-note', value, new Uint8Array([1]), { pendingUpload: true });
    const [oldSource] = await attachments.pendingUploadSources('partial-note', [value.id]);
    const adapter = new TestAdapter();
    const oldPending = await adapter.saveNoteWithPendingSync({ ...note('partial-note', 'old'), images: [value] });
    await attachments.beginCompoundUploadIntent('partial-note', oldPending.token, [oldSource.handle]);
    const newerBytes = new Uint8Array([3]);
    await attachments.stageUpload('partial-note', value, newerBytes);
    await adapter.saveNoteWithPendingSync({ ...note('partial-note', 'newer'), images: [value], updatedAt: 2 });
    const store = new NoteStore(() => resources('partial-root', attachments));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    const sync = {
      async pendingCompoundCommits() { return []; },
      async resumePendingCompoundCommit(_noteId: string, uploads: unknown[]) {
        events.push(`resume:${uploads.length}`);
        throw new Error('old source generation is unavailable');
      },
      async cancelPendingCompoundCommit() { events.push('cancel'); return true; },
      async commitNoteWithAttachments(noteValue: Note, uploads: Array<{ attachment: NoteAttachment; loadBytes: () => Promise<Uint8Array<ArrayBuffer>> }>) {
        events.push('commit-new');
        const bytes = await uploads[0].loadBytes();
        const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { noteId: noteValue.id, mutationId: 'new', fingerprint: 'new', revision: 3, attachmentRevisions: [{ id: value.id, revision: 3, contentHash }] };
      },
      async completeCompoundCommit() { events.push('complete-new'); return true; },
      async pull() { return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] }; },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(events).toEqual(['resume:0', 'cancel', 'commit-new', 'complete-new']);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent('partial-note')).resolves.toBeNull();
  });

  it('cancels a foreign pre-stage root after a newer token removes its source', async () => {
    const value = {
      id: 'foreign-partial-value',
      name: 'value.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    };
    const attachments = new AttachmentStore(
      new MemoryClientStorage(),
      'foreign-partial-root',
    );
    await attachments.save(
      'foreign-partial-note',
      value,
      new Uint8Array([1]),
      { pendingUpload: true },
    );
    const [oldSource] = await attachments.pendingUploadSources(
      'foreign-partial-note',
      [value.id],
    );
    const adapter = new TestAdapter();
    const oldPending = await adapter.saveNoteWithPendingSync({
      ...note('foreign-partial-note', 'old upload'),
      images: [value],
    });
    await attachments.beginCompoundUploadIntent(
      'foreign-partial-note',
      oldPending.token,
      [oldSource.handle],
    );
    await attachments.queueDelete(
      'foreign-partial-note',
      value,
      { retainBytes: true, purgeRetainedBytesOnComplete: true },
    );
    await adapter.saveNoteWithPendingSync({
      ...note('foreign-partial-note', 'newer removal'),
      updatedAt: 2,
    });
    const store = new NoteStore(() =>
      resources('foreign-partial-root', attachments));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    const sync = {
      async pendingCompoundCommits() { return []; },
      async resumePendingCompoundCommit() {
        events.push('foreign-mismatch');
        throw new PendingMutationCredentialMismatchError();
      },
      async resumePendingCompoundCommitAfterCredentialChange() {
        events.push('authenticated-handoff');
        throw new Error('Attachment bytes are required to resume foreign-partial-value');
      },
      async cancelPendingCompoundCommit() {
        events.push('cancel-pre-stage-root');
        return true;
      },
      async push() {
        events.push('push-newer-removal');
        return 2;
      },
      async deleteAttachment() {
        events.push('delete-retired-attachment');
      },
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined: [],
          cursor: 2,
          revisions: [],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(events).toEqual([
      'foreign-mismatch',
      'authenticated-handoff',
      'cancel-pre-stage-root',
      'push-newer-removal',
      'delete-retired-attachment',
    ]);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent('foreign-partial-note'))
      .resolves.toBeNull();
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);
    expect(store.syncStatus).toBe('synced');
  });

  it('fails closed when the current outbox still owns missing exact attachment bytes', async () => {
    const value = { id: 'missing-value', name: 'value.bin', mimeType: 'application/octet-stream', size: 1 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'missing-current-root');
    await attachments.save('missing-note', value, new Uint8Array([1]), { pendingUpload: true });
    const [oldSource] = await attachments.pendingUploadSources('missing-note', [value.id]);
    const adapter = new TestAdapter();
    const pending = await adapter.saveNoteWithPendingSync({ ...note('missing-note', 'same outbox'), images: [value] });
    await attachments.beginCompoundUploadIntent('missing-note', pending.token, [oldSource.handle]);
    // Lose the exact generation without creating a newer note token.
    await attachments.stageUpload('missing-note', value, new Uint8Array([2]));
    const store = new NoteStore(() => resources('missing-current-root', attachments));
    await store.initWithAdapter(adapter, {});
    let cancellations = 0;
    let ordinaryPushes = 0;
    const sync = {
      async pendingCompoundCommits() { return []; },
      async pendingCompoundCommit() { return null; },
      async resumePendingCompoundCommit() { throw new Error('exact source required'); },
      async cancelPendingCompoundCommit() { cancellations += 1; return true; },
      async push() { ordinaryPushes += 1; return 2; },
      async pull() { return { notes: [], deletedIds: [], attachments: [], deletedAttachments: [], cursor: 0, revisions: [] }; },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    await store.sync();

    expect(cancellations).toBe(0);
    expect(ordinaryPushes).toBe(0);
    await expect(adapter.listPendingNoteSync()).resolves.toHaveLength(1);
    await expect(attachments.compoundUploadIntent('missing-note'))
      .resolves.toMatchObject({ noteToken: pending.token, phase: 'pending' });
  });

  it('keeps the newer vault active when an older adapter initialization finishes last', async () => {
    const oldStarted = deferred<void>();
    const releaseOld = deferred<void>();
    const oldAdapter = new TestAdapter([note('old-note', 'old vault')], async () => {
      oldStarted.resolve();
      await releaseOld.promise;
    });
    const newAdapter = new TestAdapter([note('new-note', 'new vault')]);
    const store = new NoteStore();

    const openingOld = store.initWithAdapter(oldAdapter, {});
    await oldStarted.promise;
    await store.initWithAdapter(newAdapter, {});
    releaseOld.resolve();
    await openingOld;

    expect(store.adapter).toBe(newAdapter);
    expect(store.notes.map(value => value.id)).toEqual(['new-note']);
  });

  it('rejects current-vault initialization failures instead of opening the vault', async () => {
    const failure = new Error('IndexedDB could not open');
    const store = new NoteStore();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(store.initWithAdapter(new TestAdapter([], async () => { throw failure; }), {}))
        .rejects.toBe(failure);

      expect(store.adapter).toBeNull();
      expect(store.syncStatus).toBe('error');
      expect(logged).toHaveBeenCalledWith('Failed to initialize store:', failure);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not return old-vault attachment bytes after the active vault changes', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockedKey = '';
    let blockReads = false;
    const delayedStorage: ClientStorage = {
      get: async <T>(key: string) => {
        if (blockReads && key === blockedKey) {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return backing.get<T>(key);
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const oldAttachments = new AttachmentStore(delayedStorage, 'old');
    const oldResources = resources('old', oldAttachments);
    const newResources = resources('new');
    let activeResources = oldResources;
    const store = new NoteStore(() => activeResources);
    const attachment = { id: 'old-image', name: 'private.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('old-note', 'private'), images: [attachment] };
    await oldAttachments.save(oldNote.id, attachment, new Uint8Array([1, 2, 3]));
    blockedKey = oldAttachments.storageKey(oldNote.id, attachment.id);
    await store.initWithAdapter(new TestAdapter([oldNote]), {});
    blockReads = true;

    const preparing = store.prepareQuickSend(oldNote);
    await readStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(new TestAdapter([note('new-note', 'new vault')]), {});
    releaseRead.resolve();

    await expect(preparing).rejects.toThrow('vault changed');
  });

  it('finishes a received note in its originating vault without inserting it into the new vault', async () => {
    const backing = new MemoryClientStorage();
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    let blockAttachmentSave = false;
    const delayedStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
      transact: async (keys, change) => {
        if (
          blockAttachmentSave
          && keys.some(key => key.startsWith('unkeep-attachment:old:'))
        ) {
          saveStarted.resolve();
          await releaseSave.promise;
        }
        await backing.transact(keys, change);
      },
    };
    const oldResources = resources('old', new AttachmentStore(delayedStorage, 'old'));
    const newResources = resources('new');
    let activeResources = oldResources;
    const oldAdapter = new TestAdapter();
    const newAdapter = new TestAdapter([note('new-note', 'new vault')]);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    blockAttachmentSave = true;

    const creating = store.createReceivedNote({
      content: 'received in old vault',
      attachments: [{
        name: 'received.png',
        mimeType: 'image/png',
        size: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }],
    });
    await saveStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    releaseSave.resolve();
    const created = await creating;

    await expect(oldAdapter.getNote(created.id)).resolves.toMatchObject({ content: 'received in old vault' });
    await expect(newAdapter.getNote(created.id)).rejects.toThrow('Note not found');
    expect(store.notes.map(value => value.id)).toEqual(['new-note']);
  });

  it('saves a note and its retry intent even when localStorage quota writes fail', async () => {
    const adapter = new TestAdapter();
    const store = new NoteStore(() => resources('quota'));
    await store.initWithAdapter(adapter, {});
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });

    try {
      const created = await store.createReceivedNote({ content: 'durable without localStorage' });

      await expect(adapter.getNote(created.id)).resolves.toMatchObject({
        content: 'durable without localStorage',
      });
      await expect(adapter.listPendingNoteSync()).resolves.toEqual([
        expect.objectContaining({
          id: created.id,
          note: expect.objectContaining({ content: 'durable without localStorage' }),
        }),
      ]);
    } finally {
      setItem.mockRestore();
    }
  });

  it('ingests one pending share only once when two tabs race or retry after a crash', async () => {
    const adapter = new TestAdapter();
    const firstTab = new NoteStore(() => resources('share-first'));
    const secondTab = new NoteStore(() => resources('share-second'));
    await Promise.all([
      firstTab.initWithAdapter(adapter, {}),
      secondTab.initWithAdapter(adapter, {}),
    ]);

    const [first, second] = await Promise.all([
      firstTab.createReceivedNote(
        { content: 'one shared payload' },
        { idempotencyKey: 'pending-share-token', createdAt: 123 },
      ),
      secondTab.createReceivedNote(
        { content: 'one shared payload' },
        { idempotencyKey: 'pending-share-token', createdAt: 123 },
      ),
    ]);

    expect(first.id).toBe(second.id);
    await expect(adapter.listNotes()).resolves.toHaveLength(1);
    await expect(adapter.listPendingNoteSync()).resolves.toHaveLength(1);
  });

  it('lets only the claim owner stage a shared attachment across two tabs', async () => {
    const backing = new MemoryClientStorage();
    let attachmentWrites = 0;
    const countingStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: async <T>(key: string, value: T) => {
        if (key.startsWith('unkeep-attachment:shared-race:')) attachmentWrites += 1;
        await backing.set(key, value);
      },
      delete: key => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, transaction => {
        change({
          get: <T>(key: string) => transaction.get<T>(key),
          set: <T>(key: string, value: T) => {
            if (
              key.startsWith('unkeep-attachment:shared-race:')
              && (value as { needsUpload?: unknown }).needsUpload === true
            ) {
              attachmentWrites += 1;
            }
            transaction.set(key, value);
          },
          delete: key => transaction.delete(key),
        });
      }),
    };
    const attachments = new AttachmentStore(countingStorage, 'shared-race');
    const activeResources = resources('shared-race', attachments);
    const adapter = new TestAdapter();
    const firstTab = new NoteStore(() => activeResources);
    const secondTab = new NoteStore(() => activeResources);
    await Promise.all([
      firstTab.initWithAdapter(adapter, {}),
      secondTab.initWithAdapter(adapter, {}),
    ]);
    const draft = {
      content: 'shared with bytes',
      attachments: [{
        name: 'shared.png',
        mimeType: 'image/png',
        size: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }],
    };

    const [first, second] = await Promise.all([
      firstTab.createReceivedNote(
        draft,
        { idempotencyKey: 'same-share-with-attachment', createdAt: 123 },
      ),
      secondTab.createReceivedNote(
        draft,
        { idempotencyKey: 'same-share-with-attachment', createdAt: 123 },
      ),
    ]);

    expect(first.id).toBe(second.id);
    expect(attachmentWrites).toBe(1);
    expect(first.images).toHaveLength(1);
    await expect(attachments.get(first.id, first.images![0].id)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(attachments.pendingUploads()).resolves.toHaveLength(1);
  });

  it('reclaims a crashed shared-note attachment stage without duplicating bytes', async () => {
    const idempotencyKey = 'crashed-share-with-attachment';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(idempotencyKey),
    );
    const noteId = `shared_${[...new Uint8Array(digest)]
      .map(value => value.toString(16).padStart(2, '0'))
      .join('')}`;
    const attachmentId = `${noteId}_attachment_0`;
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'shared-crash');
    const activeResources = resources('shared-crash', attachments);
    const adapter = new TestAdapter();
    const abandoned = await adapter.claimNoteCreation(noteId, Date.now() - 30_001);
    expect(abandoned.status).toBe('claimed');
    await attachments.save(
      noteId,
      { id: attachmentId, name: 'shared.png', mimeType: 'image/png', size: 3 },
      new Uint8Array([9, 9, 9]),
      { pendingUpload: true },
    );
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(adapter, {});

    const created = await store.createReceivedNote({
      content: 'retry after browser stop',
      attachments: [{
        name: 'shared.png',
        mimeType: 'image/png',
        size: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }],
    }, {
      idempotencyKey,
      createdAt: 123,
    });

    expect(created.id).toBe(noteId);
    expect(created.images).toEqual([
      expect.objectContaining({ id: attachmentId, name: 'shared.png' }),
    ]);
    await expect(attachments.get(noteId, attachmentId)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expect(attachments.pendingUploads()).resolves.toHaveLength(1);
    await expect(adapter.listNotes()).resolves.toHaveLength(1);
    await expect(adapter.listPendingNoteSync()).resolves.toHaveLength(1);
  });

  it('cleans failed shared staging while still owning the claim', async () => {
    const adapter = new TestAdapter();
    const events: string[] = [];
    const originalRelease = adapter.releaseNoteCreationClaim.bind(adapter);
    adapter.releaseNoteCreationClaim = async (id, token) => {
      events.push('release');
      return originalRelease(id, token);
    };
    class FailingAttachmentStore extends AttachmentStore {
      private stages = 0;

      override async stageUpload(
        noteId: string,
        value: NoteAttachment,
        bytes: Uint8Array<ArrayBuffer>,
        options: { stagedAt?: number; generation?: string } = {},
      ) {
        this.stages += 1;
        if (this.stages === 2) throw new Error('second attachment failed');
        return super.stageUpload(noteId, value, bytes, options);
      }

      override async discardStage(handle: {
        noteId: string;
        attachmentId: string;
        generation: string;
      }): Promise<boolean> {
        const waiting = await adapter.claimNoteCreation(handle.noteId);
        events.push(`cleanup:${waiting.status}`);
        return super.discardStage(handle);
      }
    }
    const attachments = new FailingAttachmentStore(
      new MemoryClientStorage(),
      'claim-cleanup',
    );
    const store = new NoteStore(() => resources('claim-cleanup', attachments));
    await store.initWithAdapter(adapter, {});

    await expect(store.createReceivedNote({
      content: 'fail after one stage',
      attachments: [
        {
          name: 'first.bin',
          mimeType: 'application/octet-stream',
          size: 1,
          bytes: new Uint8Array([1]),
        },
        {
          name: 'second.bin',
          mimeType: 'application/octet-stream',
          size: 1,
          bytes: new Uint8Array([2]),
        },
      ],
    }, {
      idempotencyKey: 'claim-cleanup-share',
      createdAt: 123,
    })).rejects.toThrow('second attachment failed');

    expect(events).toEqual(['cleanup:busy', 'release']);
    await expect(attachments.stagedUploads()).resolves.toEqual([]);
  });

  it('adds an attachment only to the vault where file reading began', async () => {
    const oldResources = resources('old');
    const newResources = resources('new');
    let activeResources = oldResources;
    const oldNote = note('old-note', 'old vault');
    const oldAdapter = new TestAdapter([oldNote]);
    const newAdapter = new TestAdapter([note('new-note', 'new vault')]);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    const fileRead = deferred<ArrayBuffer>();
    const file = new File(['png'], 'added.png', { type: 'image/png' });
    vi.spyOn(file, 'arrayBuffer').mockImplementation(() => fileRead.promise);

    const adding = store.addAttachment(oldNote.id, file);
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    fileRead.resolve(new Uint8Array([1, 2, 3]).buffer);
    await adding;

    const savedOld = await oldAdapter.getNote(oldNote.id);
    expect(savedOld.images).toHaveLength(1);
    await expect(oldResources.attachments.get(oldNote.id, savedOld.images![0].id))
      .resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    await expect(newAdapter.getNote(oldNote.id)).rejects.toThrow('Note not found');
    expect(store.notes.map(value => value.id)).toEqual(['new-note']);
  });

  it('keeps attachment removal crash-safe until the note snapshot authorizes deletion', async () => {
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    class PausedAdapter extends TestAdapter {
      override async saveNoteWithPendingSync(
        value: Note,
        options: { beforeAttachments?: Note } = {},
      ): Promise<PendingNoteSync> {
        saveStarted.resolve();
        await releaseSave.promise;
        return super.saveNoteWithPendingSync(value, options);
      }
    }

    const attachments = new AttachmentStore(new MemoryClientStorage(), 'remove-crash');
    const vaultResources = resources('remove-crash', attachments);
    const attachment = {
      id: 'crash-image',
      name: 'crash.png',
      mimeType: 'image/png',
      size: 3,
    };
    const original = { ...note('crash-note', 'survives a crash'), images: [attachment] };
    const bytes = new Uint8Array([1, 2, 3]);
    const adapter = new PausedAdapter([original]);
    await attachments.save(original.id, attachment, bytes);
    const store = new NoteStore(() => vaultResources);
    await store.initWithAdapter(adapter, {});

    const removing = store.removeAttachment(original.id, attachment.id);
    await saveStarted.promise;
    try {
      // A tab can terminate at any await. Until the note and its pending
      // outbox snapshot commit atomically, the old note must retain its bytes.
      await expect(adapter.getNote(original.id)).resolves.toMatchObject({
        images: [attachment],
      });
      await expect(attachments.get(original.id, attachment.id)).resolves.toEqual({
        attachment,
        bytes,
      });
      await expect(attachments.pendingDeletes()).resolves.toEqual([]);

      const restarted = new NoteStore(() => vaultResources);
      await restarted.initWithAdapter(adapter, {});
      let pulls = 0;
      useTestSync(restarted, {
        push: async () => 1,
        uploadAttachment: async () => undefined,
        deleteAttachment: async () => undefined,
        pull: async () => {
          pulls += 1;
          return {
            notes: [],
            deletedIds: [],
            attachments: [],
            deletedAttachments: [],
            cursor: 0,
            revisions: [],
          };
        },
        acknowledge: async () => undefined,
      });

      await restarted.sync();

      expect(pulls).toBe(1);
      expect(restarted.syncStatus).toBe('synced');
    } finally {
      releaseSave.resolve();
      await removing;
    }
  });

  it('replays a committed attachment removal after restart before pulling', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'remove-restart');
    const vaultResources = resources('remove-restart', attachments);
    const attachment = {
      id: 'restart-image',
      name: 'restart.png',
      mimeType: 'image/png',
      size: 3,
    };
    const original = { ...note('restart-note', 'resume removal'), images: [attachment] };
    const bytes = new Uint8Array([4, 5, 6]);
    const adapter = new TestAdapter([original]);
    await attachments.save(original.id, attachment, bytes);
    const firstRun = new NoteStore(() => vaultResources);
    await firstRun.initWithAdapter(adapter, {});
    useTestSync(firstRun, {
      push: async () => {
        throw new TypeError('simulated tab termination after local commit');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await firstRun.removeAttachment(original.id, attachment.id);
    warn.mockRestore();

    await expect(adapter.getNote(original.id)).resolves.toMatchObject({ images: undefined });
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([
      expect.objectContaining({
        id: original.id,
        beforeAttachments: expect.objectContaining({ images: [attachment] }),
      }),
    ]);
    await expect(attachments.get(original.id, attachment.id)).resolves.toEqual({
      attachment,
      bytes,
    });
    await expect(attachments.pendingDeletes()).resolves.toEqual([
      { noteId: original.id, attachment, retainBytes: true },
    ]);

    const events: string[] = [];
    const restarted = new NoteStore(() => vaultResources);
    await restarted.initWithAdapter(adapter, {});
    useTestSync(restarted, {
      push: async (value: Note) => {
        events.push(value.images?.length ? 'push:predecessor' : 'push:final');
        return 2;
      },
      uploadAttachment: async () => undefined,
      deleteAttachment: async (_noteId: string, value: NoteAttachment) => {
        events.push(`delete:${value.id}`);
      },
      pull: async () => {
        events.push('pull');
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          cursor: 0,
          revisions: [],
        };
      },
      acknowledge: async () => undefined,
    });

    await restarted.sync();

    expect(events).toEqual(['push:final', `delete:${attachment.id}`, 'pull']);
    expect(restarted.syncStatus).toBe('synced');
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);
    await expect(attachments.get(original.id, attachment.id)).resolves.toBeNull();
  });

  it('removes an attachment only from the vault where removal began', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockedKey = '';
    let blockReads = false;
    const delayedStorage: ClientStorage = {
      get: async <T>(key: string) => {
        if (blockReads && key === blockedKey) {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return backing.get<T>(key);
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const oldAttachments = new AttachmentStore(delayedStorage, 'old');
    const newAttachments = new AttachmentStore(new MemoryClientStorage(), 'new');
    const oldRevoked: string[] = [];
    const newRevoked: string[] = [];
    const oldResources = resources('old', oldAttachments, oldRevoked);
    const newResources = resources('new', newAttachments, newRevoked);
    let activeResources = oldResources;
    const attachment = { id: 'shared-image', name: 'shared.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('shared-note', 'old vault'), images: [attachment] };
    const newNote = { ...note('shared-note', 'new vault'), images: [attachment] };
    const oldAdapter = new TestAdapter([oldNote]);
    const newAdapter = new TestAdapter([newNote]);
    const oldBytes = new Uint8Array([1, 2, 3]);
    const newBytes = new Uint8Array([7, 8, 9]);
    await oldAttachments.save(oldNote.id, attachment, oldBytes);
    await newAttachments.save(newNote.id, attachment, newBytes);
    blockedKey = oldAttachments.storageKey(oldNote.id, attachment.id);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    blockReads = true;

    const removing = store.removeAttachment(oldNote.id, attachment.id);
    await readStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    releaseRead.resolve();
    await removing;

    await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({ images: undefined });
    await expect(oldAttachments.get(oldNote.id, attachment.id)).resolves.toEqual({
      attachment,
      bytes: oldBytes,
    });
    await expect(oldAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault', images: [attachment] });
    await expect(newAttachments.get(newNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: newBytes });
    await expect(newAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(newAttachments.pendingUploads()).resolves.toEqual([]);
    expect(store.notes).toEqual([expect.objectContaining({ content: 'new vault', images: [expect.objectContaining(attachment)] })]);
    expect(oldRevoked).toEqual(['blob:old']);
    expect(newRevoked).toEqual([]);
    await expect(oldAdapter.listPendingNoteSync()).resolves.toEqual([
      expect.objectContaining({
        id: oldNote.id,
        beforeAttachments: expect.objectContaining({ images: [attachment] }),
      }),
    ]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('leaves a failed old-vault removal intact without creating work in the replacement vault', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockedKey = '';
    let blockReads = false;
    const delayedStorage: ClientStorage = {
      get: async <T>(key: string) => {
        if (blockReads && key === blockedKey) {
          readStarted.resolve();
          await releaseRead.promise;
        }
        return backing.get<T>(key);
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const oldAttachments = new AttachmentStore(delayedStorage, 'old');
    const newAttachments = new AttachmentStore(new MemoryClientStorage(), 'new');
    const oldResources = resources('old', oldAttachments);
    const newResources = resources('new', newAttachments);
    let activeResources = oldResources;
    const attachment = { id: 'shared-image', name: 'shared.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('shared-note', 'old vault'), images: [attachment] };
    const newNote = { ...note('shared-note', 'new vault'), images: [attachment] };
    const oldAdapter = new TestAdapter([oldNote]);
    const newAdapter = new TestAdapter([newNote]);
    const oldBytes = new Uint8Array([1, 2, 3]);
    const newBytes = new Uint8Array([7, 8, 9]);
    await oldAttachments.save(oldNote.id, attachment, oldBytes);
    await newAttachments.save(newNote.id, attachment, newBytes);
    blockedKey = oldAttachments.storageKey(oldNote.id, attachment.id);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    blockReads = true;

    const removing = store.removeAttachment(oldNote.id, attachment.id);
    await readStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    oldAdapter.failNextSave = true;
    releaseRead.resolve();
    await removing;

    await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({ content: 'old vault', images: [attachment] });
    await expect(oldAttachments.get(oldNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: oldBytes });
    await expect(oldAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(oldAttachments.pendingUploads()).resolves.toEqual([]);
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault', images: [attachment] });
    await expect(newAttachments.get(newNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: newBytes });
    await expect(newAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(newAttachments.pendingUploads()).resolves.toEqual([]);
    expect(store.notes).toEqual([expect.objectContaining({ content: 'new vault', images: [expect.objectContaining(attachment)] })]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('keeps trashed note content and attachment bytes recoverable until explicit deletion', async () => {
    const attachment = { id: 'trash-image', name: 'trash.png', mimeType: 'image/png', size: 3 };
    const original = { ...note('trash-note', 'recover me'), archived: true, images: [attachment] };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'trash');
    const bytes = new Uint8Array([1, 2, 3]);
    await attachments.save(original.id, attachment, bytes);
    const adapter = new TestAdapter([original]);
    const store = new NoteStore(() => resources('trash', attachments));
    await store.initWithAdapter(adapter, {});

    await expect(store.permanentlyDeleteNote(original.id)).resolves.toBe(false);
    await expect(adapter.getNote(original.id)).resolves.toEqual(original);

    await expect(store.trashNote(original.id)).resolves.toBe(true);
    await expect(adapter.getNote(original.id)).resolves.toMatchObject({
      content: original.content,
      archived: false,
      trashedAt: expect.any(Number),
      images: [attachment],
    });
    await expect(attachments.get(original.id, attachment.id)).resolves.toEqual({ attachment, bytes });
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);

    await expect(store.restoreTrashedNote(original.id)).resolves.toBe(true);
    const restored = await adapter.getNote(original.id);
    expect(restored.trashedAt).toBeUndefined();
    expect(restored.content).toBe(original.content);
    await expect(attachments.get(original.id, attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('finishes a deferred delete in its origin vault without mutating the same position in a new vault', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockTransaction = false;
    const delayedStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
      transact: async (keys, change) => {
        if (
          blockTransaction
          && keys.some(key => key.startsWith('unkeep-attachment:old:'))
        ) {
          blockTransaction = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        await backing.transact(keys, change);
      },
    };
    const oldAttachments = new AttachmentStore(delayedStorage, 'old');
    const oldResources = resources('old', oldAttachments);
    const newResources = resources('new');
    let activeResources = oldResources;
    const attachment = { id: 'old-image', name: 'old.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('old-note', 'old vault'), images: [attachment] };
    const newNote = note('new-note', 'new vault');
    const oldAdapter = new TestAdapter([oldNote]);
    const newAdapter = new TestAdapter([newNote]);
    await oldAttachments.save(oldNote.id, attachment, new Uint8Array([1, 2, 3]));
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    blockTransaction = true;

    const deleting = store.deleteNote(oldNote.id);
    await readStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    releaseRead.resolve();
    await deleting;

    await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({ deleted: true });
    const persistedNew = await newAdapter.getNote(newNote.id);
    expect(persistedNew).toMatchObject({ content: 'new vault' });
    expect(persistedNew).not.toHaveProperty('deleted');
    expect(store.notes).toEqual([expect.objectContaining({ id: newNote.id, content: 'new vault' })]);
    await expect(oldAttachments.pendingDeletes()).resolves.toEqual([
      { noteId: oldNote.id, attachment, retainBytes: true },
    ]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('finishes a deferred Undo durably in its origin vault without inserting into the new vault', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockedKey = '';
    let blockRead = false;
    const delayedStorage: ClientStorage = {
      get: async <T>(key: string) => {
        if (blockRead && key === blockedKey) {
          blockRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return backing.get<T>(key);
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const oldAttachments = new AttachmentStore(delayedStorage, 'old');
    const oldResources = resources('old', oldAttachments);
    const newResources = resources('new');
    let activeResources = oldResources;
    const attachment = { id: 'old-image', name: 'old.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('old-note', 'old vault'), images: [attachment] };
    const newNote = note('new-note', 'new vault');
    const oldAdapter = new TestAdapter([oldNote]);
    const newAdapter = new TestAdapter([newNote]);
    const oldBytes = new Uint8Array([1, 2, 3]);
    await oldAttachments.save(oldNote.id, attachment, oldBytes);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(oldAdapter, {});
    const token = await store.deleteNote(oldNote.id);
    expect(token).not.toBeNull();
    expect(token).not.toHaveProperty('id');
    blockedKey = oldAttachments.storageKey(oldNote.id, attachment.id);
    blockRead = true;

    const undoing = store.undoDelete(token!);
    await readStarted.promise;
    activeResources = newResources;
    await store.initWithAdapter(newAdapter, {});
    releaseRead.resolve();
    await undoing;

    const restoredOld = await oldAdapter.getNote(oldNote.id);
    expect(restoredOld).toMatchObject({
      content: 'old vault',
      deleted: false,
      images: [expect.objectContaining({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })],
    });
    expect(restoredOld.images![0].id).not.toBe(attachment.id);
    await expect(oldAttachments.get(oldNote.id, attachment.id)).resolves.toBeNull();
    await expect(oldAttachments.get(oldNote.id, restoredOld.images![0].id))
      .resolves.toEqual({ attachment: restoredOld.images![0], bytes: oldBytes });
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault' });
    expect(store.notes).toEqual([expect.objectContaining({ id: newNote.id, content: 'new vault' })]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('restores a fast online delete with fresh relay attachment IDs', async () => {
    const attachment = {
      id: 'immutable-old-id',
      name: 'old.png',
      mimeType: 'image/png',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { ...note('online-undo-note', 'restore me'), images: [attachment] };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'online-undo');
    await attachments.save(original.id, attachment, bytes);
    const adapter = new TestAdapter([original]);
    const store = new NoteStore(() => resources('online-undo', attachments));
    await store.initWithAdapter(adapter, {});
    const sync = new RevisionedSyncDouble(null, original, attachment, bytes);
    useTestSync(store, sync);

    const token = await store.deleteNote(original.id);
    expect(token).not.toBeNull();
    await store.undoDelete(token!);

    const restored = await adapter.getNote(original.id);
    expect(restored.deleted).toBe(false);
    expect(restored.images).toHaveLength(1);
    const fresh = restored.images![0];
    expect(fresh.id).not.toBe(attachment.id);
    expect(sync.events).toEqual([
      `push:${original.id}`,
      `delete:${attachment.id}`,
      `push:${original.id}`,
      `upload:${fresh.id}`,
    ]);
    await expect(attachments.get(original.id, attachment.id)).resolves.toBeNull();
    await expect(attachments.get(original.id, fresh.id)).resolves.toEqual({
      attachment: fresh,
      bytes,
    });
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
  });

  it('atomically reopens a tombstoned note with its Undo attachment', async () => {
    const oldAttachment = {
      id: 'ambiguous-old-id',
      name: 'proof.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { ...note('ambiguous-undo-note', 'restore after restart'), images: [oldAttachment] };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'ambiguous-undo');
    await attachments.save(original.id, oldAttachment, bytes);
    const adapter = new TestAdapter([original]);
    const activeResources = resources('ambiguous-undo', attachments);
    let failTombstoneResponse = true;
    let failPredecessorResponse = true;
    let remoteNote: Note = cloneNote(original);
    const remoteAttachments = new Map([[oldAttachment.id, bytes]]);
    const events: string[] = [];
    const sync = {
      async push(value: Note) {
        const kind = value.deleted ? 'tombstone' : value.images?.length ? 'final' : 'predecessor';
        events.push(`push:${kind}`);
        remoteNote = cloneNote(value);
        if (value.deleted) remoteAttachments.clear();
        if (value.deleted && failTombstoneResponse) {
          failTombstoneResponse = false;
          throw new TypeError('tombstone response lost');
        }
        if (!value.deleted && !value.images?.length && failPredecessorResponse) {
          failPredecessorResponse = false;
          throw new TypeError('predecessor response lost');
        }
        return 3;
      },
      async uploadAttachment(_noteId: string, value: NoteAttachment, valueBytes: Uint8Array<ArrayBuffer>) {
        events.push(`upload:${value.id}`);
        if (remoteNote.deleted) throw new Error('cannot attach bytes to a tombstoned note');
        remoteAttachments.set(value.id, new Uint8Array(valueBytes));
      },
      async deleteAttachment(_noteId: string, value: NoteAttachment) {
        events.push(`delete:${value.id}`);
        remoteAttachments.delete(value.id);
      },
      async pull() {
        return {
          notes: remoteNote.deleted ? [] : [cloneNote(remoteNote)],
          deletedIds: remoteNote.deleted ? [remoteNote.id] : [],
          attachments: (remoteNote.images ?? []).flatMap(value => {
            const valueBytes = remoteAttachments.get(value.id);
            return valueBytes
              ? [{ noteId: remoteNote.id, attachment: value, bytes: valueBytes }]
              : [];
          }),
          deletedAttachments: [],
          cursor: 3,
          revisions: [],
        };
      },
      async acknowledge() {},
    };
    const firstRun = new NoteStore(() => activeResources);
    await firstRun.initWithAdapter(adapter, {});
    useTestSync(firstRun, sync);

    const undoToken = await firstRun.deleteNote(original.id);
    expect(undoToken).not.toBeNull();
    await firstRun.undoDelete(undoToken!);
    const restoredBeforeRestart = await adapter.getNote(original.id);
    const fresh = restoredBeforeRestart.images![0];
    expect(events).toEqual([
      'push:tombstone',
      'push:final',
      `upload:${fresh.id}`,
      `delete:${oldAttachment.id}`,
    ]);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);

    const restarted = new NoteStore(() => activeResources);
    await restarted.initWithAdapter(adapter, {});
    useTestSync(restarted, sync);
    await restarted.sync();

    expect(events).toEqual([
      'push:tombstone',
      'push:final',
      `upload:${fresh.id}`,
      `delete:${oldAttachment.id}`,
    ]);
    expect(remoteNote).toMatchObject({
      id: original.id,
      deleted: false,
      images: [expect.objectContaining({ id: fresh.id })],
    });
    expect(remoteAttachments.has(fresh.id)).toBe(true);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
  });

  it('retires the original Undo upload after a predecessor conflict preserves a copy', async () => {
    const oldAttachment = {
      id: 'pre-conflict-old-id',
      name: 'proof.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { ...note('undo-predecessor-conflict', 'local edit'), images: [oldAttachment] };
    const winner = { ...note(original.id, 'concurrent winner'), updatedAt: 5 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'undo-predecessor-conflict');
    await attachments.save(original.id, oldAttachment, bytes);
    const adapter = new TestAdapter([original]);
    const store = new NoteStore(() => resources('undo-predecessor-conflict', attachments));
    await store.initWithAdapter(adapter, {});
    const events: string[] = [];
    const sync = {
      async push(value: Note) {
        events.push(`push:${value.id}:${value.deleted ? 'deleted' : value.images?.length ? 'images' : 'plain'}`);
        if (value.id === original.id && !value.deleted && value.images?.length) {
          throw new RecordConflictError(5);
        }
        return 5;
      },
      async uploadAttachment(noteId: string, value: NoteAttachment) {
        events.push(`upload:${noteId}:${value.id}`);
      },
      async deleteAttachment(noteId: string, value: NoteAttachment) {
        events.push(`delete:${noteId}:${value.id}`);
      },
      async pull() {
        return {
          notes: [cloneNote(winner)],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          cursor: 5,
          revisions: [],
        };
      },
      async acknowledge() {},
    };
    useTestSync(store, sync);

    const undoToken = await store.deleteNote(original.id);
    expect(undoToken).not.toBeNull();
    await store.undoDelete(undoToken!);
    const rejected = await adapter.getNote(original.id);
    const rejectedFreshId = rejected.images![0].id;
    const eventsAfterPreservation = [...events];

    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    await expect(attachments.get(original.id, rejectedFreshId)).resolves.toBeNull();
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    await expect(attachments.stagedUploads()).resolves.toEqual([]);
    await expect(attachments.compoundUploadIntent(original.id)).resolves.toBeNull();

    await store.sync();

    expect(events).toEqual(eventsAfterPreservation);
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([]);
    expect((await adapter.getAllNotes())).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: winner.id, content: winner.content }),
      expect.objectContaining({
        title: expect.stringMatching(/conflict copy/i),
        images: [expect.objectContaining({ id: expect.not.stringMatching(rejectedFreshId) })],
      }),
    ]));
  });

  it('treats an expired Undo invoked after a vault switch as a no-op', async () => {
    vi.useFakeTimers();
    try {
      const oldResources = resources('old');
      const newResources = resources('new');
      let activeResources = oldResources;
      const oldNote = note('old-note', 'old vault');
      const newNote = note('new-note', 'new vault');
      const oldAdapter = new TestAdapter([oldNote]);
      const newAdapter = new TestAdapter([newNote]);
      const store = new NoteStore(() => activeResources);
      await store.initWithAdapter(oldAdapter, {});
      const token = await store.deleteNote(oldNote.id);
      expect(token).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3_001);
      activeResources = newResources;
      await store.initWithAdapter(newAdapter, {});

      await store.undoDelete(token!);

      await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({ deleted: true });
      await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault' });
      expect(store.notes).toEqual([expect.objectContaining({ id: newNote.id })]);
      expect(localValues.get(newResources.pendingKey)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls a failed Undo persistence back to a durable deletion', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'old');
    const oldResources = resources('old', attachments);
    const attachment = { id: 'old-image', name: 'old.png', mimeType: 'image/png', size: 3 };
    const oldNote = { ...note('old-note', 'old vault'), images: [attachment] };
    const adapter = new TestAdapter([oldNote]);
    const bytes = new Uint8Array([1, 2, 3]);
    await attachments.save(oldNote.id, attachment, bytes);
    const store = new NoteStore(() => oldResources);
    await store.initWithAdapter(adapter, {});
    const token = await store.deleteNote(oldNote.id);
    expect(token).not.toBeNull();
    adapter.failNextSave = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await store.undoDelete(token!);
      await store.undoDelete(token!);
    } finally {
      logged.mockRestore();
    }

    await expect(adapter.getNote(oldNote.id)).resolves.toMatchObject({ deleted: true });
    await expect(attachments.get(oldNote.id, attachment.id))
      .resolves.toEqual({ attachment, bytes });
    await expect(attachments.pendingDeletes()).resolves.toEqual([
      { noteId: oldNote.id, attachment, retainBytes: true },
    ]);
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    expect(store.notes).toEqual([]);
  });

  it('does not let a stale attachment removal delete the attachment from a winning edit', async () => {
    const attachment = { id: 'shared-image', name: 'shared.png', mimeType: 'image/png', size: 3 };
    const bytes = new Uint8Array([1, 2, 3]);
    const stale = { ...note('shared-note', 'stale base'), images: [attachment] };
    const winner = { ...stale, content: 'winning edit', updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'conflicting-remove');
    await attachments.save(stale.id, attachment, bytes);
    const activeResources = resources('conflicting-remove', attachments);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(new TestAdapter([stale]), {});
    const sync = new RevisionedSyncDouble(stale.id, winner, attachment, bytes);
    useTestSync(store, sync);

    await store.removeAttachment(stale.id, attachment.id);
    await store.sync();

    expect(sync.attachmentPresent).toBe(true);
    expect(sync.events).toContain(`push:${stale.id}`);
    expect(sync.events).not.toContain(`delete:${attachment.id}`);
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);
    expect(store.notes).toEqual([
      expect.objectContaining({
        id: winner.id,
        content: winner.content,
        images: [expect.objectContaining(attachment)],
      }),
      expect.objectContaining({ title: 'Conflict copy', images: undefined }),
    ]);
  });

  it('does not let a stale note deletion tombstone attachments from a winning edit, including retry', async () => {
    const attachment = { id: 'shared-image', name: 'shared.png', mimeType: 'image/png', size: 3 };
    const bytes = new Uint8Array([1, 2, 3]);
    const stale = { ...note('shared-note', 'stale base'), images: [attachment] };
    const winner = { ...stale, content: 'winning edit', updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'conflicting-delete');
    await attachments.save(stale.id, attachment, bytes);
    const activeResources = resources('conflicting-delete', attachments);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(new TestAdapter([stale]), {});
    const sync = new RevisionedSyncDouble(stale.id, winner, attachment, bytes);
    useTestSync(store, sync);

    expect(await store.deleteNote(stale.id)).not.toBeNull();
    await store.sync();

    expect(sync.attachmentPresent).toBe(true);
    expect(sync.events).toContain(`push:${stale.id}`);
    expect(sync.events).not.toContain(`delete:${attachment.id}`);
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);
    expect(store.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: winner.id,
        content: winner.content,
        images: [expect.objectContaining(attachment)],
      }),
    ]));
  });

  it('retries a failed attachment deletion only after the owning note is accepted', async () => {
    const attachment = { id: 'removed-image', name: 'removed.png', mimeType: 'image/png', size: 3 };
    const bytes = new Uint8Array([1, 2, 3]);
    const original = { ...note('current-note', 'current'), images: [attachment] };
    const removed = { ...original, images: undefined, updatedAt: 2 };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'delete-retry');
    await attachments.save(original.id, attachment, bytes);
    const activeResources = resources('delete-retry', attachments);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(new TestAdapter([original]), {});
    const sync = new RevisionedSyncDouble(null, removed, attachment, bytes);
    sync.failNextAttachmentDelete = true;
    useTestSync(store, sync);

    await store.removeAttachment(original.id, attachment.id);

    expect(sync.events).toEqual([`push:${original.id}`, `delete:${attachment.id}`]);
    expect(sync.attachmentPresent).toBe(true);
    await expect(attachments.pendingDeletes()).resolves.toEqual([
      { noteId: original.id, attachment, retainBytes: true },
    ]);

    sync.events.length = 0;
    await store.sync();

    expect(sync.events).toEqual([`push:${original.id}`, `delete:${attachment.id}`]);
    expect(sync.attachmentPresent).toBe(false);
    await expect(attachments.pendingDeletes()).resolves.toEqual([]);
  });

  it('never pulls over a durable local edit when its relay mutation failed transiently', async () => {
    const local = { ...note('pending-note', 'local edit'), updatedAt: 2 };
    const remote = { ...local, content: 'concurrent remote edit', updatedAt: 3 };
    const activeResources = resources('failed-push');
    const adapter = new TestAdapter([local]);
    const store = new NoteStore(() => activeResources);
    await store.initWithAdapter(adapter, {});
    await adapter.queueNoteForSync(local.id);
    const sync = new RevisionedSyncDouble(
      null,
      remote,
      { id: 'unused', name: 'unused.bin', mimeType: 'application/octet-stream', size: 0 },
      new Uint8Array(),
    );
    sync.failNextPush = true;
    useTestSync(store, sync);

    await store.sync();

    expect(sync.events).toEqual([`push:${local.id}`]);
    expect(sync.pullCalls).toBe(0);
    expect(sync.acknowledgeCalls).toBe(0);
    await expect(adapter.getNote(local.id)).resolves.toMatchObject({ content: 'local edit' });
    expect(store.notes).toEqual([expect.objectContaining({ id: local.id, content: 'local edit' })]);
    expect(store.syncStatus).toBe('offline');
    await expect(adapter.listPendingNoteSync()).resolves.toEqual([
      expect.objectContaining({ id: local.id }),
    ]);
  });

  it('preserves an edit made while a remote pull is in flight', async () => {
    vi.useFakeTimers();
    try {
      const original = note('pull-race-note', 'before');
      const remote = { ...original, content: 'remote edit', updatedAt: 2 };
      const adapter = new TestAdapter([original]);
      const store = new NoteStore(() => resources('pull-race'));
      await store.initWithAdapter(adapter, {});
      const pullStarted = deferred<void>();
      const releasePull = deferred<void>();
      useTestSync(store, {
        async pull() {
          pullStarted.resolve();
          await releasePull.promise;
          return {
            notes: [remote],
            deletedIds: [],
            attachments: [],
            deletedAttachments: [],
            quarantined: [],
            cursor: 2,
            revisions: [{ kind: 'note', id: remote.id, revision: 2 }],
          };
        },
        async acknowledge() {},
      });

      const syncing = store.sync();
      await pullStarted.promise;
      store.updateNote(original.id, { content: 'typed during pull' });
      releasePull.resolve();
      await syncing;

      expect(store.notes).toEqual([
        expect.objectContaining({ id: original.id, content: 'typed during pull' }),
      ]);
      await vi.advanceTimersByTimeAsync(500);
      await expect(adapter.getNote(original.id)).resolves.toMatchObject({
        content: 'typed during pull',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces durable quarantines after a successful sync without reporting a sync error', async () => {
    const store = new NoteStore(() => resources('quarantine-success'));
    await store.initWithAdapter(new TestAdapter(), {});
    const quarantined = [{
      kind: 'note' as const,
      id: 'poison-note',
      revision: 7,
      reason: 'note_invalid_or_undecryptable' as const,
    }];
    useTestSync(store, {
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined,
          cursor: 7,
          revisions: [{ kind: 'note', id: 'poison-note', revision: 7 }],
        };
      },
      async acknowledge() {},
      async getQuarantinedRecords() {
        return quarantined;
      },
    });

    await store.sync();

    expect(store.syncStatus).toBe('synced');
    expect(store.syncQuarantineCount).toBe(1);
  });

  it('clears a quarantine warning after a later valid sync clears durable quarantine', async () => {
    const store = new NoteStore(() => resources('quarantine-cleared'));
    await store.initWithAdapter(new TestAdapter(), {});
    let quarantined = [{
      kind: 'note' as const,
      id: 'recovered-note',
      revision: 7,
      reason: 'note_invalid_or_undecryptable' as const,
    }];
    useTestSync(store, {
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined,
          cursor: 8,
          revisions: [],
        };
      },
      async acknowledge() {},
      async getQuarantinedRecords() {
        return quarantined;
      },
    });

    await store.sync();
    expect(store.syncQuarantineCount).toBe(1);

    quarantined = [];
    await store.sync();

    expect(store.syncStatus).toBe('synced');
    expect(store.syncQuarantineCount).toBe(0);
  });

  it('resets a prior quarantine warning when a different vault adapter is initialized', async () => {
    const store = new NoteStore(() => resources('quarantine-vault-reset'));
    await store.initWithAdapter(new TestAdapter(), {});
    const quarantined = [{
      kind: 'note' as const,
      id: 'old-vault-note',
      revision: 4,
      reason: 'note_invalid_or_undecryptable' as const,
    }];
    useTestSync(store, {
      async pull() {
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          quarantined,
          cursor: 4,
          revisions: [],
        };
      },
      async acknowledge() {},
      async getQuarantinedRecords() {
        return quarantined;
      },
    });
    await store.sync();
    expect(store.syncQuarantineCount).toBe(1);

    await store.initWithAdapter(new TestAdapter(), {});

    expect(store.syncQuarantineCount).toBe(0);
  });

  it('loads durable quarantine on session enable and clears it on session disable', async () => {
    const quarantineKey = 'unkeep-sync-quarantine:paired-vault';
    const quarantined = [{
      kind: 'note' as const,
      id: 'durably-quarantined-note',
      revision: 9,
      reason: 'note_invalid_or_undecryptable' as const,
    }];
    const readState = vi.spyOn(IndexedDbClientStorage.prototype, 'get')
      .mockImplementation(async <T>(key: string) => (
        key === quarantineKey
          ? { version: 1, records: quarantined } as T
          : null
      ));
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    try {
      const store = new NoteStore();
      await store.enableEncryptedSync({
        endpoint: 'https://relay.example',
        instanceId: 'paired-vault',
        deviceId: 'paired-device',
        credential: 'test-credential',
      }, new Uint8Array(32));

      expect(readState).toHaveBeenCalledWith(quarantineKey);
      expect(store.syncStatus).toBe('synced');
      expect(store.syncQuarantineCount).toBe(1);

      await store.disableEncryptedSync();

      expect(store.syncQuarantineCount).toBe(0);
    } finally {
      readState.mockRestore();
      vi.stubGlobal('window', previousWindow);
      vi.stubGlobal('document', previousDocument);
    }
  });

  it('does not surface a stale vault quarantine when a newer session enables first', async () => {
    const oldReadStarted = deferred<void>();
    const releaseOldRead = deferred<unknown>();
    const readState = vi.spyOn(IndexedDbClientStorage.prototype, 'get')
      .mockImplementation(async <T>(key: string) => {
        if (key === 'unkeep-sync-quarantine:old-vault') {
          oldReadStarted.resolve();
          return await releaseOldRead.promise as T;
        }
        return null;
      });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    try {
      const store = new NoteStore();
      const oldEnable = store.enableEncryptedSync({
        endpoint: 'https://old.example',
        instanceId: 'old-vault',
        deviceId: 'old-device',
        credential: 'old-credential',
      }, new Uint8Array(32));
      await oldReadStarted.promise;

      await store.enableEncryptedSync({
        endpoint: 'https://new.example',
        instanceId: 'new-vault',
        deviceId: 'new-device',
        credential: 'new-credential',
      }, new Uint8Array(32));
      releaseOldRead.resolve({
        version: 1,
        records: [{
          kind: 'note',
          id: 'old-poison',
          revision: 5,
          reason: 'note_invalid_or_undecryptable',
        }],
      });
      await oldEnable;

      expect(store.syncStatus).toBe('synced');
      expect(store.syncQuarantineCount).toBe(0);
    } finally {
      readState.mockRestore();
      vi.stubGlobal('window', previousWindow);
      vi.stubGlobal('document', previousDocument);
    }
  });

  it('keeps a crash-staged upload enumerable but excludes it from relay I/O', async () => {
    const local = note('orphan-owner', 'note saved before attachment crash');
    const orphan = {
      id: 'orphan-upload',
      name: 'orphan.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'orphan-upload');
    await attachments.stageUpload(local.id, orphan, new Uint8Array([1, 2, 3]), {
      stagedAt: Date.now() - STAGED_UPLOAD_TTL_MS,
    });
    const adapter = new TestAdapter([local]);
    await adapter.queueNoteForSync(local.id);
    const store = new NoteStore(() => resources('orphan-upload', attachments));
    await store.initWithAdapter(adapter, {});
    const sync = new RevisionedSyncDouble(null, local, orphan, new Uint8Array([1, 2, 3]));
    sync.failNextPush = true;
    useTestSync(store, sync);

    await store.sync();

    expect(sync.events).toEqual([`push:${local.id}`]);
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    await expect(attachments.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: local.id, attachment: orphan }),
    ]);
    await expect(attachments.get(local.id, orphan.id)).resolves.not.toBeNull();
  });

  it('preserves staged bytes when no durable note authorizes reconciliation', async () => {
    const orphan = {
      id: 'unowned-stage',
      name: 'unowned.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const attachments = new AttachmentStore(new MemoryClientStorage(), 'unowned-stage');
    await attachments.stageUpload('missing-note', orphan, bytes, {
      stagedAt: Date.now() - STAGED_UPLOAD_TTL_MS - 1,
    });
    const adapter = new TestAdapter();
    const store = new NoteStore(() => resources('unowned-stage', attachments));
    await store.initWithAdapter(adapter, {});
    let pullCalls = 0;
    useTestSync(store, {
      async push() { throw new Error('No note is authorized for upload'); },
      async uploadAttachment() { throw new Error('No attachment is authorized for upload'); },
      async deleteAttachment() { throw new Error('No attachment is authorized for deletion'); },
      async pull() {
        pullCalls += 1;
        return {
          notes: [],
          deletedIds: [],
          attachments: [],
          deletedAttachments: [],
          cursor: 0,
          revisions: [],
        };
      },
      async acknowledge() {},
    });

    await store.sync();

    expect(pullCalls).toBe(1);
    await expect(attachments.get('missing-note', orphan.id)).resolves.toEqual({
      attachment: orphan,
      bytes,
    });
    await expect(attachments.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'missing-note', attachment: orphan }),
    ]);
  });

  it('migrates legacy localStorage pending IDs before removing the old marker', async () => {
    const local = { ...note('legacy-pending-note', 'unsynced legacy edit'), updatedAt: 2 };
    const activeResources = resources('legacy-pending');
    localValues.set(activeResources.pendingKey, JSON.stringify([local.id]));
    const adapter = new TestAdapter([local]);
    const store = new NoteStore(() => activeResources);

    await store.initWithAdapter(adapter, {});

    await expect(adapter.listPendingNoteSync()).resolves.toEqual([
      expect.objectContaining({
        id: local.id,
        note: expect.objectContaining({ content: local.content }),
      }),
    ]);
    expect(localValues.get(activeResources.pendingKey)).toBeUndefined();
  });
});
