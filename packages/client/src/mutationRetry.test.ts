import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteAttachment } from '@unkeep/core';
import { EncryptedSync } from './sync.js';
import { MemoryClientStorage } from './storage.js';
import type { RelaySession } from './relay.js';

const session: RelaySession = {
  endpoint: 'https://relay.example.test',
  instanceId: 'vault-one',
  deviceId: 'device-one',
  credential: 'credential-one',
};
const masterKey = new Uint8Array(32).fill(9);

function note(content: string): Note {
  return {
    id: 'retry-note',
    content,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
  };
}

function success(revision: number): Response {
  return new Response(JSON.stringify({ revision }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('durable mutation retries', () => {
  it('reuses the exact mutation and encrypted payload after an unknown response outcome', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'))
      .mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EncryptedSync(session, masterKey, storage).push(note('first version')))
      .rejects.toThrow('connection reset');
    await expect(new EncryptedSync(session, masterKey, storage).push(note('first version')))
      .resolves.toBe(7);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const retriedBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(retriedBody).toEqual(firstBody);
  });

  it('settles an unknown older mutation before sending a newer local edit', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(success(3))
      .mockResolvedValueOnce(success(4));
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);

    await expect(sync.push(note('older local edit'))).rejects.toThrow('response lost');
    await expect(sync.push({ ...note('newer local edit'), updatedAt: 2 })).resolves.toBe(4);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const unknownBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const settledBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    const newerBody = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(settledBody).toEqual(unknownBody);
    expect(newerBody.mutationId).not.toBe(unknownBody.mutationId);
    expect(newerBody.baseRevision).toBe(3);
  });

  it('settles an unknown attachment upload before sending its deletion', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('upload response lost'))
      .mockResolvedValueOnce(success(5))
      .mockResolvedValueOnce(success(6));
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);
    const attachment: NoteAttachment = {
      id: 'retry-attachment',
      name: 'proof.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    };

    await expect(sync.uploadAttachment('retry-note', attachment, new Uint8Array([1, 2, 3])))
      .rejects.toThrow('upload response lost');
    await sync.deleteAttachment('retry-note', attachment);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const upload = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const uploadRetry = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    const deletion = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(uploadRetry).toEqual(upload);
    expect(deletion).toMatchObject({ deleted: true, baseRevision: 5 });
    expect(deletion.mutationId).not.toBe(upload.mutationId);
  });
});
