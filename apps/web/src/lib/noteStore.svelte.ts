import { nanoid } from 'nanoid';
import type { Note, NoteAttachment, NoteColor, ChecklistItem, StorageAdapter } from '@unkeep/core';
import { normalizeNoteRecord } from '@unkeep/core';
import { EncryptedSync, RecordConflictError, type RelaySession } from '@unkeep/client';
import { toastStore } from './toast.svelte';
import { clientStorage } from './clientStorage';
import { attachmentSizeError } from './attachments';
import { AttachmentStore, AttachmentUrlCache } from './attachmentStorage';
import type { ImportedAttachment } from './keepImporter';
import type { QuickSendDraft } from './quickSend';
import { createVaultExport } from './vaultExport';
import { createConflictCopy } from './conflictCopy';
import { resolveImportCollisions } from './importCollisions';
import { commitImportBatch } from './importCommit';
import { beginImportJournal, recoverImportJournal } from './importJournal';
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

function markPending(id: string, pending: boolean, key = pendingSyncKey): void {
  const ids = pendingIds(key);
  if (pending) ids.add(id); else ids.delete(id);
  localStorage.setItem(key, JSON.stringify([...ids]));
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
  pendingKey: string;
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
  private encryptedSync: EncryptedSync | null = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private readonly syncCoordinator = new VaultTaskCoordinator();
  private readonly preservedConflicts = new Set<string>();
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
      .filter(n => !n.archived)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      })
  );

  archivedNotes = $derived(
    this.filteredNotes
      .filter(n => n.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );

  pinnedNotes = $derived(this.activeNotes.filter(n => n.pinned));
  unpinnedNotes = $derived(this.activeNotes.filter(n => !n.pinned));

  async init(vaultNamespace: string, migrateLegacy = false) {
    this.loading = true;
    this.syncCoordinator.reset();
    const context = this.syncCoordinator.capture();
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
        adapter,
        attachments: resources.attachments,
        readPendingNoteIds: () => pendingIds(resources.pendingKey),
        writePendingNoteIds: ids => localStorage.setItem(resources.pendingKey, JSON.stringify([...ids])),
      });
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
    this.unsubscribeRealtime?.();
    window.removeEventListener('online', this.wakeSync);
    document.removeEventListener('visibilitychange', this.syncWhenVisible);
    this.encryptedSync = new EncryptedSync(session, masterKey, clientStorage);
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
    this.adapter = null;
    attachmentUrls.releaseAll();
    this.notes = [];
  }

  async initWithAdapter(adapter: StorageAdapter, config: Record<string, unknown>) {
    this.loading = true;
    this.syncCoordinator.reset();
    const context = this.syncCoordinator.capture();
    this.adapter = null;
    this.preservedConflicts.clear();
    const resources = this.readVaultResources();
    try {
      await adapter.init(config);
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

  async createReceivedNote(draft: QuickSendDraft): Promise<Note> {
    const target = this.captureMutationTarget();
    if (!target.adapter) throw new Error('Unlock your vault before saving this note');
    const now = Date.now();
    const note: Note = {
      id: nanoid(),
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
    const storedAttachments: NoteAttachment[] = [];
    try {
      for (const incoming of draft.attachments ?? []) {
        const attachment: NoteAttachment = {
          id: nanoid(),
          name: incoming.name,
          mimeType: incoming.mimeType || 'application/octet-stream',
          size: incoming.size,
        };
        await target.attachments.save(note.id, attachment, incoming.bytes, { pendingUpload: true });
        storedAttachments.push(attachment);
      }
      note.images = storedAttachments.length ? storedAttachments : undefined;
    } catch (error) {
      for (const attachment of storedAttachments) await target.attachments.delete(note.id, attachment.id);
      throw error;
    }
    if (!await this.persistNote(note, {}, target)) {
      for (const attachment of storedAttachments) await target.attachments.delete(note.id, attachment.id);
      throw new Error('The received note could not be saved locally');
    }
    if (!target.context.isCurrent()) return note;
    const hydrated = await target.urls.hydrate(note);
    if (!target.context.isCurrent()) {
      for (const attachment of storedAttachments) target.urls.release(note.id, attachment.id);
      return note;
    }
    this.notes.push(hydrated);
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
    saveQueue.schedule(
      note.id,
      note,
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
    { deferRemote = false }: { deferRemote?: boolean } = {},
    target = this.captureMutationTarget(),
  ): Promise<boolean> {
    // Every awaited write uses one immutable vault snapshot. A reset can make
    // this context stale, but it cannot redirect an old-vault note, attachment,
    // or pending marker into the newly selected vault.
    const { context, adapter, sync, attachments, pendingKey: writePendingKey } = target;
    if (!adapter) return false;
    try {
      const portable = this.portableNote(note);
      await adapter.saveNote(portable);
      markPending(note.id, true, writePendingKey);
      if (sync && !deferRemote && context.isCurrent()) {
        try {
          const deletions = await attachments.flushDeletes(
            (noteId, attachment) => sync.deleteAttachment(noteId, attachment),
            note.id,
          );
          if (deletions.failed.length) throw new Error('Attachment deletion failed');
          const uploads = await attachments.flushUploads(
            (noteId, attachment, bytes) => sync.uploadAttachment(noteId, attachment, bytes),
            note.id,
          );
          if (uploads.failed.length) throw new Error('Attachment upload failed');
          await sync.push(portable);
          markPending(note.id, false, writePendingKey);
        } catch (error) {
          if (error instanceof RecordConflictError && context.isCurrent()) {
            const preserved = await this.preserveConflict(portable, target);
            if (preserved) {
              markPending(note.id, false, writePendingKey);
              if (context.isCurrent()) void this.sync();
              return true;
            }
          }
          markPending(note.id, true, writePendingKey);
          console.warn('Remote sync queued:', error);
          if (context.isCurrent()) this.syncStatus = 'offline';
          return true;
        }
      }
      if (context.isCurrent() && !deferRemote) this.syncStatus = 'synced';
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
      pendingKey: resources.pendingKey,
    };
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
    const copiedAttachments: NoteAttachment[] = [];
    let copy: Note | null = null;
    const discardCopiedAttachments = async () => {
      if (!copy) return;
      for (const attachment of copiedAttachments) {
        urls.release(copy.id, attachment.id);
        await attachments.delete(copy.id, attachment.id);
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
        await attachments.save(copy.id, copied, stored.bytes, { pendingUpload: true });
        copiedAttachments.push(copied);
        if (await abandonIfStale()) return false;
      }
      copy.images = copiedAttachments.length ? copiedAttachments : undefined;
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
      if (target.context.isCurrent()) toastStore.show('Failed to delete note');
      return null;
    }
    try {
      await target.adapter.deleteNote(id);
    } catch (error) {
      console.error('Failed to delete note:', error);
      for (const attachment of queuedAttachments) {
        await target.attachments.cancelDelete(id, attachment.id);
        const stored = await target.attachments.get(id, attachment.id);
        if (stored) await target.attachments.save(id, stored.attachment, stored.bytes, { pendingUpload: true });
      }
      if (target.context.isCurrent()) toastStore.show('Failed to delete note');
      return null;
    }
    if (target.sync) {
      markPending(id, true, target.pendingKey);
      try {
        const tombstone = await target.adapter.getNote(id);
        const deletions = await target.attachments.flushDeletes(
          (noteId, attachment) => target.sync!.deleteAttachment(noteId, attachment),
          id,
        );
        if (deletions.failed.length) throw new Error('Attachment deletion failed');
        await target.sync.push(tombstone);
        markPending(id, false, target.pendingKey);
      } catch {
        // The local tombstone and attachment deletion intents are durable;
        // performSync will retry them in the same order when connectivity returns.
        markPending(id, true, target.pendingKey);
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
    try {
      const restoredAttachments = await target.attachments.restoreForUndo(restored.id, restored.images ?? []);
      restored.images = restoredAttachments.length ? restoredAttachments : undefined;
      if (!await this.persistNote(restored, {}, target)) throw new Error('Failed to persist restored note');
    } catch (error) {
      const rollback = await Promise.allSettled([
        target.adapter?.deleteNote(restored.id) ?? Promise.resolve(),
        ...((note.images ?? []).map(attachment =>
          target.attachments.queueDelete(note.id, attachment, { retainBytes: true })
        )),
      ]);
      pending.state = 'consumed';
      console.error('Failed to undo note deletion:', error, rollback);
      if (target.context.isCurrent()) toastStore.show('Failed to restore note');
      return;
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

  toggleArchive(id: string) {
    const note = this.notes.find(n => n.id === id);
    if (note) {
      note.archived = !note.archived;
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
    await target.attachments.save(noteId, attachment, bytes, { pendingUpload: true });
    const next = this.portableNote(note);
    next.images = [...(next.images ?? []), attachment];
    next.updatedAt = Date.now();
    if (!await this.persistNote(next, {}, target)) {
      await target.attachments.delete(noteId, attachment.id);
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
    const stored = await target.attachments.get(noteId, attachmentId);
    const rollback = async () => {
      await target.attachments.cancelDelete(noteId, attachmentId);
      if (stored) {
        await target.attachments.save(noteId, stored.attachment, stored.bytes, { pendingUpload: true });
      }
    };
    try {
      await target.attachments.queueDelete(noteId, attachment);
    } catch (error) {
      // queueDelete records intent first, so explicitly roll it back if a
      // later local write fails before the visible note has changed.
      await rollback();
      if (target.context.isCurrent()) {
        console.error('Failed to queue attachment deletion:', error);
        toastStore.show('Failed to remove attachment');
      }
      return;
    }
    const next = this.portableNote(note);
    next.images = next.images?.filter(value => value.id !== attachmentId);
    if (!next.images?.length) next.images = undefined;
    next.updatedAt = Date.now();
    if (!await this.persistNote(next, {}, target)) {
      await rollback();
      return;
    }
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
    if (!adapter.saveNotesAtomically) {
      throw new Error('The active storage adapter does not support atomic imports');
    }
    const context = this.syncCoordinator.capture();
    const store = attachmentStore;
    const urls = attachmentUrls;
    const importPendingKey = pendingSyncKey;
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
    const pendingBefore = pendingIds(importPendingKey);
    const pendingAfter = new Set(pendingBefore);
    for (const note of portable) pendingAfter.add(note.id);
    await beginImportJournal(clientStorage, activeJournalKey, portable, attachments);
    try {
      localStorage.setItem(importPendingKey, JSON.stringify([...pendingAfter]));
      await commitImportBatch(portable, attachments, {
        saveAttachment: imported => store.save(
          imported.noteId,
          imported.attachment,
          imported.bytes,
          { pendingUpload: true },
        ),
        deleteAttachment: (noteId, attachmentId) => store.delete(noteId, attachmentId),
        saveNotesAtomically: values => adapter.saveNotesAtomically!(values),
      });
    } catch (error) {
      try {
        await recoverImportJournal({
          storage: clientStorage,
          journalKey: activeJournalKey,
          adapter,
          attachments: store,
          readPendingNoteIds: () => pendingIds(importPendingKey),
          writePendingNoteIds: ids => localStorage.setItem(importPendingKey, JSON.stringify([...ids])),
        });
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'Import failed and durable rollback must retry on next startup');
      }
      throw error;
    }

    try { await clientStorage.delete(activeJournalKey); }
    catch (error) { console.warn('Committed import journal will be finalized on next startup:', error); }

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
        const deletions = await attachmentStore.flushDeletes((noteId, attachment) =>
          encryptedSync.deleteAttachment(noteId, attachment));
        if (!context.isCurrent()) return;
        const uploads = await attachmentStore.flushUploads((noteId, attachment, bytes) =>
          encryptedSync.uploadAttachment(noteId, attachment, bytes));
        if (!context.isCurrent()) return;
        const attachmentFailures = new Set([
          ...deletions.failed.map(value => value.noteId),
          ...uploads.failed.map(value => value.noteId),
        ]);
        for (const noteId of attachmentFailures) markPending(noteId, true);
        for (const id of pendingIds()) {
          if (attachmentFailures.has(id)) continue;
          try {
            await encryptedSync.push(await adapter.getNote(id));
            if (!context.isCurrent()) return;
            markPending(id, false);
          } catch (error) {
            if (error instanceof RecordConflictError) {
              const preserved = await useForCurrentVault(
                context,
                () => adapter.getNote(id),
                note => this.preserveConflict(note, target),
              );
              if (!context.isCurrent()) return;
              if (preserved) markPending(id, false, target.pendingKey);
            }
            // Other failures stay queued. Pulling unrelated revisions is still useful.
          }
        }
        const pulled = await encryptedSync.pull();
        if (!context.isCurrent()) return;
        const attachmentBytes = new Set<string>();
        for (const value of pulled.attachments) {
          await attachmentStore.save(value.noteId, value.attachment, value.bytes);
          if (!context.isCurrent()) return;
          attachmentBytes.add(`${value.noteId}:${value.attachment.id}`);
        }
        for (const { noteId, attachmentId } of pulled.deletedAttachments) {
          attachmentUrls.release(noteId, attachmentId);
          await attachmentStore.applyRemoteDelete(noteId, attachmentId);
          if (!context.isCurrent()) return;
          const existing = this.notes.find(note => note.id === noteId);
          if (!existing?.images?.some(attachment => attachment.id === attachmentId)) continue;
          existing.images = existing.images.filter(attachment => attachment.id !== attachmentId);
          if (!existing.images.length) existing.images = undefined;
          await adapter.saveNote(this.portableNote(existing));
          if (!context.isCurrent()) return;
        }
        for (const note of pulled.notes) {
          for (const attachment of note.images ?? []) {
            const key = `${note.id}:${attachment.id}`;
            if (!attachmentBytes.has(key) && !await attachmentStore.get(note.id, attachment.id)) {
              throw new Error(`Attachment bytes unavailable: ${attachment.name}`);
            }
          }
          const portable = this.portableNote(note);
          await adapter.saveNote(portable);
          if (!context.isCurrent()) return;
          const hydrated = await attachmentUrls.hydrate(portable);
          if (!context.isCurrent()) return;
          const existing = this.notes.find(value => value.id === note.id);
          if (existing) {
            for (const attachment of existing.images ?? []) {
              if (!hydrated.images?.some(value => value.id === attachment.id)) {
                attachmentUrls.release(note.id, attachment.id);
              }
            }
            Object.assign(existing, hydrated);
          } else {
            this.notes.push(hydrated);
          }
          this.preservedConflicts.delete(note.id);
        }
        for (const id of pulled.deletedIds) {
          const existing = this.notes.find(note => note.id === id);
          await applyRemoteNoteTombstone(adapter, id);
          if (!context.isCurrent()) return;
          for (const attachment of existing?.images ?? []) {
            attachmentUrls.release(id, attachment.id);
            await attachmentStore.applyRemoteDelete(id, attachment.id);
            if (!context.isCurrent()) return;
          }
          this.notes = this.notes.filter(note => note.id !== id);
          this.preservedConflicts.delete(id);
        }
        await encryptedSync.acknowledge(pulled.cursor, pulled.revisions);
        if (!context.isCurrent()) return;
        if (attachmentFailures.size) {
          this.syncStatus = 'offline';
          return;
        }
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
