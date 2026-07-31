import { describe, expect, it, vi } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { ClientStorage } from '@unkeep/client';
import type { NoteAttachment } from '@unkeep/core';
import {
  AttachmentStore,
  AttachmentUrlCache,
  STAGED_UPLOAD_TTL_MS,
} from './attachmentStorage';

const attachment: NoteAttachment = {
  id: 'image-one',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 4,
};

describe('AttachmentStore', () => {
  it('discovers queued note IDs without reading attachment byte records', async () => {
    const backing = new MemoryClientStorage();
    const store = new AttachmentStore(backing);
    await store.save('note-one', attachment, new Uint8Array([1, 2, 3, 4]), {
      pendingUpload: true,
    });
    const reads: string[] = [];
    const observing = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'get') {
          return async (key: string) => {
            reads.push(key);
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ClientStorage;

    await expect(new AttachmentStore(observing).pendingUploadNoteIds())
      .resolves.toEqual(['note-one']);
    expect(reads).not.toContain(store.storageKey('note-one', attachment.id));
  });

  it('provides reusable generation-fenced lazy byte loaders', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes, { pendingUpload: true });

    const [source] = await store.pendingUploadSources('note-one', [attachment.id]);
    expect(source.attachment).toEqual(attachment);
    await expect(source.loadBytes()).resolves.toEqual(bytes);
    await expect(source.loadBytes()).resolves.toEqual(bytes);

    await store.stageUpload('note-one', attachment, new Uint8Array([9, 9, 9, 9]));
    await expect(source.loadBytes()).rejects.toThrow('Attachment upload generation changed');
  });

  it('confirms only the exact generation whose bytes match the relay content hash', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes, { pendingUpload: true });
    const [source] = await store.pendingUploadSources('note-one', [attachment.id]);
    const contentHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');

    await expect(store.confirmCompoundUpload(source.handle, contentHash)).resolves.toBe('confirmed');
    await expect(store.pendingUploads()).resolves.toEqual([]);

    await store.stageUpload('note-one', attachment, new Uint8Array([8, 8, 8, 8]));
    await expect(store.confirmCompoundUpload(source.handle, contentHash)).resolves.toBe('changed');
    await expect(store.stagedUploads()).resolves.toHaveLength(1);
  });

  it('persists the compound completion phase until exact cleanup', async () => {
    const storage = new MemoryClientStorage();
    const first = new AttachmentStore(storage, 'compound-phase');
    await first.save('note-one', attachment, new Uint8Array([1]), { pendingUpload: true });
    const [source] = await first.pendingUploadSources('note-one', [attachment.id]);

    await first.beginCompoundUploadIntent('note-one', 'token-one', [source.handle]);
    await expect(new AttachmentStore(storage, 'compound-phase').compoundUploadIntent('note-one'))
      .resolves.toMatchObject({ phase: 'pending', noteToken: 'token-one' });

    await expect(first.markCompoundUploadIntentReconciled('note-one', 'wrong-token'))
      .resolves.toBe(false);
    await expect(first.markCompoundUploadIntentReconciled('note-one', 'token-one'))
      .resolves.toBe(true);
    await expect(new AttachmentStore(storage, 'compound-phase').compoundUploadIntent('note-one'))
      .resolves.toMatchObject({ phase: 'reconciled', noteToken: 'token-one' });

    await expect(first.completeCompoundUploadIntent('note-one', 'wrong-token')).resolves.toBe(false);
    await expect(first.completeCompoundUploadIntent('note-one', 'token-one')).resolves.toBe(true);
    await expect(first.compoundUploadIntent('note-one')).resolves.toBeNull();
  });
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

  it('returns the original upload failure and stops before later uploads', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const second = { ...attachment, id: 'image-two', name: 'second.png' };
    await store.save('note-one', attachment, new Uint8Array([1]), {
      pendingUpload: true,
    });
    await store.save('note-one', second, new Uint8Array([2]), {
      pendingUpload: true,
    });
    const failure = new TypeError('relay unavailable');
    const upload = vi.fn(async () => {
      throw failure;
    });

    const result = await store.flushUploads(upload);

    expect(result.error).toBe(failure);
    expect(result.failed).toEqual([
      expect.objectContaining({ noteId: 'note-one', attachment }),
    ]);
    expect(upload).toHaveBeenCalledTimes(1);
    await expect(store.pendingUploads()).resolves.toHaveLength(2);
  });

  it('keeps uploaded bytes pending until their owning note is confirmed', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.stageUpload('note-one', attachment, bytes);
    await store.prepareUploads('note-one', [attachment]);

    const result = await store.flushUploads(
      async () => undefined,
      'note-one',
      [attachment.id],
      { deferConfirmation: true },
    );

    expect(result).toMatchObject({
      uploaded: 1,
      failed: [],
      pendingConfirmation: [
        { noteId: 'note-one', attachmentId: attachment.id },
      ],
    });
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);

    await store.confirmUploads(result.pendingConfirmation ?? []);

    await expect(store.pendingUploads()).resolves.toEqual([]);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes,
    });
  });

  it('does not let stale upload confirmation retire a same-key restage', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    await store.stageUpload('note-one', attachment, new Uint8Array([1]));
    await store.prepareUploads('note-one', [attachment]);
    const uploaded = await store.flushUploads(
      async () => undefined,
      'note-one',
      [attachment.id],
      { deferConfirmation: true },
    );
    const replacement = new Uint8Array([7, 8, 9]);

    await store.stageUpload('note-one', attachment, replacement);
    await store.confirmUploads(uploaded.pendingConfirmation ?? []);

    await expect(store.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes: replacement,
    });
    await expect(store.stagedUploads()).resolves.toEqual([
      expect.objectContaining({
        noteId: 'note-one',
        attachment,
        bytes: replacement,
      }),
    ]);
  });

  it('self-clears a stale queue key after upload confirmation survives a crash', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await storage.set('unkeep-pending-attachment-uploads', [
      store.storageKey('note-one', attachment.id),
    ]);

    await expect(store.pendingUploads()).resolves.toEqual([]);

    await expect(storage.get('unkeep-pending-attachment-uploads')).resolves.toEqual([]);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('preserves upload work written by the legacy string-index format', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage);
    const bytes = new Uint8Array([4, 3, 2, 1]);
    const key = store.storageKey('note-one', attachment.id);
    await storage.set(key, {
      noteId: 'note-one',
      attachment,
      bytes,
    });
    await storage.set('unkeep-pending-attachment-uploads', [key]);

    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
    await expect(store.flushUploads(async () => undefined)).resolves.toEqual({
      uploaded: 1,
      failed: [],
    });
    await expect(store.pendingUploads()).resolves.toEqual([]);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
  });

  it('never exposes staged bytes to upload before a durable note references them', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await store.stageUpload('note-one', attachment, bytes);
    await expect(store.pendingUploads()).resolves.toEqual([]);

    await store.prepareUploads('note-one', [attachment]);
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
  });

  it('commits a staged marker, bytes, and upload ineligibility atomically', async () => {
    const backing = new MemoryClientStorage();
    const atomicOnly: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: () => Promise.reject(new Error('split set must not be used')),
      delete: () => Promise.reject(new Error('split delete must not be used')),
      update: () => Promise.reject(new Error('split update must not be used')),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const store = new AttachmentStore(atomicOnly);
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await store.stageUpload('note-one', attachment, bytes);

    await expect(store.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'note-one', attachment, bytes }),
    ]);
    await expect(store.pendingUploads()).resolves.toEqual([]);
  });

  it('revokes an inherited upload intent before replacing bytes during staging', async () => {
    const backing = new MemoryClientStorage();
    const bootstrap = new AttachmentStore(backing);
    await bootstrap.save('note-one', attachment, new Uint8Array([9]), {
      pendingUpload: true,
    });
    let transactionStarted!: () => void;
    let releaseTransaction!: () => void;
    const waitForTransaction = new Promise<void>(resolve => { transactionStarted = resolve; });
    const waitForRelease = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const stagingStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: async (keys, change) => {
        if (keys.some(key => key.startsWith('unkeep-attachment:'))) {
          transactionStarted();
          await waitForRelease;
        }
        await backing.transact(keys, change);
      },
    };
    const observerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const staging = new AttachmentStore(stagingStorage)
      .stageUpload('note-one', attachment, new Uint8Array([1, 2, 3, 4]));
    await waitForTransaction;

    await expect(new AttachmentStore(observerStorage).pendingUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'note-one', attachment }),
    ]);

    releaseTransaction();
    await staging;
    await expect(new AttachmentStore(observerStorage).pendingUploads()).resolves.toEqual([]);
  });

  it('keeps an unreferenced pending generation enumerable but excludes it from a push', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes, {
      pendingUpload: true,
    });

    await store.prepareUploads('note-one', []);
    const upload = vi.fn(async () => undefined);
    await expect(store.flushUploads(upload, 'note-one', [])).resolves.toEqual({
      uploaded: 0,
      failed: [],
    });

    expect(upload).not.toHaveBeenCalled();
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes,
    });
  });

  it('does not let a stale note snapshot delete a different attachment generation', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const oldAttachment = { ...attachment, id: 'old-image', name: 'old.png' };
    const concurrentAttachment = {
      ...attachment,
      id: 'concurrent-image',
      name: 'concurrent.png',
    };
    const concurrentBytes = new Uint8Array([7, 8, 9]);
    await store.save('note-one', oldAttachment, new Uint8Array([1]));
    await store.stageUpload('note-one', concurrentAttachment, concurrentBytes);
    await store.prepareUploads('note-one', [concurrentAttachment]);

    await store.prepareUploads('note-one', [oldAttachment]);
    const upload = vi.fn(async () => undefined);
    await store.flushUploads(upload, 'note-one', [oldAttachment.id]);

    expect(upload).not.toHaveBeenCalled();
    await expect(store.pendingUploads()).resolves.toEqual([
      {
        noteId: 'note-one',
        attachment: concurrentAttachment,
        bytes: concurrentBytes,
      },
    ]);
    await expect(store.get('note-one', concurrentAttachment.id)).resolves.toEqual({
      attachment: concurrentAttachment,
      bytes: concurrentBytes,
    });
  });

  it('keeps a crash-staged orphan enumerable after TTL without uploading it', async () => {
    const storage = new MemoryClientStorage();
    const first = new AttachmentStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await first.stageUpload('note-one', attachment, bytes, { stagedAt: 10 });

    const afterRestart = new AttachmentStore(storage);
    await expect(afterRestart.pendingUploads()).resolves.toEqual([]);
    await expect(afterRestart.stagedUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes, stagedAt: 10 },
    ]);

    await afterRestart.prepareUploads('note-one', [], 10 + STAGED_UPLOAD_TTL_MS);
    await expect(afterRestart.stagedUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes, stagedAt: 10 },
    ]);
    await expect(afterRestart.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes,
    });
  });

  it('retains an in-flight staged index until the owning tab writes its bytes', async () => {
    for (const observerAction of ['enumerate', 'prepare'] as const) {
      const backing = new MemoryClientStorage();
      let releaseTransaction!: () => void;
      let transactionStarted!: () => void;
      const waitForTransaction = new Promise<void>(resolve => { transactionStarted = resolve; });
      const waitForRelease = new Promise<void>(resolve => { releaseTransaction = resolve; });
      const ownerStorage: ClientStorage = {
        get: <T>(key: string) => backing.get<T>(key),
        set: <T>(key: string, value: T) => backing.set(key, value),
        delete: (key: string) => backing.delete(key),
        update: <T>(key: string, change: (value: T | null) => T | null) =>
          backing.update(key, change),
        transact: async (keys, change) => {
          transactionStarted();
          await waitForRelease;
          await backing.transact(keys, change);
        },
      };
      // A different wrapper models a different tab: its operations must not
      // share the in-memory serialization queue with the writer.
      const observerStorage: ClientStorage = {
        get: <T>(key: string) => backing.get<T>(key),
        set: <T>(key: string, value: T) => backing.set(key, value),
        delete: (key: string) => backing.delete(key),
        update: <T>(key: string, change: (value: T | null) => T | null) =>
          backing.update(key, change),
        transact: (keys, change) => backing.transact(keys, change),
      };
      const owner = new AttachmentStore(ownerStorage);
      const observer = new AttachmentStore(observerStorage);
      const stagedAt = Date.now();
      const staged = { ...attachment, id: `in-flight-${observerAction}` };
      const staging = owner.stageUpload('note-one', staged, new Uint8Array([1, 2]), {
        stagedAt,
      });
      await waitForTransaction;

      if (observerAction === 'enumerate') {
        await expect(observer.stagedUploads()).resolves.toEqual([]);
      } else {
        await observer.prepareUploads('note-one', [], stagedAt + 1);
      }
      releaseTransaction();
      await staging;

      await expect(observer.stagedUploads()).resolves.toEqual([
        expect.objectContaining({ noteId: 'note-one', attachment: staged, stagedAt }),
      ]);
    }
  });

  it('never expires an in-flight marker before a stalled writer commits its bytes', async () => {
    const backing = new MemoryClientStorage();
    let releaseTransaction!: () => void;
    let transactionStarted!: () => void;
    const waitForTransaction = new Promise<void>(resolve => { transactionStarted = resolve; });
    const waitForRelease = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const ownerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: async (keys, change) => {
        transactionStarted();
        await waitForRelease;
        await backing.transact(keys, change);
      },
    };
    const observerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const owner = new AttachmentStore(ownerStorage);
    const observer = new AttachmentStore(observerStorage);
    const stagedAt = Date.now();
    const staging = owner.stageUpload('note-one', attachment, new Uint8Array([1, 2]), {
      stagedAt,
    });
    await waitForTransaction;

    await observer.prepareUploads(
      'note-one',
      [],
      stagedAt + STAGED_UPLOAD_TTL_MS + 1,
    );
    releaseTransaction();
    await staging;

    await expect(observer.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'note-one', attachment, stagedAt }),
    ]);
    await expect(observer.get('note-one', attachment.id)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2]),
    });
  });

  it('does not let expired cleanup delete a same-key restage from another tab', async () => {
    const backing = new MemoryClientStorage();
    const writerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const writer = new AttachmentStore(writerStorage);
    await writer.stageUpload('note-one', attachment, new Uint8Array([1]), {
      stagedAt: 0,
    });
    const replacementBytes = new Uint8Array([7, 8, 9]);
    const replacementTime = Date.now();
    let restaged = false;
    const observerStorage: ClientStorage = {
      get: async <T>(key: string) => {
        const value = await backing.get<T>(key);
        if (key === writer.storageKey('note-one', attachment.id) && !restaged) {
          restaged = true;
          await writer.stageUpload('note-one', attachment, replacementBytes, {
            stagedAt: replacementTime,
          });
        }
        return value;
      },
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const observer = new AttachmentStore(observerStorage);

    await observer.prepareUploads('note-one', [], STAGED_UPLOAD_TTL_MS + 1);

    await expect(observer.get('note-one', attachment.id)).resolves.toMatchObject({
      bytes: replacementBytes,
    });
    await expect(observer.stagedUploads()).resolves.toEqual([
      expect.objectContaining({
        noteId: 'note-one',
        attachment,
        stagedAt: replacementTime,
      }),
    ]);
  });

  it('does not let a superseded share owner overwrite a newer same-key stage', async () => {
    const backing = new MemoryClientStorage();
    let oldTransactionStarted!: () => void;
    let releaseOldTransaction!: () => void;
    const oldStarted = new Promise<void>(resolve => { oldTransactionStarted = resolve; });
    const oldRelease = new Promise<void>(resolve => { releaseOldTransaction = resolve; });
    const oldStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: async (keys, change) => {
        if (keys.some(key => key.startsWith('unkeep-attachment:'))) {
          oldTransactionStarted();
          await oldRelease;
        }
        await backing.transact(keys, change);
      },
    };
    const newStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const oldOwner = new AttachmentStore(oldStorage);
    const newOwner = new AttachmentStore(newStorage);
    const staleWrite = oldOwner.stageUpload(
      'note-one',
      attachment,
      new Uint8Array([1]),
      { writeEpoch: 100 },
    );
    await oldStarted;
    const winningBytes = new Uint8Array([7, 8, 9]);

    await newOwner.stageUpload(
      'note-one',
      attachment,
      winningBytes,
      { writeEpoch: 200 },
    );
    releaseOldTransaction();

    await expect(staleWrite).rejects.toThrow('superseded');
    await expect(newOwner.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes: winningBytes,
    });
  });

  it('keeps a newer share-owner fence while its attachment deletion is queued', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    await store.stageUpload(
      'note-one',
      attachment,
      new Uint8Array([7, 8, 9]),
      { writeEpoch: 200 },
    );
    await store.queueDelete('note-one', attachment);

    await expect(store.stageUpload(
      'note-one',
      attachment,
      new Uint8Array([1]),
      { writeEpoch: 100 },
    )).rejects.toThrow('superseded');

    await expect(store.pendingDeletes()).resolves.toEqual([
      { noteId: 'note-one', attachment },
    ]);
    await expect(store.get('note-one', attachment.id)).resolves.toBeNull();
  });

  it('does not erase a staged entry appended by another tab during stale cleanup', async () => {
    const backing = new MemoryClientStorage();
    const writerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const writer = new AttachmentStore(writerStorage);
    const stale = { ...attachment, id: 'stale-stage' };
    const concurrent = { ...attachment, id: 'concurrent-stage' };
    const staleHandle = await writer.stageUpload(
      'stale-note',
      stale,
      new Uint8Array([1]),
      { stagedAt: 0 },
    );
    // Simulate upload confirmation surviving a crash before its stale stage
    // marker was cleared.
    await backing.set(writer.storageKey('stale-note', stale.id), {
      noteId: 'stale-note',
      attachment: stale,
      bytes: new Uint8Array([1]),
      uploadGeneration: staleHandle.generation,
    });
    let injected = false;
    const observerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: async <T>(key: string, change: (value: T | null) => T | null) => {
        if (key.startsWith('unkeep-staged-attachment-uploads') && !injected) {
          injected = true;
          await writer.stageUpload('concurrent-note', concurrent, new Uint8Array([2]));
        }
        await backing.update(key, change);
      },
      transact: (keys, change) => backing.transact(keys, change),
    };
    const observer = new AttachmentStore(observerStorage);

    await expect(observer.stagedUploads()).resolves.toEqual([]);

    await expect(observer.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'concurrent-note', attachment: concurrent }),
    ]);
  });

  it('does not erase a pending upload appended by another tab during reconciliation', async () => {
    const backing = new MemoryClientStorage();
    const writerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const writer = new AttachmentStore(writerStorage);
    const first = { ...attachment, id: 'first-pending' };
    const concurrent = { ...attachment, id: 'concurrent-pending' };
    await writer.save('first-note', first, new Uint8Array([1]), { pendingUpload: true });
    let injected = false;
    const observerStorage: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: <T>(key: string, value: T) => backing.set(key, value),
      delete: (key: string) => backing.delete(key),
      update: <T>(key: string, change: (value: T | null) => T | null) =>
        backing.update(key, change),
      transact: async (keys, change) => {
        if (keys.some(key => key.startsWith('unkeep-pending-attachment-uploads')) && !injected) {
          injected = true;
          await writer.save(
            'concurrent-note',
            concurrent,
            new Uint8Array([2]),
            { pendingUpload: true },
          );
        }
        await backing.transact(keys, change);
      },
    };
    const observer = new AttachmentStore(observerStorage);

    await observer.prepareUploads('first-note', [first]);

    await expect(observer.pendingUploads()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ noteId: 'first-note', attachment: first }),
      expect.objectContaining({ noteId: 'concurrent-note', attachment: concurrent }),
    ]));
    await expect(observer.pendingUploads()).resolves.toHaveLength(2);
  });

  it('discards only local-only uploads after their note mutation is rejected', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const existing = { ...attachment, id: 'already-shared' };
    const rejected = { ...attachment, id: 'rejected-local-upload' };
    const existingBytes = new Uint8Array([1, 2]);
    const rejectedBytes = new Uint8Array([3, 4]);
    await store.save('note-one', existing, existingBytes);
    await store.stageUpload('note-one', rejected, rejectedBytes);
    await store.prepareUploads('note-one', [existing, rejected]);
    const handles = await store.pendingUploadHandles(
      'note-one',
      [existing.id, rejected.id],
    );

    await store.discardRejectedUploads(handles);

    await expect(store.get('note-one', existing.id)).resolves.toEqual({
      attachment: existing,
      bytes: existingBytes,
    });
    await expect(store.get('note-one', rejected.id)).resolves.toBeNull();
    await expect(store.pendingUploads()).resolves.toEqual([]);
    await expect(store.stagedUploads()).resolves.toEqual([]);
  });

  it('does not let stale rejected-work cleanup delete a same-key restage', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const firstBytes = new Uint8Array([1]);
    const replacementBytes = new Uint8Array([7, 8, 9]);
    await store.stageUpload('note-one', attachment, firstBytes);
    await store.prepareUploads('note-one', [attachment]);
    const handles = await store.pendingUploadHandles('note-one', [attachment.id]);

    await store.stageUpload('note-one', attachment, replacementBytes);
    await store.discardRejectedUploads(handles);

    await expect(store.get('note-one', attachment.id)).resolves.toMatchObject({
      bytes: replacementBytes,
    });
    await expect(store.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: 'note-one', attachment, bytes: replacementBytes }),
    ]);
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

  it('blocks a same-key restage while a claimed remote deletion is in flight', async () => {
    const storage = new MemoryClientStorage();
    const deletingTab = new AttachmentStore(storage);
    const writingTab = new AttachmentStore(storage);
    await deletingTab.save('note-one', attachment, new Uint8Array([1]));
    await deletingTab.queueDelete('note-one', attachment);
    let remoteDeleteStarted!: () => void;
    let releaseRemoteDelete!: () => void;
    const started = new Promise<void>(resolve => { remoteDeleteStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseRemoteDelete = resolve; });
    const deleting = deletingTab.flushDeletes(async () => {
      remoteDeleteStarted();
      await release;
    });
    await started;

    await expect(writingTab.stageUpload(
      'note-one',
      attachment,
      new Uint8Array([7, 8, 9]),
    )).rejects.toThrow('deletion is already in progress');

    releaseRemoteDelete();
    await expect(deleting).resolves.toEqual({ deleted: 1, failed: [] });
    await writingTab.stageUpload(
      'note-one',
      attachment,
      new Uint8Array([7, 8, 9]),
    );

    await expect(writingTab.pendingDeletes()).resolves.toEqual([]);
    await expect(writingTab.get('note-one', attachment.id)).resolves.toMatchObject({
      bytes: new Uint8Array([7, 8, 9]),
    });
  });

  it('indexes pulled bytes until their exact remote note generation is confirmed', async () => {
    const storage = new MemoryClientStorage();
    const store = new AttachmentStore(storage, 'remote-stage');
    const remoteBytes = new Uint8Array([1, 2, 3]);
    const first = await store.saveRemote('note-one', attachment, remoteBytes);

    await expect(storage.get(
      'unkeep-staged-remote-attachments:remote-stage',
    )).resolves.toEqual([
      {
        key: store.storageKey('note-one', attachment.id),
        generation: first.generation,
      },
    ]);
    await expect(new AttachmentStore(storage, 'remote-stage').get(
      'note-one',
      attachment.id,
    )).resolves.toBeNull();

    await expect(store.confirmRemote(first)).resolves.toBe(true);
    await expect(storage.get(
      'unkeep-staged-remote-attachments:remote-stage',
    )).resolves.toEqual([]);
    await expect(new AttachmentStore(storage, 'remote-stage').get(
      'note-one',
      attachment.id,
    )).resolves.toEqual({ attachment, bytes: remoteBytes });

    const stale = await store.saveRemote('note-one', attachment, remoteBytes);
    const localBytes = new Uint8Array([7, 8, 9]);
    await new AttachmentStore(storage, 'remote-stage').stageUpload(
      'note-one',
      attachment,
      localBytes,
    );

    await expect(store.confirmRemote(stale)).resolves.toBe(false);
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({
      attachment,
      bytes: localBytes,
    });
    await expect(storage.get(
      'unkeep-staged-remote-attachments:remote-stage',
    )).resolves.toEqual([]);
  });

  it('deletes bytes and every local marker in one transaction', async () => {
    const backing = new MemoryClientStorage();
    const atomicOnly: ClientStorage = {
      get: <T>(key: string) => backing.get<T>(key),
      set: () => Promise.reject(new Error('split set must not be used')),
      delete: () => Promise.reject(new Error('split delete must not be used')),
      update: () => Promise.reject(new Error('split update must not be used')),
      transact: (keys, change) => backing.transact(keys, change),
    };
    const store = new AttachmentStore(atomicOnly);
    await store.stageUpload('note-one', attachment, new Uint8Array([1]));

    await store.delete('note-one', attachment.id);

    await expect(store.get('note-one', attachment.id)).resolves.toBeNull();
    await expect(store.pendingUploads()).resolves.toEqual([]);
    await expect(store.stagedUploads()).resolves.toEqual([]);
    await expect(store.pendingDeletes()).resolves.toEqual([]);
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

  it('forces active-content attachment object URLs to an inert MIME type', async () => {
    const hostileAttachment = {
      ...attachment,
      id: 'active-content',
      name: 'payload.svg',
      mimeType: 'image/svg+xml',
    };
    const store = new AttachmentStore(new MemoryClientStorage());
    await store.save('note-one', hostileAttachment, new Uint8Array([1, 2, 3, 4]));
    const created: Blob[] = [];
    const urls = new AttachmentUrlCache(store, {
      create: (blob) => {
        created.push(blob);
        return 'blob:inert';
      },
      revoke: () => undefined,
    });

    await urls.hydrate({
      id: 'note-one',
      content: '',
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
      images: [hostileAttachment],
    });

    expect(created[0].type).toBe('application/octet-stream');
  });

  it('discards every attachment URL when verified local bytes are unavailable', async () => {
    const urls = new AttachmentUrlCache(new AttachmentStore(new MemoryClientStorage()), {
      create: () => {
        throw new Error('must not mint an object URL without bytes');
      },
      revoke: () => undefined,
    });
    const note = {
      id: 'hostile-note',
      content: '',
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
      images: [
        { ...attachment, id: 'javascript', url: 'javascript:alert(document.domain)' },
        { ...attachment, id: 'data', url: 'data:text/html,<script>alert(1)</script>' },
        { ...attachment, id: 'remote', url: 'https://attacker.example/payload' },
        { ...attachment, id: 'forged-blob', url: 'blob:https://unkeep.example/forged' },
      ],
    };

    expect((await urls.hydrate(note)).images).toEqual(note.images.map(value => ({
      id: value.id,
      name: value.name,
      mimeType: value.mimeType,
      size: value.size,
    })));
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

  it('rolls the whole delete transition back when its transaction is interrupted', async () => {
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
      transact: async (keys, change) => {
        if (
          interruptUploadQueueWrite
          && keys.includes('unkeep-pending-attachment-uploads')
        ) {
          interruptUploadQueueWrite = false;
          throw new Error('interrupted');
        }
        await backing.transact(keys, change);
      },
    };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const store = new AttachmentStore(storage);
    await store.save('note-one', attachment, bytes, { pendingUpload: true });

    interruptUploadQueueWrite = true;
    await expect(store.queueDelete('note-one', attachment)).rejects.toThrow('interrupted');

    const afterReload = new AttachmentStore(storage);
    await expect(afterReload.pendingDeletes()).resolves.toEqual([]);
    await expect(afterReload.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
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

  it('restores an interrupted unsynced upload when a queued note deletion is cancelled after restart', async () => {
    const storage = new MemoryClientStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const beforeCrash = new AttachmentStore(storage);
    await beforeCrash.save('note-one', attachment, bytes, { pendingUpload: true });
    const originalHandles = await beforeCrash.pendingUploadHandles(
      'note-one',
      [attachment.id],
    );
    await beforeCrash.queueDelete('note-one', attachment, { retainBytes: true });

    const afterRestart = new AttachmentStore(storage);
    await afterRestart.cancelDelete('note-one', attachment.id);

    await expect(afterRestart.pendingUploadHandles(
      'note-one',
      [attachment.id],
    )).resolves.toEqual(originalHandles);
    await expect(afterRestart.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment, bytes },
    ]);
  });

  it('purges crash-retained removal bytes only after the remote deletion completes', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, {
      retainBytes: true,
      purgeRetainedBytesOnComplete: true,
    });

    await store.flushDeletes(async () => {
      throw new Error('offline');
    });
    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });

    await store.flushDeletes(async () => undefined);

    await expect(store.pendingDeletes()).resolves.toEqual([]);
    await expect(store.get('note-one', attachment.id)).resolves.toBeNull();
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

    const restored = await store.restoreForUndo('note-one', [attachment, missing]);
    expect(restored).toEqual([
      expect.objectContaining({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }),
    ]);
    expect(restored[0].id).not.toBe(attachment.id);
    await expect(store.get('note-one', restored[0].id)).resolves.toEqual({
      attachment: restored[0],
      bytes,
    });
    await expect(store.pendingDeletes()).resolves.toEqual([
      { noteId: 'note-one', attachment, retainBytes: true },
    ]);
    await expect(store.pendingUploads()).resolves.toEqual([]);
  });

  it('keeps an Undo re-upload queued when an older remote tombstone arrives afterward', async () => {
    const store = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.save('note-one', attachment, bytes);
    await store.queueDelete('note-one', attachment, { retainBytes: true });
    await store.flushDeletes(async () => undefined);
    const [restored] = await store.restoreForUndo('note-one', [attachment]);
    await store.prepareUploads('note-one', [restored]);

    await store.applyRemoteDelete('note-one', attachment.id);

    await expect(store.get('note-one', attachment.id)).resolves.toEqual({ attachment, bytes });
    await expect(store.pendingUploads()).resolves.toEqual([
      { noteId: 'note-one', attachment: restored, bytes },
    ]);
  });

  it('resolves retained-byte purge races according to whether Undo or expiry wins first', async () => {
    const undoWins = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await undoWins.save('undo-first', attachment, bytes);
    await undoWins.queueDelete('undo-first', attachment, { retainBytes: true });
    await undoWins.flushDeletes(async () => undefined);
    const [fresh] = await undoWins.restoreForUndo('undo-first', [attachment]);
    await undoWins.purgeRetained('undo-first', [attachment.id]);
    await expect(undoWins.get('undo-first', attachment.id)).resolves.toBeNull();
    await expect(undoWins.get('undo-first', fresh.id)).resolves.toEqual({
      attachment: fresh,
      bytes,
    });

    const expiryWins = new AttachmentStore(new MemoryClientStorage());
    await expiryWins.save('expiry-first', attachment, bytes);
    await expiryWins.queueDelete('expiry-first', attachment, { retainBytes: true });
    await expiryWins.flushDeletes(async () => undefined);
    await expiryWins.purgeRetained('expiry-first', [attachment.id]);
    await expect(expiryWins.restoreForUndo('expiry-first', [attachment])).resolves.toEqual([]);
    await expect(expiryWins.get('expiry-first', attachment.id)).resolves.toBeNull();
  });
});
