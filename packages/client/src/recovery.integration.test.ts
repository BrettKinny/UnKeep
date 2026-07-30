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

test('rejects stale relay identity during setup and recovery without changing credentials', async () => {
  const relay=await startTestServer({
    setupToken:'test-setup-token-0000000000000001',
    env:{UNKEEP_RECOVERY_TOKEN:'operator-recovery-token-0000000001'},
  });
  try {
    const anonymous=new RelayClient(relay.endpoint);
    const status=await anonymous.status();
    const wrongInstance='00000000-0000-4000-8000-000000000000';

    await expect(anonymous.claimSetup(
      relay.setupToken,
      wrongInstance,
      'first-device',
      'First device',
    )).rejects.toMatchObject({status:409,code:'instance_mismatch'});
    await expect(anonymous.status()).resolves.toMatchObject({initialized:false});

    const claimed=await anonymous.claimSetup(
      relay.setupToken,
      status.instanceId,
      'first-device',
      'First device',
    );
    const owner=new RelayClient(relay.endpoint,claimed.deviceCredential);
    await expect(anonymous.reclaimSetup(
      'operator-recovery-token-0000000001',
      wrongInstance,
      'recovered-device',
      'Recovered device',
    )).rejects.toMatchObject({status:409,code:'instance_mismatch'});
    await expect(owner.vault()).resolves.toEqual({vaultId:status.instanceId});
    await expect(owner.devices()).resolves.toEqual({devices:[{
      id:'first-device',
      name:'First device',
      revokedAt:null,
      approvedByDeviceId:null,
    }]});

    const recovered=await anonymous.reclaimSetup(
      'operator-recovery-token-0000000001',
      status.instanceId,
      'recovered-device',
      'Recovered device',
    );
    await expect(new RelayClient(relay.endpoint,recovered.deviceCredential).vault())
      .resolves.toEqual({vaultId:status.instanceId});
  } finally {
    await relay.stop();
  }
});

test('prepares recoverable device keys before first-device setup is claimed', async () => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  try {
    const client = new RelayClient(relay.endpoint);
    const status = await client.status();
    const keys = new DeviceKeyStore(new MemoryClientStorage());
    const provisioned = await keys.provisionFirstDevice(status.instanceId);
    await expect(new DeviceKeyStore(new MemoryClientStorage()).restoreDeviceFromRecovery(
      provisioned.recoveryKit,
      status.instanceId,
    ))
      .resolves.toEqual(provisioned.masterKey);

    await expect(client.claimSetup('wrong-token', status.instanceId, provisioned.deviceId, 'First device'))
      .rejects.toThrow('invalid_setup_token');
    await expect(client.status()).resolves.toMatchObject({ initialized: false });

    const claimed = await client.claimSetup(relay.setupToken, status.instanceId, provisioned.deviceId, 'First device');
    expect(claimed.instanceId).toBe(status.instanceId);
    await expect(new RelayClient(relay.endpoint, claimed.deviceCredential).vault())
      .resolves.toEqual({ vaultId: claimed.instanceId });
  } finally {
    await relay.stop();
  }
});

test('reclaims device access with an operator recovery token', async () => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  try {
    const original = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      relay.instanceId,
      'lost-device',
      'Lost device',
    );
    await fetch(`${relay.endpoint}/devices/lost-device`, {
      method: 'DELETE',
      headers: { authorization: `Device ${original.deviceCredential}` },
    });

    const recovered = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token-0000000001',
      relay.instanceId,
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
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  try {
    const owner = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      relay.instanceId,
      'owner-device',
      'Owner device',
    );
    const second = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token-0000000001',
      relay.instanceId,
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
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  try {
    const status = await new RelayClient(relay.endpoint).status();
    const originalKeys = new DeviceKeyStore(new MemoryClientStorage());
    const provisioned = await originalKeys.provisionFirstDevice(status.instanceId);
    const claimed = await new RelayClient(relay.endpoint).claimSetup(
      relay.setupToken,
      status.instanceId,
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
    const recoveredMasterKey = await recoveredKeys.restoreDeviceFromRecovery(
      provisioned.recoveryKit,
      status.instanceId,
    );
    const recoveredDeviceId = await recoveredKeys.getDeviceId();
    const reclaimed = await new RelayClient(relay.endpoint).reclaimSetup(
      'operator-recovery-token-0000000001',
      status.instanceId,
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
