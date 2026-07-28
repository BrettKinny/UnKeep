import { describe, expect, it } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { ClientStorage } from '@unkeep/client';
import type { NoteAttachment } from '@unkeep/core';
import { AttachmentStore, AttachmentUrlCache } from './attachmentStorage';

const attachment: NoteAttachment = {
  id: 'image-one',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 4,
};

describe('AttachmentStore', () => {
  it('keeps attachment bytes and pending upload work across store instances', async () => {
    const storage = new MemoryClientStorage();
    const first = new AttachmentStore(storage);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await first.save('note-one', attachment, bytes, { pendingUpload: true });

    const afterReload = new AttachmentStore(storage);
    await expect(afterReload.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
    await expect(afterReload.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
  });

  it('retries a failed upload with the durable bytes and clears only after success', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes, { pendingUpload: true });

    await expect(store.flushUploads(async () => { throw new Error('offline'); })).resolves.toMatchObject({
      uploaded: 0,
      failed: [{ noteId: 'note-one', attachment }],
    });

    const uploaded: Uint8Array[] = [];
    const afterReload = new AttachmentStore(storage);
    await expect(afterReload.flushUploads(async (_noteId, _attachment, retryBytes) => {
      uploaded.push(retryBytes);
    })).resolves.toEqual({ uploaded: 1, failed: [] });
    expect(uploaded).toEqual([bytes]);
    await expect(afterReload.pendingUploads()).resolves.toEqual([]);
    await expect(afterReload.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('preserves every pending upload when attachments are saved concurrently', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const secondStore = new AttachmentStore(storage);
    const secondAttachment: NoteAttachment = { ...attachment, id: 'image-two', name: 'second.png' };

    await Promise.all([
      store.save('note-one', attachment, new Uint8Array([1]), { pendingUpload: true }),
      secondStore.save('note-two', secondAttachment, new Uint8Array([2]), { pendingUpload: true }),
    ]);

    await expect(store.pendingUploads()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ noteId: 'note-one', attachment }),
      expect.objectContaining({ noteId: 'note-two', attachment: secondAttachment }),
    ]));
    await expect(store.pendingUploads()).resolves.toHaveLength(2);
  });

  it('preserves every delete intent when attachments are removed concurrently', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const secondStore = new AttachmentStore(storage);
    const secondAttachment: NoteAttachment = { ...attachment, id: 'image-two', name: 'second.png' };
    await store.save('note-one', attachment, new Uint8Array([1]));
    await store.save('note-two', secondAttachment, new Uint8Array([2]));

    await Promise.all([
      store.queueDelete('note-one', attachment),
      secondStore.queueDelete('note-two', secondAttachment),
    ]);

    await expect(store.pendingDeletes()).resolves.toEqual(expect.arrayContaining([
      { noteId: 'note-one', attachment },
      { noteId: 'note-two', attachment: secondAttachment },
    ]));
    await expect(store.pendingDeletes()).resolves.toHaveLength(2);
  });

  it('hydrates a persistent attachment into a reusable object URL and revokes it on release', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    await store.save('note-one', attachment, new Uint8Array([1, 2, 3, 4]));
    const created: Blob[] = [];
    const revoked: string[] = [];
    const urls = new AttachmentUrlCache(store, {
      create: (blob) => {
        created.push(blob);
        return `blob:test-${created.length}`;
      },
      revoke: (url) => revoked.push(url),
    });
    const note = {
      id: 'note-one',
      content: '',
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
      images: [attachment],
    };

    expect((await urls.hydrate(note)).images?.[0].url).toBe('blob:test-1');
    expect((await urls.hydrate(note)).images?.[0].url).toBe('blob:test-1');
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe('image/png');

    urls.release('note-one', attachment.id);
    expect(revoked).toEqual(['blob:test-1']);
  });

  it('isolates bytes and pending uploads between vault namespaces', async () => {
    const storage = new MemoryClientStorage();
    const firstVault = new AttachmentStore(storage, 'vault-one');
    const secondVault = new AttachmentStore(storage, 'vault-two');
    await firstVault.save('note-one', attachment, new Uint8Array([1, 2, 3, 4]), { pendingUpload: true });

    await expect(secondVault.get('note-one', attachment.id)).resolves.toBeNull();
    await expect(secondVault.pendingUploads()).resolves.toEqual([]);
    await expect(firstVault.pendingUploads()).resolves.toHaveLength(1);
  });

  it('keeps a deletion intent across reload and retries it without resurrecting a queued upload', async () => {
    const storage = new MemoryClientStorage();
    const first = new AttachmentStore(storage, 'vault-one');
    await first.save('note-one', attachment, new Uint8Array([1, 2, 3, 4]), { pendingUpload: true });
    await first.queueDelete('note-one', attachment);

    const afterReload = new AttachmentStore(storage, 'vault-one');
    await expect(afterReload.get('note-one', attachment.id)).resolves.toBeNull();
    await expect(afterReload.pendingUploads()).resolves.toEqual([]);
    await expect(afterReload.pendingDeletes()).resolves.toEqual([{ noteId: 'note-one', attachment }]);

    await expect(afterReload.flushDeletes(async () => { throw new Error('offline'); })).resolves.toMatchObject({
      deleted: 0,
      failed: [{ noteId: 'note-one', attachment }],
    });
    await expect(afterReload.pendingDeletes()).resolves.toHaveLength(1);

    const deleted: string[] = [];
    await expect(new AttachmentStore(storage, 'vault-one').flushDeletes(async (noteId, value) => {
      deleted.push(`${noteId}:${value.id}`);
    })).resolves.toEqual({ deleted: 1, failed: [] });
    expect(deleted).toEqual(['note-one:image-one']);
    await expect(afterReload.pendingDeletes()).resolves.toEqual([]);
  });

  it('gives a persisted delete intent precedence after interruption before upload cleanup', async () => {
    const backing = new MemoryClientStorage();
    let interruptUploadQueueWrite = false;
    const storage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: async <T>(key: string, value: T) => {
        if (interruptUploadQueueWrite && key === 'unkeep-pending-attachment-uploads') {
          interruptUploadQueueWrite = false;
          throw new Error('interrupted');
        }
        await backing.set(key, value);
      },
      delete: (key: string) => backing.delete(key),
    };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const store = new AttachmentStore(storage);
    await store.save('note-one', attachment, bytes, { pendingUpload: true });

    interruptUploadQueueWrite = true;
    await expect(store.queueDelete('note-one', attachment)).rejects.toThrow('interrupted');

    const afterReload = new AttachmentStore(storage);
    await expect(afterReload.pendingDeletes()).resolves.toEqual([{ noteId: 'note-one', attachment }]);
    await expect(afterReload.pendingUploads()).resolves.toEqual([]);
    await expect(afterReload.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('can retain bytes for note undo while cancelling the queued remote deletion', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, { retainBytes: true });

    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
    await expect(store.pendingDeletes()).resolves.toEqual([
      { noteId: 'note-one', attachment, retainBytes: true },
    ]);

    await store.cancelDelete('note-one', attachment.id);
    await expect(store.pendingDeletes()).resolves.toEqual([]);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('keeps note-undo bytes when the matching remote tombstone is pulled', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, { retainBytes: true });
    await store.flushDeletes(async () => undefined);

    await store.applyRemoteDelete('note-one', attachment.id);

    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('restores only attachment metadata backed by retained bytes', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const missing: NoteAttachment = { ...attachment, id: 'missing-image', name: 'missing.png' };
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, { retainBytes: true });

    await expect(store.restoreForUndo('note-one', [attachment, missing])).resolves.toEqual([attachment]);
    await expect(store.pendingDeletes()).resolves.toEqual([]);
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
  });

  it('keeps an Undo re-upload queued when an older remote tombstone arrives afterward', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, { retainBytes: true });
    await store.flushDeletes(async () => undefined);
    await store.restoreForUndo('note-one', [attachment]);

    await store.applyRemoteDelete('note-one', attachment.id);

    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
  });

  it('resolves retained-byte purge races according to whether Undo or expiry wins first', async () => {
    const undoWins = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await undoWins.save('undo-first', attachment, bytes);
    await undoWins.queueDelete('undo-first', attachment, { retainBytes: true });
    await undoWins.flushDeletes(async () => undefined);
    await undoWins.restoreForUndo('undo-first', [attachment]);
    await undoWins.purgeRetained('undo-first', [attachment.id]);
    await expect(undoWins.get('undo-first', attachment.id)).resolves.toEqual({ attachment, bytes });

    const expiryWins = new AttachmentStore(new MemoryClientStorage());
    await expiryWins.save('expiry-first', attachment, bytes);
    await expiryWins.queueDelete('expiry-first', attachment, { retainBytes: true });
    await expiryWins.flushDeletes(async () => undefined);
    await expiryWins.purgeRetained('expiry-first', [attachment.id]);
    await expect(expiryWins.restoreForUndo('expiry-first', [attachment])).resolves.toEqual([]);
    await expect(expiryWins.get('expiry-first', attachment.id)).resolves.toBeNull();
  });
});
