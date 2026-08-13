import { describe, expect, it } from 'vitest';
import type { Note } from '@unkeep/core';
import type { ImportedAttachment } from './keepImporter';
import { resolveImportCollisions } from './importCollisions';

const note: Note = {
  id: 'existing-note',
  title: 'Backup note',
  content: 'body',
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  archived: false,
  images: [{ id: 'old-image', name: 'photo.png', mimeType: 'image/png', size: 2 }],
};
const attachment: ImportedAttachment = {
  noteId: note.id,
  attachment: note.images![0],
  bytes: new Uint8Array([1, 2]),
};

describe('resolveImportCollisions', () => {
  it('re-IDs notes and attachments that already exist without changing bytes', () => {
    const ids = ['new-note', 'new-image'];
    const result = resolveImportCollisions([note], [attachment], new Set([note.id]), () => ids.shift()!);

    expect(result.notes[0]).toMatchObject({
      id: 'new-note',
      title: 'Backup note (restored copy)',
      images: [{ id: 'new-image' }],
    });
    expect(result.attachments[0]).toMatchObject({
      noteId: 'new-note',
      attachment: { id: 'new-image' },
    });
    expect(result.attachments[0].bytes).toEqual(attachment.bytes);
  });

  it('preserves IDs when there is no local collision', () => {
    const result = resolveImportCollisions([note], [attachment], new Set(), () => 'unused');
    expect(result.notes[0].id).toBe(note.id);
    expect(result.attachments[0].attachment.id).toBe('old-image');
  });

  it('re-IDs an attachment that collides with an existing vault attachment even when its note is new', () => {
    const result = resolveImportCollisions(
      [note],
      [attachment],
      new Set(),
      () => 'new-image',
      new Set([attachment.attachment.id]),
    );

    expect(result.notes[0]).toMatchObject({
      id: note.id,
      title: note.title,
      images: [{ id: 'new-image' }],
    });
    expect(result.attachments[0]).toMatchObject({
      noteId: note.id,
      attachment: { id: 'new-image' },
    });
    expect(result.attachments[0].bytes).toEqual(attachment.bytes);
  });

  it('re-IDs later duplicate attachment IDs within one incoming batch', () => {
    const secondNote: Note = {
      ...note,
      id: 'second-note',
      images: [{ ...note.images![0] }],
    };
    const secondAttachment: ImportedAttachment = {
      noteId: secondNote.id,
      attachment: secondNote.images![0],
      bytes: new Uint8Array([3, 4]),
    };

    const result = resolveImportCollisions(
      [note, secondNote],
      [attachment, secondAttachment],
      new Set(),
      () => 'deduped-image',
    );

    expect(result.notes[0].images![0].id).toBe('old-image');
    expect(result.notes[1].images![0].id).toBe('deduped-image');
    expect(result.attachments).toMatchObject([
      { noteId: note.id, attachment: { id: 'old-image' } },
      { noteId: secondNote.id, attachment: { id: 'deduped-image' } },
    ]);
    expect(result.attachments[0].bytes).toEqual(attachment.bytes);
    expect(result.attachments[1].bytes).toEqual(secondAttachment.bytes);
  });

  it('does not replace a collision with another globally used attachment ID', () => {
    const ids = ['still-used', 'fresh-image'];
    const result = resolveImportCollisions(
      [note],
      [attachment],
      new Set(),
      () => ids.shift()!,
      new Set(['old-image', 'still-used']),
    );

    expect(result.notes[0].images![0].id).toBe('fresh-image');
    expect(result.attachments[0].attachment.id).toBe('fresh-image');
  });

  it('re-IDs duplicate attachments within the same incoming note without swapping their bytes', () => {
    const duplicateNote: Note = {
      ...note,
      images: [
        note.images![0],
        { ...note.images![0], name: 'second.png', size: 1 },
      ],
    };
    const duplicateAttachments: ImportedAttachment[] = [
      attachment,
      {
        noteId: duplicateNote.id,
        attachment: duplicateNote.images![1],
        bytes: new Uint8Array([9]),
      },
    ];

    const result = resolveImportCollisions(
      [duplicateNote],
      duplicateAttachments,
      new Set(),
      () => 'deduped-image',
    );

    expect(result.notes[0].images).toMatchObject([
      { id: 'old-image', name: 'photo.png' },
      { id: 'deduped-image', name: 'second.png' },
    ]);
    expect(result.attachments).toMatchObject([
      { attachment: { id: 'old-image', name: 'photo.png' } },
      { attachment: { id: 'deduped-image', name: 'second.png' } },
    ]);
    expect(result.attachments[0].bytes).toEqual(new Uint8Array([1, 2]));
    expect(result.attachments[1].bytes).toEqual(new Uint8Array([9]));
  });
});
