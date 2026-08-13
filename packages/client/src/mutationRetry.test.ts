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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
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

  it('does not replay or erase another credential pending record mutation', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'))
      .mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.push(note('first version')))
      .rejects.toThrow('connection reset');
    await expect(new EncryptedSync(
      { ...session, credential: 'different-credential' },
      masterKey,
      storage,
    ).push(note('first version')))
      .rejects.toThrow(/belongs to another credential/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(original.push(note('first version'))).resolves.toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('authenticates a replacement credential and replays the exact pending payload', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'))
      .mockResolvedValueOnce(json({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.push(note('credential handoff')))
      .rejects.toThrow('connection reset');
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('credential handoff').id,
    )).resolves.toBe(7);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://relay.example.test/api/v1/vault');
    expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({
      authorization: 'Device replacement-credential',
    });
    expect(fetchMock.mock.calls[2]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    await expect(storage.get('unkeep-pending-mutation:vault-one:note:retry-note'))
      .resolves.toBeNull();
  });

  it('proof-binds retirement of a stale foreign retry before rebasing it', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('request never reached relay'))
      .mockResolvedValueOnce(json({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(json({
        error: 'record_conflict',
        currentRevision: 4,
      }, 409))
      .mockResolvedValueOnce(success(6));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.push(note('stale credential edit')))
      .rejects.toThrow('request never reached relay');
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.abandonPendingMutationAfterCredentialChange(
      'note',
      note('stale credential edit').id,
    )).resolves.toBe(false);
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('stale credential edit').id,
    )).rejects.toMatchObject({
      status: 409,
      code: 'record_conflict',
      currentRevision: 4,
    });
    await replacement.acknowledge(5, [{
      kind: 'note',
      id: note('stale credential edit').id,
      revision: 5,
    }]);
    await expect(replacement.rebasePendingNoteAfterCredentialChange(
      note('rebased credential edit'),
    ))
      .resolves.toBe(6);

    const originalBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const exactRetry = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    const rebased = JSON.parse(fetchMock.mock.calls[3]![1].body as string);
    expect(exactRetry).toEqual(originalBody);
    expect(rebased.mutationId).not.toBe(originalBody.mutationId);
    expect(rebased.baseRevision).toBe(5);
  });

  it('refuses to rebase a stale full note before the conflict revision is pulled', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('request did not reach relay'))
      .mockResolvedValueOnce(json({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(json({
        error: 'record_conflict',
        currentRevision: 4,
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    const key = 'unkeep-pending-mutation:vault-one:note:retry-note';

    await expect(original.push(note('stale full note')))
      .rejects.toThrow('request did not reach relay');
    const exactPending = await storage.get(key);
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('stale full note').id,
    )).rejects.toMatchObject({ code: 'record_conflict', currentRevision: 4 });
    await expect(replacement.rebasePendingNoteAfterCredentialChange(
      {
        ...note('would overwrite unseen remote fields'),
        title: 'stale title',
        labels: ['stale'],
      },
    )).rejects.toMatchObject({
      name: 'PendingMutationRebaseRequiresPullError',
      currentRevision: 4,
    });
    await expect(storage.get(key)).resolves.toEqual(exactPending);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not apply a stale rebase proof to a newer same-fingerprint mutation', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('old request did not reach relay'))
      .mockResolvedValueOnce(json({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(json({
        error: 'record_conflict',
        currentRevision: 4,
      }, 409))
      .mockResolvedValueOnce(success(5))
      .mockRejectedValueOnce(new TypeError('new request did not reach relay'))
      .mockResolvedValueOnce(success(6));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );

    await expect(original.push(note('same fingerprint')))
      .rejects.toThrow('old request did not reach relay');
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('same fingerprint').id,
    )).rejects.toMatchObject({ code: 'record_conflict' });
    await expect(original.push(note('same fingerprint'))).resolves.toBe(5);
    await expect(original.push(note('same fingerprint')))
      .rejects.toThrow('new request did not reach relay');

    await expect(replacement.abandonPendingMutationAfterCredentialChange(
      'note',
      note('same fingerprint').id,
    )).resolves.toBe(false);
    await expect(original.push(note('same fingerprint'))).resolves.toBe(6);

    const oldBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const newBody = JSON.parse(fetchMock.mock.calls[4]![1].body as string);
    expect(newBody.mutationId).not.toBe(oldBody.mutationId);
    expect(fetchMock.mock.calls[5]![1].body).toBe(fetchMock.mock.calls[4]![1].body);
  });

  it.each([
    [
      'invalid',
      [json({ error: 'invalid_device_credential' }, 401)],
      /invalid_device_credential/,
    ],
    [
      'read-only',
      [
        json({ vaultId: session.instanceId }),
        json({ error: 'service_credential_read_only' }, 403),
      ],
      /service_credential_read_only/,
    ],
  ])('does not let an %s replacement erase another credential retry', async (
    _description,
    replacementResponses,
    expectedError,
  ) => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'));
    for (const response of replacementResponses) {
      fetchMock.mockResolvedValueOnce(response);
    }
    fetchMock.mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);
    const key = 'unkeep-pending-mutation:vault-one:note:retry-note';

    await expect(original.push(note('credential handoff')))
      .rejects.toThrow('connection reset');
    const exactPending = await storage.get(key);
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('credential handoff').id,
    )).rejects.toThrow(expectedError);
    await expect(storage.get(key)).resolves.toEqual(exactPending);

    await expect(original.push(note('credential handoff'))).resolves.toBe(7);
    await expect(storage.get(key)).resolves.toBeNull();
  });

  it.each([
    [401, 'invalid_device_credential'],
    [403, 'service_credential_read_only'],
  ])('preserves an exact owner retry across a %s before credential replacement', async (
    status,
    code,
  ) => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'))
      .mockResolvedValueOnce(json({ error: code }, status))
      .mockResolvedValueOnce(json({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);
    const key = 'unkeep-pending-mutation:vault-one:note:retry-note';

    await expect(original.push(note('credential handoff')))
      .rejects.toThrow('connection reset');
    const exactPending = await storage.get(key);
    await expect(original.push(note('credential handoff'))).rejects.toThrow(code);
    await expect(storage.get(key)).resolves.toEqual(exactPending);

    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingMutationAfterCredentialChange(
      'note',
      note('credential handoff').id,
    )).resolves.toBe(7);
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    expect(fetchMock.mock.calls[3]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
  });

  it('safely retries the released unbound version-1 pending mutation format', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset after request'))
      .mockResolvedValueOnce(success(7));
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);

    await expect(sync.push(note('legacy pending'))).rejects.toThrow('connection reset');
    const key = 'unkeep-pending-mutation:vault-one:note:retry-note';
    const pending = await storage.get<Record<string, unknown>>(key);
    expect(pending).not.toBeNull();
    delete pending!.ownerCredentialHash;
    await storage.set(key, pending);

    await expect(sync.push(note('legacy pending'))).resolves.toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(storage.get(key)).resolves.toBeNull();
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
