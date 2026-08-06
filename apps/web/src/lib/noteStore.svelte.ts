import { nanoid } from 'nanoid';
import type { Note, NoteAttachment, NoteColor, ChecklistItem } from '@unkeep/core';
import { normalizeNoteRecord } from '@unkeep/core';
import type {
  DurableNoteStorageAdapter,
  PendingNoteSync,
  StorageAdapter,
} from '@unkeep/core/experimental';
import { NOTE_CREATION_CLAIM_TTL_MS } from '@unkeep/core/experimental';
import {
  EncryptedSync,
  PendingCompoundCompletionError,
  PendingMutationCredentialMismatchError,
  PendingMutationRebaseRequiresPullError,
  RecordConflictError,
  type CompoundCommitHandle,
  type RelaySession,
} from '@unkeep/client';
import { toastStore } from './toast.svelte';
import { clientStorage } from './clientStorage';
import { attachmentSizeError } from './attachments';
import {
  AttachmentStore,
  AttachmentUrlCache,
  type AttachmentUploadHandle,
  type RemoteAttachmentHandle,
  type StagedAttachmentHandle,
} from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';
import type { QuickSendDraft } from './quickSend';
import { createVaultExport } from './vaultExport';
import { createConflictCopy } from './conflictCopy';
import { resolveImportCollisions } from './importCollisions';
import { commitImportBatch } from './importCommit';
import {
  IMPORT_JOURNAL_LEASE_MS,
  beginImportJournal,
  completeImportJournal,
  markImportJournalCommitFailed,
  markImportJournalCommitStarted,
  recoverImportJournal,
  renewImportJournal,
} from './importJournal';
import { initializeVaultAdapter, scopedClientStateKey } from './vaultNamespace';
import { useForCurrentVault, VaultTaskCoordinator, type VaultTaskContext } from './vaultTaskCoordinator';
import { applyRemoteNoteTombstone } from './remoteTombstone';
import { DebouncedWorkQueue } from './debouncedWorkQueue';

// Debounce timer for auto-save
const SAVE_DEBOUNCE_MS = 500;
const DELETE_UNDO_MS = 3000;
const saveQueue = new DebouncedWorkQueue<Note>(SAVE_DEBOUNCE_MS);
const PENDING_SYNC_KEY = 'unkeep-pending-note-ids';
let pendingSyncKey = PENDING_SYNC_KEY;
let importJournalKey = 'unkeep-pending-import';
let attachmentStore = new AttachmentStore(clientStorage);
let attachmentUrls = new AttachmentUrlCache(attachmentStore);
const DELETE_UNDO_TOKEN = Symbol('delete-undo-token');
export interface DeleteUndoToken {
  readonly [DELETE_UNDO_TOKEN]: true;
}

function pendingIds(key = pendingSyncKey): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]); }
  catch { return new Set(); }
}

function durableNoteAdapter(adapter: StorageAdapter): DurableNoteStorageAdapter {
  const candidate = adapter as Partial<DurableNoteStorageAdapter>;
  if (
    typeof candidate.saveNoteWithPendingSync !== 'function'
    || typeof candidate.saveNotesWithPendingSyncAtomically !== 'function'
    || typeof candidate.prepareImportCommit !== 'function'
    || typeof candidate.importCommitState !== 'function'
    || typeof candidate.cancelImportCommit !== 'function'
    || typeof candidate.clearImportCommit !== 'function'
    || typeof candidate.createNoteWithPendingSyncIfAbsent !== 'function'
    || typeof candidate.claimNoteCreation !== 'function'
    || typeof candidate.renewNoteCreationClaim !== 'function'
    || typeof candidate.finalizeClaimedNote !== 'function'
    || typeof candidate.releaseNoteCreationClaim !== 'function'
    || typeof candidate.queueNoteForSync !== 'function'
    || typeof candidate.listPendingNoteSync !== 'function'
    || typeof candidate.completePendingNoteSync !== 'function'
  ) {
    throw new Error('The active storage adapter does not support durable note synchronization');
  }
  return candidate as DurableNoteStorageAdapter;
}

function isRecordConflict(error: unknown): boolean {
  if (error instanceof RecordConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 && candidate.code === 'record_conflict';
}

function isPreservableRemoteConflict(error: unknown): boolean {
  if (isRecordConflict(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 && candidate.code === 'attachment_id_unavailable';
}

function isPendingCredentialMismatch(error: unknown): boolean {
  return error instanceof PendingMutationCredentialMismatchError
    || (
      !!error
      && typeof error === 'object'
      && (error as { name?: unknown }).name === 'PendingMutationCredentialMismatchError'
    );
}

function isRebaseRequiresPull(error: unknown): boolean {
  return error instanceof PendingMutationRebaseRequiresPullError
    || (
      !!error
      && typeof error === 'object'
      && (error as { name?: unknown }).name
        === 'PendingMutationRebaseRequiresPullError'
    );
}

function isForeignCompoundRebuildRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && typeof candidate.code === 'string'
    && new Set([
      'attachment_id_unavailable',
      'attachment_stage_conflict',
      'attachment_stage_missing',
      'mutation_conflict',
      'record_conflict',
    ]).has(candidate.code);
}

function attachmentIdUnavailable(): Error & { status: number; code: string } {
  return Object.assign(new Error('attachment_id_unavailable'), {
    name: 'RelayHttpError',
    status: 409,
    code: 'attachment_id_unavailable',
  });
}

async function pushWithCredentialHandoff(
  sync: EncryptedSync,
  note: Note,
): Promise<number> {
  try {
    return await sync.push(note);
  } catch (error) {
    if (!isPendingCredentialMismatch(error)) throw error;
    try {
      await sync.resumePendingMutationAfterCredentialChange('note', note.id);
    } catch (handoffError) {
      if (!isRecordConflict(handoffError)) throw handoffError;
      try {
        return await sync.rebasePendingNoteAfterCredentialChange(note);
      } catch (rebaseError) {
        if (
          !isRebaseRequiresPull(rebaseError)
          || !await sync.abandonPendingMutationAfterCredentialChange(
            'note',
            note.id,
          )
        ) throw rebaseError;
        // The durable browser outbox still owns the full local snapshot.
        // Surface the original conflict so the normal path preserves it as a
        // separate note before clearing the original ID and pulling.
        throw handoffError;
      }
    }
    return sync.push(note);
  }
}

async function receivedNoteId(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(idempotencyKey),
  );
  const hex = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  return `shared_${hex}`;
}

async function migrateLegacyPendingNoteIds(
  adapter: StorageAdapter,
  key: string,
): Promise<void> {
  const ids = pendingIds(key);
  if (ids.size > 0) {
    const durable = durableNoteAdapter(adapter);
    for (const id of ids) await durable.queueNoteForSync(id);
  }
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // The durable records are already committed. Retaining the legacy marker
    // merely causes an idempotent migration retry on the next startup.
    console.warn('Could not remove migrated pending-note marker:', error);
  }
}

interface VaultLocalResources {
  attachments: AttachmentStore;
  urls: AttachmentUrlCache;
  pendingKey: string;
  importJournalKey: string;
}

function currentVaultResources(): VaultLocalResources {
  return {
    attachments: attachmentStore,
    urls: attachmentUrls,
    pendingKey: pendingSyncKey,
    importJournalKey,
  };
}

function configureVaultNamespace(vaultNamespace: string, migrateLegacy: boolean): VaultLocalResources {
  attachmentUrls.releaseAll();
  attachmentStore = new AttachmentStore(clientStorage, vaultNamespace);
  attachmentUrls = new AttachmentUrlCache(attachmentStore);
  pendingSyncKey = scopedClientStateKey('pending-note-ids', vaultNamespace);
  importJournalKey = scopedClientStateKey('pending-import', vaultNamespace);
  if (localStorage.getItem(pendingSyncKey) === null) {
    const legacy = migrateLegacy ? localStorage.getItem(PENDING_SYNC_KEY) : null;
    localStorage.setItem(pendingSyncKey, legacy ?? '[]');
  }
  return currentVaultResources();
}

interface VaultMutationTarget {
  context: VaultTaskContext;
  adapter: StorageAdapter | null;
  sync: EncryptedSync | null;
  attachments: AttachmentStore;
  urls: AttachmentUrlCache;
}

interface PendingDeleteUndo {
  note: Note;
  target: VaultMutationTarget;
  attachmentIds: string[];
  expiresAt: number;
  state: 'active' | 'consuming' | 'consumed' | 'expired';
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingDeleteUndos = new WeakMap<DeleteUndoToken, PendingDeleteUndo>();

export class NoteStore {
  notes = $state<Note[]>([]);
  searchQuery = $state('');
  adapter: StorageAdapter | null = $state(null);
  loading = $state(true);
  syncStatus = $state<'synced' | 'syncing' | 'offline' | 'error'>('synced');
  syncQuarantineCount = $state(0);
  private encryptedSync: EncryptedSync | null = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private readonly syncCoordinator = new VaultTaskCoordinator();
  private readonly preservedConflicts = new Set<string>();
  private readonly localEditGenerations = new Map<string, number>();
  private readonly remoteNoteMutationTails = new Map<string, Promise<void>>();
  private importInProgress = false;
  private lifecycleListening = false;
  private readonly wakeSync = () => void this.sync();
  private readonly syncWhenVisible = () => {
    if (document.visibilityState === 'visible') void this.sync();
    else void this.flushPendingSaves();
  };
  private readonly flushOnPageHide = () => void this.flushPendingSaves();

  constructor(
    private readonly readVaultResources: () => VaultLocalResources = currentVaultResources,
  ) {}

  filteredNotes = $derived.by(() => {
    let result = this.notes.filter(n => !n.deleted);
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(n => {
        if (n.title?.toLowerCase().includes(q)) return true;
        if (n.content.toLowerCase().includes(q)) return true;
        if (n.checkboxes?.some(c => c.text.toLowerCase().includes(q))) return true;
        if (n.labels?.some(label => label.toLowerCase().includes(q))) return true;
        return false;
      });
    }
    return result;
  });

  activeNotes = $derived(
    this.filteredNotes
      .filter(n => n.trashedAt === undefined)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      })
  );

  trashedNotes = $derived(
    this.filteredNotes
      .filter(n => n.trashedAt !== undefined)
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0) || b.updatedAt - a.updatedAt)
  );

  pinnedNotes = $derived(this.activeNotes.filter(n => n.pinned));
  unpinnedNotes = $derived(this.activeNotes.filter(n => !n.pinned));

  async init(vaultNamespace: string, migrateLegacy = false) {
    this.loading = true;
    this.syncCoordinator.reset();
    const context = this.syncCoordinator.capture();
    this.syncQuarantineCount = 0;
    this.adapter = null;
    this.preservedConflicts.clear();
    this.registerLocalLifecycle();
    const resources = configureVaultNamespace(vaultNamespace, migrateLegacy);
    try {
      const adapter = await initializeVaultAdapter(
        vaultNamespace,
        migrateLegacy,
        clientStorage,
      );
      if (!context.isCurrent()) return;
      await recoverImportJournal({
        storage: clientStorage,
        journalKey: resources.importJournalKey,
        adapter: durableNoteAdapter(adapter),
        attachments: resources.attachments,
      });
      if (!context.isCurrent()) return;
      await migrateLegacyPendingNoteIds(adapter, resources.pendingKey);
      if (!context.isCurrent()) return;
      const notes = await this.loadNotesFrom(adapter, resources.urls);
      if (!context.isCurrent()) {
        resources.urls.releaseAll();
        return;
      }
      this.adapter = adapter;
      this.notes = notes;
    } catch (e) {
      if (!context.isCurrent()) return;
      console.error('Failed to initialize store:', e);
      this.syncStatus = 'error';
      throw e;
    } finally {
      if (context.isCurrent()) this.loading = false;
    }
  }

  private registerLocalLifecycle(): void {
    if (this.lifecycleListening || typeof window === 'undefined') return;
    document.addEventListener('visibilitychange', this.syncWhenVisible);
    window.addEventListener('pagehide', this.flushOnPageHide);
    this.lifecycleListening = true;
  }

  async enableEncryptedSync(session: RelaySession, masterKey: Uint8Array<ArrayBuffer>) {
    this.syncCoordinator.reset();
    const context = this.syncCoordinator.capture();
    this.unsubscribeRealtime?.();
    window.removeEventListener('online', this.wakeSync);
    document.removeEventListener('visibilitychange', this.syncWhenVisible);
    this.syncQuarantineCount = 0;
    const encryptedSync = new EncryptedSync(session, masterKey, clientStorage);
    this.encryptedSync = encryptedSync;
    try {
      await this.refreshSyncQuarantine(encryptedSync, context);
    } catch {
      if (context.isCurrent() && this.encryptedSync === encryptedSync) {
        this.syncStatus = 'error';
      }
    }
    if (!context.isCurrent() || this.encryptedSync !== encryptedSync) return;
    const timer = window.setInterval(() => void this.sync(), 15_000);
    this.unsubscribeRealtime = () => window.clearInterval(timer);
    window.addEventListener('online', this.wakeSync);
    document.addEventListener('visibilitychange', this.syncWhenVisible);
    // Local data is usable immediately. The initial network pass is deliberately
    // background work so a cold start cannot be held hostage by relay reachability.
    void this.sync();
  }

  async disableEncryptedSync(): Promise<void> {
    // Commit debounced edits locally and durably queue them while the old vault
    // resources are still available. Disconnecting must never turn an edit
    // into an untracked local-only write.
    await this.flushPendingSaves({ deferRemote: true, requireDurable: true });
    this.syncCoordinator.reset();
    this.preservedConflicts.clear();
    this.unsubscribeRealtime?.();
    window.removeEventListener('online', this.wakeSync);
    this.unsubscribeRealtime = null;
    this.encryptedSync = null;
    this.syncQuarantineCount = 0;
    this.adapter = null;
    attachmentUrls.releaseAll();
    this.notes = [];
  }

  async initWithAdapter(adapter: StorageAdapter, config: Record<string, unknown>) {
    this.loading = true;
    this.syncCoordinator.reset();
    const context = this.syncCoordinator.capture();
    this.syncQuarantineCount = 0;
    this.adapter = null;
    this.preservedConflicts.clear();
    const resources = this.readVaultResources();
    try {
      await adapter.init(config);
      if (!context.isCurrent()) return;
      await migrateLegacyPendingNoteIds(adapter, resources.pendingKey);
      if (!context.isCurrent()) return;
      const notes = await this.loadNotesFrom(adapter, resources.urls);
      if (!context.isCurrent()) return;
      this.adapter = adapter;
      this.notes = notes;
    } catch (e) {
      if (!context.isCurrent()) return;
      console.error('Failed to initialize store:', e);
      this.syncStatus = 'error';
      throw e;
    } finally {
      if (context.isCurrent()) this.loading = false;
    }
  }

  private async loadNotesFrom(adapter: StorageAdapter, urls: AttachmentUrlCache): Promise<Note[]> {
    let notes: Note[];
    if (adapter.getAllNotes) {
      const all = await adapter.getAllNotes();
      notes = all.filter(n => !n.deleted);
    } else {
      const metaList = await adapter.listNotes();
      const loaded: Note[] = [];
      for (const meta of metaList) {
        if (!meta.deleted) {
          try {
            const note = await adapter.getNote(meta.id);
            loaded.push(note);
          } catch {
            // Skip notes that fail to load
          }
        }
      }
      notes = loaded;
    }
    urls.releaseAll();
    return Promise.all(notes.map(note => urls.hydrate(note)));
  }

  createNote(content: string = '', title: string = ''): Note {
    const note: Note = {
      id: nanoid(),
      title,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      archived: false,
    };
    this.notes.push(note);
    void this.persistNote(note);
    return note;
  }

  async createReceivedNote(
    draft: QuickSendDraft,
    options: { idempotencyKey?: string; createdAt?: number } = {},
  ): Promise<Note> {
    const target = this.captureMutationTarget();
    if (!target.adapter) throw new Error('Unlock your vault before saving this note');
    const now = typeof options.createdAt === 'number' && Number.isFinite(options.createdAt)
      ? options.createdAt
      : Date.now();
    const note: Note = {
      id: options.idempotencyKey
        ? await receivedNoteId(options.idempotencyKey)
        : nanoid(),
      ...(draft.title ? { title: draft.title } : {}),
      content: draft.content,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      ...(draft.checkboxes?.length
        ? { checkboxes: draft.checkboxes.map(item => ({ ...item })) }
        : {}),
      ...(draft.labels?.length ? { labels: [...draft.labels] } : {}),
      ...(draft.color ? { color: draft.color } : {}),
    };
    let storedNote = note;
    if (options.idempotencyKey) {
      const durable = durableNoteAdapter(target.adapter);
      let claim: { token: string; claimedAt: number } | null = null;
      while (true) {
        const result = await durable.claimNoteCreation(note.id);
        if (result.status === 'existing') {
          storedNote = result.note;
          break;
        }
        if (result.status === 'claimed') {
          claim = result.claim;
          break;
        }
        if (!target.context.isCurrent()) {
          throw new Error('The active vault changed while receiving a shared note');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (claim) {
        const stagedAttachments: Array<{
          attachment: NoteAttachment;
          handle: StagedAttachmentHandle;
        }> = [];
        let claimOwned = true;
        const heartbeat = setInterval(() => {
          void durable.renewNoteCreationClaim(note.id, claim!.token)
            .then(owned => { claimOwned = claimOwned && owned; })
            .catch(() => { claimOwned = false; });
        }, Math.floor(NOTE_CREATION_CLAIM_TTL_MS / 3));
        try {
          for (const [index, incoming] of (draft.attachments ?? []).entries()) {
            claimOwned = claimOwned
              && await durable.renewNoteCreationClaim(note.id, claim.token);
            if (!claimOwned) throw new Error('Received-note creation claim was lost');
            const attachment: NoteAttachment = {
              // Stable IDs let a retry after a browser stop overwrite the
              // same staged bytes instead of accumulating orphan records.
              id: `${note.id}_attachment_${index}`,
              name: incoming.name,
              mimeType: incoming.mimeType || 'application/octet-stream',
              size: incoming.size,
            };
            const handle = await target.attachments.stageUpload(
              note.id,
              attachment,
              incoming.bytes,
              { writeEpoch: claim.claimedAt },
            );
            stagedAttachments.push({ attachment, handle });
          }
          claimOwned = claimOwned
            && await durable.renewNoteCreationClaim(note.id, claim.token);
          if (!claimOwned) throw new Error('Received-note creation claim was lost');
          note.images = stagedAttachments.length
            ? stagedAttachments.map(value => value.attachment)
            : undefined;
          const result = await durable.finalizeClaimedNote(
            this.portableNote(note),
            claim.token,
          );
          storedNote = result.note;
          if (result.created) await this.pushPendingNote(result.pending, target);
        } catch (error) {
          let stillOwned = false;
          try {
            stillOwned = claimOwned
              && await durable.renewNoteCreationClaim(note.id, claim.token);
          } catch {
            // Ownership is uncertain. Keep the deterministic staged bytes for
            // the durable claim/retry path instead of risking winner data.
          }
          if (stillOwned) {
            const cleanup = await Promise.allSettled(stagedAttachments.map(value =>
              target.attachments.discardStage(value.handle)));
            if (cleanup.every(result => result.status === 'fulfilled')) {
              await durable.releaseNoteCreationClaim(note.id, claim.token);
            }
          }
          throw error;
        } finally {
          clearInterval(heartbeat);
        }
      }
    } else {
      const storedAttachments: Array<{
        attachment: NoteAttachment;
        handle: StagedAttachmentHandle;
      }> = [];
      try {
        for (const incoming of draft.attachments ?? []) {
          const attachment: NoteAttachment = {
            id: nanoid(),
            name: incoming.name,
            mimeType: incoming.mimeType || 'application/octet-stream',
            size: incoming.size,
          };
          const handle = await target.attachments.stageUpload(
            note.id,
            attachment,
            incoming.bytes,
          );
          storedAttachments.push({ attachment, handle });
        }
        note.images = storedAttachments.length
          ? storedAttachments.map(value => value.attachment)
          : undefined;
      } catch (error) {
        for (const value of storedAttachments) {
          await target.attachments.discardStage(value.handle);
        }
        throw error;
      }
      if (!await this.persistNote(note, {}, target)) {
        for (const value of storedAttachments) {
          await target.attachments.discardStage(value.handle);
        }
        throw new Error('The received note could not be saved locally');
      }
    }
    if (!target.context.isCurrent() || storedNote.deleted) return storedNote;
    const hydrated = await target.urls.hydrate(storedNote);
    if (!target.context.isCurrent()) {
      for (const attachment of storedNote.images ?? []) {
        target.urls.release(storedNote.id, attachment.id);
      }
      return storedNote;
    }
    const existing = this.notes.find(value => value.id === hydrated.id);
    if (existing) Object.assign(existing, hydrated);
    else this.notes.push(hydrated);
    return hydrated;
  }

  async prepareQuickSend(note: Note): Promise<QuickSendDraft> {
    const target = this.captureMutationTarget();
    const attachments = [];
    for (const attachment of note.images ?? []) {
      const stored = await target.attachments.get(note.id, attachment.id);
      if (!target.context.isCurrent()) {
        throw new Error('The active vault changed while preparing Quick Send');
      }
      if (!stored) throw new Error(`Attachment is unavailable on this device: ${attachment.name}`);
      attachments.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        bytes: stored.bytes,
      });
    }
    return {
      title: note.title,
      content: note.content,
      checkboxes: note.checkboxes?.map(item => ({ ...item })),
      labels: note.labels ? [...note.labels] : undefined,
      color: note.color,
      attachments: attachments.length ? attachments : undefined,
    };
  }

  updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt'>>) {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return;
    const note = this.notes[idx];
    Object.assign(note, updates, { updatedAt: Date.now() });
    this.debouncedSave(note);
  }

  private debouncedSave(note: Note) {
    this.markLocalEdit(note.id);
    const snapshot = this.portableNote(note);
    saveQueue.schedule(
      note.id,
      snapshot,
      async value => {
        if (!await this.persistNote(value)) {
          throw new Error('Debounced note edit could not be saved locally');
        }
      },
    );
  }

  private async flushPendingSaves(
    {
      deferRemote = false,
      requireDurable = false,
    }: { deferRemote?: boolean; requireDurable?: boolean } = {},
  ): Promise<void> {
    await saveQueue.drain(async note => {
      const saved = await this.persistNote(note, { deferRemote });
      if (!saved && requireDurable) throw new Error('Pending note edits could not be saved locally');
    });
  }

  private async persistNote(
    note: Note,
    {
      deferRemote = false,
      beforeAttachments,
    }: { deferRemote?: boolean; beforeAttachments?: Note } = {},
    target = this.captureMutationTarget(),
  ): Promise<boolean> {
    this.markLocalEdit(note.id);
    // Every awaited write uses one immutable vault snapshot. A reset can make
    // this context stale, but it cannot redirect an old-vault note, attachment,
    // or pending marker into the newly selected vault.
    const { context, adapter, sync } = target;
    if (!adapter) return false;
    try {
      const portable = this.portableNote(note);
      const durable = durableNoteAdapter(adapter);
      const pending = await durable.saveNoteWithPendingSync(portable, {
        ...(beforeAttachments
          ? { beforeAttachments: this.portableNote(beforeAttachments) }
          : {}),
      });
      const pushed = await this.pushPendingNote(pending, target, deferRemote);
      if (context.isCurrent() && !deferRemote && (!sync || pushed)) this.syncStatus = 'synced';
      return true;
    } catch (e) {
      console.error('Failed to save note:', e);
      if (context.isCurrent()) {
        this.syncStatus = 'error';
        toastStore.show('Failed to save note');
      }
      return false;
    }
  }

  private markLocalEdit(noteId: string): void {
    this.localEditGenerations.set(
      noteId,
      (this.localEditGenerations.get(noteId) ?? 0) + 1,
    );
  }

  private async pushPendingNote(
    pending: PendingNoteSync,
    target: VaultMutationTarget,
    deferRemote = false,
  ): Promise<boolean> {
    const { context, adapter, sync, attachments } = target;
    try {
      await attachments.prepareUploads(
        pending.id,
        pending.note.deleted ? [] : (pending.note.images ?? []),
      );
    } catch (error) {
      console.warn('Attachment upload reconciliation queued:', error);
      if (context.isCurrent()) this.syncStatus = 'offline';
      return false;
    }
    if (!sync) return true;
    if (!adapter || deferRemote || !context.isCurrent()) return false;
    const durable = durableNoteAdapter(adapter);
    let rejectedUploadHandles: AttachmentUploadHandle[] = [];
    try {
      rejectedUploadHandles = await attachments.pendingUploadHandles(
        pending.id,
        (pending.note.images ?? []).map(attachment => attachment.id),
      );
      await this.pushNoteWithAttachments(pending, target, durable);
      return true;
    } catch (error) {
      let queuedError: unknown = error;
      if (isPreservableRemoteConflict(error) && context.isCurrent()) {
        try {
          await attachments.completeCompoundUploadIntent(pending.id, pending.token);
          // The note mutation was rejected, so none of its attachment
          // deletions are authorized. Leaving them queued would let a later
          // retry delete blobs still referenced by the winning note.
          await this.cancelAttachmentDeletes(pending.id, attachments);
          const preserved = await this.preserveConflict(pending.note, target);
          if (preserved) {
            await attachments.discardRejectedUploads(rejectedUploadHandles);
            await durable.completePendingNoteSync(pending.id, pending.token);
            if (context.isCurrent()) void this.sync();
            return true;
          }
        } catch (conflictError) {
          queuedError = conflictError;
        }
      }
      console.warn('Remote sync queued:', queuedError);
      if (context.isCurrent()) this.syncStatus = 'offline';
      return false;
    }
  }

  /**
   * Apply the remote parts of one logical note mutation in dependency order:
   * new bytes before the note references them, and removed bytes only after
   * the note revision check accepts the version that stopped referencing them.
   */
  private async pushNoteWithAttachments(
    pending: PendingNoteSync,
    target: VaultMutationTarget,
    durable = durableNoteAdapter(target.adapter!),
  ): Promise<void> {
    const previous = this.remoteNoteMutationTails.get(pending.id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn);
    this.remoteNoteMutationTails.set(pending.id, tail);
    await previous;
    try {
      await this.pushNoteWithAttachmentsUnlocked(pending, target, durable);
    } finally {
      release();
      if (this.remoteNoteMutationTails.get(pending.id) === tail) {
        this.remoteNoteMutationTails.delete(pending.id);
      }
    }
  }

  private async pushNoteWithAttachmentsUnlocked(
    pending: PendingNoteSync,
    target: VaultMutationTarget,
    durable: DurableNoteStorageAdapter,
  ): Promise<void> {
    const sync = target.sync;
    if (!sync) return;
    const note = pending.note;
    const beforeAttachments = pending.beforeAttachments;
    if (beforeAttachments) {
      const finalAttachments = note.deleted ? [] : (note.images ?? []);
      const referenced = new Set(finalAttachments.map(attachment => attachment.id));
      for (const attachment of beforeAttachments.images ?? []) {
        if (referenced.has(attachment.id)) continue;
        await target.attachments.queueDelete(note.id, attachment, {
          retainBytes: true,
          purgeRetainedBytesOnComplete: true,
        });
      }
    }
    await target.attachments.prepareUploads(
      note.id,
      note.deleted ? [] : (note.images ?? []),
    );

    // A durable delete intent may outlive the stale note version that created
    // it. Never delete an attachment referenced by the version being pushed.
    if (!note.deleted) {
      const referenced = new Set((note.images ?? []).map(attachment => attachment.id));
      if (referenced.size) {
        for (const pending of await target.attachments.pendingDeletes()) {
          if (pending.noteId === note.id && referenced.has(pending.attachment.id)) {
            await target.attachments.cancelDelete(note.id, pending.attachment.id);
          }
        }
      }
    }

    const uploads = await target.attachments.pendingUploadSources(
      note.id,
      note.deleted ? [] : (note.images ?? []).map(attachment => attachment.id),
    );
    if (uploads.length > 0) {
      const awaitingCompletion = await sync.pendingCompoundCommit(note.id);
      if (awaitingCompletion) {
        await this.finishCompoundCommit(awaitingCompletion, target, durable);
      } else {
        const stale = await target.attachments.compoundUploadIntent(note.id);
        if (stale?.phase === 'reconciled') {
          await target.attachments.completeCompoundUploadIntent(
            stale.noteId,
            stale.noteToken,
          );
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await target.attachments.beginCompoundUploadIntent(
          note.id,
          pending.token,
          uploads.map(value => value.handle),
        );
        try {
          const compoundUploads = uploads.map(
            ({ attachment, loadBytes }) => ({ attachment, loadBytes }),
          );
          let handle: CompoundCommitHandle;
          try {
            handle = await sync.commitNoteWithAttachments(note, compoundUploads);
          } catch (error) {
            if (!isPendingCredentialMismatch(error)) throw error;
            try {
              handle = await sync.resumePendingCompoundCommitAfterCredentialChange(
                note.id,
                compoundUploads,
              ) ?? await sync.commitNoteWithAttachments(note, compoundUploads);
            } catch (handoffError) {
              if (!isForeignCompoundRebuildRejection(handoffError)) {
                throw handoffError;
              }
              if (!await sync.abandonPendingCompoundAfterCredentialChange(note.id)) {
                throw handoffError;
              }
              throw attachmentIdUnavailable();
            }
          }
          await this.finishCompoundCommit(handle, target, durable);
          break;
        } catch (error) {
          if (
            error instanceof PendingCompoundCompletionError
            && error.handle.noteId === note.id
            && attempt === 0
          ) {
            await this.finishCompoundCommit(error.handle, target, durable);
            continue;
          }
          throw error;
        }
      }
    } else {
      await pushWithCredentialHandoff(sync, note);
      await durable.completePendingNoteSync(pending.id, pending.token);
    }

    const deletions = await target.attachments.flushDeletes(
      async (noteId, attachment) => {
        try {
          return await sync.deleteAttachment(noteId, attachment);
        } catch (error) {
          if (!isPendingCredentialMismatch(error)) throw error;
          await sync.resumePendingMutationAfterCredentialChange(
            'attachment',
            attachment.id,
          );
          return sync.deleteAttachment(noteId, attachment);
        }
      },
      note.id,
    );
    if (deletions.failed.length) throw new Error('Attachment deletion failed');
  }

  private async finishCompoundCommit(
    handle: CompoundCommitHandle,
    target: VaultMutationTarget,
    durable: DurableNoteStorageAdapter,
  ): Promise<void> {
    const sync = target.sync;
    if (!sync) return;
    const intent = await target.attachments.compoundUploadIntent(handle.noteId);
    if (!intent) throw new Error('Committed attachment mutation has no local completion intent');
    if (intent.phase === 'pending') {
      const committed = new Map(
        handle.attachmentRevisions.map(value => [value.id, value.contentHash]),
      );
      for (const upload of intent.uploads) {
        const contentHash = committed.get(upload.attachmentId);
        if (!contentHash) throw new Error('Committed attachment mutation is missing an intended upload');
        await target.attachments.confirmCompoundUpload(upload, contentHash);
      }
      // The compare-clear may intentionally return false when a newer local
      // snapshot replaced this token. Marking this exact intent reconciled is
      // the durable boundary before the SDK root may be removed.
      await durable.completePendingNoteSync(handle.noteId, intent.noteToken);
      if (!await target.attachments.markCompoundUploadIntentReconciled(
        handle.noteId,
        intent.noteToken,
      )) throw new Error('Compound completion intent changed during reconciliation');
    }
    await sync.completeCompoundCommit(handle);
    await target.attachments.completeCompoundUploadIntent(handle.noteId, intent.noteToken);
  }

  private async recoverCompoundCommits(
    target: VaultMutationTarget,
    durable: DurableNoteStorageAdapter,
  ): Promise<void> {
    if (!target.sync) return;
    const committedHandles = await target.sync.pendingCompoundCommits();
    for (const handle of committedHandles) {
      await this.finishCompoundCommit(handle, target, durable);
    }
    const currentPending = new Map(
      (await durable.listPendingNoteSync()).map(value => [value.id, value]),
    );
    for (const intent of await target.attachments.compoundUploadIntents()) {
      if (intent.phase === 'reconciled') {
        // SDK completion succeeded but the browser stopped before deleting the
        // web intent. No SDK handle is expected or needed at this point.
        await target.attachments.completeCompoundUploadIntent(
          intent.noteId,
          intent.noteToken,
        );
        continue;
      }
      const exactSources = await target.attachments.pendingUploadSourcesForHandles(
        intent.uploads,
      );
      try {
        const resumed = await target.sync.resumePendingCompoundCommit(
          intent.noteId,
          exactSources.map(({ attachment, loadBytes }) => ({ attachment, loadBytes })),
        );
        if (resumed) {
          await this.finishCompoundCommit(resumed, target, durable);
          continue;
        }
      } catch (error) {
        if (isPendingCredentialMismatch(error)) {
          const current = currentPending.get(intent.noteId);
          if (!current) throw error;
          try {
            const resumed = await target.sync
              .resumePendingCompoundCommitAfterCredentialChange(
                intent.noteId,
                exactSources.map(
                  ({ attachment, loadBytes }) => ({ attachment, loadBytes }),
                ),
              );
            if (resumed) {
              await this.finishCompoundCommit(resumed, target, durable);
              continue;
            }
          } catch (handoffError) {
            if (isForeignCompoundRebuildRejection(handoffError)) {
              if (!await target.sync.abandonPendingCompoundAfterCredentialChange(
                intent.noteId,
              )) throw handoffError;
              if (current.token !== intent.noteToken) {
                await target.attachments.completeCompoundUploadIntent(
                  intent.noteId,
                  intent.noteToken,
                );
              }
              // The current token retains its exact generations for the normal
              // push path. A newer token has already retired the old intent
              // above and may be an ordinary removal with no uploads at all.
              continue;
            }
            // An authenticated replacement can still lack an old pre-stage
            // source. Fall through to the generation-fenced cancellation
            // below only when a newer outbox token makes that source obsolete.
            if (exactSources.length === intent.uploads.length) throw handoffError;
          }
        }
        if (exactSources.length === intent.uploads.length) throw error;
        const current = currentPending.get(intent.noteId);
        if (!current || current.token === intent.noteToken) throw error;
        const currentAttachmentIds = new Set(
          (current.note.deleted ? [] : (current.note.images ?? []))
            .map(value => value.id),
        );
        const exactIdentities = new Set(exactSources.map(value =>
          `${value.handle.attachmentId}\0${value.handle.generation ?? 'legacy'}`));
        for (const upload of intent.uploads) {
          if (exactIdentities.has(
            `${upload.attachmentId}\0${upload.generation ?? 'legacy'}`,
          )) continue;
          if (
            currentAttachmentIds.has(upload.attachmentId)
            && !await target.attachments.hasReplacementUploadGeneration(upload)
          ) throw error;
        }
        // A newer same-key generation can make an unfinished old stage
        // irrecoverable. Cancellation is safe only when the SDK proves the
        // root never reached finalization; false preserves ambiguity.
        if (!await target.sync.cancelPendingCompoundCommit(intent.noteId)) throw error;
        await target.attachments.completeCompoundUploadIntent(
          intent.noteId,
          intent.noteToken,
        );
        continue;
      }
      // No SDK root exists. Retain an intent that still owns the current
      // outbox so the normal commit path can start it; otherwise it is stale.
      if (currentPending.get(intent.noteId)?.token !== intent.noteToken) {
        await target.attachments.completeCompoundUploadIntent(
          intent.noteId,
          intent.noteToken,
        );
      }
    }
  }

  private async cancelAttachmentDeletes(
    noteId: string,
    attachments: AttachmentStore,
  ): Promise<void> {
    for (const pending of await attachments.pendingDeletes()) {
      if (pending.noteId === noteId) {
        await attachments.cancelDelete(noteId, pending.attachment.id);
      }
    }
  }

  private captureMutationTarget(
    context: VaultTaskContext = this.syncCoordinator.capture(),
  ): VaultMutationTarget {
    const resources = this.readVaultResources();
    return {
      context,
      adapter: this.adapter,
      sync: this.encryptedSync,
      attachments: resources.attachments,
      urls: resources.urls,
    };
  }

  private async refreshSyncQuarantine(
    sync: EncryptedSync,
    context: VaultTaskContext,
  ): Promise<void> {
    const quarantined = await sync.getQuarantinedRecords();
    if (context.isCurrent() && this.encryptedSync === sync) {
      this.syncQuarantineCount = quarantined.length;
    }
  }

  private portableNote(note: Note): Note {
    const snapshot = $state.snapshot(note) as Note;
    return normalizeNoteRecord({
      ...snapshot,
      images: snapshot.images?.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    });
  }

  private async preserveConflict(
    staleNote: Note,
    target: VaultMutationTarget,
  ): Promise<boolean> {
    const { context, attachments, urls } = target;
    if (!context.isCurrent()) return false;
    if (this.preservedConflicts.has(staleNote.id)) return true;
    this.preservedConflicts.add(staleNote.id);
    const copiedAttachments: Array<{
      attachment: NoteAttachment;
      handle: StagedAttachmentHandle;
    }> = [];
    let copy: Note | null = null;
    const discardCopiedAttachments = async () => {
      if (!copy) return;
      for (const value of copiedAttachments) {
        urls.release(copy.id, value.attachment.id);
        await attachments.discardStage(value.handle);
      }
    };
    const abandonIfStale = async () => {
      if (context.isCurrent()) return false;
      await discardCopiedAttachments();
      this.preservedConflicts.delete(staleNote.id);
      return true;
    };
    try {
      copy = createConflictCopy(staleNote, () => nanoid(), Date.now());
      for (let index = 0; index < (staleNote.images?.length ?? 0); index++) {
        const source = staleNote.images![index];
        const copied = copy.images![index];
        const stored = await attachments.get(staleNote.id, source.id);
        if (await abandonIfStale()) return false;
        if (!stored) continue;
        const handle = await attachments.stageUpload(copy.id, copied, stored.bytes);
        copiedAttachments.push({ attachment: copied, handle });
        if (await abandonIfStale()) return false;
      }
      copy.images = copiedAttachments.length
        ? copiedAttachments.map(value => value.attachment)
        : undefined;
      const hydrated = await urls.hydrate(copy);
      if (await abandonIfStale()) return false;
      this.notes.push(hydrated);
      if (!await this.persistNote(hydrated, {}, target)) {
        if (context.isCurrent()) this.notes = this.notes.filter(note => note.id !== copy!.id);
        await discardCopiedAttachments();
        throw new Error('Could not preserve the conflicting edit');
      }
      if (context.isCurrent()) toastStore.show('A concurrent edit was preserved as a conflict copy');
      else this.preservedConflicts.delete(staleNote.id);
      return true;
    } catch (error) {
      this.preservedConflicts.delete(staleNote.id);
      throw error;
    }
  }

  async deleteNote(id: string): Promise<DeleteUndoToken | null> {
    const target = this.captureMutationTarget();
    const activeNote = this.notes.find(note => note.id === id);
    if (!activeNote || !target.adapter) return null;
    const note = this.portableNote(activeNote);
    this.markLocalEdit(id);
    const attachments = note.images ?? [];
    saveQueue.cancel(id);
    const queuedAttachments: NoteAttachment[] = [];
    try {
      for (const attachment of attachments) {
        queuedAttachments.push(attachment);
        await target.attachments.queueDelete(id, attachment, { retainBytes: true });
      }
    } catch (error) {
      console.error('Failed to queue note attachments for deletion:', error);
      for (const attachment of queuedAttachments) {
        await target.attachments.cancelDelete(id, attachment.id);
        const stored = await target.attachments.get(id, attachment.id);
        if (stored) await target.attachments.save(id, stored.attachment, stored.bytes, { pendingUpload: true });
      }
      if (target.context.isCurrent() && this.notes.some(current => current.id === id)) {
        this.debouncedSave(activeNote);
      }
      if (target.context.isCurrent()) toastStore.show('Failed to delete note');
      return null;
    }
    let pendingSync: PendingNoteSync;
    try {
      pendingSync = await durableNoteAdapter(target.adapter).saveNoteWithPendingSync({
        ...note,
        trashedAt: undefined,
        deleted: true,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error('Failed to delete note:', error);
      for (const attachment of queuedAttachments) {
        await target.attachments.cancelDelete(id, attachment.id);
        const stored = await target.attachments.get(id, attachment.id);
        if (stored) await target.attachments.save(id, stored.attachment, stored.bytes, { pendingUpload: true });
      }
      if (target.context.isCurrent() && this.notes.some(current => current.id === id)) {
        this.debouncedSave(activeNote);
      }
      if (target.context.isCurrent()) toastStore.show('Failed to delete note');
      return null;
    }
    if (target.sync) {
      try {
        await this.pushNoteWithAttachments(
          pendingSync,
          target,
          durableNoteAdapter(target.adapter),
        );
      } catch (error) {
        if (error instanceof RecordConflictError) {
          try {
            await this.cancelAttachmentDeletes(id, target.attachments);
          } catch (cancelError) {
            console.warn('Failed to cancel rejected attachment deletions:', cancelError);
          }
        }
        // The local tombstone remains durable. Non-conflicting attachment
        // deletion intents remain queued, and performSync always retries the
        // note revision check before attempting them.
        if (target.context.isCurrent()) this.syncStatus = 'offline';
      }
    }
    if (target.context.isCurrent()) this.notes = this.notes.filter(current => current.id !== id);
    const attachmentIds = attachments.map(attachment => attachment.id);
    const token = Object.freeze({ [DELETE_UNDO_TOKEN]: true }) as DeleteUndoToken;
    const pending: PendingDeleteUndo = {
      note,
      target,
      attachmentIds,
      expiresAt: Date.now() + DELETE_UNDO_MS,
      state: 'active',
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (pending.state !== 'active') return;
      pending.state = 'expired';
      void target.attachments.purgeRetained(id, attachmentIds)
        .catch(error => console.warn('Failed to purge expired Undo attachments:', error))
        .finally(() => { pending.timer = null; });
    }, DELETE_UNDO_MS);
    pendingDeleteUndos.set(token, pending);
    return token;
  }

  async trashNote(id: string): Promise<boolean> {
    const target = this.captureMutationTarget();
    const activeNote = this.notes.find(note => note.id === id);
    if (!activeNote || !target.adapter || activeNote.trashedAt !== undefined) return false;
    saveQueue.cancel(id);
    const trashed = this.portableNote({
      ...activeNote,
      archived: false,
      trashedAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!await this.persistNote(trashed, {}, target)) return false;
    if (!target.context.isCurrent()) return true;
    const current = this.notes.find(note => note.id === id);
    if (current) Object.assign(current, trashed);
    return true;
  }

  async restoreTrashedNote(id: string): Promise<boolean> {
    const target = this.captureMutationTarget();
    const activeNote = this.notes.find(note => note.id === id);
    if (!activeNote || !target.adapter || activeNote.trashedAt === undefined) return false;
    saveQueue.cancel(id);
    const restored = this.portableNote({
      ...activeNote,
      trashedAt: undefined,
      updatedAt: Date.now(),
    });
    if (!await this.persistNote(restored, {}, target)) return false;
    if (!target.context.isCurrent()) return true;
    const current = this.notes.find(note => note.id === id);
    if (current) Object.assign(current, restored);
    return true;
  }

  async permanentlyDeleteNote(id: string): Promise<boolean> {
    const note = this.notes.find(candidate => candidate.id === id);
    if (!note || note.trashedAt === undefined) return false;
    return (await this.deleteNote(id)) !== null;
  }

  async undoDelete(token: DeleteUndoToken): Promise<void> {
    const pending = pendingDeleteUndos.get(token);
    if (!pending || pending.state !== 'active') return;
    if (Date.now() >= pending.expiresAt || !pending.target.context.isCurrent()) return;
    pending.state = 'consuming';
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const { note, target } = pending;
    const restored = this.portableNote({ ...note, deleted: false, updatedAt: Date.now() });
    let restoredAttachmentHandles: StagedAttachmentHandle[] = [];
    try {
      const restoredUploads = await target.attachments.restoreForUndoWithHandles(
        restored.id,
        restored.images ?? [],
      );
      const restoredAttachments = restoredUploads.map(value => value.attachment);
      restoredAttachmentHandles = restoredUploads.map(value => value.handle);
      restored.images = restoredAttachments.length ? restoredAttachments : undefined;
      if (!await this.persistNote(restored, {
        beforeAttachments: { ...restored, images: undefined },
      }, target)) {
        throw new Error('Failed to persist restored note');
      }
    } catch (error) {
      const rollback = await Promise.allSettled([
        target.adapter?.deleteNote(restored.id) ?? Promise.resolve(),
        ...restoredAttachmentHandles.map(handle =>
          target.attachments.discardStage(handle)),
        ...((note.images ?? []).map(attachment =>
          target.attachments.queueDelete(note.id, attachment, { retainBytes: true })
        )),
      ]);
      pending.state = 'consumed';
      console.error('Failed to undo note deletion:', error, rollback);
      if (target.context.isCurrent()) toastStore.show('Failed to restore note');
      return;
    }
    try {
      // The restored note and its outbox snapshot now reference only fresh
      // immutable relay IDs, so the retained tombstoned bytes are no longer
      // the sole recovery copy.
      await target.attachments.purgeRetained(
        note.id,
        (note.images ?? []).map(attachment => attachment.id),
      );
    } catch (error) {
      console.warn('Failed to purge superseded Undo attachment bytes:', error);
    }
    pending.state = 'consumed';
    if (!target.context.isCurrent()) return;
    try {
      const hydrated = await target.urls.hydrate(restored);
      if (!target.context.isCurrent()) {
        for (const attachment of hydrated.images ?? []) target.urls.release(restored.id, attachment.id);
        return;
      }
      this.notes = [...this.notes.filter(current => current.id !== restored.id), hydrated];
    } catch (error) {
      console.error('Failed to show restored note:', error);
      if (target.context.isCurrent()) toastStore.show('Note restored; reload to show it');
    }
  }

  togglePin(id: string) {
    const note = this.notes.find(n => n.id === id);
    if (note) {
      note.pinned = !note.pinned;
      note.updatedAt = Date.now();
      this.persistNote(note);
    }
  }

  setColor(id: string, color: NoteColor) {
    const note = this.notes.find(n => n.id === id);
    if (note) {
      note.color = color;
      note.updatedAt = Date.now();
      this.persistNote(note);
    }
  }

  toggleChecklist(id: string) {
    const note = this.notes.find(n => n.id === id);
    if (!note) return;
    if (note.checkboxes) {
      // Convert back to text
      note.content = note.checkboxes.map(c => `${c.checked ? '☑' : '☐'} ${c.text}`).join('\n');
      note.checkboxes = undefined;
    } else {
      // Convert text to checklist
      const lines = note.content.split('\n').filter(l => l.trim());
      note.checkboxes = lines.map(line => ({
        id: nanoid(),
        text: line.replace(/^[☑☐]\s*/, ''),
        checked: line.startsWith('☑'),
      }));
      note.content = '';
    }
    note.updatedAt = Date.now();
    this.persistNote(note);
  }

  addChecklistItem(noteId: string, text: string = '') {
    const note = this.notes.find(n => n.id === noteId);
    if (!note || !note.checkboxes) return;
    note.checkboxes.push({ id: nanoid(), text, checked: false });
    note.updatedAt = Date.now();
    this.debouncedSave(note);
  }

  updateChecklistItem(noteId: string, itemId: string, updates: Partial<Omit<ChecklistItem, 'id'>>) {
    const note = this.notes.find(n => n.id === noteId);
    if (!note || !note.checkboxes) return;
    const item = note.checkboxes.find(c => c.id === itemId);
    if (item) {
      Object.assign(item, updates);
      note.updatedAt = Date.now();
      this.debouncedSave(note);
    }
  }

  removeChecklistItem(noteId: string, itemId: string) {
    const note = this.notes.find(n => n.id === noteId);
    if (!note || !note.checkboxes) return;
    note.checkboxes = note.checkboxes.filter(c => c.id !== itemId);
    note.updatedAt = Date.now();
    this.debouncedSave(note);
  }

  async addAttachment(noteId: string, file: File): Promise<void> {
    const target = this.captureMutationTarget();
    const sizeError = attachmentSizeError(file);
    if (sizeError) {
      if (target.context.isCurrent()) toastStore.show(sizeError);
      return;
    }
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return;
    const attachment: NoteAttachment = {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
    };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const staged = await target.attachments.stageUpload(noteId, attachment, bytes);
    const next = this.portableNote(note);
    next.images = [...(next.images ?? []), attachment];
    next.updatedAt = Date.now();
    if (!await this.persistNote(next, {}, target)) {
      await target.attachments.discardStage(staged);
      return;
    }
    if (!target.context.isCurrent()) return;
    const hydrated = await target.urls.hydrate(next);
    if (!target.context.isCurrent()) {
      target.urls.release(noteId, attachment.id);
      return;
    }
    const current = this.notes.find(value => value === note);
    if (current) {
      current.images = hydrated.images;
      current.updatedAt = next.updatedAt;
    }
    if (this.syncStatus === 'offline') toastStore.show('Attachment saved locally and queued for sync');
  }

  async removeAttachment(noteId: string, attachmentId: string): Promise<void> {
    const target = this.captureMutationTarget();
    const note = this.notes.find(value => value.id === noteId);
    const attachment = note?.images?.find(value => value.id === attachmentId);
    if (!note || !attachment) return;
    await target.attachments.get(noteId, attachmentId);
    const beforeAttachments = this.portableNote(note);
    const next = this.portableNote(note);
    next.images = next.images?.filter(value => value.id !== attachmentId);
    if (!next.images?.length) next.images = undefined;
    next.updatedAt = Date.now();
    if (!await this.persistNote(next, { beforeAttachments }, target)) return;
    target.urls.release(noteId, attachmentId);
    if (!target.context.isCurrent()) return;
    const current = this.notes.find(value => value === note);
    if (current) {
      current.images = current.images?.filter(value => value.id !== attachmentId);
      if (!current.images?.length) current.images = undefined;
      current.updatedAt = next.updatedAt;
    }
  }

  async importNotes(notes: Note[], attachments: ImportedAttachment[] = []): Promise<number> {
    if (this.importInProgress) throw new Error('Another import is already in progress');
    // Invalidate any sync pass currently waiting on I/O. New sync triggers
    // return while the batch is staged, so an attachment cannot be uploaded
    // remotely before the matching atomic note commit succeeds.
    this.importInProgress = true;
    this.syncCoordinator.reset();
    try {
      return await this.commitImportedNotes(notes, attachments);
    } finally {
      this.importInProgress = false;
      if (this.encryptedSync) void this.sync();
    }
  }

  private async commitImportedNotes(
    notes: Note[],
    attachments: ImportedAttachment[],
  ): Promise<number> {
    const adapter = this.adapter;
    if (!adapter) throw new Error('Unlock your vault before importing notes');
    const durable = durableNoteAdapter(adapter);
    const context = this.syncCoordinator.capture();
    const store = attachmentStore;
    const urls = attachmentUrls;
    const activeJournalKey = importJournalKey;
    const storedMetadata = await adapter.listNotes();
    const storedNotes = adapter.getAllNotes
      ? await adapter.getAllNotes()
      : await Promise.all(storedMetadata.map(note => adapter.getNote(note.id)));
    const storedNoteIds = new Set([
      ...storedMetadata.map(note => note.id),
      ...storedNotes.map(note => note.id),
    ]);
    const storedAttachmentIds = new Set<string>();
    for (const note of [...storedNotes, ...this.notes]) {
      storedNoteIds.add(note.id);
      for (const attachment of note.images ?? []) storedAttachmentIds.add(attachment.id);
    }
    const resolved = resolveImportCollisions(
      notes,
      attachments,
      storedNoteIds,
      () => nanoid(),
      storedAttachmentIds,
    );
    notes = resolved.notes;
    attachments = resolved.attachments;
    const portable = notes.map(note => this.portableNote(note));
    if (portable.length === 0) return 0;
    const importClaim = await beginImportJournal(
      clientStorage,
      activeJournalKey,
      portable,
      attachments,
    );
    const importHandleByAttachment = new Map(importClaim.handles.map(handle => [
      `${handle.noteId}\0${handle.attachmentId}`,
      handle,
    ]));
    let journalOwned = true;
    const heartbeat = setInterval(() => {
      void renewImportJournal(
        clientStorage,
        activeJournalKey,
        importClaim.ownerToken,
      ).then(owned => { journalOwned = journalOwned && owned; })
        .catch(() => { journalOwned = false; });
    }, Math.floor(IMPORT_JOURNAL_LEASE_MS / 3));
    try {
      await durable.prepareImportCommit(importClaim.commitToken);
      await commitImportBatch(portable, attachments, {
        saveAttachment: async imported => {
          journalOwned = journalOwned && await renewImportJournal(
            clientStorage,
            activeJournalKey,
            importClaim.ownerToken,
          );
          if (!journalOwned) throw new Error('The import journal lease was lost');
          const handle = importHandleByAttachment.get(
            `${imported.noteId}\0${imported.attachment.id}`,
          );
          if (!handle) throw new Error('The import journal is missing an attachment generation');
          return await store.stageUpload(
            imported.noteId,
            imported.attachment,
            imported.bytes,
            {
              generation: handle.generation,
              writeEpoch: importClaim.writeEpoch,
            },
          );
        },
        discardAttachment: handle => store.discardStage(handle),
        saveNotesWithPendingSyncAtomically: async values => {
          journalOwned = journalOwned && await markImportJournalCommitStarted(
            clientStorage,
            activeJournalKey,
            importClaim.ownerToken,
          );
          if (!journalOwned) throw new Error('The import journal lease was lost');
          try {
            return await durable.saveNotesWithPendingSyncAtomically(values, {
              importCommitToken: importClaim.commitToken,
            });
          } catch (error) {
            await markImportJournalCommitFailed(
              clientStorage,
              activeJournalKey,
              importClaim.ownerToken,
            );
            throw error;
          }
        },
      });
    } catch (error) {
      try {
        await recoverImportJournal({
          storage: clientStorage,
          journalKey: activeJournalKey,
          adapter: durable,
          attachments: store,
          ownerToken: importClaim.ownerToken,
        });
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Import failed and durable rollback must retry on next startup',
          { cause: recoveryError },
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }

    try {
      await durable.clearImportCommit(importClaim.commitToken);
      const finalized = await completeImportJournal(
        clientStorage,
        activeJournalKey,
        importClaim.ownerToken,
      );
      if (!finalized) {
        console.warn('Committed import journal ownership changed; startup recovery will finalize it');
      }
    } catch (error) {
      console.warn('Committed import journal will be finalized on next startup:', error);
    }

    if (context.isCurrent()) {
      // Persistence is already committed. A browser object-URL failure should
      // not turn a complete import into a false "nothing restored" report.
      const hydrated = await Promise.all(portable.map(async note => {
        try { return await urls.hydrate(note); }
        catch { return note; }
      }));
      if (context.isCurrent()) this.notes.push(...hydrated);
    }
    return portable.length;
  }

  async exportVault(): Promise<string> {
    if (!this.adapter) throw new Error('Unlock your vault before exporting');
    return createVaultExport(this.notes.map(note => this.portableNote(note)), attachmentStore);
  }

  sync(): Promise<void> {
    return this.syncCoordinator.run(context => this.performSync(context));
  }

  private async performSync(context: VaultTaskContext): Promise<void> {
    if (this.importInProgress) return;
    const target = this.captureMutationTarget(context);
    const adapter = target.adapter;
    const encryptedSync = target.sync;
    if (!adapter) return;
    await this.flushPendingSaves();
    if (!context.isCurrent()) return;
    this.syncStatus = 'syncing';
    try {
      if (encryptedSync) {
        const durable = durableNoteAdapter(adapter);
        const mutationFailures = new Set<string>();
        await this.recoverCompoundCommits(target, durable);
        const stagedUploads = await target.attachments.stagedUploads();
        const queuedAttachmentNoteIds = new Set([
          ...await target.attachments.pendingUploadNoteIds(),
          ...(await target.attachments.pendingDeletes()).map(value => value.noteId),
          ...stagedUploads.map(value => value.noteId),
        ]);
        if (!context.isCurrent()) return;
        for (const noteId of queuedAttachmentNoteIds) {
          const pending = await durable.queueNoteForSync(noteId);
          if (!pending) {
            // A staged marker is evidence of incomplete local work, not
            // authority to delete it. Only a durable note snapshot can decide
            // which attachment generations are referenced.
            continue;
          }
          if (stagedUploads.some(value => value.noteId === noteId)) {
            await target.attachments.prepareUploads(
              noteId,
              pending.note.deleted ? [] : (pending.note.images ?? []),
            );
          }
        }
        for (const pending of await durable.listPendingNoteSync()) {
          const id = pending.id;
          let rejectedUploadHandles: AttachmentUploadHandle[] = [];
          try {
            rejectedUploadHandles = await target.attachments.pendingUploadHandles(
              id,
              (pending.note.images ?? []).map(attachment => attachment.id),
            );
            await this.pushNoteWithAttachments(pending, target, durable);
            if (!context.isCurrent()) return;
          } catch (error) {
            if (isPreservableRemoteConflict(error)) {
              try {
                await target.attachments.completeCompoundUploadIntent(id, pending.token);
                await this.cancelAttachmentDeletes(id, target.attachments);
              } catch {
                mutationFailures.add(id);
                continue;
              }
              const preserved = await useForCurrentVault(
                context,
                () => Promise.resolve(pending.note),
                note => this.preserveConflict(note, target),
              );
              if (!context.isCurrent()) return;
              if (preserved) {
                await target.attachments.discardRejectedUploads(rejectedUploadHandles);
                await durable.completePendingNoteSync(id, pending.token);
                continue;
              }
            }
            mutationFailures.add(id);
          }
        }
        if (mutationFailures.size) {
          // One global cursor covers every record. Pulling and acknowledging
          // while a local mutation is still pending could apply a remote
          // version of that same note over the only durable local copy. Retry
          // the queued mutation before reading any later relay revision.
          this.syncStatus = 'offline';
          return;
        }
        // A newer mutation may have committed while an older remote push was
        // in flight. Its different token survives the compare-and-clear above;
        // never pull over that newly queued local snapshot.
        if ((await durable.listPendingNoteSync()).length > 0) {
          this.syncStatus = 'offline';
          return;
        }
        const pullEditGenerations = new Map(this.localEditGenerations);
        const editedDuringPull = (noteId: string) =>
          (this.localEditGenerations.get(noteId) ?? 0)
          !== (pullEditGenerations.get(noteId) ?? 0);
        const stopForLocalEdit = (noteId: string): boolean => {
          if (!editedDuringPull(noteId)) return false;
          this.syncStatus = 'offline';
          return true;
        };
        const pulled = await encryptedSync.pull();
        if (!context.isCurrent()) return;
        const affectedNoteIds = new Set([
          ...pulled.notes.map(note => note.id),
          ...pulled.deletedIds,
          ...pulled.attachments.map(value => value.noteId),
          ...pulled.deletedAttachments.map(value => value.noteId),
        ]);
        if ([...affectedNoteIds].some(editedDuringPull)) {
          this.syncStatus = 'offline';
          return;
        }
        const attachmentBytes = new Set<string>();
        const remoteAttachmentHandles = new Map<string, RemoteAttachmentHandle>();
        for (const value of pulled.attachments) {
          if (stopForLocalEdit(value.noteId)) return;
          const handle = await target.attachments.saveRemote(
            value.noteId,
            value.attachment,
            value.bytes,
          );
          if (!context.isCurrent() || stopForLocalEdit(value.noteId)) return;
          const key = `${value.noteId}:${value.attachment.id}`;
          attachmentBytes.add(key);
          remoteAttachmentHandles.set(key, handle);
        }
        for (const { noteId, attachmentId } of pulled.deletedAttachments) {
          if (stopForLocalEdit(noteId)) return;
          target.urls.release(noteId, attachmentId);
          await target.attachments.applyRemoteDelete(noteId, attachmentId);
          if (!context.isCurrent() || stopForLocalEdit(noteId)) return;
          const existing = this.notes.find(note => note.id === noteId);
          if (!existing?.images?.some(attachment => attachment.id === attachmentId)) continue;
          existing.images = existing.images.filter(attachment => attachment.id !== attachmentId);
          if (!existing.images.length) existing.images = undefined;
          await adapter.saveNote(this.portableNote(existing));
          if (!context.isCurrent() || stopForLocalEdit(noteId)) return;
        }
        for (const note of pulled.notes) {
          if (stopForLocalEdit(note.id)) return;
          for (const attachment of note.images ?? []) {
            const key = `${note.id}:${attachment.id}`;
            if (!attachmentBytes.has(key) && !await target.attachments.get(note.id, attachment.id)) {
              throw new Error(`Attachment bytes unavailable: ${attachment.name}`);
            }
          }
          const portable = this.portableNote(note);
          await adapter.saveNote(portable);
          if (!context.isCurrent() || stopForLocalEdit(note.id)) return;
          for (const attachment of portable.images ?? []) {
            const handle = remoteAttachmentHandles.get(
              `${portable.id}:${attachment.id}`,
            );
            if (handle && !await target.attachments.confirmRemote(handle)) {
              throw new Error(
                `Attachment changed locally while applying remote note: ${attachment.name}`,
              );
            }
            if (stopForLocalEdit(note.id)) return;
          }
          const hydrated = await target.urls.hydrate(portable);
          if (!context.isCurrent() || stopForLocalEdit(note.id)) return;
          const existing = this.notes.find(value => value.id === note.id);
          if (existing) {
            for (const attachment of existing.images ?? []) {
              if (!hydrated.images?.some(value => value.id === attachment.id)) {
                target.urls.release(note.id, attachment.id);
              }
            }
            Object.assign(existing, hydrated);
          } else {
            this.notes.push(hydrated);
          }
          this.preservedConflicts.delete(note.id);
        }
        for (const id of pulled.deletedIds) {
          if (stopForLocalEdit(id)) return;
          const existing = this.notes.find(note => note.id === id);
          await applyRemoteNoteTombstone(adapter, id);
          if (!context.isCurrent() || stopForLocalEdit(id)) return;
          for (const attachment of existing?.images ?? []) {
            target.urls.release(id, attachment.id);
            await target.attachments.applyRemoteDelete(id, attachment.id);
            if (!context.isCurrent() || stopForLocalEdit(id)) return;
          }
          this.notes = this.notes.filter(note => note.id !== id);
          this.preservedConflicts.delete(id);
        }
        await encryptedSync.acknowledge(pulled.cursor, pulled.revisions);
        if (!context.isCurrent()) return;
        await this.refreshSyncQuarantine(encryptedSync, context);
        if (!context.isCurrent()) return;
      } else {
        const result = await adapter.sync();
        if (!context.isCurrent()) return;
        if (result.errors.length > 0) throw new Error(result.errors.join(', '));
      }
      this.syncStatus = 'synced';
    } catch {
      if (context.isCurrent()) {
        this.syncStatus = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error';
      }
    }
  }
}

export const noteStore = new NoteStore();
