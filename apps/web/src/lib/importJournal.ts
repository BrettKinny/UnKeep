import { isValidNoteId, type Note } from '@unkeep/core';
import type { ClientStorage } from '@unkeep/client';
import type { AttachmentStore } from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';

const JOURNAL_VERSION = 1;

interface ImportJournalAttachment {
  noteId: string;
  attachmentId: string;
}

interface ImportJournal {
  version: typeof JOURNAL_VERSION;
  noteIds: string[];
  attachments: ImportJournalAttachment[];
}

interface ImportJournalRecovery {
  storage: ClientStorage;
  journalKey: string;
  adapter: Pick<import('@unkeep/core').StorageAdapter, 'listNotes'>;
  attachments: AttachmentStore;
  readPendingNoteIds(): Set<string>;
  writePendingNoteIds(ids: Set<string>): void;
}

function isJournal(value: unknown): value is ImportJournal {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImportJournal>;
  const attachments = candidate.attachments;
  return candidate.version === JOURNAL_VERSION
    && Array.isArray(candidate.noteIds)
    && candidate.noteIds.every(id => typeof id === 'string' && isValidNoteId(id))
    && new Set(candidate.noteIds).size === candidate.noteIds.length
    && Array.isArray(attachments)
    && attachments.every(attachment => attachment
      && typeof attachment.noteId === 'string'
      && isValidNoteId(attachment.noteId)
      && candidate.noteIds!.includes(attachment.noteId)
      && typeof attachment.attachmentId === 'string'
      && isValidNoteId(attachment.attachmentId))
    && new Set(attachments.map(attachment => attachment.attachmentId)).size === attachments.length;
}

export async function beginImportJournal(
  storage: ClientStorage,
  journalKey: string,
  notes: readonly Note[],
  attachments: readonly ImportedAttachment[],
): Promise<void> {
  if (await storage.get(journalKey) !== null) {
    throw new Error('An interrupted import must be recovered before starting another import');
  }
  const journal: ImportJournal = {
    version: JOURNAL_VERSION,
    noteIds: notes.map(note => note.id),
    attachments: attachments.map(imported => ({
      noteId: imported.noteId,
      attachmentId: imported.attachment.id,
    })),
  };
  if (!isJournal(journal)) throw new Error('Cannot journal an invalid import batch');
  await storage.set(journalKey, journal);
}

/**
 * Recover the only two states allowed by the atomic note transaction:
 * every imported note committed, or none did. The former keeps staged bytes
 * and reasserts sync work; the latter removes every attempted byte/queue entry.
 */
export async function recoverImportJournal({
  storage,
  journalKey,
  adapter,
  attachments,
  readPendingNoteIds,
  writePendingNoteIds,
}: ImportJournalRecovery): Promise<'none' | 'committed' | 'rolled-back'> {
  const value = await storage.get<unknown>(journalKey);
  if (value === null) return 'none';
  if (!isJournal(value)) throw new Error('The interrupted import journal is invalid');

  const metadata = await adapter.listNotes();
  const storedIds = new Set(metadata.map(note => note.id));
  const committedCount = value.noteIds.filter(id => storedIds.has(id)).length;
  if (committedCount !== 0 && committedCount !== value.noteIds.length) {
    throw new Error('Interrupted import has a partial note commit; recovery stopped without deleting data');
  }

  const pending = readPendingNoteIds();
  if (committedCount === value.noteIds.length && value.noteIds.length > 0) {
    for (const imported of value.attachments) {
      if (!await attachments.get(imported.noteId, imported.attachmentId)) {
        throw new Error(`Committed import is missing attachment bytes: ${imported.attachmentId}`);
      }
    }
    for (const id of value.noteIds) pending.add(id);
    writePendingNoteIds(pending);
    await storage.delete(journalKey);
    return 'committed';
  }

  for (const imported of value.attachments) {
    await attachments.delete(imported.noteId, imported.attachmentId);
  }
  for (const id of value.noteIds) pending.delete(id);
  writePendingNoteIds(pending);
  await storage.delete(journalKey);
  return 'rolled-back';
}
