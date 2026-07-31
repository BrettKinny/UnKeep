import type { StorageAdapter } from '@unkeep/core/experimental';

type NoteTombstoneAdapter = Pick<StorageAdapter, 'listNotes' | 'deleteNote'>;

/**
 * Apply a pulled note tombstone idempotently. Absence is already durable;
 * every other adapter failure must propagate so the pull is not acknowledged.
 */
export async function applyRemoteNoteTombstone(
  adapter: NoteTombstoneAdapter,
  noteId: string,
): Promise<void> {
  const metadata = (await adapter.listNotes()).find(note => note.id === noteId);
  if (!metadata || metadata.deleted) return;
  await adapter.deleteNote(noteId);
}
