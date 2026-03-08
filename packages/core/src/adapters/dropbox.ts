import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
  OAuthProviderConfig,
} from '../adapter.js';

interface DropboxConfig {
  accessToken: string;
  path: string;
}

function parseConfig(config: AdapterConfig): DropboxConfig {
  let path = ((config.path as string) || '/UnKeep').replace(/\/$/, '');
  if (!path.startsWith('/')) path = '/' + path;
  return {
    accessToken: config.accessToken as string,
    path,
  };
}

export class DropboxAdapter implements StorageAdapter {
  id = 'dropbox';
  displayName = 'Dropbox';
  description = 'Store notes in your Dropbox account. Sign in with OAuth.';

  configSchema: ConfigField[] = [
    {
      key: 'clientId',
      label: 'App Key (Client ID)',
      type: 'text',
      placeholder: 'your-dropbox-app-key',
      helpText: 'Create an app at https://www.dropbox.com/developers/apps and copy the App Key.',
      required: true,
    },
    {
      key: 'path',
      label: 'Folder Path',
      type: 'text',
      placeholder: '/UnKeep',
      helpText: 'Folder in Dropbox where notes will be stored. Defaults to "/UnKeep".',
    },
  ];

  oauthConfig: OAuthProviderConfig = {
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: [],
    requiresSecret: false,
    extraAuthParams: { token_access_type: 'offline' },
  };

  private config: DropboxConfig | null = null;

  private headers(): Record<string, string> {
    if (!this.config) throw new Error('DropboxAdapter not initialized');
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
    try {
      await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path: this.config.path, autorename: false }),
      });
    } catch {
      // Folder may already exist
    }
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
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
    if (!this.config) throw new Error('DropboxAdapter not initialized');

    const notes: NoteMetadata[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      let res: Response;
      if (!cursor) {
        res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ path: this.config.path, recursive: false }),
        });
      } else {
        res = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ cursor }),
        });
      }

      if (!res.ok) {
        const text = await res.text();
        if (text.includes('path/not_found')) return [];
        throw new Error(`Failed to list notes: ${res.status}`);
      }

      const data = await res.json();
      for (const entry of data.entries) {
        if (entry['.tag'] === 'file' && entry.name.endsWith('.json')) {
          const id = entry.name.replace(/\.json$/, '');
          const updatedAt = new Date(entry.server_modified).getTime();
          notes.push({ id, updatedAt });
        }
      }
      hasMore = data.has_more;
      cursor = data.cursor;
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    if (!this.config) throw new Error('DropboxAdapter not initialized');
    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `${this.config.path}/${id}.json` }),
      },
    });
    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);
    return res.json();
  }

  async saveNote(note: Note): Promise<void> {
    if (!this.config) throw new Error('DropboxAdapter not initialized');
    const body = JSON.stringify(note);
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          path: `${this.config.path}/${note.id}.json`,
          mode: 'overwrite',
          mute: true,
        }),
        'Content-Type': 'application/octet-stream',
      },
      body,
    });
    if (!res.ok) throw new Error(`Failed to save note ${note.id}: ${res.status}`);
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.config) throw new Error('DropboxAdapter not initialized');
    const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ path: `${this.config.path}/${id}.json` }),
    });
    if (!res.ok) throw new Error(`Failed to delete note ${id}: ${res.status}`);
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
