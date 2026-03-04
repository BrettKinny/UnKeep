import type { Note, NoteMetadata } from '../types.js';
import type {
  StorageAdapter,
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
} from '../adapter.js';

interface WebDAVConfig {
  url: string;
  username: string;
  password: string;
  path: string;
}

function parseConfig(config: AdapterConfig): WebDAVConfig {
  return {
    url: (config.url as string).replace(/\/$/, ''),
    username: config.username as string,
    password: config.password as string,
    path: ((config.path as string) || '/notes/').replace(/\/$/, '') + '/',
  };
}

function authHeader(username: string, password: string): string {
  return 'Basic ' + btoa(`${username}:${password}`);
}

// Reuse the same markdown format as GitAdapter
function noteToMarkdown(note: Note): string {
  const frontmatter = [
    '---',
    `id: ${note.id}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    `pinned: ${note.pinned}`,
    `archived: ${note.archived}`,
    note.color ? `color: ${note.color}` : null,
    note.deleted ? `deleted: ${note.deleted}` : null,
    note.checkboxes ? `checkboxes: ${JSON.stringify(note.checkboxes)}` : null,
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}\n\n${note.content}`;
}

function markdownToNote(content: string): Note {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error('Invalid note format: no frontmatter');

  const fm = fmMatch[1];
  const body = fmMatch[2] || '';

  function getVal(key: string): string | undefined {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim();
  }

  const checkboxesRaw = getVal('checkboxes');
  let checkboxes;
  if (checkboxesRaw) {
    try { checkboxes = JSON.parse(checkboxesRaw); } catch { /* ignore */ }
  }

  return {
    id: getVal('id') || '',
    createdAt: parseInt(getVal('createdAt') || '0', 10),
    updatedAt: parseInt(getVal('updatedAt') || '0', 10),
    pinned: getVal('pinned') === 'true',
    archived: getVal('archived') === 'true',
    color: (getVal('color') as Note['color']) || undefined,
    deleted: getVal('deleted') === 'true' ? true : undefined,
    checkboxes,
    content: body,
  };
}

export class WebDAVAdapter implements StorageAdapter {
  id = 'webdav';
  displayName = 'WebDAV';
  description = 'Store notes on any WebDAV server (Nextcloud, ownCloud, etc).';

  configSchema: ConfigField[] = [
    {
      key: 'url',
      label: 'WebDAV URL',
      type: 'url',
      placeholder: 'https://cloud.example.com/remote.php/dav/files/username',
      helpText: 'Your WebDAV server URL. For Nextcloud: https://your-server/remote.php/dav/files/USERNAME',
      required: true,
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      placeholder: 'your-username',
      required: true,
    },
    {
      key: 'password',
      label: 'Password',
      type: 'password',
      placeholder: '',
      helpText: 'Your password or app-specific password.',
      required: true,
    },
    {
      key: 'path',
      label: 'Notes Path',
      type: 'text',
      placeholder: '/notes/',
      helpText: 'Remote folder for notes. Defaults to "/notes/".',
    },
  ];

  private config: WebDAVConfig | null = null;

  private fullUrl(file?: string): string {
    if (!this.config) throw new Error('WebDAVAdapter not initialized');
    const base = `${this.config.url}${this.config.path}`;
    return file ? `${base}${file}` : base;
  }

  private headers(): HeadersInit {
    if (!this.config) throw new Error('WebDAVAdapter not initialized');
    return {
      Authorization: authHeader(this.config.username, this.config.password),
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
    // Ensure the notes directory exists via MKCOL
    try {
      await fetch(this.fullUrl(), {
        method: 'MKCOL',
        headers: this.headers(),
      });
    } catch {
      // Directory might already exist, ignore errors
    }
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const res = await fetch(`${c.url}${c.path}`, {
        method: 'PROPFIND',
        headers: {
          Authorization: authHeader(c.username, c.password),
          Depth: '0',
        },
      });
      if (res.status === 404) {
        // Try to create the directory
        const mkres = await fetch(`${c.url}${c.path}`, {
          method: 'MKCOL',
          headers: { Authorization: authHeader(c.username, c.password) },
        });
        if (!mkres.ok && mkres.status !== 405) {
          return { valid: false, error: `Could not create notes folder (${mkres.status})` };
        }
        return { valid: true };
      }
      if (!res.ok && res.status !== 207) {
        return { valid: false, error: `WebDAV access failed (${res.status})` };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async listNotes(): Promise<NoteMetadata[]> {
    if (!this.config) throw new Error('WebDAVAdapter not initialized');
    const res = await fetch(this.fullUrl(), {
      method: 'PROPFIND',
      headers: {
        ...this.headers(),
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getlastmodified/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
    });

    if (!res.ok && res.status !== 207) {
      throw new Error(`Failed to list notes: ${res.status}`);
    }

    const xml = await res.text();
    const notes: NoteMetadata[] = [];

    // Parse PROPFIND response for .md files
    const hrefRegex = /<d:href>([^<]+)<\/d:href>/gi;
    let match;
    while ((match = hrefRegex.exec(xml)) !== null) {
      const href = decodeURIComponent(match[1]);
      if (href.endsWith('.md')) {
        const filename = href.split('/').pop()!;
        const id = filename.replace(/\.md$/, '');
        notes.push({ id, updatedAt: 0 });
      }
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    const res = await fetch(this.fullUrl(`${id}.md`), {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);
    const content = await res.text();
    return markdownToNote(content);
  }

  async saveNote(note: Note): Promise<void> {
    const content = noteToMarkdown(note);
    const res = await fetch(this.fullUrl(`${note.id}.md`), {
      method: 'PUT',
      headers: {
        ...this.headers(),
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      body: content,
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`Failed to save note ${note.id}: ${res.status}`);
    }
  }

  async deleteNote(id: string): Promise<void> {
    const res = await fetch(this.fullUrl(`${id}.md`), {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (!res.ok && res.status !== 204) {
      throw new Error(`Failed to delete note ${id}: ${res.status}`);
    }
  }

  async sync(): Promise<SyncResult> {
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
