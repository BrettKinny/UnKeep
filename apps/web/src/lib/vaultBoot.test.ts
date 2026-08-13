import { describe, expect, it, vi } from 'vitest';
import type { RelaySession } from '@unkeep/client';
import { loadLocalVault } from './vaultBoot';

const session: RelaySession = {
  endpoint: 'https://relay.example.test',
  instanceId: 'vault-one',
  deviceId: 'device-one',
  credential: 'offline-credential',
};

describe('offline vault boot', () => {
  it('unlocks a complete locally stored vault without contacting the relay', async () => {
    const network = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', network);

    const masterKey = new Uint8Array(32).fill(7);
    const unlockDevice = vi.fn().mockResolvedValue(masterKey);
    await expect(loadLocalVault(
      { load: vi.fn().mockResolvedValue(session) },
      { unlockDevice },
    )).resolves.toEqual({ session, masterKey });
    expect(unlockDevice).toHaveBeenCalledWith(session.instanceId);
    expect(network).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not partially unlock when either session or key is absent', async () => {
    await expect(loadLocalVault(
      { load: vi.fn().mockResolvedValue(session) },
      { unlockDevice: vi.fn().mockResolvedValue(null) },
    )).resolves.toBeNull();
  });
});
