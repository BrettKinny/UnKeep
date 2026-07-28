import type { Note, NoteAttachment } from '@unkeep/core';
import type { ClientStorage } from '@unkeep/client';

const ATTACHMENT_PREFIX = 'unkeep-attachment:';
const PENDING_UPLOADS_KEY = 'unkeep-pending-attachment-uploads';
const PENDING_DELETES_KEY = 'unkeep-pending-attachment-deletes';

interface StoredAttachment {
  noteId: string;
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
  retainedForUndo?: true;
}

export interface AttachmentBytes {
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface PendingAttachmentUpload extends AttachmentBytes {
  noteId: string;
}

export interface AttachmentUploadResult {
  uploaded: number;
  failed: PendingAttachmentUpload[];
}

export interface PendingAttachmentDelete {
  noteId: string;
  attachment: NoteAttachment;
  retainBytes?: boolean;
}

export interface AttachmentDeleteResult {
  deleted: number;
  failed: PendingAttachmentDelete[];
}

export type AttachmentUploader = (
  noteId: string,
  attachment: NoteAttachment,
  bytes: Uint8Array<ArrayBuffer>,
) => Promise<void>;

export type AttachmentDeleter = (
  noteId: string,
  attachment: NoteAttachment,
) => Promise<void>;

interface ObjectUrlApi {
  create(blob: Blob): string;
  revoke(url: string): void;
}

interface StorageQueue {
  tail: Promise<void>;
}

const storageQueues = new WeakMap<object, Map<string, StorageQueue>>();

function queueFor(storage: ClientStorage, scope: string): StorageQueue {
  let scopes = storageQueues.get(storage as object);
  if (!scopes) {
    scopes = new Map();
    storageQueues.set(storage as object, scopes);
  }
  let queue = scopes.get(scope);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    scopes.set(scope, queue);
  }
  return queue;
}

function portableAttachment(attachment: NoteAttachment): NoteAttachment {
  const { id, name, mimeType, size } = attachment;
  return { id, name, mimeType, size };
}

export class AttachmentStore {
  private readonly attachmentPrefix: string;
  private readonly pendingUploadsKey: string;
  private readonly pendingDeletesKey: string;
  private readonly operationQueue: StorageQueue;

  constructor(private readonly storage: ClientStorage, vaultNamespace?: string) {
    const scope = vaultNamespace ? `${encodeURIComponent(vaultNamespace)}:` : '';
    this.attachmentPrefix = `${ATTACHMENT_PREFIX}${scope}`;
    this.pendingUploadsKey = vaultNamespace
      ? `${PENDING_UPLOADS_KEY}:${encodeURIComponent(vaultNamespace)}`
      : PENDING_UPLOADS_KEY;
    this.pendingDeletesKey = vaultNamespace
      ? `${PENDING_DELETES_KEY}:${encodeURIComponent(vaultNamespace)}`
      : PENDING_DELETES_KEY;
    this.operationQueue = queueFor(storage, this.attachmentPrefix);
  }

  storageKey(noteId: string, attachmentId: string): string {
    return `${this.attachmentPrefix}${encodeURIComponent(noteId)}:${encodeURIComponent(attachmentId)}`;
  }

  async save(
    noteId: string,
    attachment: NoteAttachment,
    bytes: Uint8Array<ArrayBuffer>,
    { pendingUpload = false }: { pendingUpload?: boolean } = {},
  ): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachment.id);
      await this.storage.set<StoredAttachment>(key, {
        noteId,
        attachment: portableAttachment(attachment),
        bytes: new Uint8Array(bytes),
      });
      await this.setPendingUnlocked(key, pendingUpload);
    });
  }

  async get(noteId: string, attachmentId: string): Promise<AttachmentBytes | null> {
    const value = await this.storage.get<StoredAttachment>(this.storageKey(noteId, attachmentId));
    if (!value) return null;
    return {
      attachment: portableAttachment(value.attachment),
      bytes: new Uint8Array(value.bytes),
    };
  }

  async pendingUploads(): Promise<PendingAttachmentUpload[]> {
    return this.runExclusive(() => this.pendingUploadsUnlocked());
  }

  private async pendingUploadsUnlocked(): Promise<PendingAttachmentUpload[]> {
    const keys = await this.pendingKeysUnlocked();
    const deleting = new Set((await this.pendingDeletesUnlocked()).map(value => this.storageKey(value.noteId, value.attachment.id)));
    const uploads: PendingAttachmentUpload[] = [];
    const liveKeys: string[] = [];
    for (const key of keys) {
      if (deleting.has(key)) continue;
      const value = await this.storage.get<StoredAttachment>(key);
      if (!value) continue;
      liveKeys.push(key);
      uploads.push({
        noteId: value.noteId,
        attachment: portableAttachment(value.attachment),
        bytes: new Uint8Array(value.bytes),
      });
    }
    if (liveKeys.length !== keys.length) {
      const staleKeys = new Set(keys.filter(key => !liveKeys.includes(key)));
      await this.updateValue<string[]>(
        this.pendingUploadsKey,
        current => (current ?? []).filter(key => !staleKeys.has(key)),
      );
    }
    return uploads;
  }

  async markUploaded(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(() => this.setPendingUnlocked(this.storageKey(noteId, attachmentId), false));
  }

  async flushUploads(upload: AttachmentUploader, noteId?: string): Promise<AttachmentUploadResult> {
    let uploaded = 0;
    const failed: PendingAttachmentUpload[] = [];
    for (const pending of await this.pendingUploads()) {
      if (noteId && pending.noteId !== noteId) continue;
      try {
        await upload(pending.noteId, pending.attachment, pending.bytes);
        await this.markUploaded(pending.noteId, pending.attachment.id);
        uploaded++;
      } catch {
        failed.push(pending);
      }
    }
    return { uploaded, failed };
  }

  async queueDelete(
    noteId: string,
    attachment: NoteAttachment,
    { retainBytes = false }: { retainBytes?: boolean } = {},
  ): Promise<void> {
    await this.runExclusive(async () => {
      const queued = { noteId, attachment: portableAttachment(attachment), ...(retainBytes ? { retainBytes: true } : {}) };
      // Persist the intent before removing bytes or a pending upload. If the
      // browser stops between these writes, pendingUploads() gives deletion
      // precedence and cannot resurrect the file.
      await this.updateValue<PendingAttachmentDelete[]>(this.pendingDeletesKey, current => [
        ...(current ?? []).filter(value => value.noteId !== noteId || value.attachment.id !== attachment.id),
        queued,
      ]);
      const key = this.storageKey(noteId, attachment.id);
      if (retainBytes) {
        const stored = await this.storage.get<StoredAttachment>(key);
        if (stored) await this.storage.set<StoredAttachment>(key, { ...stored, retainedForUndo: true });
      }
      await this.setPendingUnlocked(key, false);
      if (!retainBytes) await this.storage.delete(key);
    });
  }

  async pendingDeletes(): Promise<PendingAttachmentDelete[]> {
    return this.runExclusive(() => this.pendingDeletesUnlocked());
  }

  private async pendingDeletesUnlocked(): Promise<PendingAttachmentDelete[]> {
    const values = await this.storage.get<PendingAttachmentDelete[]>(this.pendingDeletesKey) ?? [];
    return values.map(value => ({
      noteId: value.noteId,
      attachment: portableAttachment(value.attachment),
      ...(value.retainBytes ? { retainBytes: true } : {}),
    }));
  }

  async flushDeletes(remove: AttachmentDeleter, noteId?: string): Promise<AttachmentDeleteResult> {
    let deleted = 0;
    const failed: PendingAttachmentDelete[] = [];
    for (const pending of await this.pendingDeletes()) {
      if (noteId && pending.noteId !== noteId) continue;
      try {
        await remove(pending.noteId, pending.attachment);
        await this.runExclusive(async () => {
          await this.removePendingDeleteUnlocked(pending.noteId, pending.attachment.id);
          if (!pending.retainBytes) await this.storage.delete(this.storageKey(pending.noteId, pending.attachment.id));
        });
        deleted++;
      } catch {
        failed.push(pending);
      }
    }
    return { deleted, failed };
  }

  async cancelDelete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(() => this.removePendingDeleteUnlocked(noteId, attachmentId));
  }

  async delete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachmentId);
      await this.storage.delete(key);
      await this.setPendingUnlocked(key, false);
      await this.removePendingDeleteUnlocked(noteId, attachmentId);
    });
  }

  async applyRemoteDelete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachmentId);
      const stored = await this.storage.get<StoredAttachment>(key);
      const pendingUpload = new Set(await this.pendingKeysUnlocked()).has(key);
      if (!stored?.retainedForUndo && !pendingUpload) {
        await this.storage.delete(key);
        await this.setPendingUnlocked(key, false);
      }
      await this.removePendingDeleteUnlocked(noteId, attachmentId);
    });
  }

  async restoreForUndo(
    noteId: string,
    attachments: readonly NoteAttachment[],
  ): Promise<NoteAttachment[]> {
    return this.runExclusive(async () => {
      const attachmentIds = new Set(attachments.map(attachment => attachment.id));
      const restored: NoteAttachment[] = [];
      const restoredKeys = new Set<string>();

      for (const attachment of attachments) {
        const key = this.storageKey(noteId, attachment.id);
        const stored = await this.storage.get<StoredAttachment>(key);
        if (!stored) continue;
        const portable = portableAttachment(attachment);
        await this.storage.set<StoredAttachment>(key, {
          noteId,
          attachment: portable,
          bytes: new Uint8Array(stored.bytes),
        });
        restoredKeys.add(key);
        restored.push(portable);
      }

      await this.updateValue<PendingAttachmentDelete[]>(
        this.pendingDeletesKey,
        current => (current ?? [])
          .filter(value => value.noteId !== noteId || !attachmentIds.has(value.attachment.id)),
      );
      const targetKeys = new Set(attachments.map(attachment => this.storageKey(noteId, attachment.id)));
      await this.updateValue<string[]>(this.pendingUploadsKey, current => {
        const next = new Set((current ?? []).filter(key => !targetKeys.has(key)));
        for (const key of restoredKeys) next.add(key);
        return [...next];
      });
      return restored;
    });
  }

  async purgeRetained(noteId: string, attachmentIds: readonly string[]): Promise<void> {
    await this.runExclusive(async () => {
      for (const attachmentId of attachmentIds) {
        const key = this.storageKey(noteId, attachmentId);
        const stored = await this.storage.get<StoredAttachment>(key);
        if (!stored?.retainedForUndo) continue;
        await this.storage.delete(key);
        await this.setPendingUnlocked(key, false);
      }
    });
  }

  private async pendingKeysUnlocked(): Promise<string[]> {
    return await this.storage.get<string[]>(this.pendingUploadsKey) ?? [];
  }

  private async setPendingUnlocked(key: string, pending: boolean): Promise<void> {
    await this.updateValue<string[]>(this.pendingUploadsKey, current => {
      const keys = new Set(current ?? []);
      if (pending) keys.add(key);
      else keys.delete(key);
      return [...keys];
    });
  }

  private async removePendingDeleteUnlocked(noteId: string, attachmentId: string): Promise<void> {
    await this.updateValue<PendingAttachmentDelete[]>(
      this.pendingDeletesKey,
      current => (current ?? [])
        .filter(value => value.noteId !== noteId || value.attachment.id !== attachmentId),
    );
  }

  private async updateValue<T>(key: string, change: (value: T | null) => T | null): Promise<void> {
    if (this.storage.update) {
      await this.storage.update(key, change);
      return;
    }
    const next = change(await this.storage.get<T>(key));
    if (next === null) await this.storage.delete(key);
    else await this.storage.set(key, next);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.tail.then(operation);
    this.operationQueue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class AttachmentUrlCache {
  private readonly urls = new Map<string, string>();

  constructor(
    private readonly attachments: AttachmentStore,
    private readonly objectUrls: ObjectUrlApi = {
      create: blob => URL.createObjectURL(blob),
      revoke: url => URL.revokeObjectURL(url),
    },
  ) {}

  async hydrate(note: Note): Promise<Note> {
    if (!note.images?.length) return note;
    const images: NoteAttachment[] = [];
    for (const attachment of note.images) {
      const stored = await this.attachments.get(note.id, attachment.id);
      if (!stored) {
        const url = attachment.url?.startsWith('blob:') ? undefined : attachment.url;
        images.push({ ...portableAttachment(attachment), ...(url ? { url } : {}) });
        continue;
      }
      const key = this.attachments.storageKey(note.id, attachment.id);
      let url = this.urls.get(key);
      if (!url) {
        url = this.objectUrls.create(new Blob([stored.bytes], { type: stored.attachment.mimeType }));
        this.urls.set(key, url);
      }
      images.push({ ...portableAttachment(attachment), url });
    }
    return { ...note, images };
  }

  release(noteId: string, attachmentId: string): void {
    const key = this.attachments.storageKey(noteId, attachmentId);
    const url = this.urls.get(key);
    if (!url) return;
    this.objectUrls.revoke(url);
    this.urls.delete(key);
  }

  releaseAll(): void {
    for (const url of this.urls.values()) this.objectUrls.revoke(url);
    this.urls.clear();
  }
}
