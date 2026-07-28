import { expect, test } from 'vitest';
import { clearDeviceAccess } from './index.js';
import {
  DeviceKeyStore,
  VaultInstanceMismatchError,
} from './deviceKeys.js';
import { MemoryClientStorage } from './storage.js';
import { RelaySessionStore } from './session.js';

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
