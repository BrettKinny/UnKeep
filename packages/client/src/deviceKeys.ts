import {
  createRecoveryKit,
  exportRecoveryKit,
  generateDeviceWrappingKey,
  generateMasterKey,
  importRecoveryKit,
  recoverMasterKey,
  unwrapMasterKeyForDevice,
  wrapMasterKeyForDevice,
  type EncryptedEnvelope,
} from '@unkeep/core';
import type { ClientStorage } from './storage.js';

const DEVICE_KEYS_KEY = 'unkeep-device-keys';
const DEVICE_ID_KEY = 'unkeep-device-id';

interface StoredDeviceKeys {
  id: 'current';
  deviceId: string;
  wrappingKey: CryptoKey;
  masterKeyEnvelope: EncryptedEnvelope;
  version?: 2;
  instanceId?: string;
}

export interface ProvisionedKeys {
  deviceId: string;
  masterKey: Uint8Array<ArrayBuffer>;
  recoveryKit: string;
}

export class VaultKeyMismatchError extends Error {
  readonly name:string = 'VaultKeyMismatchError';

  constructor() {
    super('This device already stores a key for a different vault. Clear this device before switching vaults.');
  }
}

export class VaultInstanceMismatchError extends Error {
  readonly name = 'VaultInstanceMismatchError';

  constructor() {
    super('Stored vault access belongs to a different relay instance. Clear this device before switching vaults.');
  }
}

function sameKey(left:Uint8Array<ArrayBuffer>,right:Uint8Array<ArrayBuffer>):boolean {
  if (left.byteLength!==right.byteLength) return false;
  let difference=0;
  for (let index=0;index<left.byteLength;index+=1) difference|=left[index]^right[index];
  return difference===0;
}

export class DeviceKeyStore {
  constructor(private readonly storage: ClientStorage) {}

  async getDeviceId(): Promise<string> {
    let deviceId = await this.storage.get<string>(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = globalThis.crypto.randomUUID();
      await this.storage.set(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }

  private async persistMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
    existingDeviceId?: string,
  ): Promise<string> {
    const deviceId = existingDeviceId ?? await this.getDeviceId();
    const wrappingKey = await generateDeviceWrappingKey();
    const masterKeyEnvelope = await wrapMasterKeyForDevice(masterKey, wrappingKey, deviceId, instanceId);
    await this.storage.set<StoredDeviceKeys>(DEVICE_KEYS_KEY, {
      id: 'current',
      version: 2,
      instanceId,
      deviceId,
      wrappingKey,
      masterKeyEnvelope,
    });
    return deviceId;
  }

  private async persistCompatibleMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
  ): Promise<string> {
    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (existing) {
      if (existing.instanceId && existing.instanceId !== instanceId) {
        throw new VaultInstanceMismatchError();
      }
      const storedMasterKey = await unwrapMasterKeyForDevice(
        existing.masterKeyEnvelope,
        existing.wrappingKey,
        existing.deviceId,
        existing.instanceId,
      );
      if (!sameKey(storedMasterKey,masterKey)) throw new VaultKeyMismatchError();
      if (!existing.instanceId) {
        await this.persistMasterKey(masterKey, instanceId, existing.deviceId);
      }
      return existing.deviceId;
    }
    return this.persistMasterKey(masterKey, instanceId);
  }

  async persistPairedMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
  ): Promise<string> {
    return this.persistCompatibleMasterKey(masterKey, instanceId);
  }

  async provisionFirstDevice(instanceId: string): Promise<ProvisionedKeys> {
    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (existing) throw new Error('This device already has encryption keys');
    const masterKey = generateMasterKey();
    const deviceId = await this.persistMasterKey(masterKey, instanceId);
    const recoveryKit = exportRecoveryKit(await createRecoveryKit(masterKey, instanceId));
    return { deviceId, masterKey, recoveryKit };
  }

  async createRecoveryKit(): Promise<string> {
    const stored = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (!stored?.instanceId) throw new Error('Stored vault key is not bound to a relay instance');
    const masterKey = await this.unlockDevice(stored.instanceId);
    if (!masterKey) throw new Error('This device has no encryption keys');
    return exportRecoveryKit(await createRecoveryKit(masterKey, stored.instanceId));
  }

  async hasDeviceKeys(): Promise<boolean> {
    return Boolean(await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY));
  }

  async unlockDevice(instanceId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const stored = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (!stored) return null;
    if (stored.instanceId && stored.instanceId !== instanceId) {
      throw new VaultInstanceMismatchError();
    }
    const masterKey = await unwrapMasterKeyForDevice(
      stored.masterKeyEnvelope,
      stored.wrappingKey,
      stored.deviceId,
      stored.instanceId,
    );
    if (!stored.instanceId) {
      await this.persistMasterKey(masterKey, instanceId, stored.deviceId);
    }
    return masterKey;
  }

  async clearDevice():Promise<void> {
    await this.storage.delete(DEVICE_KEYS_KEY);
    await this.storage.delete(DEVICE_ID_KEY);
  }

  async restoreDeviceFromRecovery(
    serializedKit: string,
    expectedInstanceId: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const kit = importRecoveryKit(serializedKit);
    if (kit.version === 1) throw new Error('Legacy recovery kit requires confirmation');
    if (kit.instanceId !== expectedInstanceId) throw new VaultInstanceMismatchError();
    const masterKey = await recoverMasterKey(kit, expectedInstanceId);
    await this.persistCompatibleMasterKey(masterKey, expectedInstanceId);
    return masterKey;
  }
}
