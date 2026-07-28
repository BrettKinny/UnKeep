import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfigField,
  Note,
  NoteMetadata,
  StorageAdapter,
  SyncResult,
  ValidationResult,
} from '@unkeep/core';
import { MemoryClientStorage, type ClientStorage } from '@unkeep/client';
import { AttachmentStore, AttachmentUrlCache } from './attachmentStorage';

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
  initWithAdapter(adapter: StorageAdapter, config: Record<string, unknown>): Promise<void>;
  prepareQuickSend(note: Note): Promise<{ attachments?: Array<{ bytes: Uint8Array<ArrayBuffer> }> }>;
  createReceivedNote(draft: {
    content: string;
    attachments?: Array<{ name: string; mimeType: string; size: number; bytes: Uint8Array<ArrayBuffer> }>;
  }): Promise<Note>;
  addAttachment(noteId: string, file: File): Promise<void>;
  removeAttachment(noteId: string, attachmentId: string): Promise<void>;
  deleteNote(noteId: string): Promise<unknown | null>;
  undoDelete(token: unknown): Promise<void>;
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

class TestAdapter implements StorageAdapter {
  readonly id = 'test';
  readonly displayName = 'Test';
  readonly description = 'Test adapter';
  readonly configSchema: ConfigField[] = [];
  private readonly values = new Map<string, Note>();
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

describe('NoteStore vault lifecycle', () => {
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
      set: async <T>(key: string, value: T) => {
        if (blockAttachmentSave && key.startsWith('unkeep-attachment:old:')) {
          saveStarted.resolve();
          await releaseSave.promise;
        }
        await backing.set(key, value);
      },
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
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
    await expect(oldAttachments.get(oldNote.id, attachment.id)).resolves.toBeNull();
    await expect(oldAttachments.pendingDeletes()).resolves.toEqual([{ noteId: oldNote.id, attachment }]);
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault', images: [attachment] });
    await expect(newAttachments.get(newNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: newBytes });
    await expect(newAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(newAttachments.pendingUploads()).resolves.toEqual([]);
    expect(store.notes).toEqual([expect.objectContaining({ content: 'new vault', images: [expect.objectContaining(attachment)] })]);
    expect(oldRevoked).toEqual(['blob:old']);
    expect(newRevoked).toEqual([]);
    expect(localValues.get(oldResources.pendingKey)).toContain(oldNote.id);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('rolls a failed old-vault removal back without creating work in the replacement vault', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockedKey = '';
    let blockReads = false;
    let failDeleteQueue = false;
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
      update: async <T>(key: string, change: (value: T | null) => T | null) => {
        if (failDeleteQueue && key.startsWith('unkeep-pending-attachment-uploads')) {
          failDeleteQueue = false;
          throw new Error('IndexedDB queue update failed');
        }
        await backing.update(key, change);
      },
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
    failDeleteQueue = true;
    releaseRead.resolve();
    await removing;

    await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({ content: 'old vault', images: [attachment] });
    await expect(oldAttachments.get(oldNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: oldBytes });
    await expect(oldAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(oldAttachments.pendingUploads()).resolves.toEqual([{ noteId: oldNote.id, attachment, bytes: oldBytes }]);
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault', images: [attachment] });
    await expect(newAttachments.get(newNote.id, attachment.id)).resolves.toEqual({ attachment, bytes: newBytes });
    await expect(newAttachments.pendingDeletes()).resolves.toEqual([]);
    await expect(newAttachments.pendingUploads()).resolves.toEqual([]);
    expect(store.notes).toEqual([expect.objectContaining({ content: 'new vault', images: [expect.objectContaining(attachment)] })]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
  });

  it('finishes a deferred delete in its origin vault without mutating the same position in a new vault', async () => {
    const backing = new MemoryClientStorage();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let blockReads = false;
    const delayedStorage: ClientStorage = {
      get: async <T>(key: string) => {
        if (blockReads && key.startsWith('unkeep-attachment:old:')) {
          blockReads = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return backing.get<T>(key);
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) => backing.update(key, change),
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
    blockReads = true;

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

    await expect(oldAdapter.getNote(oldNote.id)).resolves.toMatchObject({
      content: 'old vault',
      deleted: false,
      images: [attachment],
    });
    await expect(oldAttachments.get(oldNote.id, attachment.id))
      .resolves.toEqual({ attachment, bytes: oldBytes });
    await expect(newAdapter.getNote(newNote.id)).resolves.toMatchObject({ content: 'new vault' });
    expect(store.notes).toEqual([expect.objectContaining({ id: newNote.id, content: 'new vault' })]);
    expect(localValues.get(newResources.pendingKey)).toBeUndefined();
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
});
