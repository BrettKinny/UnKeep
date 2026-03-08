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

interface GitConfig {
  baseUrl: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

interface GitFileInfo {
  name: string;
  path: string;
  sha: string;
  content?: string;
}

function parseConfig(config: AdapterConfig): GitConfig {
  return {
    baseUrl: (config.baseUrl as string).replace(/\/$/, ''),
    owner: config.owner as string,
    repo: config.repo as string,
    branch: (config.branch as string) || 'main',
    path: ((config.path as string) || 'notes/').replace(/\/$/, '') + '/',
    token: config.token as string,
  };
}

export class GitAdapter implements StorageAdapter {
  id = 'git';
  displayName = 'Git Repository';
  description = 'Store notes as markdown files in a GitHub, Gitea, or Forgejo repository.';

  configSchema: ConfigField[] = [
    {
      key: 'baseUrl',
      label: 'API Base URL',
      type: 'url',
      placeholder: 'https://api.github.com',
      helpText: 'Use https://api.github.com for GitHub, or your Gitea/Forgejo instance URL.',
      required: true,
    },
    {
      key: 'owner',
      label: 'Repository Owner',
      type: 'text',
      placeholder: 'your-username',
      helpText: 'Your GitHub/Gitea username or organization name.',
      required: true,
    },
    {
      key: 'repo',
      label: 'Repository Name',
      type: 'text',
      placeholder: 'my-notes',
      helpText: 'The repository where notes will be stored. Must already exist.',
      required: true,
    },
    {
      key: 'branch',
      label: 'Branch',
      type: 'text',
      placeholder: 'main',
      helpText: 'The branch to store notes on. Defaults to "main".',
    },
    {
      key: 'path',
      label: 'Notes Path',
      type: 'text',
      placeholder: 'notes/',
      helpText: 'Folder within the repo for notes. Defaults to "notes/".',
    },
    {
      key: 'token',
      label: 'Access Token',
      type: 'password',
      placeholder: 'ghp_...',
      helpText: 'Create a fine-grained token at github.com/settings/tokens — only needs Contents: Read and Write permission.',
      required: true,
    },
  ];

  private config: GitConfig | null = null;
  private shaCache = new Map<string, string>();

  private headers(): HeadersInit {
    if (!this.config) throw new Error('GitAdapter not initialized');
    return {
      Authorization: `token ${this.config.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  private apiUrl(path: string): string {
    if (!this.config) throw new Error('GitAdapter not initialized');
    const { baseUrl, owner, repo } = this.config;
    return `${baseUrl}/repos/${owner}/${repo}/contents/${path}`;
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = parseConfig(config);
  }

  async validate(config: AdapterConfig): Promise<ValidationResult> {
    try {
      const c = parseConfig(config);
      const res = await fetch(`${c.baseUrl}/repos/${c.owner}/${c.repo}`, {
        headers: {
          Authorization: `token ${c.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (!res.ok) {
        const body = await res.text();
        return { valid: false, error: `Repository access failed (${res.status}): ${body}` };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e}` };
    }
  }

  async listNotes(): Promise<NoteMetadata[]> {
    if (!this.config) throw new Error('GitAdapter not initialized');
    const url = this.apiUrl(this.config.path) + `?ref=${this.config.branch}`;
    const res = await fetch(url, { headers: this.headers() });

    if (res.status === 404) return []; // Empty folder
    if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);

    const files: GitFileInfo[] = await res.json();
    const notes: NoteMetadata[] = [];

    for (const file of files) {
      if (!file.name.endsWith('.md')) continue;
      const id = file.name.replace(/\.md$/, '');
      if (!isValidNoteId(id)) continue;
      this.shaCache.set(id, file.sha);
      // We can't get updatedAt from the listing, so we use 0 and rely on getNote for full data
      notes.push({ id, updatedAt: 0 });
    }

    return notes;
  }

  async getNote(id: string): Promise<Note> {
    validateNoteId(id);
    if (!this.config) throw new Error('GitAdapter not initialized');
    const url = this.apiUrl(`${this.config.path}${id}.md`) + `?ref=${this.config.branch}`;
    const res = await fetch(url, { headers: this.headers() });

    if (!res.ok) throw new Error(`Failed to get note ${id}: ${res.status}`);

    const data = await res.json();
    this.shaCache.set(id, data.sha);

    const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
    return markdownToNote(content);
  }

  async saveNote(note: Note): Promise<void> {
    validateNoteId(note.id);
    if (!this.config) throw new Error('GitAdapter not initialized');
    const path = `${this.config.path}${note.id}.md`;
    const content = btoa(unescape(encodeURIComponent(noteToMarkdown(note))));

    const body: Record<string, unknown> = {
      message: `Update note ${note.id}`,
      content,
      branch: this.config.branch,
    };

    const sha = this.shaCache.get(note.id);
    if (sha) body.sha = sha;

    const res = await fetch(this.apiUrl(path), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Failed to save note ${note.id}: ${res.status}`);

    const data = await res.json();
    this.shaCache.set(note.id, data.content.sha);
  }

  async deleteNote(id: string): Promise<void> {
    validateNoteId(id);
    if (!this.config) throw new Error('GitAdapter not initialized');
    const path = `${this.config.path}${id}.md`;

    let sha = this.shaCache.get(id);
    if (!sha) {
      // Need to fetch the SHA first
      const url = this.apiUrl(path) + `?ref=${this.config.branch}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Failed to get SHA for deletion of ${id}: ${res.status}`);
      const data = await res.json();
      sha = data.sha;
    }

    const res = await fetch(this.apiUrl(path), {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({
        message: `Delete note ${id}`,
        sha,
        branch: this.config.branch,
      }),
    });

    if (!res.ok) throw new Error(`Failed to delete note ${id}: ${res.status}`);
    this.shaCache.delete(id);
  }

  async getAllNotes(): Promise<Note[]> {
    if (!this.config) throw new Error('GitAdapter not initialized');
    const url = this.apiUrl(this.config.path) + `?ref=${this.config.branch}`;
    const res = await fetch(url, { headers: this.headers() });

    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);

    const files: GitFileInfo[] = await res.json();
    const mdFiles = files.filter(
      (f) => f.name.endsWith('.md') && isValidNoteId(f.name.replace(/\.md$/, ''))
    );

    // Fetch file contents in parallel, batched in groups of 10
    const batchSize = 10;
    const notes: Note[] = [];

    for (let i = 0; i < mdFiles.length; i += batchSize) {
      const batch = mdFiles.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (file) => {
          const fileUrl =
            this.apiUrl(`${this.config!.path}${file.name}`) +
            `?ref=${this.config!.branch}`;
          const fileRes = await fetch(fileUrl, { headers: this.headers() });
          if (!fileRes.ok)
            throw new Error(`Failed to get note ${file.name}: ${fileRes.status}`);
          const data = await fileRes.json();
          const id = file.name.replace(/\.md$/, '');
          this.shaCache.set(id, data.sha);
          const content = decodeURIComponent(
            escape(atob(data.content.replace(/\n/g, '')))
          );
          return markdownToNote(content);
        })
      );
      notes.push(...results);
    }

    return notes;
  }

  async sync(): Promise<SyncResult> {
    // For Git adapter, sync is implicit via API calls
    // A full sync would re-fetch all notes and reconcile
    return { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  }
}
