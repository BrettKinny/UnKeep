import type { Note } from '@unkeep/core';
import type { ImportedAttachment } from './keepImporter';

export interface ResolvedImport {
  notes: Note[];
  attachments: ImportedAttachment[];
}

function sameAttachment(
  left: NonNullable<Note['images']>[number],
  right: NonNullable<Note['images']>[number],
): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mimeType === right.mimeType
    && left.size === right.size;
}

/** Preserve existing vault records by remapping colliding note and attachment IDs. */
export function resolveImportCollisions(
  notes: Note[],
  attachments: ImportedAttachment[],
  existingNoteIds: ReadonlySet<string>,
  createId: () => string,
  existingAttachmentIds: ReadonlySet<string> = new Set(),
): ResolvedImport {
  const resolvedNotes: Note[] = [];
  const resolvedAttachments: ImportedAttachment[] = [];
  const usedAttachmentIds = new Set(existingAttachmentIds);
  const createAttachmentId = (): string => {
    let id = createId();
    while (usedAttachmentIds.has(id)) id = createId();
    return id;
  };

  for (const sourceNote of notes) {
    const sourceAttachments = attachments.filter(value => value.noteId === sourceNote.id);
    const noteCollides = existingNoteIds.has(sourceNote.id);
    const noteId = noteCollides ? createId() : sourceNote.id;
    const assignments: Array<{
      source: NonNullable<Note['images']>[number];
      target: NonNullable<Note['images']>[number];
      claimed: boolean;
    }> = [];
    const images = sourceNote.images?.map(attachment => {
      const id = noteCollides || usedAttachmentIds.has(attachment.id)
        ? createAttachmentId()
        : attachment.id;
      usedAttachmentIds.add(id);
      const target = { ...attachment, id, url: undefined };
      assignments.push({ source: attachment, target, claimed: false });
      return target;
    });
    resolvedNotes.push({
      ...sourceNote,
      id: noteId,
      ...(noteCollides
        ? {
            title: sourceNote.title?.trim()
              ? `${sourceNote.title} (restored copy)`
              : 'Restored copy',
          }
        : {}),
      ...(images ? { images } : {}),
    });
    resolvedAttachments.push(...sourceAttachments.map(value => {
      const assignment = assignments.find(candidate =>
        !candidate.claimed && sameAttachment(candidate.source, value.attachment));
      if (assignment) assignment.claimed = true;
      return {
        noteId,
        attachment: assignment?.target ?? { ...value.attachment, url: undefined },
        bytes: value.bytes,
      };
    }));
  }

  return { notes: resolvedNotes, attachments: resolvedAttachments };
}
