import type { Note } from '@unkeep/core';
import type { StorageAdapter } from '@unkeep/core/experimental';

type NoteTombstoneAdapter = Pick<StorageAdapter, 'listNotes' | 'deleteNote'> & {
  deleteNoteIfUnchanged?(id: string, expected: Note | null): Promise<void>;
};

/**
 * Apply a pulled note tombstone idempotently. Absence is already durable;
 * every other adapter failure must propagate so the pull is not acknowledged.
 */
export async function applyRemoteNoteTombstone(
  adapter: NoteTombstoneAdapter,
  noteId: string,
  expected?: Note | null,
): Promise<void> {
  if (expected !== undefined && adapter.deleteNoteIfUnchanged) {
    await adapter.deleteNoteIfUnchanged(noteId, expected);
    return;
  }
  const metadata = (await adapter.listNotes()).find(note => note.id === noteId);
  if (!metadata || metadata.deleted) return;
  await adapter.deleteNote(noteId);
}
