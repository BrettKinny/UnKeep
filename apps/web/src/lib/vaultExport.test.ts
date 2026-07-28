import { describe, expect, it } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { Note, NoteAttachment } from '@unkeep/core';
import { AttachmentStore } from './attachmentStorage';
import { MAX_ATTACHMENT_SIZE } from './attachments';
import { createVaultExport, parseVaultExport } from './vaultExport';

const attachment: NoteAttachment = {
  id: 'photo-one',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 5,
  url: 'blob:temporary-and-not-portable',
};

const note: Note = {
  id: 'note-one',
  title: 'Portable note',
  content: 'Unicode survives: ☃',
  createdAt: 1,
  updatedAt: 2,
  pinned: true,
  archived: false,
  labels: ['exported'],
  images: [attachment],
};

describe('vault export', () => {
  it('round-trips notes and byte-identical attachments without temporary URLs', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    const bytes = new Uint8Array([0, 255, 1, 2, 128]);
    await attachments.save(note.id, attachment, bytes);

    const serialized = await createVaultExport([note], attachments, () => 1_700_000_000_000);
    const parsed = parseVaultExport(serialized);

    expect(parsed.exportedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(parsed.notes).toEqual([{ ...note, images: [{ ...attachment, url: undefined }] }]);
    expect(parsed.attachments).toEqual([{
      noteId: note.id,
      attachment: { ...attachment, url: undefined },
      bytes,
    }]);
  });

  it('fails closed rather than producing an incomplete backup', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await expect(createVaultExport([note], attachments)).rejects.toThrow(
      'Cannot export 1 unavailable attachment',
    );
  });

  it('fails closed when stored attachment bytes or metadata do not match the note manifest', async () => {
    const wrongLength = new AttachmentStore(new MemoryClientStorage());
    await wrongLength.save(note.id, attachment, new Uint8Array([0, 1, 2, 3]));
    await expect(createVaultExport([note], wrongLength)).rejects.toThrow(
      'Cannot export invalid attachment: photo.png',
    );

    const wrongMetadata = new AttachmentStore(new MemoryClientStorage());
    await wrongMetadata.save(
      note.id,
      { ...attachment, name: 'different.png' },
      new Uint8Array([0, 1, 2, 3, 4]),
    );
    await expect(createVaultExport([note], wrongMetadata)).rejects.toThrow(
      'Cannot export invalid attachment: photo.png',
    );
  });

  it('fails closed instead of producing a duplicate-ID backup that its parser rejects', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    const secondNote: Note = { ...note, id: 'note-two', images: [{ ...attachment }] };
    const bytes = new Uint8Array([0, 255, 1, 2, 128]);
    await attachments.save(note.id, attachment, bytes);
    await attachments.save(secondNote.id, secondNote.images![0], bytes);

    await expect(createVaultExport([note, secondNote], attachments)).rejects.toThrow(
      'Cannot export duplicate attachment ID: photo-one',
    );
  });

  it('rejects backups whose attachment manifest is missing, orphaned, or mismatched', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as {
      notes: Note[];
      attachments: Array<{ noteId: string; attachment: NoteAttachment; dataBase64: string }>;
    };

    expect(() => parseVaultExport(JSON.stringify({ ...valid, attachments: [] })))
      .toThrow('missing attachment data');
    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      attachments: [...valid.attachments, {
        ...valid.attachments[0],
        attachment: { ...valid.attachments[0]!.attachment, id: 'orphan' },
      }],
    }))).toThrow('orphaned attachment data');
    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      attachments: [{
        ...valid.attachments[0],
        attachment: { ...valid.attachments[0]!.attachment, name: 'wrong.png' },
      }],
    }))).toThrow('attachment metadata mismatch');
  });

  it('rejects an attachment over the web client limit before restore can commit', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const backup = JSON.parse(await createVaultExport([note], attachments)) as {
      notes: Note[];
      attachments: Array<{ attachment: NoteAttachment }>;
    };
    backup.notes[0].images![0].size = MAX_ATTACHMENT_SIZE + 1;
    backup.attachments[0].attachment.size = MAX_ATTACHMENT_SIZE + 1;

    expect(() => parseVaultExport(JSON.stringify(backup))).toThrow(
      'photo.png is too large. Attachments must be 25 MB or smaller.',
    );
  });

  it('rejects duplicate note and globally duplicate attachment identifiers', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as {
      notes: Note[];
      attachments: Array<{ noteId: string; attachment: NoteAttachment; dataBase64: string }>;
    };

    expect(() => parseVaultExport(JSON.stringify({ ...valid, notes: [...valid.notes, valid.notes[0]] })))
      .toThrow('duplicate note ID');

    const second = {
      ...valid.notes[0]!,
      id: 'note-two',
      images: valid.notes[0]!.images?.map(image => ({ ...image })),
    };
    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      notes: [...valid.notes, second],
      attachments: [...valid.attachments, { ...valid.attachments[0], noteId: 'note-two' }],
    }))).toThrow('duplicate attachment ID');
  });

  it('rejects unsupported schemas and identifiers before importing anything', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as { notes: Note[] };

    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      notes: [{ ...valid.notes[0], schemaVersion: 999 }],
    }))).toThrow('newer than supported');
    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      notes: [{ ...valid.notes[0], id: '../unsafe' }],
    }))).toThrow('Invalid or unsupported UnKeep vault export');
  });
});
