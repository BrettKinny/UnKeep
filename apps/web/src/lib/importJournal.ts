import { isValidNoteId, type Note } from '@unkeep/core';
import type { ClientStorage } from '@unkeep/client';
import type {
  AttachmentStore,
  StagedAttachmentHandle,
} from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';

const JOURNAL_VERSION = 1;
export const IMPORT_JOURNAL_LEASE_MS = 60_000;

type ImportJournalPhase = 'staging' | 'commit-started';

interface ImportJournalAttachment {
  noteId: string;
  attachmentId: string;
  generation?: string;
}

interface ImportJournal {
  version: typeof JOURNAL_VERSION;
  noteIds: string[];
  attachments: ImportJournalAttachment[];
  ownerToken?: string;
  commitToken?: string;
  leaseExpiresAt?: number;
  phase?: ImportJournalPhase;
}

export interface ImportJournalClaim {
  ownerToken: string;
  commitToken: string;
  writeEpoch: number;
  handles: StagedAttachmentHandle[];
}

interface ImportJournalRecovery {
  storage: ClientStorage;
  journalKey: string;
  adapter: Pick<
    import('@unkeep/core/experimental').DurableNoteStorageAdapter,
    | 'listNotes'
    | 'queueNoteForSync'
    | 'importCommitState'
    | 'cancelImportCommit'
    | 'clearImportCommit'
  >;
  attachments: AttachmentStore;
  ownerToken?: string;
  now?: number;
}

function isJournal(value: unknown): value is ImportJournal {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImportJournal>;
  const attachments = candidate.attachments;
  const legacyOwner = candidate.ownerToken === undefined
    && candidate.commitToken === undefined
    && candidate.leaseExpiresAt === undefined
    && candidate.phase === undefined;
  const currentOwner = typeof candidate.ownerToken === 'string'
    && candidate.ownerToken.length > 0
    && typeof candidate.commitToken === 'string'
    && candidate.commitToken.length > 0
    && typeof candidate.leaseExpiresAt === 'number'
    && Number.isFinite(candidate.leaseExpiresAt)
    && (candidate.phase === 'staging' || candidate.phase === 'commit-started');
  return candidate.version === JOURNAL_VERSION
    && (legacyOwner || currentOwner)
    && Array.isArray(candidate.noteIds)
    && candidate.noteIds.every(id => typeof id === 'string' && isValidNoteId(id))
    && new Set(candidate.noteIds).size === candidate.noteIds.length
    && Array.isArray(attachments)
    && attachments.every(attachment => attachment
      && typeof attachment.noteId === 'string'
      && isValidNoteId(attachment.noteId)
      && candidate.noteIds!.includes(attachment.noteId)
      && typeof attachment.attachmentId === 'string'
      && isValidNoteId(attachment.attachmentId)
      && (attachment.generation === undefined
        || (typeof attachment.generation === 'string' && attachment.generation.length > 0)))
    && new Set(attachments.map(attachment => attachment.attachmentId)).size === attachments.length;
}

function requireTransactions(storage: ClientStorage): NonNullable<ClientStorage['transact']> {
  if (!storage.transact) {
    throw new Error('Import recovery requires atomic client storage transactions');
  }
  return storage.transact.bind(storage);
}

export async function beginImportJournal(
  storage: ClientStorage,
  journalKey: string,
  notes: readonly Note[],
  attachments: readonly ImportedAttachment[],
  now = Date.now(),
): Promise<ImportJournalClaim> {
  const ownerToken = crypto.randomUUID();
  const commitToken = crypto.randomUUID();
  const handles = attachments.map(imported => ({
    noteId: imported.noteId,
    attachmentId: imported.attachment.id,
    generation: crypto.randomUUID(),
  }));
  const journal: ImportJournal = {
    version: JOURNAL_VERSION,
    noteIds: notes.map(note => note.id),
    attachments: handles,
    ownerToken,
    commitToken,
    leaseExpiresAt: now + IMPORT_JOURNAL_LEASE_MS,
    phase: 'staging',
  };
  if (!isJournal(journal)) throw new Error('Cannot journal an invalid import batch');

  let claimed = false;
  await requireTransactions(storage)([journalKey], transaction => {
    if (transaction.get(journalKey) !== null) return;
    transaction.set(journalKey, journal);
    claimed = true;
  });
  if (!claimed) {
    throw new Error('An interrupted import must be recovered before starting another import');
  }
  return { ownerToken, commitToken, writeEpoch: now, handles };
}

async function updateOwnedJournal(
  storage: ClientStorage,
  journalKey: string,
  ownerToken: string,
  change: (journal: ImportJournal) => ImportJournal | null,
): Promise<boolean> {
  let owned = false;
  await requireTransactions(storage)([journalKey], transaction => {
    const journal = transaction.get<unknown>(journalKey);
    if (!isJournal(journal) || journal.ownerToken !== ownerToken) return;
    const next = change(journal);
    if (next) transaction.set(journalKey, next);
    else transaction.delete(journalKey);
    owned = true;
  });
  return owned;
}

export function renewImportJournal(
  storage: ClientStorage,
  journalKey: string,
  ownerToken: string,
  now = Date.now(),
): Promise<boolean> {
  return updateOwnedJournal(storage, journalKey, ownerToken, journal => ({
    ...journal,
    leaseExpiresAt: now + IMPORT_JOURNAL_LEASE_MS,
  }));
}

export function markImportJournalCommitStarted(
  storage: ClientStorage,
  journalKey: string,
  ownerToken: string,
  now = Date.now(),
): Promise<boolean> {
  return updateOwnedJournal(storage, journalKey, ownerToken, journal => ({
    ...journal,
    phase: 'commit-started',
    leaseExpiresAt: now + IMPORT_JOURNAL_LEASE_MS,
  }));
}

export function markImportJournalCommitFailed(
  storage: ClientStorage,
  journalKey: string,
  ownerToken: string,
  now = Date.now(),
): Promise<boolean> {
  return updateOwnedJournal(storage, journalKey, ownerToken, journal => ({
    ...journal,
    phase: 'staging',
    leaseExpiresAt: now + IMPORT_JOURNAL_LEASE_MS,
  }));
}

export function completeImportJournal(
  storage: ClientStorage,
  journalKey: string,
  ownerToken: string,
): Promise<boolean> {
  return updateOwnedJournal(storage, journalKey, ownerToken, () => null);
}

/**
 * A live owner excludes recovery. Expired staging work can be claimed and
 * rolled back exactly. Once note commit has started, zero visible notes are
 * indeterminate across the separate note/client databases, so recovery keeps
 * bytes and the journal rather than risking a late committed note without
 * attachments.
 */
export async function recoverImportJournal({
  storage,
  journalKey,
  adapter,
  attachments,
  ownerToken,
  now = Date.now(),
}: ImportJournalRecovery): Promise<'none' | 'active' | 'committed' | 'rolled-back'> {
  const recoveryToken = ownerToken ?? crypto.randomUUID();
  let journal: ImportJournal | null = null;
  let active = false;
  await requireTransactions(storage)([journalKey], transaction => {
    const value = transaction.get<unknown>(journalKey);
    if (value === null) return;
    if (!isJournal(value)) {
      throw new Error('The interrupted import journal is invalid');
    }
    const callerOwns = ownerToken !== undefined && value.ownerToken === ownerToken;
    if (
      !callerOwns
      && value.ownerToken !== undefined
      && value.leaseExpiresAt !== undefined
      && value.leaseExpiresAt > now
    ) {
      active = true;
      return;
    }
    journal = {
      ...value,
      ownerToken: recoveryToken,
      leaseExpiresAt: now + IMPORT_JOURNAL_LEASE_MS,
      phase: 'staging',
    };
    transaction.set(journalKey, journal);
  });
  if (active) return 'active';
  const claimedJournal = journal as ImportJournal | null;
  if (!claimedJournal) return 'none';

  const metadata = await adapter.listNotes();
  const storedIds = new Set(metadata.map(note => note.id));
  let committedCount = claimedJournal.noteIds.filter(id => storedIds.has(id)).length;
  let commitState = claimedJournal.commitToken
    ? await adapter.importCommitState(claimedJournal.commitToken)
    : 'none';
  if (commitState === 'pending' && claimedJournal.commitToken) {
    // This transaction serializes behind an already-running import commit.
    // It either observes "committed", or fences every later stale writer by
    // changing the note-DB receipt to "cancelled".
    commitState = await adapter.cancelImportCommit(claimedJournal.commitToken);
  }
  if (commitState === 'committed' && committedCount !== claimedJournal.noteIds.length) {
    const refreshed = new Set((await adapter.listNotes()).map(note => note.id));
    committedCount = claimedJournal.noteIds.filter(id => refreshed.has(id)).length;
  }
  if (committedCount !== 0 && committedCount !== claimedJournal.noteIds.length) {
    throw new Error('Interrupted import has a partial note commit; recovery stopped without deleting data');
  }
  if (
    commitState === 'committed'
    && committedCount !== claimedJournal.noteIds.length
  ) {
    throw new Error('Committed import receipt is missing one or more notes');
  }

  if (
    committedCount === claimedJournal.noteIds.length
    && claimedJournal.noteIds.length > 0
  ) {
    for (const imported of claimedJournal.attachments) {
      if (!await attachments.get(imported.noteId, imported.attachmentId)) {
        throw new Error(`Committed import is missing attachment bytes: ${imported.attachmentId}`);
      }
    }
    for (const id of claimedJournal.noteIds) await adapter.queueNoteForSync(id);
    if (claimedJournal.commitToken) {
      await adapter.clearImportCommit(claimedJournal.commitToken);
    }
    await updateOwnedJournal(
      storage,
      journalKey,
      claimedJournal.ownerToken ?? recoveryToken,
      () => null,
    );
    return 'committed';
  }

  if (commitState === 'committed') {
    throw new Error('Committed import receipt could not be reconciled');
  }

  for (const imported of claimedJournal.attachments) {
    if (imported.generation) {
      await attachments.discardStage({
        noteId: imported.noteId,
        attachmentId: imported.attachmentId,
        generation: imported.generation,
      });
    }
  }
  if (claimedJournal.commitToken) {
    await adapter.clearImportCommit(claimedJournal.commitToken);
  }
  await updateOwnedJournal(storage, journalKey, recoveryToken, () => null);
  return 'rolled-back';
}
