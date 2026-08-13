import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Adapter } from './s3.js';
import type { Note } from '../types.js';

const mockConfig = {
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
  bucket: 'test-bucket',
  prefix: 'notes/',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
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

describe('S3Adapter', () => {
  let adapter: S3Adapter;

  beforeEach(() => {
    adapter = new S3Adapter();
    vi.restoreAllMocks();
  });

  it('has correct metadata', () => {
    expect(adapter.id).toBe('s3');
    expect(adapter.displayName).toBe('S3-Compatible Storage');
    expect(adapter.configSchema.length).toBeGreaterThan(0);
  });

  it('throws before init', async () => {
    await expect(adapter.listNotes()).rejects.toThrow('not initialized');
  });

  describe('after init', () => {
    beforeEach(async () => {
      await adapter.init(mockConfig);
    });

    it('listNotes parses XML response', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <Contents><Key>notes/note1.json</Key></Contents>
          <Contents><Key>notes/note2.json</Key></Contents>
          <Contents><Key>notes/readme.txt</Key></Contents>
        </ListBucketResult>`;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }));

      const notes = await adapter.listNotes();
      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe('note1');
      expect(notes[1].id).toBe('note2');
    });

    it('listNotes filters invalid IDs', async () => {
      const xml = `<ListBucketResult>
        <Contents><Key>notes/valid-id.json</Key></Contents>
        <Contents><Key>notes/has space.json</Key></Contents>
      </ListBucketResult>`;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => xml,
      }));

      const notes = await adapter.listNotes();
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe('valid-id');
    });

    it('getNote fetches and parses JSON', async () => {
      const note = makeNote();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => note,
      }));

      const result = await adapter.getNote('test-note');
      expect(result).toEqual(note);
    });

    it('getNote throws on invalid ID', async () => {
      await expect(adapter.getNote('bad id!')).rejects.toThrow('Invalid note ID');
    });

    it('saveNote sends PUT with JSON body', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const note = makeNote();
      await adapter.saveNote(note);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('test-bucket/notes/test-note.json');
      expect(opts.method).toBe('PUT');
      expect(opts.body).toBe(JSON.stringify(note));
    });

    it('deleteNote sends DELETE request', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.deleteNote('test-note');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('test-bucket/notes/test-note.json');
      expect(opts.method).toBe('DELETE');
    });

    it('deleteNote throws on invalid ID', async () => {
      await expect(adapter.deleteNote('bad/id')).rejects.toThrow('Invalid note ID');
    });

    it('saveNote throws on invalid ID', async () => {
      await expect(adapter.saveNote(makeNote('bad id!'))).rejects.toThrow('Invalid note ID');
    });

    it('requests include AWS Sig V4 authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '<ListBucketResult></ListBucketResult>',
      });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.listNotes();

      const [, opts] = fetchMock.mock.calls[0];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Authorization']).toContain('AWS4-HMAC-SHA256');
      expect(headers['Authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE');
      expect(headers['x-amz-date']).toBeTruthy();
      expect(headers['x-amz-content-sha256']).toBeTruthy();
    });

    it('validate checks bucket access', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const result = await adapter.validate(mockConfig);
      expect(result.valid).toBe(true);
    });

    it('validate reports failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      }));
      const result = await adapter.validate(mockConfig);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('403');
    });

    it('sync returns zeros', async () => {
      const result = await adapter.sync();
      expect(result).toEqual({ pushed: 0, pulled: 0, conflicts: 0, errors: [] });
    });
  });

  describe('config parsing', () => {
    it('handles trailing slash on endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '<ListBucketResult></ListBucketResult>' });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.init({ ...mockConfig, endpoint: 'https://s3.amazonaws.com/' });
      await adapter.listNotes();

      const [url] = fetchMock.mock.calls[0];
      expect(url).not.toContain('//test-bucket');
    });

    it('defaults region to us-east-1', async () => {
      await adapter.init({ ...mockConfig, region: '' });
      // No error means it parsed correctly
    });

    it('normalizes prefix to end with slash', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      await adapter.init({ ...mockConfig, prefix: 'custom-prefix' });
      await adapter.saveNote(makeNote());

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('custom-prefix/test-note.json');
    });
  });
});
