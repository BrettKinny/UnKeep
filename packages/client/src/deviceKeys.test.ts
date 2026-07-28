import { expect, test } from 'vitest';
import { clearDeviceAccess } from './index.js';
import { DeviceKeyStore, VaultKeyMismatchError } from './deviceKeys.js';
import { MemoryClientStorage } from './storage.js';
import { RelaySessionStore } from './session.js';

test('exports a fresh recovery kit for already-persisted device keys', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const provisioned = await keys.provisionFirstDevice();

  const replacementKit = await keys.createRecoveryKit();
  const restored = await new DeviceKeyStore(new MemoryClientStorage())
    .restoreDeviceFromRecovery(replacementKit);

  expect(restored).toEqual(provisioned.masterKey);
});

test('rejects a recovery kit for a different vault without replacing the stored key', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice();
  const foreign = await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice();

  await expect(keys.restoreDeviceFromRecovery(foreign.recoveryKit))
    .rejects.toBeInstanceOf(VaultKeyMismatchError);
  expect(await keys.unlockDevice()).toEqual(existing.masterKey);
});

test('allows restoring the byte-identical vault key already stored on the device', async () => {
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const existing = await keys.provisionFirstDevice();
  const deviceId = await keys.getDeviceId();

  const restored = await keys.restoreDeviceFromRecovery(existing.recoveryKit);

  expect(restored).toEqual(existing.masterKey);
  expect(await keys.unlockDevice()).toEqual(existing.masterKey);
  expect(await keys.getDeviceId()).toBe(deviceId);
});

test('explicitly clears the device identity, stored vault key, and relay session', async () => {
  const storage = new MemoryClientStorage();
  const keys = new DeviceKeyStore(storage);
  const provisioned = await keys.provisionFirstDevice();
  const sessions = new RelaySessionStore(storage);
  await sessions.save({
    endpoint: 'https://vault.example',
    instanceId: 'vault-instance',
    deviceId: provisioned.deviceId,
    credential: 'device-credential',
  });
  await sessions.saveEndpoint('https://vault.example');

  await clearDeviceAccess(keys, sessions);

  expect(await keys.unlockDevice()).toBeNull();
  expect(await sessions.load()).toBeNull();
  expect(await keys.getDeviceId()).not.toBe(provisioned.deviceId);
  expect(await sessions.defaultEndpoint('https://fallback.example')).toBe('https://vault.example');
});
