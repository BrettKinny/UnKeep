import { describe, expect, it, vi } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { Note, NoteAttachment } from '@unkeep/core';
import { AttachmentStore } from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';
import { beginImportJournal, recoverImportJournal } from './importJournal';

const note: Note = {
  id: 'import-note',
  content: 'body',
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  archived: false,
};
const image: NoteAttachment = {
  id: 'import-image',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 2,
};
const imported: ImportedAttachment = {
  noteId: note.id,
  attachment: image,
  bytes: new Uint8Array([1, 2]),
};

function recovery(
  storage: MemoryClientStorage,
  attachments: AttachmentStore,
  storedNoteIds: string[],
  pending = new Set<string>(['existing-pending', note.id]),
) {
  return {
    pending,
    options: {
      storage,
      journalKey: 'journal',
      adapter: { listNotes: vi.fn(async () => storedNoteIds.map(id => ({ id, updatedAt: 1 }))) },
      attachments,
      readPendingNoteIds: () => new Set(pending),
      writePendingNoteIds: (ids: Set<string>) => {
        pending.clear();
        for (const id of ids) pending.add(id);
      },
    },
  };
}

describe('durable import journal', () => {
  it('rolls back bytes and only the imported pending ID after termination before note commit', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    await beginImportJournal(storage, 'journal', [note], [imported]);
    await attachments.save(note.id, image, imported.bytes, { pendingUpload: true });
    const state = recovery(storage, attachments, []);

    await expect(recoverImportJournal(state.options)).resolves.toBe('rolled-back');
    await expect(attachments.get(note.id, image.id)).resolves.toBeNull();
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    expect(state.pending).toEqual(new Set(['existing-pending']));
    await expect(storage.get('journal')).resolves.toBeNull();
  });

  it('keeps a completely committed batch and reasserts its pending sync work', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    await beginImportJournal(storage, 'journal', [note], [imported]);
    await attachments.save(note.id, image, imported.bytes, { pendingUpload: true });
    const state = recovery(storage, attachments, [note.id], new Set(['existing-pending']));

    await expect(recoverImportJournal(state.options)).resolves.toBe('committed');
    await expect(attachments.get(note.id, image.id)).resolves.toEqual({ attachment: image, bytes: imported.bytes });
    expect(state.pending).toEqual(new Set(['existing-pending', note.id]));
    await expect(storage.get('journal')).resolves.toBeNull();
  });

  it('stops without deleting anything if an allegedly atomic note batch is partial', async () => {
    const second: Note = { ...note, id: 'second-note' };
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    await beginImportJournal(storage, 'journal', [note, second], [imported]);
    await attachments.save(note.id, image, imported.bytes, { pendingUpload: true });
    const state = recovery(storage, attachments, [note.id]);

    await expect(recoverImportJournal(state.options)).rejects.toThrow('partial note commit');
    await expect(attachments.get(note.id, image.id)).resolves.not.toBeNull();
    await expect(storage.get('journal')).resolves.not.toBeNull();
  });

  it('refuses to replace an unrecovered journal', async () => {
    const storage = new MemoryClientStorage();
    await beginImportJournal(storage, 'journal', [note], []);
    await expect(beginImportJournal(storage, 'journal', [{ ...note, id: 'other-note' }], []))
      .rejects.toThrow('must be recovered');
  });
});
