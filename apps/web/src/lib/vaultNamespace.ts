import type { Note, NoteAttachment } from '@unkeep/core';
import { LocalOnlyAdapter } from '@unkeep/core/experimental';
import type { ClientStorage } from '@unkeep/client';
import { AttachmentStore } from './attachmentStorage';

const STATE_PREFIX = 'unkeep-vault-state';
const LEGACY_MIGRATION_VERSION = 2;

interface VaultLocalAdapter {
  init(config: Record<string, unknown>): Promise<void>;
  saveNote(note: Note): Promise<void>;
  getAllNotes?(): Promise<Note[]>;
}

interface MigrationMarker {
  copied: boolean;
  version: number;
}

async function mergeAttachment(
  target: AttachmentStore,
  noteId: string,
  attachment: NoteAttachment,
  bytes: Uint8Array<ArrayBuffer>,
  pendingUpload: boolean,
): Promise<void> {
  const existing = await target.get(noteId, attachment.id);
  if (existing) {
    if (pendingUpload) {
      await target.save(noteId, existing.attachment, existing.bytes, { pendingUpload: true });
    }
    return;
  }
  await target.save(noteId, attachment, bytes, { pendingUpload });
}

async function copyLegacyAttachmentState(
  notes: readonly Note[],
  storage: ClientStorage,
  vaultNamespace: string,
): Promise<void> {
  const legacyAttachments = new AttachmentStore(storage);
  const scopedAttachments = new AttachmentStore(storage, vaultNamespace);
  const scopedDeleteKeys = new Set(
    (await scopedAttachments.pendingDeletes())
      .map(value => scopedAttachments.storageKey(value.noteId, value.attachment.id)),
  );
  const pendingDeletes = await legacyAttachments.pendingDeletes();
  const pendingUploads = await legacyAttachments.pendingUploads();
  const pendingUploadKeys = new Set(
    pendingUploads.map(value => legacyAttachments.storageKey(value.noteId, value.attachment.id)),
  );
  const copiedAttachmentKeys = new Set<string>();

  for (const note of notes) {
    for (const attachment of note.images ?? []) {
      const key = legacyAttachments.storageKey(note.id, attachment.id);
      if (scopedDeleteKeys.has(scopedAttachments.storageKey(note.id, attachment.id))) {
        copiedAttachmentKeys.add(key);
        continue;
      }
      const stored = await legacyAttachments.get(note.id, attachment.id);
      if (!stored) continue;
      await mergeAttachment(
        scopedAttachments,
        note.id,
        stored.attachment,
        stored.bytes,
        pendingUploadKeys.has(key),
      );
      copiedAttachmentKeys.add(key);
    }
  }

  for (const pending of pendingUploads) {
    const key = legacyAttachments.storageKey(pending.noteId, pending.attachment.id);
    if (copiedAttachmentKeys.has(key)) continue;
    if (scopedDeleteKeys.has(scopedAttachments.storageKey(pending.noteId, pending.attachment.id))) continue;
    await mergeAttachment(
      scopedAttachments,
      pending.noteId,
      pending.attachment,
      pending.bytes,
      true,
    );
  }

  // Apply deletes last so they retain precedence over an interrupted upload.
  for (const pending of pendingDeletes) {
    const key = scopedAttachments.storageKey(pending.noteId, pending.attachment.id);
    if (scopedDeleteKeys.has(key)) continue;
    if (pending.retainBytes) {
      const stored = await legacyAttachments.get(pending.noteId, pending.attachment.id);
      if (stored) {
        await mergeAttachment(
          scopedAttachments,
          pending.noteId,
          stored.attachment,
          stored.bytes,
          false,
        );
      }
    }
    await scopedAttachments.queueDelete(
      pending.noteId,
      pending.attachment,
      { retainBytes: pending.retainBytes ?? false },
    );
    scopedDeleteKeys.add(key);
  }
}

export function scopedClientStateKey(name: string, vaultNamespace: string): string {
  return `${STATE_PREFIX}:${encodeURIComponent(vaultNamespace)}:${name}`;
}

export function initializeVaultAdapter(
  vaultNamespace: string,
  migrateLegacy: boolean,
  storage: ClientStorage,
): Promise<LocalOnlyAdapter>;
export function initializeVaultAdapter<T extends VaultLocalAdapter>(
  vaultNamespace: string,
  migrateLegacy: boolean,
  storage: ClientStorage,
  factory: () => T,
): Promise<T>;
export async function initializeVaultAdapter<T extends VaultLocalAdapter = LocalOnlyAdapter>(
  vaultNamespace: string,
  migrateLegacy: boolean,
  storage: ClientStorage,
  factory: () => T = (() => new LocalOnlyAdapter() as unknown as T),
): Promise<T> {
  const adapter = factory();
  await adapter.init({ vaultNamespace });

  const markerKey = scopedClientStateKey('legacy-notes-migrated', vaultNamespace);
  const storedMarker = await storage.get<MigrationMarker | boolean>(markerKey);
  // The notes-only migration shipped with both boolean and versioned marker shapes.
  const marker: MigrationMarker | null = typeof storedMarker === 'boolean'
    ? { copied: storedMarker, version: 1 }
    : storedMarker;
  if (marker && marker.version >= LEGACY_MIGRATION_VERSION) return adapter;
  const shouldMigrateLegacy = marker ? marker.copied : migrateLegacy;

  if (shouldMigrateLegacy) {
    const legacy = factory();
    await legacy.init({});
    if (!legacy.getAllNotes) throw new Error('Legacy note migration requires getAllNotes support');
    const notes = await legacy.getAllNotes();
    if (!marker || marker.version < 1) {
      for (const note of notes) await adapter.saveNote(note);
    }
    await copyLegacyAttachmentState(notes, storage, vaultNamespace);
  }

  await storage.set<MigrationMarker>(markerKey, {
    copied: shouldMigrateLegacy,
    version: LEGACY_MIGRATION_VERSION,
  });
  return adapter;
}
