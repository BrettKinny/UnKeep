import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';

interface PCloudConfig {
  accessToken: string;
  hostname: string;
  path: string;
}

function parseConfig(config: AdapterConfig): PCloudConfig {
  let path = ((config.path as string) || '/UnKeep').replace(/\/$/, '');
  if (!path.startsWith('/')) path = '/' + path;
  const hostname = (config.hostname as string) || 'api.pcloud.com';
  return {
    accessToken: config.accessToken as string,
    hostname,
    path,
  };
}

export class PCloudAdapter implements StorageAdapter {
  id = 'pcloud';
  displayName = 'pCloud';
  description = 'Store notes in your pCloud account.';

  configSchema: ConfigField[] = [
    {
      key: 'accessToken',
      label: 'Access Token',
      type: 'password',
      placeholder: '',
      helpText: 'Your pCloud OAuth access token. Generate one from the pCloud developer console (https://docs.pcloud.com/).',
      required: true,
    },
    {
      key: 'hostname',
      label: 'API Hostname',
      type: 'text',
      placeholder: 'api.pcloud.com',
      helpText: 'API hostname. Use "api.pcloud.com" for US or "eapi.pcloud.com" for EU. Defaults to "api.pcloud.com".',
    },
    {
      key: 'path',
      label: 'Folder Path',
      type: 'text',
      placeholder: '/UnKeep',
      helpText: 'Folder path in pCloud. Defaults to "/UnKeep".',
    },
  ];

  private config: PCloudConfig | null = null;

  private apiUrl(method: string, params?: Record<string, string>): string {
    if (!this.config) throw new Error('PCloudAdapter not initialized');
    const url = new URL(`https://${this.config.hostname}/${method}`);
    url.searchParams.set('access_token', this.config.accessToken);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
    // Ensure folder exists
    try {
      await fetch(this.apiUrl('createfolderifnotexists', { path: this.config.path }));
    } catch {
      // Ignore errors if folder already exists
    }
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const url = new URL(`https://${c.hostname}/userinfo`);
      url.searchParams.set('access_token', c.accessToken);
      const res = await fetch(url.toString());
      if (!res.ok) {
        return { valid: false, error: `Connection failed (${res.status}).` };
      }
      const data = await res.json();
      if (data.error) {
        return { valid: false, error: `Authentication failed: ${data.error}` };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async listNotes(): Promise<NoteMetadata[]> {
    if (!this.config) throw new Error('PCloudAdapter not initialized');

    const res = await fetch(this.apiUrl('listfolder', { path: this.config.path }));
    if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);

    const data = await res.json();
    if (data.error) {
      if (data.result === 2005) return []; // Folder not found
      throw new Error(`Failed to list notes: ${data.error}`);
    }

    const notes: NoteMetadata[] = [];
    for (const item of data.metadata?.contents || []) {
      if (!item.isfolder && item.name?.endsWith('.json')) {
        const id = item.name.replace(/\.json$/, '');
        const updatedAt = new Date(item.modified).getTime();
        notes.push({ id, updatedAt });
      }
    }
    return notes;
  }

  async getNote(id: string): Promise<Note> {
    if (!this.config) throw new Error('PCloudAdapter not initialized');

    // First get a file link, then download the content
    const path = `${this.config.path}/${id}.json`;
    const linkRes = await fetch(this.apiUrl('getfilelink', { path }));
    if (!linkRes.ok) throw new Error(`Failed to get note ${id}: ${linkRes.status}`);

    const linkData = await linkRes.json();
    if (linkData.error) throw new Error(`Failed to get note ${id}: ${linkData.error}`);

    const downloadUrl = `https://${linkData.hosts[0]}${linkData.path}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Failed to download note ${id}: ${res.status}`);
    return res.json();
  }

  async saveNote(note: Note): Promise<void> {
    if (!this.config) throw new Error('PCloudAdapter not initialized');

    const body = JSON.stringify(note);
    const blob = new Blob([body], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', blob, `${note.id}.json`);

    const url = this.apiUrl('uploadfile', {
      path: this.config.path,
      filename: `${note.id}.json`,
      nopartial: '1',
      renameifexists: '0',
    });

    // pCloud doesn't have a direct overwrite — delete first, then upload
    try {
      await this.deleteNote(note.id);
    } catch {
      // File may not exist yet
    }

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) throw new Error(`Failed to save note ${note.id}: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Failed to save note ${note.id}: ${data.error}`);
  }

  async deleteNote(id: string): Promise<void> {
    if (!this.config) throw new Error('PCloudAdapter not initialized');

    const path = `${this.config.path}/${id}.json`;
    const res = await fetch(this.apiUrl('deletefile', { path }));
    if (!res.ok) throw new Error(`Failed to delete note ${id}: ${res.status}`);

    const data = await res.json();
    if (data.error && data.result !== 2009) {
      // 2009 = file not found, which is fine for deletes
      throw new Error(`Failed to delete note ${id}: ${data.error}`);
    }
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
