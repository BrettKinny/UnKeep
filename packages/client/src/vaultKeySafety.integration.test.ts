import { expect, test } from 'vitest';
import { startTestServer } from '@unkeep/server/test';
import {
  approvePairingCode,
  createPairingRequest,
  DeviceKeyStore,
  MemoryClientStorage,
  RelayClient,
  RelaySessionStore,
  VaultKeyMismatchError,
  waitForPairing,
  type RelaySession,
} from './index.js';

test('rejects pairing a different vault key before replacing the stored session', async () => {
  const relay = await startTestServer();
  try {
    const ownerKeys = new DeviceKeyStore(new MemoryClientStorage());
    const owner = await ownerKeys.provisionFirstDevice();
    const claimed = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      owner.deviceId,
      'Pairing owner',
    );
    const ownerSession: RelaySession = {
      endpoint: relay.endpoint,
      instanceId: claimed.instanceId,
      deviceId: owner.deviceId,
      credential: claimed.deviceCredential,
    };

    const occupiedStorage = new MemoryClientStorage();
    const occupiedKeys = new DeviceKeyStore(occupiedStorage);
    const occupied = await occupiedKeys.provisionFirstDevice();
    expect(occupied.masterKey).not.toEqual(owner.masterKey);
    const sessions = new RelaySessionStore(occupiedStorage);
    const originalSession: RelaySession = {
      endpoint: 'https://old-vault.example',
      instanceId: 'old-vault',
      deviceId: occupied.deviceId,
      credential: 'old-credential',
    };
    await sessions.save(originalSession);

    const pairing = await createPairingRequest(relay.endpoint, occupiedKeys, 'Occupied device');
    await approvePairingCode(ownerSession, pairing.code, owner.masterKey);
    const outcome = await waitForPairing(pairing, { keyStore: occupiedKeys, sessionStore: sessions })
      .then(value => ({ status: 'fulfilled' as const, value }))
      .catch(error => ({ status: 'rejected' as const, error }));

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.error).toBeInstanceOf(VaultKeyMismatchError);
    expect(await occupiedKeys.unlockDevice()).toEqual(occupied.masterKey);
    expect(await sessions.load()).toEqual(originalSession);
  } finally {
    await relay.stop();
  }
});

test('allows pairing when the device already stores the byte-identical vault key', async () => {
  const relay = await startTestServer();
  try {
    const ownerKeys = new DeviceKeyStore(new MemoryClientStorage());
    const owner = await ownerKeys.provisionFirstDevice();
    const claimed = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      owner.deviceId,
      'Pairing owner',
    );
    const ownerSession: RelaySession = {
      endpoint: relay.endpoint,
      instanceId: claimed.instanceId,
      deviceId: owner.deviceId,
      credential: claimed.deviceCredential,
    };
    const returningStorage = new MemoryClientStorage();
    const returningKeys = new DeviceKeyStore(returningStorage);
    await returningKeys.persistPairedMasterKey(owner.masterKey);
    const sessions = new RelaySessionStore(returningStorage);

    const pairing = await createPairingRequest(relay.endpoint, returningKeys, 'Returning device');
    await approvePairingCode(ownerSession, pairing.code, owner.masterKey);
    const result = await waitForPairing(pairing, { keyStore: returningKeys, sessionStore: sessions });

    expect(result.masterKey).toEqual(owner.masterKey);
    expect(await returningKeys.unlockDevice()).toEqual(owner.masterKey);
    expect(await sessions.load()).toEqual(result.session);
  } finally {
    await relay.stop();
  }
});
