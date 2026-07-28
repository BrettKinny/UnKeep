import { describe, expect, it, vi } from 'vitest';
import type { Note } from '@unkeep/core';
import type { ImportedAttachment } from './keepImporter';
import { commitImportBatch, type ImportCommitTarget } from './importCommit';

const note: Note = {
  id: 'note-one',
  content: 'Imported',
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  archived: false,
  images: [{ id: 'image-one', name: 'one.png', mimeType: 'image/png', size: 2 }],
};

const attachment: ImportedAttachment = {
  noteId: note.id,
  attachment: note.images![0],
  bytes: new Uint8Array([1, 2]),
};

function target(overrides: Partial<ImportCommitTarget> = {}): ImportCommitTarget {
  return {
    saveAttachment: vi.fn(async () => {}),
    deleteAttachment: vi.fn(async () => {}),
    saveNotesAtomically: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('commitImportBatch', () => {
  it('stages complete attachment bytes before committing all notes once', async () => {
    const destination = target();
    await commitImportBatch([note], [attachment], destination);
    expect(destination.saveAttachment).toHaveBeenCalledWith(attachment);
    expect(destination.saveNotesAtomically).toHaveBeenCalledOnce();
    expect(destination.saveNotesAtomically).toHaveBeenCalledWith([note]);
    expect(destination.deleteAttachment).not.toHaveBeenCalled();
  });

  it('removes every staged attachment when the atomic note commit fails', async () => {
    const destination = target({ saveNotesAtomically: vi.fn(async () => { throw new Error('quota'); }) });
    await expect(commitImportBatch([note], [attachment], destination)).rejects.toThrow('quota');
    expect(destination.deleteAttachment).toHaveBeenCalledWith('note-one', 'image-one');
  });

  it('does not write anything when attachment bytes disagree with the note manifest', async () => {
    const destination = target();
    await expect(commitImportBatch(
      [note],
      [{ ...attachment, bytes: new Uint8Array([1]) }],
      destination,
    )).rejects.toThrow('does not match its manifest');
    expect(destination.saveAttachment).not.toHaveBeenCalled();
    expect(destination.saveNotesAtomically).not.toHaveBeenCalled();
  });

  it('rejects globally duplicate attachment IDs before writing anything', async () => {
    const secondNote: Note = {
      ...note,
      id: 'note-two',
      images: [{ ...note.images![0], name: 'copy.png' }],
    };
    const second: ImportedAttachment = {
      noteId: secondNote.id,
      attachment: secondNote.images![0],
      bytes: new Uint8Array([3, 4]),
    };
    const destination = target();

    await expect(commitImportBatch([note, secondNote], [attachment, second], destination))
      .rejects.toThrow('duplicate attachment ID: image-one');
    expect(destination.saveAttachment).not.toHaveBeenCalled();
    expect(destination.saveNotesAtomically).not.toHaveBeenCalled();
  });

  it('rolls back earlier attachment writes when a later staged write fails', async () => {
    const secondNote: Note = {
      ...note,
      id: 'note-two',
      images: [{ id: 'image-two', name: 'two.png', mimeType: 'image/png', size: 1 }],
    };
    const second: ImportedAttachment = {
      noteId: secondNote.id,
      attachment: secondNote.images![0],
      bytes: new Uint8Array([3]),
    };
    const saveAttachment = vi.fn(async (value: ImportedAttachment) => {
      if (value.noteId === secondNote.id) throw new Error('storage failed');
    });
    const destination = target({ saveAttachment });

    await expect(commitImportBatch([note, secondNote], [attachment, second], destination))
      .rejects.toThrow('storage failed');
    expect(destination.deleteAttachment).toHaveBeenCalledTimes(2);
    expect(destination.deleteAttachment).toHaveBeenCalledWith('note-one', 'image-one');
    expect(destination.deleteAttachment).toHaveBeenCalledWith('note-two', 'image-two');
    expect(destination.saveNotesAtomically).not.toHaveBeenCalled();
  });
});
