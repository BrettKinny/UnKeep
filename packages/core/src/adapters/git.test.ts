import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitAdapter } from './git.js';
import type { Note } from '../types.js';

const mockConfig = {
  baseUrl: 'https://api.github.com',
  owner: 'testuser',
  repo: 'notes',
  branch: 'main',
  path: 'notes/',
  token: 'ghp_test123',
};

function makeNote(id: string = 'test-note'): Note {
  return {
    id,
    content: 'Hello',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    pinned: false,
    archived: false,
  };
}

describe('GitAdapter', () => {
  let adapter: GitAdapter;

  beforeEach(() => {
    adapter = new GitAdapter();
    vi.restoreAllMocks();
  });

  it('has correct metadata', () => {
    expect(adapter.id).toBe('git');
    expect(adapter.displayName).toBe('Git Repository');
    expect(adapter.configSchema.length).toBeGreaterThan(0);
  });

  it('throws before init', async () => {
    await expect(adapter.listNotes()).rejects.toThrow('not initialized');
  });

  it('initializes with config', async () => {
    await adapter.init(mockConfig);
    // Should not throw after init
  });

  describe('after init', () => {
    beforeEach(async () => {
      await adapter.init(mockConfig);
    });

    it('listNotes returns empty on 404', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, ok: false }));
      const notes = await adapter.listNotes();
      expect(notes).toEqual([]);
    });

    it('listNotes parses file listing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { name: 'note1.md', path: 'notes/note1.md', sha: 'abc123' },
          { name: 'note2.md', path: 'notes/note2.md', sha: 'def456' },
          { name: 'readme.txt', path: 'notes/readme.txt', sha: 'ghi789' },
        ],
      }));

      const notes = await adapter.listNotes();
      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe('note1');
      expect(notes[1].id).toBe('note2');
    });

    it('listNotes filters invalid IDs', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { name: 'valid-id.md', path: 'notes/valid-id.md', sha: 'a' },
          { name: 'has space.md', path: 'notes/has space.md', sha: 'b' },
          { name: 'has.dot.md', path: 'notes/has.dot.md', sha: 'c' },
        ],
      }));

      const notes = await adapter.listNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe('valid-id');
    });

    it('getNote decodes base64 content', async () => {
      const markdown = '---\nid: test-note\ncreatedAt: 1700000000000\nupdatedAt: 1700000001000\npinned: false\narchived: false\n---\n\nHello';
      const base64Content = btoa(unescape(encodeURIComponent(markdown)));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sha: 'abc', content: base64Content }),
      }));

      const note = await adapter.getNote('test-note');
      expect(note.id).toBe('test-note');
      expect(note.content).toBe('Hello');
    });

    it('getNote throws on invalid ID', async () => {
      await expect(adapter.getNote('bad id!')).rejects.toThrow('Invalid note ID');
    });

    it('saveNote sends PUT with base64 content', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: { sha: 'new-sha' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.saveNote(makeNote());

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('notes/test-note.md');
      expect(opts.method).toBe('PUT');

      const body = JSON.parse(opts.body);
      expect(body.message).toContain('test-note');
      expect(body.branch).toBe('main');
      expect(typeof body.content).toBe('string');
    });

    it('saveNote includes SHA when cached', async () => {
      // First, populate the SHA cache via listNotes
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ name: 'test-note.md', path: 'notes/test-note.md', sha: 'cached-sha' }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ content: { sha: 'new-sha' } }),
        }));

      await adapter.listNotes();
      await adapter.saveNote(makeNote());

      const fetchMock = vi.mocked(fetch);
      const [, opts] = fetchMock.mock.calls[1];
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.sha).toBe('cached-sha');
    });

    it('deleteNote sends DELETE request', async () => {
      // Populate SHA cache first
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ name: 'test-note.md', path: 'notes/test-note.md', sha: 'del-sha' }],
        })
        .mockResolvedValueOnce({ ok: true }));

      await adapter.listNotes();
      await adapter.deleteNote('test-note');

      const fetchMock = vi.mocked(fetch);
      const [, opts] = fetchMock.mock.calls[1];
      expect((opts as RequestInit).method).toBe('DELETE');
    });

    it('validate checks repo access', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await adapter.validate(mockConfig);
      expect(result.valid).toBe(true);
    });

    it('validate reports failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      }));
      const result = await adapter.validate(mockConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('404');
    });

    it('sync returns zeros', async () => {
      const result = await adapter.sync();
      expect(result).toEqual({ pushed: 0, pulled: 0, conflicts: 0, errors: [] });
    });
  });
});
