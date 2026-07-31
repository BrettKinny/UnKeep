import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { Note, NoteAttachment } from '@unkeep/core';
import { AttachmentStore } from './attachmentStorage';
import { MAX_ATTACHMENT_SIZE } from './attachments';
import {
  createVaultExport,
  isVaultExportFile,
  MAX_VAULT_EXPORT_ATTACHMENT_BYTES,
  MAX_VAULT_EXPORT_FILE_SIZE,
  MAX_VAULT_EXPORT_NOTES,
  parseVaultExport,
  readVaultExportFile,
} from './vaultExport';

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(parsed.notes).toEqual([{
      ...note,
      schemaVersion: 1,
      images: [{
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }],
    }]);
    expect(parsed.attachments).toEqual([{
      noteId: note.id,
      attachment: {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
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

  it('rejects an oversized backup file before reading text', async () => {
    const file = new File(['{}'], 'vault.json', { type: 'application/json' });
    const text = vi.fn(async () => { throw new Error('must not read'); });
    Object.defineProperty(file, 'size', { value: MAX_VAULT_EXPORT_FILE_SIZE + 1 });
    Object.defineProperty(file, 'text', { value: text });

    await expect(readVaultExportFile(file)).rejects.toThrow('256 MiB or smaller');
    expect(text).not.toHaveBeenCalled();
  });

  it('identifies a vault export from only its bounded header', async () => {
    const vault = new File([
      '\uFEFF \n { "format": "unkeep-vault", "version": 1, "notes": [] }',
    ], 'renamed.json');
    await expect(isVaultExportFile(vault)).resolves.toBe(true);

    const keep = new File([
      '{ "title": "ordinary Keep note", "textContent": "not a vault" }',
    ], 'note.json');
    await expect(isVaultExportFile(keep)).resolves.toBe(false);
  });

  it('rejects excessive collection counts and aggregate attachment bytes before decoding', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as {
      notes: Note[];
      attachments: Array<{ noteId: string; attachment: NoteAttachment; dataBase64: string }>;
    };

    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      notes: Array.from({ length: MAX_VAULT_EXPORT_NOTES + 1 }, () => valid.notes[0]),
    }))).toThrow('Invalid or unsupported UnKeep vault export');

    const declaredSize = Math.floor(MAX_VAULT_EXPORT_ATTACHMENT_BYTES / 4) + 1;
    const oversizedImages = Array.from({ length: 4 }, (_, index) => ({
      id: `large-${index}`,
      name: `large-${index}.bin`,
      mimeType: 'application/octet-stream',
      size: declaredSize,
    }));
    expect(() => parseVaultExport(JSON.stringify({
      ...valid,
      notes: [{ ...valid.notes[0], images: oversizedImages }],
      attachments: [],
    }))).toThrow('attachment data exceeds 96 MiB');
  });

  it('checks declared base64 length before allocating decoded bytes', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as {
      attachments: Array<{ dataBase64: string }>;
    };
    valid.attachments[0].dataBase64 = 'A'.repeat(1_000_000);
    const atob = vi.fn(() => { throw new Error('must not decode'); });
    vi.stubGlobal('atob', atob);

    expect(() => parseVaultExport(JSON.stringify(valid))).toThrow('Attachment size mismatch');
    expect(atob).not.toHaveBeenCalled();
  });

  it('returns only normalized note fields from an untrusted backup', async () => {
    const attachments = new AttachmentStore(new MemoryClientStorage());
    await attachments.save(note.id, attachment, new Uint8Array([0, 255, 1, 2, 128]));
    const valid = JSON.parse(await createVaultExport([note], attachments)) as {
      notes: Array<Note & { injected?: string }>;
    };
    valid.notes[0].injected = '<script>not portable</script>';

    expect(parseVaultExport(JSON.stringify(valid)).notes[0]).not.toHaveProperty('injected');
  });
});
