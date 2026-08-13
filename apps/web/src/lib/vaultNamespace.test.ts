import { describe, expect, it, vi } from 'vitest';
import { MemoryClientStorage, type ClientStorage } from '@unkeep/client';
import type { Note, NoteAttachment } from '@unkeep/core';
import { AttachmentStore } from './attachmentStorage';
import { initializeVaultAdapter, scopedClientStateKey } from './vaultNamespace';

const legacyAttachment: NoteAttachment = {
  id: 'legacy-image',
  name: 'legacy.png',
  mimeType: 'image/png',
  size: 4,
};
const queuedAttachment: NoteAttachment = {
  ...legacyAttachment,
  id: 'queued-image',
  name: 'queued.png',
};

const legacyNote: Note = {
  id: 'legacy-note',
  content: 'Keep me',
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  archived: false,
  images: [legacyAttachment],
};

function adapterHarness() {
  const opened: Array<Record<string, unknown>> = [];
  const saved: Note[] = [];
  const adapters = [
    {
      init: vi.fn(async (config: Record<string, unknown>) => { opened.push(config); }),
      getAllNotes: vi.fn(async () => [] as Note[]),
      saveNote: vi.fn(async (note: Note) => { saved.push(note); }),
    },
    {
      init: vi.fn(async (config: Record<string, unknown>) => { opened.push(config); }),
      getAllNotes: vi.fn(async () => [legacyNote]),
      saveNote: vi.fn(),
    },
  ];
  let index = 0;
  return { opened, saved, factory: () => adapters[index++]!, adapters };
}

describe('vault namespace initialization', () => {
  it('copies legacy attachment bytes with the note', async () => {
    const storage = new MemoryClientStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await new AttachmentStore(storage).save(legacyNote.id, legacyAttachment, bytes);

    await initializeVaultAdapter('vault-with-attachment', true, storage, adapterHarness().factory);

    await expect(new AttachmentStore(storage, 'vault-with-attachment').get(
      legacyNote.id,
      legacyAttachment.id,
    )).resolves.toEqual({ attachment: legacyAttachment, bytes });
  });

  it('preserves the legacy pending attachment upload', async () => {
    const storage = new MemoryClientStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await new AttachmentStore(storage).save(
      legacyNote.id,
      legacyAttachment,
      bytes,
      { pendingUpload: true },
    );

    await initializeVaultAdapter('vault-with-upload', true, storage, adapterHarness().factory);

    await expect(new AttachmentStore(storage, 'vault-with-upload').pendingUploads()).resolves.toEqual([
      { noteId: legacyNote.id, attachment: legacyAttachment, bytes },
    ]);
  });

  it('preserves a pending upload whose note metadata was not persisted yet', async () => {
    const storage = new MemoryClientStorage();
    const bytes = new Uint8Array([5, 6, 7, 8]);
    await new AttachmentStore(storage).save(
      'interrupted-note',
      queuedAttachment,
      bytes,
      { pendingUpload: true },
    );

    await initializeVaultAdapter('vault-with-orphan-upload', true, storage, adapterHarness().factory);

    await expect(new AttachmentStore(storage, 'vault-with-orphan-upload').pendingUploads()).resolves.toEqual([
      { noteId: 'interrupted-note', attachment: queuedAttachment, bytes },
    ]);
  });

  it('preserves a pending delete and its retained undo bytes', async () => {
    const storage = new MemoryClientStorage();
    const bytes = new Uint8Array([9, 10, 11, 12]);
    const legacyAttachments = new AttachmentStore(storage);
    await legacyAttachments.save('deleted-note', queuedAttachment, bytes);
    await legacyAttachments.queueDelete('deleted-note', queuedAttachment, { retainBytes: true });

    await initializeVaultAdapter('vault-with-delete', true, storage, adapterHarness().factory);

    const scopedAttachments = new AttachmentStore(storage, 'vault-with-delete');
    await expect(scopedAttachments.pendingDeletes()).resolves.toEqual([
      { noteId: 'deleted-note', attachment: queuedAttachment, retainBytes: true },
    ]);
    await expect(scopedAttachments.get('deleted-note', queuedAttachment.id)).resolves.toEqual({
      attachment: queuedAttachment,
      bytes,
    });
  });

  it('upgrades an earlier notes-only migration by copying attachments', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'vault-from-version-one';
    const bytes = new Uint8Array([13, 14, 15, 16]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), {
      copied: true,
      version: 1,
    });
    await new AttachmentStore(storage).save(legacyNote.id, legacyAttachment, bytes);
    const harness = adapterHarness();

    await initializeVaultAdapter(namespace, true, storage, harness.factory);

    expect(harness.saved).toEqual([]);
    await expect(new AttachmentStore(storage, namespace).get(
      legacyNote.id,
      legacyAttachment.id,
    )).resolves.toEqual({ attachment: legacyAttachment, bytes });
    await expect(storage.get(scopedClientStateKey('legacy-notes-migrated', namespace))).resolves.toEqual({
      copied: true,
      version: 2,
    });
  });

  it('upgrades a boolean notes-migrated marker without replaying notes', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'vault-from-boolean-marker';
    const bytes = new Uint8Array([37, 38, 39, 40]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), true);
    await new AttachmentStore(storage).save(legacyNote.id, legacyAttachment, bytes);
    const harness = adapterHarness();

    await initializeVaultAdapter(namespace, true, storage, harness.factory);

    expect(harness.saved).toEqual([]);
    await expect(new AttachmentStore(storage, namespace).get(
      legacyNote.id,
      legacyAttachment.id,
    )).resolves.toEqual({ attachment: legacyAttachment, bytes });
    await expect(storage.get(scopedClientStateKey('legacy-notes-migrated', namespace))).resolves.toEqual({
      copied: true,
      version: 2,
    });
  });

  it('does not overwrite scoped bytes or clear scoped upload work during backfill', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'vault-with-newer-attachment';
    const legacyBytes = new Uint8Array([25, 26, 27, 28]);
    const scopedBytes = new Uint8Array([29, 30, 31, 32]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), {
      copied: true,
      version: 1,
    });
    await new AttachmentStore(storage).save(legacyNote.id, legacyAttachment, legacyBytes);
    await new AttachmentStore(storage, namespace).save(
      legacyNote.id,
      legacyAttachment,
      scopedBytes,
      { pendingUpload: true },
    );

    await initializeVaultAdapter(namespace, true, storage, adapterHarness().factory);

    const scopedAttachments = new AttachmentStore(storage, namespace);
    await expect(scopedAttachments.get(legacyNote.id, legacyAttachment.id)).resolves.toEqual({
      attachment: legacyAttachment,
      bytes: scopedBytes,
    });
    await expect(scopedAttachments.pendingUploads()).resolves.toEqual([
      { noteId: legacyNote.id, attachment: legacyAttachment, bytes: scopedBytes },
    ]);
  });

  it('does not downgrade a scoped retained delete during backfill', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'vault-with-newer-delete';
    const scopedBytes = new Uint8Array([33, 34, 35, 36]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), {
      copied: true,
      version: 1,
    });
    const legacyAttachments = new AttachmentStore(storage);
    await legacyAttachments.save(legacyNote.id, legacyAttachment, new Uint8Array([1, 2, 3, 4]));
    await legacyAttachments.queueDelete(legacyNote.id, legacyAttachment);
    const scopedAttachments = new AttachmentStore(storage, namespace);
    await scopedAttachments.save(legacyNote.id, legacyAttachment, scopedBytes);
    await scopedAttachments.queueDelete(legacyNote.id, legacyAttachment, { retainBytes: true });

    await initializeVaultAdapter(namespace, true, storage, adapterHarness().factory);

    await expect(scopedAttachments.pendingDeletes()).resolves.toEqual([
      { noteId: legacyNote.id, attachment: legacyAttachment, retainBytes: true },
    ]);
    await expect(scopedAttachments.get(legacyNote.id, legacyAttachment.id)).resolves.toEqual({
      attachment: legacyAttachment,
      bytes: scopedBytes,
    });
  });

  it('does not resurrect a scoped delete from a legacy pending upload', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'vault-delete-over-upload';
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), {
      copied: true,
      version: 1,
    });
    await new AttachmentStore(storage).save(
      legacyNote.id,
      legacyAttachment,
      new Uint8Array([1, 2, 3, 4]),
      { pendingUpload: true },
    );
    const scopedAttachments = new AttachmentStore(storage, namespace);
    await scopedAttachments.save(
      legacyNote.id,
      legacyAttachment,
      new Uint8Array([45, 46, 47, 48]),
    );
    await scopedAttachments.queueDelete(legacyNote.id, legacyAttachment, { retainBytes: true });

    await initializeVaultAdapter(namespace, true, storage, adapterHarness().factory);
    await scopedAttachments.flushDeletes(async () => {});
    const upload = vi.fn(async () => {});

    await expect(scopedAttachments.flushUploads(upload)).resolves.toEqual({ uploaded: 0, failed: [] });
    expect(upload).not.toHaveBeenCalled();
  });

  it('retries an interrupted attachment migration without duplicating pending work', async () => {
    const backing = new MemoryClientStorage();
    const namespace = 'vault-retry';
    const bytes = new Uint8Array([17, 18, 19, 20]);
    await new AttachmentStore(backing).save(
      legacyNote.id,
      legacyAttachment,
      bytes,
      { pendingUpload: true },
    );
    const scopedAttachmentKey = new AttachmentStore(backing, namespace)
      .storageKey(legacyNote.id, legacyAttachment.id);
    let interrupt = true;
    const storage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: async <T>(key: string, value: T) => {
        if (interrupt && key === scopedAttachmentKey) {
          interrupt = false;
          throw new Error('attachment migration interrupted');
        }
        await backing.set(key, value);
      },
      delete: (key: string) => backing.delete(key),
      transact: async (keys, change) => {
        if (interrupt && keys.includes(scopedAttachmentKey)) {
          interrupt = false;
          throw new Error('attachment migration interrupted');
        }
        await backing.transact(keys, change);
      },
    };

    await expect(initializeVaultAdapter(namespace, true, storage, adapterHarness().factory))
      .rejects.toThrow('attachment migration interrupted');
    await expect(backing.get(scopedClientStateKey('legacy-notes-migrated', namespace)))
      .resolves.toBeNull();

    await initializeVaultAdapter(namespace, true, storage, adapterHarness().factory);
    await initializeVaultAdapter(namespace, true, storage, adapterHarness().factory);

    await expect(new AttachmentStore(backing, namespace).pendingUploads()).resolves.toEqual([
      { noteId: legacyNote.id, attachment: legacyAttachment, bytes },
    ]);
    await expect(backing.get(scopedClientStateKey('legacy-notes-migrated', namespace))).resolves.toEqual({
      copied: true,
      version: 2,
    });
  });

  it('upgrades a fresh-vault marker without inheriting legacy attachment state', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'fresh-vault-from-version-one';
    const bytes = new Uint8Array([21, 22, 23, 24]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), {
      copied: false,
      version: 1,
    });
    await new AttachmentStore(storage).save(
      legacyNote.id,
      legacyAttachment,
      bytes,
      { pendingUpload: true },
    );
    const harness = adapterHarness();

    await initializeVaultAdapter(namespace, true, storage, harness.factory);

    expect(harness.opened).toEqual([{ vaultNamespace: namespace }]);
    expect(harness.saved).toEqual([]);
    const scopedAttachments = new AttachmentStore(storage, namespace);
    await expect(scopedAttachments.get(legacyNote.id, legacyAttachment.id)).resolves.toBeNull();
    await expect(scopedAttachments.pendingUploads()).resolves.toEqual([]);
    await expect(storage.get(scopedClientStateKey('legacy-notes-migrated', namespace))).resolves.toEqual({
      copied: false,
      version: 2,
    });
  });

  it('preserves a boolean fresh-vault marker without inheriting legacy state', async () => {
    const storage = new MemoryClientStorage();
    const namespace = 'fresh-vault-from-boolean-marker';
    const bytes = new Uint8Array([41, 42, 43, 44]);
    await storage.set(scopedClientStateKey('legacy-notes-migrated', namespace), false);
    await new AttachmentStore(storage).save(
      legacyNote.id,
      legacyAttachment,
      bytes,
      { pendingUpload: true },
    );
    const harness = adapterHarness();

    await initializeVaultAdapter(namespace, true, storage, harness.factory);

    expect(harness.opened).toEqual([{ vaultNamespace: namespace }]);
    expect(harness.saved).toEqual([]);
    const scopedAttachments = new AttachmentStore(storage, namespace);
    await expect(scopedAttachments.get(legacyNote.id, legacyAttachment.id)).resolves.toBeNull();
    await expect(scopedAttachments.pendingUploads()).resolves.toEqual([]);
    await expect(storage.get(scopedClientStateKey('legacy-notes-migrated', namespace))).resolves.toEqual({
      copied: false,
      version: 2,
    });
  });

  it('copies the legacy database once for an already-persisted vault', async () => {
    const storage = new MemoryClientStorage();
    const first = adapterHarness();

    await initializeVaultAdapter('vault-one', true, storage, first.factory);

    expect(first.opened).toEqual([{ vaultNamespace: 'vault-one' }, {}]);
    expect(first.saved).toEqual([legacyNote]);

    const second = adapterHarness();
    await initializeVaultAdapter('vault-one', true, storage, second.factory);
    expect(second.opened).toEqual([{ vaultNamespace: 'vault-one' }]);
    expect(second.saved).toEqual([]);
  });

  it('marks a newly paired vault without copying legacy notes', async () => {
    const storage = new MemoryClientStorage();
    const harness = adapterHarness();

    await initializeVaultAdapter('vault-two', false, storage, harness.factory);

    expect(harness.opened).toEqual([{ vaultNamespace: 'vault-two' }]);
    expect(harness.saved).toEqual([]);

    await initializeVaultAdapter('vault-two', true, storage, adapterHarness().factory);
    expect(await storage.get(scopedClientStateKey('legacy-notes-migrated', 'vault-two'))).toEqual({
      copied: false,
      version: 2,
    });
  });

  it('does not mark a failed legacy copy as complete so it can retry', async () => {
    const storage = new MemoryClientStorage();
    const harness = adapterHarness();
    harness.adapters[0]!.saveNote.mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(initializeVaultAdapter('vault-three', true, storage, harness.factory))
      .rejects.toThrow('quota exceeded');
    await expect(storage.get(scopedClientStateKey('legacy-notes-migrated', 'vault-three')))
      .resolves.toBeNull();
  });

  it('creates stable, collision-safe keys for vault-scoped browser state', () => {
    expect(scopedClientStateKey('pending-notes', 'vault / one')).toBe(
      'unkeep-vault-state:vault%20%2F%20one:pending-notes',
    );
  });
});
