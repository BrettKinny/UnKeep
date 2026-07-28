import type { Note } from '@unkeep/core';

/**
 * Preserve a stale local edit as a new note instead of silently choosing one
 * side. Attachment IDs are regenerated because attachment encryption binds
 * each blob to both its note ID and attachment ID.
 */
export function createConflictCopy(
  note: Note,
  createId: () => string,
  now: number,
): Note {
  return {
    ...note,
    id: createId(),
    title: note.title?.trim() ? `${note.title} (conflict copy)` : 'Conflict copy',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    deleted: undefined,
    ...(note.labels ? { labels: [...note.labels] } : {}),
    ...(note.checkboxes ? { checkboxes: note.checkboxes.map(item => ({ ...item })) } : {}),
    ...(note.images
      ? {
          images: note.images.map(attachment => ({
            id: createId(),
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
          })),
        }
      : {}),
  };
}
