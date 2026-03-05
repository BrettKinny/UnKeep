import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';

interface OneDriveConfig {
  accessToken: string;
  path: string;
}

function parseConfig(config: AdapterConfig): OneDriveConfig {
  let path = ((config.path as string) || '/UnKeep').replace(/\/$/, '');
  if (!path.startsWith('/')) path = '/' + path;
  return {
    accessToken: config.accessToken as string,
    path,
  };
}

export class OneDriveAdapter implements StorageAdapter {
  id = 'onedrive';
  displayName = 'OneDrive';
  description = 'Store notes in your Microsoft OneDrive account.';

  configSchema: ConfigField[] = [
    {
      key: 'accessToken',
      label: 'Access Token',
      type: 'password',
      placeholder: 'EwB...',
      helpText: 'A Microsoft Graph API access token with Files.ReadWrite scope. Generate one via the Microsoft Graph Explorer (https://developer.microsoft.com/graph/graph-explorer).',
      required: true,
    },
    {
      key: 'path',
      label: 'Folder Path',
      type: 'text',
      placeholder: '/UnKeep',
      helpText: 'Folder path in OneDrive root. Defaults to "/UnKeep".',
    },
  ];

  private config: OneDriveConfig | null = null;

  private headers(): Record<string, string> {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');
    return { Authorization: `Bearer ${this.config.accessToken}` };
  }

  private itemByPath(filePath?: string): string {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');
    const base = this.config.path;
    const full = filePath ? `${base}/${filePath}` : base;
    return `https://graph.microsoft.com/v1.0/me/drive/root:${full}`;
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
    // Ensure folder exists by creating it
    try {
      const parts = this.config.path.split('/').filter(Boolean);
      const folderName = parts[parts.length - 1];
      const parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '';
      const parentUrl = parentPath
        ? `https://graph.microsoft.com/v1.0/me/drive/root:${parentPath}:/children`
        : 'https://graph.microsoft.com/v1.0/me/drive/root/children';

      await fetch(parentUrl, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: folderName,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }),
      });
    } catch {
      // Folder may already exist
    }
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${c.accessToken}` },
      });
      if (!res.ok) {
        return { valid: false, error: `Authentication failed (${res.status}). Check your access token.` };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async listNotes(): Promise<NoteMetadata[]> {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');

    const notes: NoteMetadata[] = [];
    let url: string | null = `${this.itemByPath()}:/children?$select=name,lastModifiedDateTime&$top=200`;

    while (url) {
      const res = await fetch(url, { headers: this.headers() });

      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`Failed to list notes: ${res.status}`);
      }

      const data = await res.json();
      for (const item of data.value || []) {
        if (item.name?.endsWith('.json')) {
          const id = item.name.replace(/\.json$/, '');
          const updatedAt = new Date(item.lastModifiedDateTime).getTime();
          notes.push({ id, updatedAt });
        }
      }
      url = data['@odata.nextLink'] || null;
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');

    const res = await fetch(`${this.itemByPath(`${id}.json`)}:/content`, {
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);
    return res.json();
  }

  async saveNote(note: Note): Promise<void> {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');

    const body = JSON.stringify(note);
    const res = await fetch(`${this.itemByPath(`${note.id}.json`)}:/content`, {
      method: 'PUT',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) throw new Error(`Failed to save note ${note.id}: ${res.status}`);
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.config) throw new Error('OneDriveAdapter not initialized');

    const res = await fetch(this.itemByPath(`${id}.json`), {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete note ${id}: ${res.status}`);
    }
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
