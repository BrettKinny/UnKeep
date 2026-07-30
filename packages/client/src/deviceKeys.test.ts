import { expect, test } from 'vitest';
import { generateMasterKey, importRecoveryKit } from '@unkeep/core';
import { clearDeviceAccess } from './index.js';
import {
  DEVICE_KEYS_KEY,
  DeviceKeyStore,
  VaultInstanceMismatchError,
  VaultKeyMismatchError,
} from './deviceKeys.js';
import { MemoryClientStorage } from './storage.js';
import type { ClientStorage } from './storage.js';
import { RelaySessionStore } from './session.js';

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function legacyRecoveryKit(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const recoveryKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKey = await crypto.subtle.importKey(
    'raw',
    recoveryKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyId = 'legacy-recovery';
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(`unkeep:1:recovery-master-key:${keyId}`),
      tagLength: 128,
    },
    recoveryKey,
    masterKey,
  );
  return JSON.stringify({
    version: 1,
    recoveryKey: encodeBase64(recoveryKeyBytes),
    masterKeyEnvelope: {
      version: 1,
      algorithm: 'AES-GCM',
      keyId,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    },
  });
}

class RecordingStorage extends MemoryClientStorage {
  writes = 0;

  override async set<T>(key: string, value: T): Promise<void> {
    this.writes += 1;
    await super.set(key, value);
  }

  override async delete(key: string): Promise<void> {
    this.writes += 1;
    await super.delete(key);
  }
}

class FailingTransactionStorage extends MemoryClientStorage {
  failNextTransaction = false;

  override transact(
    keys: readonly string[],
    change: Parameters<MemoryClientStorage['transact']>[1],
  ): Promise<void> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      return Promise.reject(new Error('injected transaction failure'));
    }
    return super.transact(keys, change);
  }
}

test('exports a fresh recovery kit for already-persisted device keys', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const provisioned = await keys.provisionFirstDevice('vault-instance');

  const replacementKit = await keys.createRecoveryKit();
  const restored = await new DeviceKeyStore(new MemoryClientStorage())
    .restoreDeviceFromRecovery(replacementKit, 'vault-instance');

  expect(restored).toEqual(provisioned.masterKey);
});

test('rejects a recovery kit for a different vault without replacing the stored key', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice('vault-instance');
  const foreign = await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice('foreign-vault');

  await expect(keys.restoreDeviceFromRecovery(foreign.recoveryKit, 'vault-instance'))
    .rejects.toBeInstanceOf(VaultInstanceMismatchError);
  expect(await keys.unlockDevice('vault-instance')).toEqual(existing.masterKey);
});

test('allows restoring the byte-identical vault key already stored on the device', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice('vault-instance');
  const deviceId = await keys.getDeviceId();

  const restored = await keys.restoreDeviceFromRecovery(existing.recoveryKit, 'vault-instance');

  expect(restored).toEqual(existing.masterKey);
  expect(await keys.unlockDevice('vault-instance')).toEqual(existing.masterKey);
  expect(await keys.getDeviceId()).toBe(deviceId);
});

test('rejects the same master key for a different relay instance', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice('vault-one');

  await expect(keys.persistPairedMasterKey(existing.masterKey, 'vault-two'))
    .rejects.toBeInstanceOf(VaultInstanceMismatchError);
  await expect(keys.unlockDevice('vault-two'))
    .rejects.toBeInstanceOf(VaultInstanceMismatchError);
  await expect(keys.unlockDevice('vault-one')).resolves.toEqual(existing.masterKey);
});

test('validates a legacy kit without persistence and upgrades it only after confirmation', async () => {
  const storage = new RecordingStorage();
  const keys = new DeviceKeyStore(storage);
  const masterKey = generateMasterKey();
  const legacyKit = await legacyRecoveryKit(masterKey);

  await expect(keys.validateLegacyRecovery(legacyKit, 'vault-one')).resolves.toBeUndefined();
  expect(storage.writes).toBe(0);

  await expect(keys.restoreLegacyDeviceFromRecovery(legacyKit, 'vault-one'))
    .resolves.toEqual(masterKey);
  await expect(keys.unlockDevice('vault-one')).resolves.toEqual(masterKey);
  expect(importRecoveryKit(await keys.createRecoveryKit())).toMatchObject({
    version: 2,
    instanceId: 'vault-one',
  });
});

test('preserves a relay-scoped fingerprint when access is cleared and rejects a different legacy key', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice('vault-one');
  const matchingLegacyKit = await legacyRecoveryKit(existing.masterKey);
  const foreignLegacyKit = await legacyRecoveryKit(generateMasterKey());

  await keys.clearDevice();

  await expect(keys.validateLegacyRecovery(foreignLegacyKit, 'vault-one'))
    .rejects.toBeInstanceOf(VaultKeyMismatchError);
  await expect(keys.restoreLegacyDeviceFromRecovery(matchingLegacyKit, 'vault-one'))
    .resolves.toEqual(existing.masterKey);
});

test('explicitly clears the device identity, stored vault key, and relay session', async () => {
  const storage = new MemoryClientStorage();
  const keys = new DeviceKeyStore(storage);
  const provisioned = await keys.provisionFirstDevice('vault-instance');
  const sessions = new RelaySessionStore(storage);
  await sessions.save({
    endpoint: 'https://vault.example',
    instanceId: 'vault-instance',
    deviceId: provisioned.deviceId,
    credential: 'device-credential',
  });
  await sessions.saveEndpoint('https://vault.example');

  await clearDeviceAccess(keys, sessions);

  expect(await keys.unlockDevice('vault-instance')).toBeNull();
  expect(await sessions.load()).toBeNull();
  expect(await keys.getDeviceId()).not.toBe(provisioned.deviceId);
  expect(await sessions.defaultEndpoint('https://fallback.example')).toBe('https://vault.example');
});

test('does not expose a torn wrapped key when its atomic install fails', async () => {
  const storage = new FailingTransactionStorage();
  const keys = new DeviceKeyStore(storage);
  const deviceId = await keys.getDeviceId();
  storage.failNextTransaction = true;

  await expect(keys.provisionFirstDevice('vault-instance'))
    .rejects.toThrow('injected transaction failure');
  await expect(keys.hasDeviceKeys()).resolves.toBe(false);
  await expect(keys.snapshotPairingAccess('vault-instance')).resolves.toEqual({
    storedKeys: null,
    fingerprint: null,
  });
  await expect(keys.getDeviceId()).resolves.toBe(deviceId);
});

test('rolls session, wrapped key, and device identity back together when clear fails', async () => {
  const storage = new FailingTransactionStorage();
  const keys = new DeviceKeyStore(storage);
  const provisioned = await keys.provisionFirstDevice('vault-instance');
  const sessions = new RelaySessionStore(storage);
  const session = {
    endpoint: 'https://vault.example',
    instanceId: 'vault-instance',
    deviceId: provisioned.deviceId,
    credential: 'device-credential',
  };
  await sessions.save(session);
  storage.failNextTransaction = true;

  await expect(clearDeviceAccess(keys, sessions))
    .rejects.toThrow('injected transaction failure');
  await expect(sessions.load()).resolves.toEqual(session);
  await expect(keys.unlockDevice('vault-instance')).resolves.toEqual(
    provisioned.masterKey,
  );
  await expect(keys.getDeviceId()).resolves.toBe(provisioned.deviceId);
});

test('fails closed before installing keys on storage without atomic transactions', async () => {
  const backing = new Map<string, unknown>();
  const storage: ClientStorage = {
    get: async <T>(key: string) => (backing.get(key) as T | undefined) ?? null,
    set: async <T>(key: string, value: T) => { backing.set(key, value); },
    delete: async (key: string) => { backing.delete(key); },
  };
  const keys = new DeviceKeyStore(storage);

  await expect(keys.provisionFirstDevice('vault-instance'))
    .rejects.toThrow('atomic client storage transactions');
  expect(backing.size).toBe(0);
});

test('fails closed before clearing access split across transaction domains', async () => {
  const keyStorage = new MemoryClientStorage();
  const sessionStorage = new MemoryClientStorage();
  const keys = new DeviceKeyStore(keyStorage);
  const provisioned = await keys.provisionFirstDevice('vault-instance');
  const sessions = new RelaySessionStore(sessionStorage);
  const session = {
    endpoint: 'https://vault.example',
    instanceId: 'vault-instance',
    deviceId: provisioned.deviceId,
    credential: 'device-credential',
  };
  await sessions.save(session);

  await expect(clearDeviceAccess(keys, sessions))
    .rejects.toThrow('same atomic client storage');
  await expect(sessions.load()).resolves.toEqual(session);
  await expect(keys.unlockDevice('vault-instance')).resolves.toEqual(
    provisioned.masterKey,
  );
});

test('uses the opaque key generation to reject stale rollback CAS', async () => {
  const storage = new MemoryClientStorage();
  const keys = new DeviceKeyStore(storage);
  await keys.provisionFirstDevice('vault-instance');
  const installed = await keys.snapshotPairingAccess('vault-instance');

  await storage.transact([DEVICE_KEYS_KEY], transaction => {
    const current = transaction.get<Record<string, unknown>>(DEVICE_KEYS_KEY);
    if (!current) throw new Error('expected stored keys');
    transaction.set(DEVICE_KEYS_KEY, {
      ...current,
      generation: 'concurrent-generation',
    });
  });

  await expect(keys.restorePairingAccess(
    { storedKeys: null, fingerprint: null },
    'vault-instance',
    installed,
  )).rejects.toThrow('Device key state changed');
  await expect(keys.hasDeviceKeys()).resolves.toBe(true);
});

test('fails closed when pairing finalization lacks atomic session updates', async () => {
  const values = new Map<string, unknown>();
  const storage: ClientStorage = {
    get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
    set: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  };
  const sessions = new RelaySessionStore(storage);
  const pending = {
    endpoint: 'https://vault.example',
    instanceId: 'vault-instance',
    deviceId: 'device-one',
    credential: 'device-credential',
    pendingPairingRequestId: 'pairing-one',
  };
  await sessions.save(pending);

  await expect(sessions.completePairingFinalization(pending))
    .rejects.toThrow('atomic client storage updates');
  await expect(sessions.load()).resolves.toEqual(pending);
});
