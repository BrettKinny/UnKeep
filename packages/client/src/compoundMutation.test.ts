import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteAttachment } from '@unkeep/core';
import {
  EncryptedSync,
  PendingCompoundCompletionError,
} from './sync.js';
import { MemoryClientStorage } from './storage.js';
import type { ClientStorage, ClientStorageTransaction } from './storage.js';
import { RelayClient, type RelaySession } from './relay.js';

const session: RelaySession = {
  endpoint: 'https://relay.example.test',
  instanceId: 'vault-one',
  deviceId: 'device-one',
  credential: 'credential-one',
};
const masterKey = new Uint8Array(32).fill(7);
const attachment: NoteAttachment = {
  id: 'attachment-one',
  name: 'proof.bin',
  mimeType: 'application/octet-stream',
  size: 3,
};
const bytes = new Uint8Array([1, 2, 3]);

function note(content = 'with attachment'): Note {
  return {
    id: 'compound-note',
    content,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    images: [attachment],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class InspectableStorage extends MemoryClientStorage {
  private readonly stageKeys = new Set<string>();
  maxStoredStagePayloads = 0;

  override async set<T>(key: string, value: T): Promise<void> {
    await super.set(key, value);
    if (key.startsWith('unkeep-pending-compound-stage:')) {
      this.stageKeys.add(key);
      this.maxStoredStagePayloads = Math.max(this.maxStoredStagePayloads, this.stageKeys.size);
    }
  }

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    this.stageKeys.delete(key);
  }

  override update<T>(key: string, change: (value: T | null) => T | null): Promise<void> {
    return super.update<T>(key, current => {
      const next = change(current);
      if (key.startsWith('unkeep-pending-compound-stage:')) {
        if (next === null) this.stageKeys.delete(key);
        else this.stageKeys.add(key);
        this.maxStoredStagePayloads = Math.max(this.maxStoredStagePayloads, this.stageKeys.size);
      }
      return next;
    });
  }

  override transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    return super.transact(keys, transaction => change({
      get: <T>(key: string) => transaction.get<T>(key),
      set: <T>(key: string, value: T) => {
        transaction.set(key, value);
        if (key.startsWith('unkeep-pending-compound-stage:')) {
          this.stageKeys.add(key);
          this.maxStoredStagePayloads = Math.max(this.maxStoredStagePayloads, this.stageKeys.size);
        }
      },
      delete: (key: string) => {
        transaction.delete(key);
        this.stageKeys.delete(key);
      },
    }));
  }
}

class CleanupRaceStorage extends MemoryClientStorage {
  private interleaving = false;
  private replacementInstalledResolve!: () => void;
  private readonly replacementInstalled = new Promise<void>(resolve => {
    this.replacementInstalledResolve = resolve;
  });
  onStandaloneStageDelete?: () => void;
  lastStageKey?: string;

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    if (!key.startsWith('unkeep-pending-compound-stage:') || !this.onStandaloneStageDelete) return;
    this.interleaving = true;
    this.onStandaloneStageDelete();
    await this.replacementInstalled;
  }

  override transact(
    keys: readonly string[],
    change: (transaction: ClientStorageTransaction) => void,
  ): Promise<void> {
    let installed = false;
    return super.transact(keys, transaction => change({
      get: <T>(key: string) => transaction.get<T>(key),
      set: <T>(key: string, value: T) => {
        transaction.set(key, value);
        if (this.interleaving && key.startsWith('unkeep-pending-compound-stage:')) {
          installed = true;
          this.lastStageKey = key;
        } else if (key.startsWith('unkeep-pending-compound-stage:')) {
          this.lastStageKey = key;
        }
      },
      delete: (key: string) => transaction.delete(key),
    })).then(() => {
      if (installed) this.replacementInstalledResolve();
    });
  }
}

class ForeignRecordConflictError extends Error {
  override readonly name = 'RecordConflictError';
  readonly status = 409;
  readonly code = 'record_conflict';

  constructor(readonly currentRevision: number) {
    super('record_conflict');
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('durable compound note mutations', () => {
  it('reuses the stable mutation and exact encrypted stage payload after a lost response and restart', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('stage response lost'))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EncryptedSync(session, masterKey, storage)
      .commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toThrow('stage response lost');
    const handle = await new EncryptedSync(session, masterKey, storage)
      .resumePendingCompoundCommit(note().id);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe(fetchMock.mock.calls[0]![0]);
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    expect(handle).toMatchObject({
      noteId: note().id,
      revision: 2,
      attachmentRevisions: [{
        id: attachment.id,
        revision: 1,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(await new EncryptedSync(session, masterKey, storage).pendingCompoundCommit(note().id))
      .toEqual(handle);
    expect(await new EncryptedSync(session, masterKey, storage).pendingCompoundCommits())
      .toEqual([handle]);
  });

  it('does not replay or erase another credential pending compound payload', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('stage response lost'))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.commitNoteWithAttachments(
      note(),
      [{ attachment, bytes }],
    )).rejects.toThrow('stage response lost');
    await expect(new EncryptedSync(
      { ...session, credential: 'different-credential' },
      masterKey,
      storage,
    ).resumePendingCompoundCommit(note().id))
      .rejects.toThrow(/belongs to another credential/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(original.resumePendingCompoundCommit(note().id))
      .resolves.toMatchObject({ noteId: note().id, revision: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('explicitly abandons a finalizing bundle after credential replacement', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockRejectedValueOnce(new TypeError('final response lost'));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.commitNoteWithAttachments(
      note(),
      [{ attachment, bytes }],
    )).rejects.toThrow('final response lost');
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingCompoundCommit(note().id))
      .rejects.toThrow(/belongs to another credential/i);
    await expect(replacement.abandonPendingCompoundAfterCredentialChange(note().id))
      .resolves.toBe(true);
    await expect(replacement.resumePendingCompoundCommit(note().id))
      .resolves.toBeNull();
    await expect(original.resumePendingCompoundCommit(note().id))
      .resolves.toBeNull();
  });

  it('preserves a foreign compound retry when replacement replay is rejected', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockRejectedValueOnce(new TypeError('final response lost'))
      .mockResolvedValueOnce(jsonResponse({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(jsonResponse({
        error: 'attachment_stage_missing',
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.commitNoteWithAttachments(
      note(),
      [{ attachment, bytes }],
    )).rejects.toThrow('final response lost');
    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingCompoundCommitAfterCredentialChange(
      note().id,
    )).rejects.toMatchObject({
      status: 409,
      code: 'attachment_stage_missing',
    });

    await expect(original.resumePendingCompoundCommit(note().id))
      .resolves.toMatchObject({ noteId: note().id, revision: 2 });
    expect(fetchMock.mock.calls[4]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
  });

  it('preserves an exact compound root across owner authorization loss', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('stage request outcome unknown'))
      .mockResolvedValueOnce(jsonResponse({
        error: 'service_credential_read_only',
      }, 403))
      .mockResolvedValueOnce(jsonResponse({ vaultId: session.instanceId }))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const original = new EncryptedSync(session, masterKey, storage);

    await expect(original.commitNoteWithAttachments(
      note(),
      [{ attachment, bytes }],
    )).rejects.toThrow('stage request outcome unknown');
    await expect(original.resumePendingCompoundCommit(note().id))
      .rejects.toThrow('service_credential_read_only');

    const replacement = new EncryptedSync(
      { ...session, credential: 'replacement-credential' },
      masterKey,
      storage,
    );
    await expect(replacement.resumePendingCompoundCommitAfterCredentialChange(
      note().id,
    )).resolves.toMatchObject({ noteId: note().id, revision: 2 });
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    expect(fetchMock.mock.calls[3]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
  });

  it('persists and replays the exact final note payload after a lost finalize response', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'b'.repeat(64) }))
      .mockRejectedValueOnce(new TypeError('final response lost'))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EncryptedSync(session, masterKey, storage)
      .commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toThrow('final response lost');
    await new EncryptedSync(session, masterKey, storage)
      .resumePendingCompoundCommit(note().id);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe(fetchMock.mock.calls[1]![0]);
    expect(fetchMock.mock.calls[2]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
  });

  it('discards a cross-package terminally rejected final bundle so a new compound mutation can proceed', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'b'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'c'.repeat(64) }));
    const finalizeMock = vi.spyOn(RelayClient.prototype, 'finalizeNoteWithAttachments')
      .mockRejectedValueOnce(new ForeignRecordConflictError(7))
      .mockResolvedValueOnce({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      });
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);

    await expect(sync.commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toMatchObject({ status: 409, code: 'record_conflict' });

    const rootKey = `unkeep-pending-compound:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(note().id)}`;
    expect(await storage.get(rootKey)).toBeNull();
    expect(await sync.resumePendingCompoundCommit(note().id)).toBeNull();

    const handle = await sync.commitNoteWithAttachments(
      { ...note('retry after conflict'), updatedAt: 2 },
      [{ attachment, bytes }],
    );
    expect(handle).toMatchObject({ noteId: note().id, revision: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(finalizeMock).toHaveBeenCalledTimes(2);
  });

  it('compare-clears only the exact committed bundle and serializes same-note calls', async () => {
    const storage = new MemoryClientStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'c'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);

    const [first, second] = await Promise.all([
      sync.commitNoteWithAttachments(note(), [{ attachment, bytes }]),
      sync.commitNoteWithAttachments(note(), [{ attachment, bytes }]),
    ]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await sync.completeCompoundCommit({
      ...first,
      mutationId: 'different-mutation',
    })).toBe(false);
    expect(await sync.pendingCompoundCommit(note().id)).toEqual(first);
    expect(await sync.cancelPendingCompoundCommit(note().id)).toBe(false);
    expect(await sync.completeCompoundCommit(first)).toBe(true);
    expect(await sync.completeCompoundCommit(first)).toBe(false);
    expect(await sync.pendingCompoundCommit(note().id)).toBeNull();
    expect(await sync.pendingCompoundCommits()).toEqual([]);
  });

  it('blocks a different note mutation until the previous durable completion handle is cleared', async () => {
    const storage = new MemoryClientStorage();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'd'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 2,
        attachmentRevisions: [{ id: attachment.id, revision: 1 }],
      })));
    const sync = new EncryptedSync(session, masterKey, storage);
    const handle = await sync.commitNoteWithAttachments(note(), [{ attachment, bytes }]);

    const error = await sync.commitNoteWithAttachments(
      { ...note('newer edit'), updatedAt: 2 },
      [{ attachment, bytes }],
    ).catch(value => value);
    expect(error).toBeInstanceOf(PendingCompoundCompletionError);
    expect((error as PendingCompoundCompletionError).handle).toEqual(handle);
  });

  it('fails closed on malformed persisted compound state', async () => {
    const storage = new MemoryClientStorage();
    await storage.set(
      `unkeep-pending-compound:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(note().id)}`,
      { version: 1, mutationId: 'mutation-one' },
    );
    vi.stubGlobal('fetch', vi.fn());

    await expect(new EncryptedSync(session, masterKey, storage)
      .commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toThrow(/stored pending compound mutation is invalid/i);
  });

  it('fails closed when the durable committed-handle index is malformed', async () => {
    const storage = new MemoryClientStorage();
    await storage.set(
      `unkeep-pending-compound-index:${encodeURIComponent(session.instanceId)}`,
      { version: 1, handles: [{ noteId: note().id }] },
    );

    await expect(new EncryptedSync(session, masterKey, storage).pendingCompoundCommits())
      .rejects.toThrow(/stored pending compound index is invalid/i);
  });

  it('fails closed before sending when storage cannot atomically install the durable bundle', async () => {
    const values = new Map<string, unknown>();
    const storage: ClientStorage = {
      async get<T>(key: string) {
        return (values.get(key) as T | undefined) ?? null;
      },
      async set<T>(key: string, value: T) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EncryptedSync(session, masterKey, storage)
      .commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toThrow(/require transactional client storage/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains an uncommitted root when resume lacks bytes, then cancels root and exact payload atomically', async () => {
    const storage = new MemoryClientStorage();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('stage unavailable')));
    const sync = new EncryptedSync(session, masterKey, storage);

    await expect(sync.commitNoteWithAttachments(note(), [{
      attachment,
      loadBytes: vi.fn()
        .mockResolvedValueOnce(bytes)
        .mockRejectedValueOnce(new Error('staging file missing')),
    }])).rejects.toThrow('staging file missing');
    await expect(sync.resumePendingCompoundCommit(note().id))
      .rejects.toThrow(/attachment bytes are required/i);

    const rootKey = `unkeep-pending-compound:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(note().id)}`;
    const root = await storage.get<{mutationId:string}>(rootKey);
    expect(root).not.toBeNull();
    expect(await sync.cancelPendingCompoundCommit(note().id)).toBe(true);
    expect(await storage.get(rootKey)).toBeNull();
    expect(await storage.get(
      `unkeep-pending-compound-stage:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(root!.mutationId)}:${encodeURIComponent(attachment.id)}`,
    )).toBeNull();
    expect(await sync.cancelPendingCompoundCommit(note().id)).toBe(false);
  });

  it('atomically cancels an ambiguous staged payload without touching a committed bundle', async () => {
    const storage = new MemoryClientStorage();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('stage response lost')));
    const sync = new EncryptedSync(session, masterKey, storage);
    await expect(sync.commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toThrow('stage response lost');

    const rootKey = `unkeep-pending-compound:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(note().id)}`;
    const root = await storage.get<{mutationId:string}>(rootKey);
    const stageKey = `unkeep-pending-compound-stage:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(root!.mutationId)}:${encodeURIComponent(attachment.id)}`;
    expect(await storage.get(stageKey)).not.toBeNull();

    expect(await sync.cancelPendingCompoundCommit(note().id)).toBe(true);
    expect(await storage.get(rootKey)).toBeNull();
    expect(await storage.get(stageKey)).toBeNull();
  });

  it('leaves no orphan payload when another SDK reinstalls it during deterministic-error cleanup', async () => {
    const storage = new CleanupRaceStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'attachment_id_unavailable',
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const first = new EncryptedSync(session, masterKey, storage);
    const second = new EncryptedSync(session, masterKey, storage);
    let concurrentResume: Promise<unknown> | undefined;
    storage.onStandaloneStageDelete = () => {
      concurrentResume = second.resumePendingCompoundCommit(note().id, [{ attachment, bytes }]);
      void concurrentResume.catch(() => undefined);
    };

    await expect(first.commitNoteWithAttachments(note(), [{ attachment, bytes }]))
      .rejects.toMatchObject({ status: 409, code: 'attachment_id_unavailable' });

    expect(storage.lastStageKey).toBeTruthy();
    expect(await storage.get(storage.lastStageKey!)).toBeNull();
  });

  it('loads, encrypts, and retains at most one attachment payload at a time', async () => {
    const secondAttachment: NoteAttachment = {
      id: 'attachment-two',
      name: 'second.bin',
      mimeType: 'application/octet-stream',
      size: 2,
    };
    const storage = new InspectableStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'b'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 3,
        attachmentRevisions: [
          { id: attachment.id, revision: 1 },
          { id: secondAttachment.id, revision: 2 },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const lazy = (value: Uint8Array<ArrayBuffer>) => async () => {
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      await Promise.resolve();
      activeLoads -= 1;
      return value;
    };
    const value = {
      ...note(),
      images: [attachment, secondAttachment],
    };

    await new EncryptedSync(session, masterKey, storage).commitNoteWithAttachments(value, [
      { attachment, loadBytes: lazy(bytes) },
      { attachment: secondAttachment, loadBytes: lazy(new Uint8Array([4, 5])) },
    ]);

    expect(maxActiveLoads).toBe(1);
    expect(storage.maxStoredStagePayloads).toBe(1);
    const root = await storage.get<Record<string, unknown>>(
      `unkeep-pending-compound:${encodeURIComponent(session.instanceId)}:${encodeURIComponent(value.id)}`,
    );
    expect(root).not.toBeNull();
    expect((root!.stages as Record<string, unknown>[]).every(stage =>
      !Object.hasOwn(stage, 'payload') && !Object.hasOwn(stage, 'envelope'))).toBe(true);
  });

  it('uses binary protocol ordering for attachment manifests and the committed-handle index', async () => {
    const storage = new MemoryClientStorage();
    const dashAttachment: NoteAttachment = {
      id: 'a-b',
      name: 'dash.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    };
    const underscoreAttachment: NoteAttachment = {
      id: 'a_b',
      name: 'underscore.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'a'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'b'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 3,
        attachmentRevisions: [
          { id: dashAttachment.id, revision: 1 },
          { id: underscoreAttachment.id, revision: 2 },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ stageHash: 'c'.repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        revision: 5,
        attachmentRevisions: [{ id: attachment.id, revision: 4 }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const sync = new EncryptedSync(session, masterKey, storage);
    const underscoreNote = {
      ...note(),
      id: 'a_b',
      images: [underscoreAttachment, dashAttachment],
    };

    await sync.commitNoteWithAttachments(underscoreNote, [
      { attachment: underscoreAttachment, bytes: new Uint8Array([2]) },
      { attachment: dashAttachment, bytes: new Uint8Array([1]) },
    ]);
    await sync.commitNoteWithAttachments(
      { ...note(), id: 'a-b' },
      [{ attachment, bytes }],
    );

    const finalPayload = JSON.parse(
      String(fetchMock.mock.calls[2]![1].body),
    ) as { newAttachments: { id: string }[] };
    expect(finalPayload.newAttachments.map(value => value.id)).toEqual(['a-b', 'a_b']);
    await expect(sync.pendingCompoundCommits()).resolves.toEqual([
      expect.objectContaining({ noteId: 'a-b' }),
      expect.objectContaining({ noteId: 'a_b' }),
    ]);
  });
});
