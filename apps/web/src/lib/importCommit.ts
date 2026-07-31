import type { Note, NoteAttachment } from '@unkeep/core';
import type { StagedAttachmentHandle } from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';

export interface ImportCommitTarget {
  saveAttachment(imported: ImportedAttachment): Promise<StagedAttachmentHandle>;
  discardAttachment(handle: StagedAttachmentHandle): Promise<unknown>;
  saveNotesWithPendingSyncAtomically(notes: Note[]): Promise<unknown>;
}

function attachmentKey(noteId: string, attachmentId: string): string {
  return `${noteId}\0${attachmentId}`;
}

function sameMetadata(left: NoteAttachment, right: NoteAttachment): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mimeType === right.mimeType
    && left.size === right.size;
}

function validateImportManifest(notes: Note[], attachments: ImportedAttachment[]): void {
  const noteIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const expected = new Map<string, NoteAttachment>();
  for (const note of notes) {
    if (noteIds.has(note.id)) throw new Error(`Import contains duplicate note ID: ${note.id}`);
    noteIds.add(note.id);
    for (const attachment of note.images ?? []) {
      if (attachmentIds.has(attachment.id)) {
        throw new Error(`Import contains duplicate attachment ID: ${attachment.id}`);
      }
      attachmentIds.add(attachment.id);
      const key = attachmentKey(note.id, attachment.id);
      expected.set(key, attachment);
    }
  }

  const actual = new Set<string>();
  for (const imported of attachments) {
    const key = attachmentKey(imported.noteId, imported.attachment.id);
    const declared = expected.get(key);
    if (!declared) throw new Error(`Import contains orphaned attachment data: ${imported.attachment.name}`);
    if (actual.has(key)) throw new Error(`Import contains duplicate attachment data: ${imported.attachment.name}`);
    if (!sameMetadata(declared, imported.attachment)
      || imported.bytes.byteLength !== imported.attachment.size) {
      throw new Error(`Import attachment does not match its manifest: ${imported.attachment.name}`);
    }
    actual.add(key);
  }

  for (const [key, attachment] of expected) {
    if (!actual.has(key)) throw new Error(`Import is missing attachment data: ${attachment.name}`);
  }
}

/**
 * Stage attachment bytes first, then commit every note in one adapter
 * transaction. Any ordinary write failure removes all staged bytes, so the UI
 * can truthfully report either the complete batch or no imported notes.
 */
export async function commitImportBatch(
  notes: Note[],
  attachments: ImportedAttachment[],
  target: ImportCommitTarget,
): Promise<void> {
  validateImportManifest(notes, attachments);
  const staged: StagedAttachmentHandle[] = [];
  try {
    for (const imported of attachments) {
      // stageUpload is one storage transaction. A rejected call cannot leave
      // partially indexed bytes, and a successful call returns the exact
      // generation that owns its rollback.
      staged.push(await target.saveAttachment(imported));
    }
    await target.saveNotesWithPendingSyncAtomically(notes);
  } catch (error) {
    const cleanup = await Promise.allSettled(staged.map(handle =>
      target.discardAttachment(handle)));
    const cleanupErrors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Import failed and staged attachment cleanup was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
}
