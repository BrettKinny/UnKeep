import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
  OAuthProviderConfig,
} from '../adapter.js';

interface GoogleDriveConfig {
  accessToken: string;
  folderName: string;
}

function parseConfig(config: AdapterConfig): GoogleDriveConfig {
  return {
    accessToken: config.accessToken as string,
    folderName: (config.folderName as string) || 'UnKeep',
  };
}

export class GoogleDriveAdapter implements StorageAdapter {
  id = 'googledrive';
  displayName = 'Google Drive';
  description = 'Store notes in your Google Drive account. Sign in with OAuth.';

  configSchema: ConfigField[] = [
    {
      key: 'clientId',
      label: 'Client ID',
      type: 'text',
      placeholder: '123456789.apps.googleusercontent.com',
      helpText: 'Create OAuth credentials at https://console.cloud.google.com/apis/credentials. Use "Web application" type.',
      required: true,
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      type: 'password',
      placeholder: 'GOCSPX-...',
      helpText: 'Google requires a client secret even for browser apps. Your secret stays in your browser only.',
      required: true,
    },
    {
      key: 'folderName',
      label: 'Folder Name',
      type: 'text',
      placeholder: 'UnKeep',
      helpText: 'Folder name in Google Drive. Will be created if it does not exist. Defaults to "UnKeep".',
    },
  ];

  oauthConfig: OAuthProviderConfig = {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    requiresSecret: true,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  };

  private config: GoogleDriveConfig | null = null;
  private folderId: string | null = null;

  private headers(): Record<string, string> {
    if (!this.config) throw new Error('GoogleDriveAdapter not initialized');
    return { Authorization: `Bearer ${this.config.accessToken}` };
  }

  private async findOrCreateFolder(): Promise<string> {
    if (!this.config) throw new Error('GoogleDriveAdapter not initialized');
    if (this.folderId) return this.folderId;

    const query = encodeURIComponent(
      `name='${this.config.folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
      { headers: this.headers() }
    );
    if (!searchRes.ok) throw new Error(`Failed to search for folder: ${searchRes.status}`);
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
      this.folderId = searchData.files[0].id;
      return this.folderId!;
    }

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.config.folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!createRes.ok) throw new Error(`Failed to create folder: ${createRes.status}`);
    const folderData = await createRes.json();
    this.folderId = folderData.id;
    return this.folderId!;
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
    this.folderId = null;
    await this.findOrCreateFolder();
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
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

  private async findFile(name: string): Promise<string | null> {
    const folderId = await this.findOrCreateFolder();
    const query = encodeURIComponent(
      `name='${name}' and '${folderId}' in parents and trashed=false`
    );
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
      { headers: this.headers() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.files?.[0]?.id || null;
  }

  async listNotes(): Promise<NoteMetadata[]> {
    const folderId = await this.findOrCreateFolder();
    const notes: NoteMetadata[] = [];
    let pageToken: string | undefined;

    do {
      const query = encodeURIComponent(
        `'${folderId}' in parents and trashed=false and name contains '.json'`
      );
      let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&pageSize=1000`;
      if (pageToken) url += `&pageToken=${pageToken}`;

      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);

      const data = await res.json();
      for (const file of data.files || []) {
        if (file.name.endsWith('.json')) {
          const id = file.name.replace(/\.json$/, '');
          const updatedAt = new Date(file.modifiedTime).getTime();
          notes.push({ id, updatedAt });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    const fileId = await this.findFile(`${id}.json`);
    if (!fileId) throw new Error(`Note ${id} not found`);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);
    return res.json();
  }

  async saveNote(note: Note): Promise<void> {
    const fileName = `${note.id}.json`;
    const existingId = await this.findFile(fileName);
    const body = JSON.stringify(note);

    if (existingId) {
      const res = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body,
        }
      );
      if (!res.ok) throw new Error(`Failed to update note ${note.id}: ${res.status}`);
    } else {
      const folderId = await this.findOrCreateFolder();
      const metadata = {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json',
      };
      const boundary = 'unkeep_boundary';
      const multipartBody = [
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\n`,
        'Content-Type: application/json\r\n\r\n',
        body,
        `\r\n--${boundary}--`,
      ].join('');

      const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: {
            ...this.headers(),
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );
      if (!res.ok) throw new Error(`Failed to create note ${note.id}: ${res.status}`);
    }
  }

  async deleteNote(id: string): Promise<void> {
    const fileId = await this.findFile(`${id}.json`);
    if (!fileId) return;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      { method: 'DELETE', headers: this.headers() }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete note ${id}: ${res.status}`);
    }
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
