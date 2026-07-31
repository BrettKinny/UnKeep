import { describe, expect, it, vi } from 'vitest';
import { MemoryClientStorage } from '@unkeep/client';
import type { Note, NoteAttachment } from '@unkeep/core';
import { AttachmentStore } from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';
import {
  IMPORT_JOURNAL_LEASE_MS,
  beginImportJournal,
  markImportJournalCommitStarted,
  recoverImportJournal,
} from './importJournal';

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
) {
  const queueNoteForSync = vi.fn(async () => null);
  let importState: 'pending' | 'committed' | 'cancelled' | 'none' =
    storedNoteIds.length ? 'committed' : 'pending';
  return {
    queueNoteForSync,
    options: {
      storage,
      journalKey: 'journal',
      adapter: {
        listNotes: vi.fn(async () => storedNoteIds.map(id => ({ id, updatedAt: 1 }))),
        queueNoteForSync,
        importCommitState: vi.fn(async () => importState),
        cancelImportCommit: vi.fn(async () => {
          if (importState === 'pending') importState = 'cancelled';
          return importState;
        }),
        clearImportCommit: vi.fn(async () => { importState = 'none'; }),
      },
      attachments,
    },
  };
}

describe('durable import journal', () => {
  it('rolls back bytes and only the imported pending ID after termination before note commit', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(storage, 'journal', [note], [imported]);
    const [handle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: handle.generation,
    });
    const state = recovery(storage, attachments, []);

    await expect(recoverImportJournal({
      ...state.options,
      ownerToken: claim.ownerToken,
    })).resolves.toBe('rolled-back');
    await expect(attachments.get(note.id, image.id)).resolves.toBeNull();
    await expect(attachments.pendingUploads()).resolves.toEqual([]);
    expect(state.queueNoteForSync).not.toHaveBeenCalled();
    await expect(storage.get('journal')).resolves.toBeNull();
  });

  it('keeps a completely committed batch and reasserts its pending sync work', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(storage, 'journal', [note], [imported]);
    const [handle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: handle.generation,
    });
    const state = recovery(storage, attachments, [note.id]);

    await expect(recoverImportJournal({
      ...state.options,
      ownerToken: claim.ownerToken,
    })).resolves.toBe('committed');
    await expect(attachments.get(note.id, image.id)).resolves.toEqual({ attachment: image, bytes: imported.bytes });
    expect(state.queueNoteForSync).toHaveBeenCalledWith(note.id);
    await expect(storage.get('journal')).resolves.toBeNull();
  });

  it('stops without deleting anything if an allegedly atomic note batch is partial', async () => {
    const second: Note = { ...note, id: 'second-note' };
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(
      storage,
      'journal',
      [note, second],
      [imported],
    );
    const [handle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: handle.generation,
    });
    const state = recovery(storage, attachments, [note.id]);

    await expect(recoverImportJournal({
      ...state.options,
      ownerToken: claim.ownerToken,
    })).rejects.toThrow('partial note commit');
    await expect(attachments.get(note.id, image.id)).resolves.not.toBeNull();
    await expect(storage.get('journal')).resolves.not.toBeNull();
  });

  it('refuses to replace an unrecovered journal', async () => {
    const storage = new MemoryClientStorage();
    await beginImportJournal(storage, 'journal', [note], []);
    await expect(beginImportJournal(storage, 'journal', [{ ...note, id: 'other-note' }], []))
      .rejects.toThrow('must be recovered');
  });

  it('does not delete a same-key restage while rolling back a crashed import', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(
      storage,
      'journal',
      [note],
      [imported],
    );
    const [importHandle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: importHandle.generation,
    });
    const replacement = new Uint8Array([7, 8]);
    await attachments.stageUpload(note.id, image, replacement);

    await expect(recoverImportJournal(
      {
        ...recovery(storage, attachments, []).options,
        ownerToken: claim.ownerToken,
      },
    )).resolves.toBe('rolled-back');

    await expect(attachments.get(note.id, image.id)).resolves.toMatchObject({
      bytes: replacement,
    });
    await expect(attachments.stagedUploads()).resolves.toEqual([
      expect.objectContaining({ noteId: note.id, attachment: image, bytes: replacement }),
    ]);
  });

  it('claims an empty journal key atomically across tabs', async () => {
    const storage = new MemoryClientStorage();
    const attempts = await Promise.allSettled([
      beginImportJournal(storage, 'journal', [note], [imported]),
      beginImportJournal(storage, 'journal', [note], [imported]),
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('never rolls back bytes owned by a live importer', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(storage, 'journal', [note], [imported], 100);
    const [handle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: handle.generation,
    });

    await expect(recoverImportJournal({
      ...recovery(storage, attachments, []).options,
      now: 100 + IMPORT_JOURNAL_LEASE_MS - 1,
    })).resolves.toBe('active');
    await expect(attachments.get(note.id, image.id)).resolves.not.toBeNull();
    await expect(storage.get('journal')).resolves.not.toBeNull();
  });

  it('fences a stale commit-started writer before rolling its bytes back', async () => {
    const storage = new MemoryClientStorage();
    const attachments = new AttachmentStore(storage, 'vault');
    const claim = await beginImportJournal(storage, 'journal', [note], [imported], 100);
    const [handle] = claim.handles;
    await attachments.stageUpload(note.id, image, imported.bytes, {
      generation: handle.generation,
    });
    await markImportJournalCommitStarted(
      storage,
      'journal',
      claim.ownerToken,
      100,
    );

    await expect(recoverImportJournal({
      ...recovery(storage, attachments, []).options,
      now: 100 + IMPORT_JOURNAL_LEASE_MS + 1,
    })).resolves.toBe('rolled-back');
    await expect(attachments.get(note.id, image.id)).resolves.toBeNull();
    await expect(storage.get('journal')).resolves.toBeNull();
  });
});
