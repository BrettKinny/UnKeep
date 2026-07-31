import { describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@unkeep/core/experimental';
import { applyRemoteNoteTombstone } from './remoteTombstone';

describe('applyRemoteNoteTombstone', () => {
  it('rejects when a live note cannot be durably deleted', async () => {
    const failure = new Error('IndexedDB transaction failed');
    const adapter = {
      listNotes: vi.fn().mockResolvedValue([{ id: 'remote-delete', updatedAt: 1 }]),
      deleteNote: vi.fn().mockRejectedValue(failure),
    } as unknown as Pick<StorageAdapter, 'listNotes' | 'deleteNote'>;

    await expect(applyRemoteNoteTombstone(adapter, 'remote-delete')).rejects.toBe(failure);
  });

  it('is idempotent when the note is already absent', async () => {
    const adapter = {
      listNotes: vi.fn().mockResolvedValue([]),
      deleteNote: vi.fn(),
    } as unknown as Pick<StorageAdapter, 'listNotes' | 'deleteNote'>;

    await expect(applyRemoteNoteTombstone(adapter, 'already-absent')).resolves.toBeUndefined();
    expect(adapter.deleteNote).not.toHaveBeenCalled();
  });
});
