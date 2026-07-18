import { nanoid } from 'nanoid';
import type { Note, NoteColor, ChecklistItem, StorageAdapter } from '@unkeep/core';
import { LocalOnlyAdapter } from '@unkeep/core';
import { toastStore } from './toast.svelte';
import { EncryptedSync } from './encryptedSync';
import type { RelaySession } from './relayClient';
import { attachmentSizeError } from './attachments';

// Debounce timer for auto-save
let saveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const SAVE_DEBOUNCE_MS = 500;
const PENDING_SYNC_KEY = 'unkeep-pending-note-ids';

function pendingIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PENDING_SYNC_KEY) ?? '[]') as string[]); }
  catch { return new Set(); }
}

function markPending(id: string, pending: boolean): void {
  const ids = pendingIds();
  if (pending) ids.add(id); else ids.delete(id);
  localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify([...ids]));
}

class NoteStore {
  notes = $state<Note[]>([]);
  searchQuery = $state('');
  adapter: StorageAdapter | null = $state(null);
  loading = $state(true);
  syncStatus = $state<'synced' | 'syncing' | 'offline' | 'error'>('synced');
  private encryptedSync: EncryptedSync | null = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private readonly wakeSync = () => void this.sync();
  private readonly syncWhenVisible = () => {
    if (document.visibilityState === 'visible') void this.sync();
  };

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

  async init() {
    this.loading = true;
    try {
      const adapter = new LocalOnlyAdapter();
      await adapter.init({});
      this.adapter = adapter;
      await this.loadNotes();
    } catch (e) {
      console.error('Failed to initialize store:', e);
      this.syncStatus = 'error';
    } finally {
      this.loading = false;
    }
  }

  async enableEncryptedSync(session: RelaySession, masterKey: Uint8Array<ArrayBuffer>) {
    this.unsubscribeRealtime?.();
    window.removeEventListener('online', this.wakeSync);
    document.removeEventListener('visibilitychange', this.syncWhenVisible);
    this.encryptedSync = new EncryptedSync(session, masterKey);
    this.unsubscribeRealtime = this.encryptedSync.subscribe(() => void this.sync());
    window.addEventListener('online', this.wakeSync);
    document.addEventListener('visibilitychange', this.syncWhenVisible);
    // One-time migration of notes created before encrypted sync was configured.
    if (this.encryptedSync.cursor === 0) {
      for (const note of this.notes) await this.encryptedSync.push($state.snapshot(note) as Note);
    }
    await this.sync();
  }

  disableEncryptedSync() {
    this.unsubscribeRealtime?.();
    window.removeEventListener('online', this.wakeSync);
    document.removeEventListener('visibilitychange', this.syncWhenVisible);
    this.unsubscribeRealtime = null;
    this.encryptedSync = null;
    this.notes = [];
  }

  async initWithAdapter(adapter: StorageAdapter, config: Record<string, unknown>) {
    this.loading = true;
    try {
      await adapter.init(config);
      this.adapter = adapter;
      await this.loadNotes();
    } catch (e) {
      console.error('Failed to initialize store:', e);
      this.syncStatus = 'error';
    } finally {
      this.loading = false;
    }
  }

  private async loadNotes() {
    if (!this.adapter) return;
    if (this.adapter.getAllNotes) {
      const all = await this.adapter.getAllNotes();
      this.notes = all.filter(n => !n.deleted);
    } else {
      const metaList = await this.adapter.listNotes();
      const loaded: Note[] = [];
      for (const meta of metaList) {
        if (!meta.deleted) {
          try {
            const note = await this.adapter.getNote(meta.id);
            loaded.push(note);
          } catch {
            // Skip notes that fail to load
          }
        }
      }
      this.notes = loaded;
    }
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
    this.persistNote(note);
    return note;
  }

  updateNote(id: string, updates: Partial<Omit<Note, 'id' | 'createdAt'>>) {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return;
    const note = this.notes[idx];
    Object.assign(note, updates, { updatedAt: Date.now() });
    this.debouncedSave(note);
  }

  private debouncedSave(note: Note) {
    const existing = saveTimers.get(note.id);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      note.id,
      setTimeout(() => {
        this.persistNote(note);
        saveTimers.delete(note.id);
      }, SAVE_DEBOUNCE_MS)
    );
  }

  private async persistNote(note: Note) {
    if (!this.adapter) return;
    try {
      await this.adapter.saveNote($state.snapshot(note) as Note);
      if (this.encryptedSync) {
        try {
          await this.encryptedSync.push($state.snapshot(note) as Note);
          markPending(note.id, false);
        } catch (error) {
          markPending(note.id, true);
          console.warn('Remote sync queued:', error);
          this.syncStatus = 'offline';
          return;
        }
      }
      this.syncStatus = 'synced';
    } catch (e) {
      console.error('Failed to save note:', e);
      this.syncStatus = 'error';
      toastStore.show('Failed to save note');
    }
  }

  async deleteNote(id: string): Promise<Note | null> {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return null;
    const note = { ...this.notes[idx] };
    const previousUpdatedAt = this.notes[idx].updatedAt;
    // Soft delete
    this.notes[idx].deleted = true;
    this.notes[idx].updatedAt = Date.now();
    if (this.adapter) {
      try {
        await this.adapter.deleteNote(id);
        if (this.encryptedSync) {
          const tombstone = await this.adapter.getNote(id);
          try {
            await this.encryptedSync.push(tombstone);
            markPending(id, false);
          } catch {
            markPending(id, true);
            this.syncStatus = 'offline';
          }
        }
      } catch (e) {
        console.error('Failed to delete note:', e);
        // Revert the soft delete
        this.notes[idx].deleted = false;
        this.notes[idx].updatedAt = previousUpdatedAt;
        toastStore.show('Failed to delete note');
        return null;
      }
    }
    // Remove from visible array
    this.notes = this.notes.filter(n => n.id !== id || !n.deleted);
    return note; // Return for undo
  }

  async undoDelete(note: Note) {
    note.deleted = false;
    note.updatedAt = Date.now();
    this.notes.push(note);
    this.persistNote(note);
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
    const sizeError = attachmentSizeError(file);
    if (sizeError) {
      toastStore.show(sizeError);
      return;
    }
    const note = this.notes.find(n => n.id === noteId);
    if (!note) return;
    const attachment = {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      url: URL.createObjectURL(file),
    };
    note.images = [...(note.images ?? []), attachment];
    note.updatedAt = Date.now();
    await this.adapter?.saveNote($state.snapshot(note) as Note);
    if (this.encryptedSync) {
      try {
        await this.encryptedSync.uploadAttachment(
          noteId,
          attachment,
          new Uint8Array(await file.arrayBuffer()),
        );
        await this.encryptedSync.push($state.snapshot(note) as Note);
      } catch {
        markPending(noteId, true);
        this.syncStatus = 'offline';
        toastStore.show('Attachment saved locally and queued for sync');
      }
    }
  }

  async importNotes(notes: Note[]) {
    for (const note of notes) {
      this.notes.push(note);
      await this.persistNote(note);
    }
  }

  async sync() {
    if (!this.adapter) return;
    this.syncStatus = 'syncing';
    try {
      if (this.encryptedSync) {
        for (const id of pendingIds()) {
          try {
            await this.encryptedSync.push(await this.adapter.getNote(id));
            markPending(id, false);
          } catch {
            // Keep queued. Pulling other revisions is still useful while one write fails.
          }
        }
        const pulled = await this.encryptedSync.pull();
        for (const note of pulled.notes) await this.adapter.saveNote(note);
        for (const id of pulled.deletedIds) {
          try { await this.adapter.deleteNote(id); } catch { /* already absent locally */ }
        }
        if (pulled.notes.length || pulled.deletedIds.length) await this.loadNotes();
      } else {
        const result = await this.adapter.sync();
        if (result.errors.length > 0) throw new Error(result.errors.join(', '));
      }
      this.syncStatus = 'synced';
    } catch {
      this.syncStatus = 'error';
    }
  }
}

export const noteStore = new NoteStore();
