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

  private async persistMasterKey(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
    const deviceId = await this.getDeviceId();
    const wrappingKey = await generateDeviceWrappingKey();
    const masterKeyEnvelope = await wrapMasterKeyForDevice(masterKey, wrappingKey, deviceId);
    await this.storage.set<StoredDeviceKeys>(DEVICE_KEYS_KEY, { id: 'current', deviceId, wrappingKey, masterKeyEnvelope });
    return deviceId;
  }

  private async persistCompatibleMasterKey(masterKey:Uint8Array<ArrayBuffer>):Promise<string> {
    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (existing) {
      const storedMasterKey=await unwrapMasterKeyForDevice(existing.masterKeyEnvelope,existing.wrappingKey,existing.deviceId);
      if (!sameKey(storedMasterKey,masterKey)) throw new VaultKeyMismatchError();
      return existing.deviceId;
    }
    return this.persistMasterKey(masterKey);
  }

  async persistPairedMasterKey(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
    return this.persistCompatibleMasterKey(masterKey);
  }

  async provisionFirstDevice(): Promise<ProvisionedKeys> {
    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (existing) throw new Error('This device already has encryption keys');
    const masterKey = generateMasterKey();
    const deviceId = await this.persistMasterKey(masterKey);
    const recoveryKit = exportRecoveryKit(await createRecoveryKit(masterKey));
    return { deviceId, masterKey, recoveryKit };
  }

  async createRecoveryKit(): Promise<string> {
    const masterKey = await this.unlockDevice();
    if (!masterKey) throw new Error('This device has no encryption keys');
    return exportRecoveryKit(await createRecoveryKit(masterKey));
  }

  async unlockDevice(): Promise<Uint8Array<ArrayBuffer> | null> {
    const stored = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (!stored) return null;
    return unwrapMasterKeyForDevice(stored.masterKeyEnvelope, stored.wrappingKey, stored.deviceId);
  }

  async clearDevice():Promise<void> {
    await this.storage.delete(DEVICE_KEYS_KEY);
    await this.storage.delete(DEVICE_ID_KEY);
  }

  async restoreDeviceFromRecovery(serializedKit: string): Promise<Uint8Array<ArrayBuffer>> {
    const masterKey = await recoverMasterKey(importRecoveryKit(serializedKit));
    await this.persistCompatibleMasterKey(masterKey);
    return masterKey;
  }
}
