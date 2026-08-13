import type { Note, NoteAttachment } from '@unkeep/core';
import type { ClientStorage, ClientStorageTransaction } from '@unkeep/client';
import { safeAttachmentBlobType } from './attachments';

const ATTACHMENT_PREFIX = 'unkeep-attachment:';
const PENDING_UPLOADS_KEY = 'unkeep-pending-attachment-uploads';
const STAGED_UPLOADS_KEY = 'unkeep-staged-attachment-uploads';
const STAGED_REMOTE_ATTACHMENTS_KEY = 'unkeep-staged-remote-attachments';
const PENDING_DELETES_KEY = 'unkeep-pending-attachment-deletes';
const COMPOUND_UPLOAD_INTENTS_KEY = 'unkeep-compound-upload-intents';
export const STAGED_UPLOAD_TTL_MS = 30_000;

interface StoredAttachment {
  storageVersion?: 2;
  noteId: string;
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
  uploadGeneration?: string;
  remoteGeneration?: string;
  /** Monotonic owner epoch used to fence expired share/import writers. */
  writeEpoch?: number;
  needsUpload?: true;
  retainedForUndo?: true;
}

export interface AttachmentBytes {
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface PendingAttachmentUpload extends AttachmentBytes {
  noteId: string;
}

export interface StagedAttachmentUpload extends PendingAttachmentUpload {
  stagedAt: number;
}

export interface StagedAttachmentHandle {
  noteId: string;
  attachmentId: string;
  generation: string;
}

export interface RestoredAttachmentUpload {
  attachment: NoteAttachment;
  handle: StagedAttachmentHandle;
}

export interface AttachmentUploadHandle {
  noteId: string;
  attachmentId: string;
  generation?: string;
}

export interface LazyAttachmentUpload {
  attachment: NoteAttachment;
  handle: AttachmentUploadHandle;
  loadBytes(): Promise<Uint8Array<ArrayBuffer>>;
}

export type CompoundUploadConfirmation = 'confirmed' | 'already-confirmed' | 'changed';

export interface CompoundUploadIntent {
  noteId: string;
  noteToken: string;
  uploads: AttachmentUploadHandle[];
  phase: 'pending' | 'reconciled';
}

export interface RemoteAttachmentHandle {
  noteId: string;
  attachmentId: string;
  generation: string;
}

interface PendingAttachmentKey {
  key: string;
  generation?: string;
}

interface StagedAttachmentKey {
  key: string;
  stagedAt: number;
  generation?: string;
}

interface StagedRemoteAttachmentKey {
  key: string;
  generation: string;
}

function stagedEntryIdentity(value: StagedAttachmentKey): string {
  return `${value.key}\0${value.stagedAt}\0${value.generation ?? 'legacy'}`;
}

function stagedRecordMatches(
  marker: StagedAttachmentKey,
  stored: StoredAttachment,
): boolean {
  return marker.generation === stored.uploadGeneration;
}

function pendingEntryIdentity(value: PendingAttachmentKey): string {
  return `${value.key}\0${value.generation ?? 'legacy'}`;
}

function pendingRecordMatches(
  marker: PendingAttachmentKey,
  stored: StoredAttachment,
): boolean {
  return marker.generation === stored.uploadGeneration;
}

function recordNeedsUpload(
  marker: PendingAttachmentKey,
  stored: StoredAttachment,
): boolean {
  if (stored.needsUpload) return true;
  // Before storageVersion 2, upload eligibility lived only in the string
  // pending index. Preserve that queue during upgrade. Every current write
  // carries storageVersion 2, so a stale legacy index cannot resurrect a
  // newly confirmed record.
  return stored.storageVersion !== 2
    && marker.generation === undefined
    && stored.uploadGeneration === undefined;
}

function normalizePendingAttachmentKeys(value: unknown): PendingAttachmentKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PendingAttachmentKey[] => {
    if (typeof entry === 'string') return [{ key: entry }];
    if (
      !entry
      || typeof entry !== 'object'
      || typeof (entry as PendingAttachmentKey).key !== 'string'
    ) return [];
    const candidate = entry as PendingAttachmentKey;
    return [{
      key: candidate.key,
      ...(typeof candidate.generation === 'string'
        ? { generation: candidate.generation }
        : {}),
    }];
  });
}

export interface AttachmentUploadResult {
  uploaded: number;
  failed: PendingAttachmentUpload[];
  error?: unknown;
  pendingConfirmation?: AttachmentUploadHandle[];
}

interface QueuedAttachmentUpload extends PendingAttachmentUpload {
  generation?: string;
}

export interface PendingAttachmentDelete {
  noteId: string;
  attachment: NoteAttachment;
  retainBytes?: boolean;
}

interface QueuedAttachmentDelete extends PendingAttachmentDelete {
  operationToken?: string;
  uploadGeneration?: string;
  writeEpoch?: number;
  purgeRetainedBytesOnComplete?: true;
  claimToken?: string;
  claimedAt?: number;
}

interface ClaimedAttachmentDelete extends QueuedAttachmentDelete {
  operationToken: string;
  claimToken: string;
  claimedAt: number;
}

const ATTACHMENT_DELETE_CLAIM_TTL_MS = 30_000;

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
  private readonly stagedUploadsKey: string;
  private readonly stagedRemoteAttachmentsKey: string;
  private readonly pendingDeletesKey: string;
  private readonly compoundUploadIntentsKey: string;
  private readonly operationQueue: StorageQueue;

  constructor(private readonly storage: ClientStorage, vaultNamespace?: string) {
    const scope = vaultNamespace ? `${encodeURIComponent(vaultNamespace)}:` : '';
    this.attachmentPrefix = `${ATTACHMENT_PREFIX}${scope}`;
    this.pendingUploadsKey = vaultNamespace
      ? `${PENDING_UPLOADS_KEY}:${encodeURIComponent(vaultNamespace)}`
      : PENDING_UPLOADS_KEY;
    this.stagedUploadsKey = vaultNamespace
      ? `${STAGED_UPLOADS_KEY}:${encodeURIComponent(vaultNamespace)}`
      : STAGED_UPLOADS_KEY;
    this.stagedRemoteAttachmentsKey = vaultNamespace
      ? `${STAGED_REMOTE_ATTACHMENTS_KEY}:${encodeURIComponent(vaultNamespace)}`
      : STAGED_REMOTE_ATTACHMENTS_KEY;
    this.pendingDeletesKey = vaultNamespace
      ? `${PENDING_DELETES_KEY}:${encodeURIComponent(vaultNamespace)}`
      : PENDING_DELETES_KEY;
    this.compoundUploadIntentsKey = vaultNamespace
      ? `${COMPOUND_UPLOAD_INTENTS_KEY}:${encodeURIComponent(vaultNamespace)}`
      : COMPOUND_UPLOAD_INTENTS_KEY;
    this.operationQueue = queueFor(storage, this.attachmentPrefix);
  }

  storageKey(noteId: string, attachmentId: string): string {
    return `${this.attachmentPrefix}${encodeURIComponent(noteId)}:${encodeURIComponent(attachmentId)}`;
  }

  async beginCompoundUploadIntent(
    noteId: string,
    noteToken: string,
    uploads: readonly AttachmentUploadHandle[],
  ): Promise<CompoundUploadIntent> {
    let result!: CompoundUploadIntent;
    await this.runExclusive(async () => {
      await this.updateValue<CompoundUploadIntent[]>(
        this.compoundUploadIntentsKey,
        current => {
          const intents = current ?? [];
          const existing = intents.find(value => value.noteId === noteId);
          if (existing) {
            result = this.normalizeCompoundUploadIntent(existing);
            return intents;
          }
          result = {
            noteId,
            noteToken,
            uploads: uploads.map(handle => ({ ...handle })),
            phase: 'pending',
          };
          return [...intents, result];
        },
      );
    });
    return result;
  }

  async compoundUploadIntent(noteId: string): Promise<CompoundUploadIntent | null> {
    return this.runExclusive(async () => {
      const intents = await this.storage.get<CompoundUploadIntent[]>(
        this.compoundUploadIntentsKey,
      ) ?? [];
      const intent = intents.find(value => value.noteId === noteId);
      return intent ? this.normalizeCompoundUploadIntent(intent) : null;
    });
  }

  async compoundUploadIntents(): Promise<CompoundUploadIntent[]> {
    return this.runExclusive(async () => (
      await this.storage.get<CompoundUploadIntent[]>(this.compoundUploadIntentsKey) ?? []
    ).map(value => this.normalizeCompoundUploadIntent(value)));
  }

  async markCompoundUploadIntentReconciled(
    noteId: string,
    noteToken: string,
  ): Promise<boolean> {
    let reconciled = false;
    await this.runExclusive(async () => {
      await this.updateValue<CompoundUploadIntent[]>(
        this.compoundUploadIntentsKey,
        current => (current ?? []).map(value => {
          if (value.noteId !== noteId || value.noteToken !== noteToken) return value;
          reconciled = true;
          return { ...value, phase: 'reconciled' };
        }),
      );
    });
    return reconciled;
  }

  async completeCompoundUploadIntent(noteId: string, noteToken: string): Promise<boolean> {
    let completed = false;
    await this.runExclusive(async () => {
      await this.updateValue<CompoundUploadIntent[]>(
        this.compoundUploadIntentsKey,
        current => {
          const intents = current ?? [];
          completed = intents.some(value =>
            value.noteId === noteId && value.noteToken === noteToken);
          return intents.filter(value =>
            value.noteId !== noteId || value.noteToken !== noteToken);
        },
      );
    });
    return completed;
  }

  private normalizeCompoundUploadIntent(value: CompoundUploadIntent): CompoundUploadIntent {
    return {
      ...structuredClone(value),
      phase: value.phase === 'reconciled' ? 'reconciled' : 'pending',
    };
  }

  async save(
    noteId: string,
    attachment: NoteAttachment,
    bytes: Uint8Array<ArrayBuffer>,
    { pendingUpload = false }: { pendingUpload?: boolean } = {},
  ): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachment.id);
      const generation = pendingUpload ? crypto.randomUUID() : undefined;
      await this.transact(
        [
          key,
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingDeletesKey,
        ],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const pending = normalizePendingAttachmentKeys(
            transaction.get<unknown>(this.pendingUploadsKey),
          ).filter(value => value.key !== key);
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const deletes = transaction.get<QueuedAttachmentDelete[]>(
            this.pendingDeletesKey,
          ) ?? [];
          const deleteEpoch = deletes
            .filter(value =>
              value.noteId === noteId
              && value.attachment.id === attachment.id
              && typeof value.writeEpoch === 'number'
              && Number.isFinite(value.writeEpoch))
            .reduce(
              (latest, value) => Math.max(latest, value.writeEpoch ?? -Infinity),
              -Infinity,
            );
          const inheritedWriteEpoch = stored?.writeEpoch
            ?? (Number.isFinite(deleteEpoch) ? deleteEpoch : undefined);
          if (deletes.some(value =>
            value.noteId === noteId
            && value.attachment.id === attachment.id
            && value.claimToken)
          ) {
            throw new Error('Attachment deletion is already in progress');
          }
          transaction.set<StoredAttachment>(key, {
            storageVersion: 2,
            noteId,
            attachment: portableAttachment(attachment),
            bytes: new Uint8Array(bytes),
            ...(inheritedWriteEpoch !== undefined
              ? { writeEpoch: inheritedWriteEpoch }
              : {}),
            ...(generation ? { uploadGeneration: generation, needsUpload: true } : {}),
          });
          transaction.set(
            this.pendingUploadsKey,
            generation ? [...pending, { key, generation }] : pending,
          );
          transaction.set(
            this.stagedUploadsKey,
            staged.filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            (
              transaction.get<StagedRemoteAttachmentKey[]>(
                this.stagedRemoteAttachmentsKey,
              ) ?? []
            ).filter(value => value.key !== key),
          );
          transaction.set(
            this.pendingDeletesKey,
            deletes
              .filter(value =>
                value.noteId !== noteId || value.attachment.id !== attachment.id),
          );
        },
      );
    });
  }

  async saveRemote(
    noteId: string,
    attachment: NoteAttachment,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<RemoteAttachmentHandle> {
    return this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachment.id);
      const generation = crypto.randomUUID();
      await this.transact(
        [
          key,
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingDeletesKey,
        ],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const pending = normalizePendingAttachmentKeys(
            transaction.get<unknown>(this.pendingUploadsKey),
          );
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const ownsPending = !!stored && pending.some(value =>
            value.key === key
            && recordNeedsUpload(value, stored)
            && pendingRecordMatches(value, stored));
          const ownsStage = !!stored && staged.some(value =>
            value.key === key && stagedRecordMatches(value, stored));
          const ownsDelete = (
            transaction.get<QueuedAttachmentDelete[]>(this.pendingDeletesKey) ?? []
          ).some(value =>
            value.noteId === noteId && value.attachment.id === attachment.id);
          if (
            stored?.needsUpload
            || stored?.retainedForUndo
            || ownsPending
            || ownsStage
            || ownsDelete
          ) {
            throw new Error(
              `Attachment changed locally while applying remote sync: ${attachment.name}`,
            );
          }
          transaction.set<StoredAttachment>(key, {
            storageVersion: 2,
            noteId,
            attachment: portableAttachment(attachment),
            bytes: new Uint8Array(bytes),
            remoteGeneration: generation,
            ...(stored?.writeEpoch !== undefined
              ? { writeEpoch: stored.writeEpoch }
              : {}),
          });
          transaction.set(
            this.pendingUploadsKey,
            pending.filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedUploadsKey,
            staged.filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            [
              ...(
                transaction.get<StagedRemoteAttachmentKey[]>(
                  this.stagedRemoteAttachmentsKey,
                ) ?? []
              ).filter(value => value.key !== key),
              { key, generation },
            ],
          );
        },
      );
      return {
        noteId,
        attachmentId: attachment.id,
        generation,
      };
    });
  }

  async confirmRemote(handle: RemoteAttachmentHandle): Promise<boolean> {
    return this.runExclusive(async () => {
      const key = this.storageKey(handle.noteId, handle.attachmentId);
      let confirmed = false;
      await this.transact(
        [key, this.stagedRemoteAttachmentsKey],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const staged = transaction.get<StagedRemoteAttachmentKey[]>(
            this.stagedRemoteAttachmentsKey,
          ) ?? [];
          if (
            stored?.remoteGeneration !== handle.generation
            || !staged.some(value =>
              value.key === key && value.generation === handle.generation)
          ) return;
          const available = { ...stored };
          delete available.remoteGeneration;
          transaction.set(key, available);
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            staged.filter(value =>
              value.key !== key || value.generation !== handle.generation),
          );
          confirmed = true;
        },
      );
      return confirmed;
    });
  }

  /**
   * Persist bytes that are not eligible for remote upload until a matching
   * note+outbox transaction has committed.
   */
  async stageUpload(
    noteId: string,
    attachment: NoteAttachment,
    bytes: Uint8Array<ArrayBuffer>,
    {
      stagedAt = Date.now(),
      generation = crypto.randomUUID(),
      writeEpoch,
    }: {
      stagedAt?: number;
      generation?: string;
      writeEpoch?: number;
    } = {},
  ): Promise<StagedAttachmentHandle> {
    return this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachment.id);
      if (!generation) throw new Error('Attachment staging generation is required');
      if (writeEpoch !== undefined && !Number.isFinite(writeEpoch)) {
        throw new Error('Attachment write epoch must be finite');
      }
      await this.transact(
        [
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingUploadsKey,
          this.pendingDeletesKey,
          key,
        ],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const pending = normalizePendingAttachmentKeys(
            transaction.get<unknown>(this.pendingUploadsKey),
          );
          const deletes = transaction.get<QueuedAttachmentDelete[]>(
            this.pendingDeletesKey,
          ) ?? [];
          const deleteEpoch = deletes
            .filter(value =>
              value.noteId === noteId
              && value.attachment.id === attachment.id
              && typeof value.writeEpoch === 'number'
              && Number.isFinite(value.writeEpoch))
            .reduce(
              (latest, value) => Math.max(latest, value.writeEpoch ?? -Infinity),
              -Infinity,
            );
          const latestEpoch = Math.max(
            stored?.writeEpoch ?? -Infinity,
            deleteEpoch,
          );
          if (
            Number.isFinite(latestEpoch)
            && (writeEpoch === undefined || writeEpoch < latestEpoch)
          ) {
            throw new Error('Attachment staging owner was superseded');
          }
          if (deletes.some(value =>
            value.noteId === noteId
            && value.attachment.id === attachment.id
            && value.claimToken)) {
            throw new Error('Attachment deletion is already in progress');
          }
          transaction.set(this.stagedUploadsKey, [
            ...staged.filter(value => value.key !== key),
            { key, stagedAt, generation },
          ]);
          transaction.set(
            this.pendingUploadsKey,
            pending.filter(value => value.key !== key),
          );
          transaction.set<StoredAttachment>(key, {
            storageVersion: 2,
            noteId,
            attachment: portableAttachment(attachment),
            bytes: new Uint8Array(bytes),
            uploadGeneration: generation,
            ...(writeEpoch !== undefined ? { writeEpoch } : {}),
            needsUpload: true,
          });
          transaction.set(
            this.pendingDeletesKey,
            deletes
              .filter(value =>
                value.noteId !== noteId || value.attachment.id !== attachment.id),
          );
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            (
              transaction.get<StagedRemoteAttachmentKey[]>(
                this.stagedRemoteAttachmentsKey,
              ) ?? []
            ).filter(value => value.key !== key),
          );
        },
      );
      return { noteId, attachmentId: attachment.id, generation };
    });
  }

  private transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    if (!this.storage.transact) {
      return Promise.reject(
        new Error('Attachment storage does not support atomic multi-key transactions'),
      );
    }
    return this.storage.transact(keys, change);
  }

  async get(noteId: string, attachmentId: string): Promise<AttachmentBytes | null> {
    const value = await this.storage.get<StoredAttachment>(this.storageKey(noteId, attachmentId));
    // Pulled bytes are not part of the visible working copy until the matching
    // remote note has been saved. A browser stop between those operations must
    // not make an older local note render bytes from a newer remote revision.
    if (!value || value.remoteGeneration) return null;
    return {
      attachment: portableAttachment(value.attachment),
      bytes: new Uint8Array(value.bytes),
    };
  }

  async pendingUploads(): Promise<PendingAttachmentUpload[]> {
    return this.runExclusive(async () => (
      await this.pendingUploadsUnlocked()
    ).map(({ noteId, attachment, bytes }) => ({ noteId, attachment, bytes })));
  }

  /** Enumerate work without loading any attachment byte records. */
  async pendingUploadNoteIds(): Promise<string[]> {
    return this.runExclusive(async () => {
      const noteIds = new Set<string>();
      for (const { key } of [
        ...await this.pendingKeysUnlocked(),
        ...await this.stagedKeysUnlocked(),
      ]) {
        if (!key.startsWith(this.attachmentPrefix)) continue;
        const encoded = key.slice(this.attachmentPrefix.length).split(':', 1)[0];
        if (encoded) noteIds.add(decodeURIComponent(encoded));
      }
      return [...noteIds].sort();
    });
  }

  /**
   * Return metadata plus reusable loaders fenced to the exact queued
   * generation. Byte arrays are read only when the compound SDK asks for one.
   */
  async pendingUploadSources(
    noteId: string,
    attachmentIds: readonly string[],
  ): Promise<LazyAttachmentUpload[]> {
    return this.runExclusive(async () => {
      const allowed = new Set(attachmentIds);
      const sources: LazyAttachmentUpload[] = [];
      for (const marker of await this.pendingKeysUnlocked()) {
        const stored = await this.storage.get<StoredAttachment>(marker.key);
        if (
          !stored
          || stored.noteId !== noteId
          || !allowed.has(stored.attachment.id)
          || !recordNeedsUpload(marker, stored)
          || !pendingRecordMatches(marker, stored)
        ) continue;
        const handle: AttachmentUploadHandle = {
          noteId,
          attachmentId: stored.attachment.id,
          ...(marker.generation ? { generation: marker.generation } : {}),
        };
        const attachment = portableAttachment(stored.attachment);
        sources.push({
          attachment,
          handle,
          loadBytes: () => this.loadPendingGeneration(handle),
        });
      }
      return sources;
    });
  }

  /** Return every still-readable source from an exact persisted intent. */
  async pendingUploadSourcesForHandles(
    handles: readonly AttachmentUploadHandle[],
  ): Promise<LazyAttachmentUpload[]> {
    return this.runExclusive(async () => {
      const sources: LazyAttachmentUpload[] = [];
      for (const handle of handles) {
        const key = this.storageKey(handle.noteId, handle.attachmentId);
        const marker: PendingAttachmentKey = {
          key,
          ...(handle.generation ? { generation: handle.generation } : {}),
        };
        const stored = await this.storage.get<StoredAttachment>(key);
        if (
          !stored
          || !recordNeedsUpload(marker, stored)
          || !pendingRecordMatches(marker, stored)
        ) continue;
        sources.push({
          attachment: portableAttachment(stored.attachment),
          handle: { ...handle },
          loadBytes: () => this.loadPendingGeneration(handle),
        });
      }
      return sources;
    });
  }

  async hasReplacementUploadGeneration(handle: AttachmentUploadHandle): Promise<boolean> {
    return this.runExclusive(async () => {
      const stored = await this.storage.get<StoredAttachment>(
        this.storageKey(handle.noteId, handle.attachmentId),
      );
      return Boolean(
        stored?.needsUpload
        && stored.uploadGeneration
        && stored.uploadGeneration !== handle.generation,
      );
    });
  }

  private async loadPendingGeneration(
    handle: AttachmentUploadHandle,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return this.runExclusive(async () => {
      const key = this.storageKey(handle.noteId, handle.attachmentId);
      const marker: PendingAttachmentKey = {
        key,
        ...(handle.generation ? { generation: handle.generation } : {}),
      };
      const stored = await this.storage.get<StoredAttachment>(key);
      if (
        !stored
        || !recordNeedsUpload(marker, stored)
        || !pendingRecordMatches(marker, stored)
      ) throw new Error('Attachment upload generation changed');
      return new Uint8Array(stored.bytes);
    });
  }

  /**
   * Confirm relay acceptance only when both the local generation and bytes
   * still identify the attachment that was committed. A newer generation is
   * deliberately left queued.
   */
  async confirmCompoundUpload(
    handle: AttachmentUploadHandle,
    contentHash: string,
  ): Promise<CompoundUploadConfirmation> {
    return this.runExclusive(async () => {
      const key = this.storageKey(handle.noteId, handle.attachmentId);
      const marker: PendingAttachmentKey = {
        key,
        ...(handle.generation ? { generation: handle.generation } : {}),
      };
      const stored = await this.storage.get<StoredAttachment>(key);
      if (!stored) return 'changed';
      if (!pendingRecordMatches(marker, stored)) return 'changed';
      const actualHash = [...new Uint8Array(
        await crypto.subtle.digest('SHA-256', stored.bytes),
      )].map(value => value.toString(16).padStart(2, '0')).join('');
      if (actualHash !== contentHash) {
        if (!recordNeedsUpload(marker, stored)) return 'changed';
        throw new Error('Committed attachment content hash does not match local bytes');
      }
      if (!recordNeedsUpload(marker, stored)) return 'already-confirmed';
      await this.transact(
        [key, this.pendingUploadsKey, this.stagedUploadsKey],
        transaction => {
          const current = transaction.get<StoredAttachment>(key);
          if (
            !current
            || !recordNeedsUpload(marker, current)
            || !pendingRecordMatches(marker, current)
          ) return;
          const available = { ...current, storageVersion: 2 as const };
          delete available.needsUpload;
          delete available.uploadGeneration;
          transaction.set(key, available);
          transaction.set(
            this.pendingUploadsKey,
            normalizePendingAttachmentKeys(transaction.get<unknown>(this.pendingUploadsKey))
              .filter(value => pendingEntryIdentity(value) !== pendingEntryIdentity(marker)),
          );
          transaction.set(
            this.stagedUploadsKey,
            (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
              .filter(value => value.key !== key || value.generation !== handle.generation),
          );
        },
      );
      return 'confirmed';
    });
  }

  async stagedUploads(): Promise<StagedAttachmentUpload[]> {
    return this.runExclusive(async () => {
      const staged = await this.stagedKeysUnlocked();
      const stale = new Set<string>();
      const uploads: StagedAttachmentUpload[] = [];
      for (const value of staged) {
        const stored = await this.storage.get<StoredAttachment>(value.key);
        if (!stored) {
          // stageUpload commits this index before its potentially large byte
          // value. Absence cannot distinguish a crashed writer from a stalled
          // writer, so expiry is never authority to erase its marker.
          continue;
        }
        if (!stagedRecordMatches(value, stored)) continue;
        if (!stored.needsUpload) {
          stale.add(stagedEntryIdentity(value));
          continue;
        }
        uploads.push({
          noteId: stored.noteId,
          attachment: portableAttachment(stored.attachment),
          bytes: new Uint8Array(stored.bytes),
          stagedAt: value.stagedAt,
        });
      }
      if (stale.size) {
        await this.updateValue<StagedAttachmentKey[]>(
          this.stagedUploadsKey,
          current => (current ?? [])
            .filter(value => !stale.has(stagedEntryIdentity(value))),
        );
      }
      return uploads;
    });
  }

  private async pendingUploadsUnlocked(): Promise<QueuedAttachmentUpload[]> {
    const entries = await this.pendingKeysUnlocked();
    const deleting = new Set((await this.pendingDeletesUnlocked()).map(value => this.storageKey(value.noteId, value.attachment.id)));
    const uploads: QueuedAttachmentUpload[] = [];
    const stale = new Set<string>();
    for (const entry of entries) {
      if (deleting.has(entry.key)) {
        // A delete observed in this snapshot suppresses this upload attempt,
        // but may be cancelled by another tab. Only the delete transaction
        // itself may retire the upload generation.
        continue;
      }
      const value = await this.storage.get<StoredAttachment>(entry.key);
      // Upload confirmation stores the byte record first and clears this
      // index second. A browser stop between those writes must not re-upload
      // bytes whose durable record no longer says they need upload.
      if (!value || !recordNeedsUpload(entry, value) || !pendingRecordMatches(entry, value)) {
        stale.add(pendingEntryIdentity(entry));
        continue;
      }
      uploads.push({
        noteId: value.noteId,
        attachment: portableAttachment(value.attachment),
        bytes: new Uint8Array(value.bytes),
        ...(entry.generation ? { generation: entry.generation } : {}),
      });
    }
    if (stale.size) {
      await this.updateValue<unknown[]>(
        this.pendingUploadsKey,
        current => normalizePendingAttachmentKeys(current)
          .filter(value => !stale.has(pendingEntryIdentity(value))),
      );
    }
    return uploads;
  }

  private async markUploaded(pending: AttachmentUploadHandle): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(pending.noteId, pending.attachmentId);
      const expected = {
        key,
        ...(pending.generation ? { generation: pending.generation } : {}),
      };
      await this.transact(
        [key, this.pendingUploadsKey, this.stagedUploadsKey],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          if (
            !stored
            || !recordNeedsUpload(expected, stored)
            || !pendingRecordMatches(expected, stored)
          ) return;
          const available = { ...stored };
          available.storageVersion = 2;
          delete available.needsUpload;
          delete available.uploadGeneration;
          transaction.set<StoredAttachment>(key, available);
          transaction.set(
            this.pendingUploadsKey,
            normalizePendingAttachmentKeys(transaction.get<unknown>(this.pendingUploadsKey))
              .filter(value => pendingEntryIdentity(value) !== pendingEntryIdentity(expected)),
          );
          transaction.set(
            this.stagedUploadsKey,
            (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
              .filter(value => value.key !== key || value.generation !== pending.generation),
          );
        },
      );
    });
  }

  /**
   * Retire local-only bytes after the note mutation that owned them was
   * rejected. Confirmed attachment bytes are preserved even if a stale queue
   * index still mentions them.
   */
  async pendingUploadHandles(
    noteId: string,
    attachmentIds: readonly string[],
  ): Promise<AttachmentUploadHandle[]> {
    return this.runExclusive(async () => {
      const attachmentIdByKey = new Map(
        attachmentIds.map(attachmentId => [
          this.storageKey(noteId, attachmentId),
          attachmentId,
        ]),
      );
      const handles: AttachmentUploadHandle[] = [];
      for (const pending of await this.pendingKeysUnlocked()) {
        const attachmentId = attachmentIdByKey.get(pending.key);
        if (!attachmentId) continue;
        const stored = await this.storage.get<StoredAttachment>(pending.key);
        if (
          !stored
          || !recordNeedsUpload(pending, stored)
          || !pendingRecordMatches(pending, stored)
        ) continue;
        handles.push({
          noteId,
          attachmentId,
          ...(pending.generation ? { generation: pending.generation } : {}),
        });
      }
      return handles;
    });
  }

  async discardRejectedUploads(
    handles: readonly AttachmentUploadHandle[],
  ): Promise<void> {
    await this.runExclusive(async () => {
      const expected = handles.map(handle => ({
        handle,
        marker: {
          key: this.storageKey(handle.noteId, handle.attachmentId),
          ...(handle.generation ? { generation: handle.generation } : {}),
        } satisfies PendingAttachmentKey,
      }));
      await this.transact(
        [
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          ...expected.map(value => value.marker.key),
        ],
        transaction => {
          const pending = normalizePendingAttachmentKeys(
            transaction.get<unknown>(this.pendingUploadsKey),
          );
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const identities = new Set(expected.map(value => pendingEntryIdentity(value.marker)));
          for (const { marker } of expected) {
            const stored = transaction.get<StoredAttachment>(marker.key);
            if (
              stored
              && recordNeedsUpload(marker, stored)
              && pendingRecordMatches(marker, stored)
            ) {
              transaction.delete(marker.key);
            }
          }
          transaction.set(
            this.pendingUploadsKey,
            pending.filter(value => !identities.has(pendingEntryIdentity(value))),
          );
          transaction.set(
            this.stagedUploadsKey,
            staged.filter(value => !identities.has(pendingEntryIdentity(value))),
          );
        },
      );
    });
  }

  async discardStage(handle: StagedAttachmentHandle): Promise<boolean> {
    return this.runExclusive(async () => {
      const key = this.storageKey(handle.noteId, handle.attachmentId);
      const marker = { key, generation: handle.generation };
      let discarded = false;
      await this.transact(
        [key, this.pendingUploadsKey, this.stagedUploadsKey],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const ownsMarker = staged.some(value =>
            value.key === key && value.generation === handle.generation);
          if (!ownsMarker || !stored?.needsUpload || !pendingRecordMatches(marker, stored)) {
            return;
          }
          transaction.delete(key);
          transaction.set(
            this.stagedUploadsKey,
            staged.filter(value =>
              value.key !== key || value.generation !== handle.generation),
          );
          transaction.set(
            this.pendingUploadsKey,
            normalizePendingAttachmentKeys(transaction.get<unknown>(this.pendingUploadsKey))
              .filter(value => pendingEntryIdentity(value) !== pendingEntryIdentity(marker)),
          );
          discarded = true;
        },
      );
      return discarded;
    });
  }

  /**
   * Promote staged bytes referenced by the durable note and discard legacy
   * queued uploads that are absent from that exact pending snapshot.
   */
  async prepareUploads(
    noteId: string,
    attachments: readonly NoteAttachment[],
    now = Date.now(),
  ): Promise<void> {
    await this.runExclusive(async () => {
      const referenced = new Set(attachments.map(value => value.id));
      const noteKeyPrefix = `${this.attachmentPrefix}${encodeURIComponent(noteId)}:`;
      for (const value of await this.stagedKeysUnlocked()) {
        const stored = await this.storage.get<StoredAttachment>(value.key);
        if (!stored) {
          // A writer may still commit this generation. Only its owner or an
          // atomic generation match may retire the marker.
          continue;
        }
        if (!stagedRecordMatches(value, stored)) continue;
        if (!stored.needsUpload) {
          await this.transact([this.stagedUploadsKey, value.key], transaction => {
            const current = transaction.get<StoredAttachment>(value.key);
            if (current && stagedRecordMatches(value, current) && !current.needsUpload) {
              transaction.set(
                this.stagedUploadsKey,
                (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
                  .filter(marker => stagedEntryIdentity(marker) !== stagedEntryIdentity(value)),
              );
            }
          });
          continue;
        }
        if (stored.noteId !== noteId) continue;
        if (referenced.has(stored.attachment.id)) {
          await this.transact(
            [this.stagedUploadsKey, this.pendingUploadsKey, value.key],
            transaction => {
              const current = transaction.get<StoredAttachment>(value.key);
              const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
              const ownsMarker = staged.some(marker =>
                stagedEntryIdentity(marker) === stagedEntryIdentity(value));
              if (
                !ownsMarker
                || !current?.needsUpload
                || current.noteId !== noteId
                || !referenced.has(current.attachment.id)
                || !stagedRecordMatches(value, current)
              ) return;
              transaction.set(
                this.pendingUploadsKey,
                [
                  ...normalizePendingAttachmentKeys(
                    transaction.get<unknown>(this.pendingUploadsKey),
                  ).filter(pending => pending.key !== value.key),
                  {
                    key: value.key,
                    ...(value.generation ? { generation: value.generation } : {}),
                  },
                ],
              );
              transaction.set(
                this.stagedUploadsKey,
                staged.filter(marker =>
                  stagedEntryIdentity(marker) !== stagedEntryIdentity(value)),
              );
            },
          );
          continue;
        }
        // Absence from this snapshot is not deletion authority: a different
        // tab may already have committed a newer note mutation. Its generation
        // stays enumerable until the operation that owns it retires it.
        void now;
      }

      for (const pending of await this.pendingKeysUnlocked()) {
        if (!pending.key.startsWith(noteKeyPrefix)) continue;
        const stored = await this.storage.get<StoredAttachment>(pending.key);
        if (
          !stored
          || !recordNeedsUpload(pending, stored)
          || !pendingRecordMatches(pending, stored)
        ) {
          await this.updateValue<unknown[]>(
            this.pendingUploadsKey,
            current => normalizePendingAttachmentKeys(current)
              .filter(value =>
                pendingEntryIdentity(value) !== pendingEntryIdentity(pending)),
          );
          continue;
        }
        // Do not destructively reconcile valid pending bytes against this
        // potentially stale snapshot. flushUploads authorizes only IDs that
        // this exact note version references.
      }

      for (const attachment of attachments) {
        const key = this.storageKey(noteId, attachment.id);
        const stored = await this.storage.get<StoredAttachment>(key);
        if (!stored) throw new Error(`Attachment bytes unavailable: ${attachment.name}`);
        const expected: PendingAttachmentKey = {
          key,
          ...(stored.uploadGeneration ? { generation: stored.uploadGeneration } : {}),
        };
        const legacyPending = !stored.needsUpload
          && stored.storageVersion !== 2
          && stored.uploadGeneration === undefined
          && (await this.pendingKeysUnlocked()).some(value =>
            pendingEntryIdentity(value) === pendingEntryIdentity(expected));
        if (!stored.needsUpload && !legacyPending) continue;
        const promotedGeneration = expected.generation ?? crypto.randomUUID();
        let prepared = false;
        await this.transact(
          [key, this.pendingUploadsKey, this.stagedUploadsKey],
          transaction => {
            const current = transaction.get<StoredAttachment>(key);
            const queued = normalizePendingAttachmentKeys(
              transaction.get<unknown>(this.pendingUploadsKey),
            );
            const ownsLegacyPending = queued.some(value =>
              pendingEntryIdentity(value) === pendingEntryIdentity(expected));
            if (
              !current
              || !recordNeedsUpload(expected, current)
              || (!current.needsUpload && !ownsLegacyPending)
              || current.noteId !== noteId
              || current.attachment.id !== attachment.id
              || !pendingRecordMatches(expected, current)
            ) return;
            const promoted = {
              ...current,
              storageVersion: 2,
              uploadGeneration: promotedGeneration,
              needsUpload: true,
            } satisfies StoredAttachment;
            if (
              current.storageVersion !== 2
              || current.uploadGeneration !== promotedGeneration
              || !current.needsUpload
            ) {
              transaction.set(key, promoted);
            }
            transaction.set(
              this.pendingUploadsKey,
              [
                ...queued.filter(value => value.key !== key),
                { key, generation: promotedGeneration },
              ],
            );
            transaction.set(
              this.stagedUploadsKey,
              (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
                .filter(value =>
                  pendingEntryIdentity(value) !== pendingEntryIdentity(expected)),
            );
            prepared = true;
          },
        );
        if (!prepared) {
          throw new Error(`Attachment changed while preparing upload: ${attachment.name}`);
        }
      }
    });
  }

  async flushUploads(
    upload: AttachmentUploader,
    noteId?: string,
    attachmentIds?: readonly string[],
    { deferConfirmation = false }: { deferConfirmation?: boolean } = {},
  ): Promise<AttachmentUploadResult> {
    let uploaded = 0;
    const failed: PendingAttachmentUpload[] = [];
    const pendingConfirmation: AttachmentUploadHandle[] = [];
    let uploadError: unknown;
    const allowedAttachmentIds = attachmentIds
      ? new Set(attachmentIds)
      : null;
    const pendingUploads = await this.runExclusive(() => this.pendingUploadsUnlocked());
    for (const pending of pendingUploads) {
      if (noteId && pending.noteId !== noteId) continue;
      if (allowedAttachmentIds && !allowedAttachmentIds.has(pending.attachment.id)) continue;
      try {
        await upload(pending.noteId, pending.attachment, pending.bytes);
        const handle: AttachmentUploadHandle = {
          noteId: pending.noteId,
          attachmentId: pending.attachment.id,
          ...(pending.generation ? { generation: pending.generation } : {}),
        };
        if (deferConfirmation) pendingConfirmation.push(handle);
        else await this.markUploaded(handle);
        uploaded++;
      } catch (error) {
        uploadError = error;
        failed.push({
          noteId: pending.noteId,
          attachment: pending.attachment,
          bytes: pending.bytes,
        });
        break;
      }
    }
    return {
      uploaded,
      failed,
      ...(uploadError !== undefined ? { error: uploadError } : {}),
      ...(deferConfirmation ? { pendingConfirmation } : {}),
    };
  }

  async confirmUploads(handles: readonly AttachmentUploadHandle[]): Promise<void> {
    for (const handle of handles) await this.markUploaded(handle);
  }

  async queueDelete(
    noteId: string,
    attachment: NoteAttachment,
    {
      retainBytes = false,
      purgeRetainedBytesOnComplete = false,
    }: {
      retainBytes?: boolean;
      purgeRetainedBytesOnComplete?: boolean;
    } = {},
  ): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachment.id);
      const operationToken = crypto.randomUUID();
      await this.transact(
        [
          key,
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingDeletesKey,
        ],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const deletes = transaction.get<QueuedAttachmentDelete[]>(
            this.pendingDeletesKey,
          ) ?? [];
          if (deletes.some(value =>
            value.noteId === noteId
            && value.attachment.id === attachment.id
            && value.claimToken)) {
            throw new Error('Attachment deletion is already in progress');
          }
          const queued: QueuedAttachmentDelete = {
            noteId,
            attachment: portableAttachment(attachment),
            operationToken,
            ...(stored?.uploadGeneration
              ? { uploadGeneration: stored.uploadGeneration }
              : {}),
            ...(stored?.writeEpoch !== undefined
              ? { writeEpoch: stored.writeEpoch }
              : {}),
            ...(retainBytes ? { retainBytes: true } : {}),
            ...(purgeRetainedBytesOnComplete
              ? { purgeRetainedBytesOnComplete: true }
              : {}),
          };
          transaction.set(this.pendingDeletesKey, [
            ...deletes.filter(value =>
              value.noteId !== noteId || value.attachment.id !== attachment.id),
            queued,
          ]);
          transaction.set(
            this.pendingUploadsKey,
            normalizePendingAttachmentKeys(
              transaction.get<unknown>(this.pendingUploadsKey),
            ).filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedUploadsKey,
            (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
              .filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            (
              transaction.get<StagedRemoteAttachmentKey[]>(
                this.stagedRemoteAttachmentsKey,
              ) ?? []
            ).filter(value => value.key !== key),
          );
          if (retainBytes && stored) {
            const retained: StoredAttachment = {
              ...stored,
              storageVersion: 2,
              retainedForUndo: true,
            };
            delete retained.needsUpload;
            delete retained.uploadGeneration;
            delete retained.remoteGeneration;
            transaction.set<StoredAttachment>(key, retained);
          } else {
            transaction.delete(key);
          }
        },
      );
    });
  }

  async pendingDeletes(): Promise<PendingAttachmentDelete[]> {
    return this.runExclusive(async () => (
      await this.pendingDeletesUnlocked()
    ).map(value => ({
      noteId: value.noteId,
      attachment: value.attachment,
      ...(value.retainBytes ? { retainBytes: true } : {}),
    })));
  }

  private async pendingDeletesUnlocked(): Promise<QueuedAttachmentDelete[]> {
    const values = await this.storage.get<QueuedAttachmentDelete[]>(this.pendingDeletesKey) ?? [];
    return values.map(value => ({
      noteId: value.noteId,
      attachment: portableAttachment(value.attachment),
      ...(value.retainBytes ? { retainBytes: true } : {}),
      ...(value.operationToken ? { operationToken: value.operationToken } : {}),
      ...(value.uploadGeneration ? { uploadGeneration: value.uploadGeneration } : {}),
      ...(typeof value.writeEpoch === 'number' && Number.isFinite(value.writeEpoch)
        ? { writeEpoch: value.writeEpoch }
        : {}),
      ...(value.purgeRetainedBytesOnComplete
        ? { purgeRetainedBytesOnComplete: true }
        : {}),
      ...(value.claimToken ? { claimToken: value.claimToken } : {}),
      ...(typeof value.claimedAt === 'number' ? { claimedAt: value.claimedAt } : {}),
    }));
  }

  async flushDeletes(remove: AttachmentDeleter, noteId?: string): Promise<AttachmentDeleteResult> {
    let deleted = 0;
    const failed: PendingAttachmentDelete[] = [];
    const pendingDeletes = await this.runExclusive(() => this.pendingDeletesUnlocked());
    for (const pending of pendingDeletes) {
      if (noteId && pending.noteId !== noteId) continue;
      const claimed = await this.claimDelete(pending);
      if (!claimed) continue;
      try {
        await remove(pending.noteId, pending.attachment);
        await this.completeDelete(claimed);
        deleted++;
      } catch {
        await this.releaseDeleteClaim(claimed);
        failed.push({
          noteId: pending.noteId,
          attachment: pending.attachment,
          ...(pending.retainBytes ? { retainBytes: true } : {}),
        });
      }
    }
    return { deleted, failed };
  }

  private async claimDelete(
    pending: QueuedAttachmentDelete,
    now = Date.now(),
  ): Promise<ClaimedAttachmentDelete | null> {
    return this.runExclusive(async () => {
      let claimed: ClaimedAttachmentDelete | null = null;
      const operationToken = pending.operationToken ?? crypto.randomUUID();
      const claimToken = crypto.randomUUID();
      await this.transact([this.pendingDeletesKey], transaction => {
        const deletes = transaction.get<QueuedAttachmentDelete[]>(
          this.pendingDeletesKey,
        ) ?? [];
        const index = deletes.findIndex(value =>
          value.noteId === pending.noteId
          && value.attachment.id === pending.attachment.id
          && (
            pending.operationToken
              ? value.operationToken === pending.operationToken
              : value.operationToken === undefined
          ));
        if (index < 0) return;
        const current = deletes[index];
        if (
          current.claimToken
          && typeof current.claimedAt === 'number'
          && now - current.claimedAt < ATTACHMENT_DELETE_CLAIM_TTL_MS
        ) return;
        claimed = {
          ...current,
          operationToken,
          claimToken,
          claimedAt: now,
        };
        deletes[index] = claimed;
        transaction.set(this.pendingDeletesKey, deletes);
      });
      return claimed;
    });
  }

  private async completeDelete(claimed: ClaimedAttachmentDelete): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(claimed.noteId, claimed.attachment.id);
      await this.transact([this.pendingDeletesKey, key], transaction => {
        const deletes = transaction.get<QueuedAttachmentDelete[]>(
          this.pendingDeletesKey,
        ) ?? [];
        const ownsClaim = deletes.some(value =>
          value.operationToken === claimed.operationToken
          && value.claimToken === claimed.claimToken);
        if (!ownsClaim) return;
        transaction.set(
          this.pendingDeletesKey,
          deletes.filter(value =>
            value.operationToken !== claimed.operationToken
            || value.claimToken !== claimed.claimToken),
        );
        if (!claimed.purgeRetainedBytesOnComplete) return;
        const stored = transaction.get<StoredAttachment>(key);
        if (
          stored?.retainedForUndo
          && stored.writeEpoch === claimed.writeEpoch
        ) {
          transaction.delete(key);
        }
      });
    });
  }

  private async releaseDeleteClaim(claimed: ClaimedAttachmentDelete): Promise<void> {
    await this.runExclusive(async () => {
      await this.transact([this.pendingDeletesKey], transaction => {
        const deletes = transaction.get<QueuedAttachmentDelete[]>(
          this.pendingDeletesKey,
        ) ?? [];
        transaction.set(
          this.pendingDeletesKey,
          deletes.map(value => {
            if (
              value.operationToken !== claimed.operationToken
              || value.claimToken !== claimed.claimToken
            ) return value;
            const released = { ...value };
            delete released.claimToken;
            delete released.claimedAt;
            return released;
          }),
        );
      });
    });
  }

  async cancelDelete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachmentId);
      await this.transact(
        [key, this.pendingDeletesKey, this.pendingUploadsKey],
        transaction => {
          const deletes = transaction.get<QueuedAttachmentDelete[]>(
            this.pendingDeletesKey,
          ) ?? [];
          if (deletes.some(value =>
            value.noteId === noteId
            && value.attachment.id === attachmentId
            && value.claimToken)) {
            throw new Error('Attachment deletion is already in progress');
          }
          const cancelled = deletes.find(value =>
            value.noteId === noteId && value.attachment.id === attachmentId);
          transaction.set(
            this.pendingDeletesKey,
            deletes
              .filter(value =>
                value.noteId !== noteId || value.attachment.id !== attachmentId),
          );
          const stored = transaction.get<StoredAttachment>(key);
          if (cancelled && stored?.retainedForUndo) {
            const available = { ...stored };
            delete available.retainedForUndo;
            if (cancelled.uploadGeneration) {
              available.storageVersion = 2;
              available.uploadGeneration = cancelled.uploadGeneration;
              available.needsUpload = true;
              transaction.set(
                this.pendingUploadsKey,
                [
                  ...normalizePendingAttachmentKeys(
                    transaction.get<unknown>(this.pendingUploadsKey),
                  ).filter(value => value.key !== key),
                  { key, generation: cancelled.uploadGeneration },
                ],
              );
            }
            transaction.set(key, available);
          }
        },
      );
    });
  }

  async delete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachmentId);
      await this.transact(
        [
          key,
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingDeletesKey,
        ],
        transaction => {
          const deletes = transaction.get<QueuedAttachmentDelete[]>(
            this.pendingDeletesKey,
          ) ?? [];
          if (deletes.some(value =>
            value.noteId === noteId
            && value.attachment.id === attachmentId
            && value.claimToken)) {
            throw new Error('Attachment deletion is already in progress');
          }
          transaction.delete(key);
          transaction.set(
            this.pendingUploadsKey,
            normalizePendingAttachmentKeys(
              transaction.get<unknown>(this.pendingUploadsKey),
            ).filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedUploadsKey,
            (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
              .filter(value => value.key !== key),
          );
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            (
              transaction.get<StagedRemoteAttachmentKey[]>(
                this.stagedRemoteAttachmentsKey,
              ) ?? []
            ).filter(value => value.key !== key),
          );
          transaction.set(
            this.pendingDeletesKey,
            deletes.filter(value =>
              value.noteId !== noteId || value.attachment.id !== attachmentId),
          );
        },
      );
    });
  }

  async applyRemoteDelete(noteId: string, attachmentId: string): Promise<void> {
    await this.runExclusive(async () => {
      const key = this.storageKey(noteId, attachmentId);
      await this.transact(
        [
          key,
          this.pendingUploadsKey,
          this.stagedUploadsKey,
          this.stagedRemoteAttachmentsKey,
          this.pendingDeletesKey,
        ],
        transaction => {
          const stored = transaction.get<StoredAttachment>(key);
          const pending = normalizePendingAttachmentKeys(
            transaction.get<unknown>(this.pendingUploadsKey),
          );
          const staged = transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
          const ownsPending = !!stored && pending.some(value =>
            value.key === key
            && recordNeedsUpload(value, stored)
            && pendingRecordMatches(value, stored));
          const ownsStage = !!stored && staged.some(value =>
            value.key === key && stagedRecordMatches(value, stored));
          const preserve = !!stored?.retainedForUndo || ownsPending || ownsStage;
          if (!preserve) {
            transaction.delete(key);
            transaction.set(
              this.pendingUploadsKey,
              pending.filter(value => value.key !== key),
            );
            transaction.set(
              this.stagedUploadsKey,
              staged.filter(value => value.key !== key),
            );
          }
          transaction.set(
            this.stagedRemoteAttachmentsKey,
            (
              transaction.get<StagedRemoteAttachmentKey[]>(
                this.stagedRemoteAttachmentsKey,
              ) ?? []
            ).filter(value => value.key !== key),
          );
          transaction.set(
            this.pendingDeletesKey,
            (transaction.get<QueuedAttachmentDelete[]>(this.pendingDeletesKey) ?? [])
              .filter(value =>
                value.noteId !== noteId
                || value.attachment.id !== attachmentId
                || value.claimToken),
          );
        },
      );
    });
  }

  async restoreForUndo(
    noteId: string,
    attachments: readonly NoteAttachment[],
  ): Promise<NoteAttachment[]> {
    return (await this.restoreForUndoWithHandles(noteId, attachments))
      .map(value => value.attachment);
  }

  async restoreForUndoWithHandles(
    noteId: string,
    attachments: readonly NoteAttachment[],
  ): Promise<RestoredAttachmentUpload[]> {
    return this.runExclusive(async () => {
      const restored: RestoredAttachmentUpload[] = [];

      for (const attachment of attachments) {
        const source = await this.storage.get<StoredAttachment>(
          this.storageKey(noteId, attachment.id),
        );
        if (!source?.retainedForUndo) continue;
        const fresh = portableAttachment({
          ...attachment,
          id: crypto.randomUUID(),
        });
        const freshKey = this.storageKey(noteId, fresh.id);
        const generation = crypto.randomUUID();
        await this.transact(
          [freshKey, this.pendingUploadsKey, this.stagedUploadsKey],
          transaction => {
            transaction.set(
              this.stagedUploadsKey,
              [
                ...(transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
                  .filter(value => value.key !== freshKey),
                { key: freshKey, stagedAt: Date.now(), generation },
              ],
            );
            transaction.set(
              this.pendingUploadsKey,
              normalizePendingAttachmentKeys(
                transaction.get<unknown>(this.pendingUploadsKey),
              ).filter(value => value.key !== freshKey),
            );
            transaction.set<StoredAttachment>(freshKey, {
              storageVersion: 2,
              noteId,
              attachment: fresh,
              bytes: new Uint8Array(source.bytes),
              uploadGeneration: generation,
              needsUpload: true,
            });
          },
        );
        restored.push({
          attachment: fresh,
          handle: {
            noteId,
            attachmentId: fresh.id,
            generation,
          },
        });
      }
      return restored;
    });
  }

  async purgeRetained(noteId: string, attachmentIds: readonly string[]): Promise<void> {
    await this.runExclusive(async () => {
      for (const attachmentId of attachmentIds) {
        const key = this.storageKey(noteId, attachmentId);
        await this.transact(
          [
            key,
            this.pendingUploadsKey,
            this.stagedUploadsKey,
            this.stagedRemoteAttachmentsKey,
          ],
          transaction => {
            const stored = transaction.get<StoredAttachment>(key);
            if (!stored?.retainedForUndo) return;
            transaction.delete(key);
            transaction.set(
              this.pendingUploadsKey,
              normalizePendingAttachmentKeys(
                transaction.get<unknown>(this.pendingUploadsKey),
              ).filter(value => value.key !== key),
            );
            transaction.set(
              this.stagedUploadsKey,
              (transaction.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [])
                .filter(value => value.key !== key),
            );
            transaction.set(
              this.stagedRemoteAttachmentsKey,
              (
                transaction.get<StagedRemoteAttachmentKey[]>(
                  this.stagedRemoteAttachmentsKey,
                ) ?? []
              ).filter(value => value.key !== key),
            );
          },
        );
      }
    });
  }

  private async pendingKeysUnlocked(): Promise<PendingAttachmentKey[]> {
    return normalizePendingAttachmentKeys(
      await this.storage.get<unknown>(this.pendingUploadsKey),
    );
  }

  private async stagedKeysUnlocked(): Promise<StagedAttachmentKey[]> {
    return await this.storage.get<StagedAttachmentKey[]>(this.stagedUploadsKey) ?? [];
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
        // URLs are local capabilities, not portable metadata. A URL is only
        // minted below after the matching bytes have been read from this
        // vault's attachment store.
        images.push(portableAttachment(attachment));
        continue;
      }
      const key = this.attachments.storageKey(note.id, attachment.id);
      let url = this.urls.get(key);
      if (!url) {
        url = this.objectUrls.create(new Blob(
          [stored.bytes],
          { type: safeAttachmentBlobType(stored.attachment) },
        ));
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
