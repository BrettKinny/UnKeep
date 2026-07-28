import { expect, test } from 'vitest';
import { startTestServer } from '@unkeep/server/test';
import type { Note } from '@unkeep/core';
import { DeviceKeyStore } from './deviceKeys.js';
import { RelayClient, type RelaySession } from './relay.js';
import { MemoryClientStorage } from './storage.js';
import { EncryptedSync } from './sync.js';

function note(id: string, content: string): Note {
  return { id, content, createdAt: 1, updatedAt: 1, pinned: false, archived: false };
}

test('prepares recoverable device keys before first-device setup is claimed', async () => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  try {
    const keys = new DeviceKeyStore(new MemoryClientStorage());
    const provisioned = await keys.provisionFirstDevice();
    await expect(new DeviceKeyStore(new MemoryClientStorage()).restoreDeviceFromRecovery(provisioned.recoveryKit))
      .resolves.toEqual(provisioned.masterKey);

    const client = new RelayClient(relay.endpoint);
    await expect(client.claimSetup('wrong-token', provisioned.deviceId, 'First device'))
      .rejects.toThrow('invalid_setup_token');
    await expect(client.status()).resolves.toMatchObject({ initialized: false });

    const claimed = await client.claimSetup(relay.setupToken, provisioned.deviceId, 'First device');
    await expect(new RelayClient(relay.endpoint, claimed.deviceCredential).vault())
      .resolves.toEqual({ vaultId: claimed.instanceId });
  } finally {
    await relay.stop();
  }
});

test('reclaims device access with an operator recovery token', async () => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token' },
  });
  try {
    const original = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      'lost-device',
      'Lost device',
    );
    await fetch(`${relay.endpoint}/devices/lost-device`, {
      method: 'DELETE',
      headers: { authorization: `Device ${original.deviceCredential}` },
    });

    const recovered = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token',
      'recovered-device',
      'Recovered device',
    );

    expect(recovered.instanceId).toBe(original.instanceId);
    await expect(new RelayClient(relay.endpoint, recovered.deviceCredential).vault())
      .resolves.toEqual({ vaultId: original.instanceId });
  } finally {
    await relay.stop();
  }
});

test('revokes another device through the SDK', async () => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token' },
  });
  try {
    const owner = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      'owner-device',
      'Owner device',
    );
    const second = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token',
      'second-device',
      'Second device',
    );
    const ownerClient = new RelayClient(relay.endpoint, owner.deviceCredential);

    await ownerClient.revokeDevice('second-device');

    await expect(new RelayClient(relay.endpoint, second.deviceCredential).vault())
      .rejects.toThrow('invalid_device_credential');
    const revoked = (await ownerClient.devices()).devices.find(device => device.id === 'second-device');
    expect(revoked?.revokedAt).toEqual(expect.any(String));
  } finally {
    await relay.stop();
  }
});

test('restores an encrypted vault after all device credentials are lost', async () => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token' },
  });
  try {
    const originalKeys = new DeviceKeyStore(new MemoryClientStorage());
    const provisioned = await originalKeys.provisionFirstDevice();
    const claimed = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      provisioned.deviceId,
      'Only device',
    );
    const originalSession: RelaySession = {
      endpoint: relay.endpoint,
      instanceId: claimed.instanceId,
      deviceId: provisioned.deviceId,
      credential: claimed.deviceCredential,
    };
    await new EncryptedSync(originalSession, provisioned.masterKey, new MemoryClientStorage())
      .push(note('recovery-note', 'survives losing every device'));
    await new RelayClient(relay.endpoint, claimed.deviceCredential).revokeDevice(provisioned.deviceId);

    const recoveredKeys = new DeviceKeyStore(new MemoryClientStorage());
    const recoveredMasterKey = await recoveredKeys.restoreDeviceFromRecovery(provisioned.recoveryKit);
    const recoveredDeviceId = await recoveredKeys.getDeviceId();
    const reclaimed = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token',
      recoveredDeviceId,
      'Recovered device',
    );
    const recoveredSession: RelaySession = {
      endpoint: relay.endpoint,
      instanceId: reclaimed.instanceId,
      deviceId: recoveredDeviceId,
      credential: reclaimed.deviceCredential,
    };

    expect(recoveredMasterKey).toEqual(provisioned.masterKey);
    await expect(new EncryptedSync(recoveredSession, recoveredMasterKey, new MemoryClientStorage()).pull())
      .resolves.toMatchObject({ notes: [note('recovery-note', 'survives losing every device')] });
  } finally {
    await relay.stop();
  }
});
