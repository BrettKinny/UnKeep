import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebouncedWorkQueue } from './debouncedWorkQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DebouncedWorkQueue', () => {
  it('drains work scheduled while an earlier save is still flushing', async () => {
    vi.useFakeTimers();
    const firstSave = deferred();
    const oldVaultWrites: string[] = [];
    const newVaultWrites: string[] = [];
    const queue = new DebouncedWorkQueue<string>(500);
    const writeOldVault = async (content: string) => {
      oldVaultWrites.push(content);
      if (content === 'edit before disconnect') await firstSave.promise;
    };

    queue.schedule('note-one', 'edit before disconnect', async content => {
      newVaultWrites.push(content);
    });
    const disconnect = queue.drain(writeOldVault);
    await vi.waitFor(() => expect(oldVaultWrites).toEqual(['edit before disconnect']));

    // The notes UI can still emit an edit while disconnect is waiting for the
    // first durable write. Its ordinary callback would use whatever vault is
    // active when the debounce expires.
    queue.schedule('note-one', 'edit during disconnect', async content => {
      newVaultWrites.push(content);
    });
    firstSave.resolve();
    await disconnect;
    await vi.advanceTimersByTimeAsync(500);

    expect(oldVaultWrites).toEqual(['edit before disconnect', 'edit during disconnect']);
    expect(newVaultWrites).toEqual([]);
  });

  it('waits for an already-started save once before draining a newer edit', async () => {
    vi.useFakeTimers();
    const firstSave = deferred();
    const normalWrites: string[] = [];
    const drainedWrites: string[] = [];
    const newVaultWrites: string[] = [];
    const queue = new DebouncedWorkQueue<string>(500);

    queue.schedule('note-one', 'save already in flight', async content => {
      normalWrites.push(content);
      await firstSave.promise;
    });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(normalWrites).toEqual(['save already in flight']));

    const disconnect = queue.drain(async content => { drainedWrites.push(content); });
    await Promise.resolve();
    expect(drainedWrites).toEqual([]);

    queue.schedule('note-one', 'newer edit', async content => {
      newVaultWrites.push(content);
    });
    firstSave.resolve();
    await disconnect;
    await vi.advanceTimersByTimeAsync(500);

    expect(normalWrites).toEqual(['save already in flight']);
    expect(drainedWrites).toEqual(['newer edit']);
    expect(newVaultWrites).toEqual([]);
  });

  it('retains work for a later drain when durable persistence fails', async () => {
    vi.useFakeTimers();
    const queue = new DebouncedWorkQueue<string>(500);
    const retried: string[] = [];
    queue.schedule('note-one', 'must remain recoverable', async () => undefined);

    await expect(queue.drain(async () => {
      throw new Error('IndexedDB quota exceeded');
    })).rejects.toThrow('IndexedDB quota exceeded');

    await queue.drain(async content => { retried.push(content); });
    expect(retried).toEqual(['must remain recoverable']);
  });

  it('retains already-started debounced work when its scheduled persistence fails', async () => {
    vi.useFakeTimers();
    const queue = new DebouncedWorkQueue<string>(500);
    const retried: string[] = [];
    queue.schedule('note-one', 'failed active save', async () => {
      throw new Error('IndexedDB transaction failed');
    });

    await vi.advanceTimersByTimeAsync(500);
    await queue.drain(async content => { retried.push(content); });

    expect(retried).toEqual(['failed active save']);
  });

  it('does not resurrect failed active work after an explicit cancellation', async () => {
    vi.useFakeTimers();
    const queue = new DebouncedWorkQueue<string>(500);
    const started = deferred();
    const releaseFailure = deferred();
    const retried: string[] = [];
    queue.schedule('note-one', 'deleted note edit', async () => {
      started.resolve();
      await releaseFailure.promise;
      throw new Error('late persistence failure');
    });

    await vi.advanceTimersByTimeAsync(500);
    await started.promise;
    queue.cancel('note-one');
    releaseFailure.resolve();
    await expect(queue.drain(async content => { retried.push(content); }))
      .rejects.toThrow('late persistence failure');
    await queue.drain(async content => { retried.push(content); });

    expect(retried).toEqual([]);
  });

  it('waits for an in-flight stale save before an immediate superseding write', async () => {
    vi.useFakeTimers();
    const started = deferred();
    const release = deferred();
    const writes: string[] = [];
    const queue = new DebouncedWorkQueue<string>(500);

    queue.schedule('note-one', 'stale snapshot', async value => {
      started.resolve();
      await release.promise;
      writes.push(value);
    });
    await vi.advanceTimersByTimeAsync(500);
    await started.promise;

    const immediate = queue.supersede('note-one').then(() => {
      writes.push('immediate snapshot');
    });
    expect(writes).toEqual([]);
    release.resolve();
    await immediate;

    expect(writes).toEqual(['stale snapshot', 'immediate snapshot']);
  });

  it('tracks a save already claimed by drain for supersession ordering', async () => {
    vi.useFakeTimers();
    const started = deferred();
    const release = deferred();
    const writes: string[] = [];
    const queue = new DebouncedWorkQueue<string>(500);
    queue.schedule('note-one', 'draining snapshot', async () => undefined);

    const draining = queue.drain(async value => {
      started.resolve();
      await release.promise;
      writes.push(value);
    });
    await started.promise;

    const immediate = queue.supersede('note-one').then(() => writes.push('immediate snapshot'));
    expect(writes).toEqual([]);
    release.resolve();
    await draining;
    await immediate;

    expect(writes).toEqual(['draining snapshot', 'immediate snapshot']);
  });
});
