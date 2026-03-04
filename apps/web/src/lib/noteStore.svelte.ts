import { nanoid } from 'nanoid';
import type { Note, NoteColor, ChecklistItem, StorageAdapter } from '@unkeep/core';
import { LocalOnlyAdapter } from '@unkeep/core';

// Debounce timer for auto-save
let saveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const SAVE_DEBOUNCE_MS = 500;

class NoteStore {
  notes = $state<Note[]>([]);
  searchQuery = $state('');
  adapter: StorageAdapter | null = $state(null);
  loading = $state(true);
  syncStatus = $state<'synced' | 'syncing' | 'offline' | 'error'>('synced');

  filteredNotes = $derived.by(() => {
    let result = this.notes.filter(n => !n.deleted);
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(n => {
        if (n.content.toLowerCase().includes(q)) return true;
        if (n.checkboxes?.some(c => c.text.toLowerCase().includes(q))) return true;
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

  createNote(content: string = ''): Note {
    const note: Note = {
      id: nanoid(),
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
      await this.adapter.saveNote(note);
    } catch (e) {
      console.error('Failed to save note:', e);
      this.syncStatus = 'error';
    }
  }

  async deleteNote(id: string): Promise<Note | null> {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return null;
    const note = { ...this.notes[idx] };
    // Soft delete
    this.notes[idx].deleted = true;
    this.notes[idx].updatedAt = Date.now();
    if (this.adapter) {
      await this.adapter.deleteNote(id);
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
      const result = await this.adapter.sync();
      if (result.errors.length > 0) {
        this.syncStatus = 'error';
      } else {
        this.syncStatus = 'synced';
      }
      // Reload notes after sync
      if (result.pulled > 0) {
        await this.loadNotes();
      }
    } catch {
      this.syncStatus = 'error';
    }
  }
}

export const noteStore = new NoteStore();
