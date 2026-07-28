import { expect, test } from 'vitest';
import { generateMasterKey, importRecoveryKit } from '@unkeep/core';
import { clearDeviceAccess } from './index.js';
import {
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

class RecordingStorage implements ClientStorage {
  readonly values = new Map<string, unknown>();
  writes = 0;

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.writes += 1;
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.writes += 1;
    this.values.delete(key);
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
