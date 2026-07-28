import { describe, expect, it, vi } from 'vitest';
import { useForCurrentVault, VaultTaskCoordinator } from './vaultTaskCoordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('VaultTaskCoordinator', () => {
  it('coalesces overlapping work within one active vault', async () => {
    const coordinator = new VaultTaskCoordinator();
    const pending = deferred<void>();
    const work = vi.fn(async () => pending.promise);

    const first = coordinator.run(work);
    const second = coordinator.run(work);
    expect(work).toHaveBeenCalledTimes(1);

    pending.resolve();
    await Promise.all([first, second]);
  });

  it('starts new-vault work independently and invalidates the old task context', async () => {
    const coordinator = new VaultTaskCoordinator();
    const oldPending = deferred<void>();
    let oldIsCurrent = true;
    const oldRun = coordinator.run(async context => {
      await oldPending.promise;
      oldIsCurrent = context.isCurrent();
    });

    coordinator.reset();
    let newIsCurrent = false;
    await coordinator.run(async context => { newIsCurrent = context.isCurrent(); });

    expect(newIsCurrent).toBe(true);
    oldPending.resolve();
    await oldRun;
    expect(oldIsCurrent).toBe(false);
  });

  it('invalidates captured contexts without serializing independent local writes', () => {
    const coordinator = new VaultTaskCoordinator();
    const captured = coordinator.capture();
    expect(captured.isCurrent()).toBe(true);
    coordinator.reset();
    expect(captured.isCurrent()).toBe(false);
    expect(coordinator.capture().isCurrent()).toBe(true);
  });

  it('drops a conflict value that finishes loading after a vault switch', async () => {
    const coordinator = new VaultTaskCoordinator();
    const context = coordinator.capture();
    const oldConflict = deferred<{ id: string }>();
    const consume = vi.fn();

    const resolution = useForCurrentVault(context, () => oldConflict.promise, consume);
    coordinator.reset();
    oldConflict.resolve({ id: 'old-vault-note' });
    await resolution;

    expect(consume).not.toHaveBeenCalled();
  });
});
