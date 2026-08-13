import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';
import { noteToMarkdown, markdownToNote } from '../markdown.js';
import { validateNoteId, isValidNoteId } from '../validation.js';

const HANDLE_DB_NAME = 'unkeep-fs-handles';
const HANDLE_DB_VERSION = 1;
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'local-markdown-dir';

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    const store = tx.objectStore(HANDLE_STORE);
    const req = store.put(handle, HANDLE_KEY);
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const store = tx.objectStore(HANDLE_STORE);
      const req = store.get(HANDLE_KEY);
      req.onsuccess = () => {
        db.close();
        resolve(req.result ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  // showDirectoryPicker is on the global scope in supported browsers
  if (typeof showDirectoryPicker !== 'function') {
    throw new Error(
      'Your browser does not support the File System Access API. Please use Chrome, Edge, or Opera.'
    );
  }
  return await showDirectoryPicker({ id: 'unkeep-notes', mode: 'readwrite' });
}

export class LocalMarkdownAdapter implements StorageAdapter {
  id = 'local-markdown';
  displayName = 'Local Markdown Files';
  description = 'Save notes as .md files in a folder on your device (Chrome/Edge).';

  configSchema: ConfigField[] = [
    {
      key: 'folderLabel',
      label: 'Folder Label',
      type: 'text',
      placeholder: 'My Notes',
      helpText:
        'Optional label for this folder. After clicking Connect, your browser will ask you to select a folder.',
    },
  ];

  private dirHandle: FileSystemDirectoryHandle | null = null;

  async validate(_config: AdapterConfig): Promise<ValidationResult> {
    try {
      if (typeof showDirectoryPicker !== 'function') {
        return {
          valid: false,
          error:
            'Your browser does not support the File System Access API. Please use Chrome, Edge, or Opera.',
        };
      }

      const handle = await pickDirectory();
      await storeHandle(handle);
      this.dirHandle = handle;
      return { valid: true };
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { valid: false, error: 'Folder selection was cancelled.' };
      }
      return { valid: false, error: `Failed to select folder: ${e}` };
    }
  }

  async init(_config: AdapterConfig): Promise<void> {
    // If validate() already set the handle (normal setup flow), use it
    if (this.dirHandle) return;

    // Otherwise try to restore from IndexedDB (e.g. returning user)
    const stored = await getStoredHandle();
    if (stored) {
      const perm = await stored.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = stored;
        return;
      }
    }

    // Last resort: open picker (requires user gesture)
    this.dirHandle = await pickDirectory();
    await storeHandle(this.dirHandle);
  }

  private getDir(): FileSystemDirectoryHandle {
    if (!this.dirHandle) throw new Error('LocalMarkdownAdapter not initialized. Call init() first.');
    return this.dirHandle;
  }

  async listNotes(): Promise<NoteMetadata[]> {
    const dir = this.getDir();
    const notes: NoteMetadata[] = [];

    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
      const id = name.replace(/\.md$/, '');
      if (!isValidNoteId(id)) continue;
      // Read file to get metadata
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        const text = await file.text();
        const note = markdownToNote(text);
        notes.push({ id, updatedAt: note.updatedAt, deleted: note.deleted });
      } catch {
        // Skip unreadable files
        notes.push({ id, updatedAt: 0 });
      }
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    validateNoteId(id);
    const dir = this.getDir();
    const fileHandle = await dir.getFileHandle(`${id}.md`);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return markdownToNote(text);
  }

  async saveNote(note: Note): Promise<void> {
    validateNoteId(note.id);
    const dir = this.getDir();
    const fileHandle = await dir.getFileHandle(`${note.id}.md`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(noteToMarkdown(note));
    await writable.close();
  }

  async deleteNote(id: string): Promise<void> {
    validateNoteId(id);
    const dir = this.getDir();
    try {
      // Soft delete: update the file with deleted flag
      const fileHandle = await dir.getFileHandle(`${id}.md`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      const note = markdownToNote(text);
      note.deleted = true;
      note.updatedAt = Date.now();

      const writable = await fileHandle.createWritable();
      await writable.write(noteToMarkdown(note));
      await writable.close();
    } catch {
      // File doesn't exist — nothing to delete
    }
  }

  async sync(): Promise<SyncResult> {
    // No remote sync — files are written directly
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
