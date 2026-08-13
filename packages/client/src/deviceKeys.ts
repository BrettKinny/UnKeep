import {
  createRecoveryKit,
  exportRecoveryKit,
  generateDeviceWrappingKey,
  generateMasterKey,
  importRecoveryKit,
  recoverLegacyMasterKey,
  recoverMasterKey,
  unwrapMasterKeyForDevice,
  wrapMasterKeyForDevice,
  type EncryptedEnvelope,
} from '@unkeep/core';
import type { ClientStorage } from './storage.js';

export const DEVICE_KEYS_KEY = 'unkeep-device-keys';
export const DEVICE_ID_KEY = 'unkeep-device-id';
const VAULT_KEY_FINGERPRINT_PREFIX = 'unkeep-vault-key-fingerprint:';
const VALID_DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const deviceKeyStoreBackings = new WeakMap<DeviceKeyStore, ClientStorage>();

interface StoredDeviceKeys {
  id: 'current';
  deviceId: string;
  wrappingKey: CryptoKey;
  masterKeyEnvelope: EncryptedEnvelope;
  /**
   * Opaque mutation identity used for exact CAS across structured-cloned
   * CryptoKeys, whose object identity is not stable across storage reads.
   */
  generation?: string;
  version?: 2;
  instanceId?: string;
}

export interface PairingKeySnapshot {
  readonly storedKeys: StoredDeviceKeys | null;
  readonly fingerprint: string | null;
}

export interface ProvisionedKeys {
  deviceId: string;
  masterKey: Uint8Array<ArrayBuffer>;
  recoveryKit: string;
}

export interface PairingKeyInstallation {
  readonly deviceId: string;
  readonly snapshot: PairingKeySnapshot;
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

async function masterKeyFingerprint(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', masterKey));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fingerprintKey(instanceId: string): string {
  return `${VAULT_KEY_FINGERPRINT_PREFIX}${encodeURIComponent(instanceId)}`;
}

export function deviceKeyFingerprintKey(instanceId: string): string {
  return fingerprintKey(instanceId);
}

export function deviceKeyStoreStorage(keyStore: DeviceKeyStore): ClientStorage {
  const storage = deviceKeyStoreBackings.get(keyStore);
  if (!storage) throw new Error('Device key store is not initialized');
  return storage;
}

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && VALID_DEVICE_ID.test(value);
}

function sameStoredKeys(
  left: StoredDeviceKeys | null,
  right: StoredDeviceKeys | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftEnvelope = left.masterKeyEnvelope;
  const rightEnvelope = right.masterKeyEnvelope;
  return left.id === right.id
    && left.version === right.version
    && left.instanceId === right.instanceId
    && left.deviceId === right.deviceId
    && left.generation === right.generation
    && leftEnvelope.version === rightEnvelope.version
    && leftEnvelope.algorithm === rightEnvelope.algorithm
    && leftEnvelope.keyId === rightEnvelope.keyId
    && leftEnvelope.iv === rightEnvelope.iv
    && leftEnvelope.ciphertext === rightEnvelope.ciphertext;
}

export function pairingKeySnapshotsEqual(
  left: PairingKeySnapshot,
  right: PairingKeySnapshot,
): boolean {
  return sameStoredKeys(left.storedKeys, right.storedKeys)
    && left.fingerprint === right.fingerprint;
}

export class DeviceKeyStore {
  constructor(private readonly storage: ClientStorage) {
    deviceKeyStoreBackings.set(this, storage);
  }

  async getDeviceId(): Promise<string> {
    if (this.storage.transact) {
      let deviceId = '';
      await this.storage.transact(
        [DEVICE_ID_KEY, DEVICE_KEYS_KEY],
        transaction => {
          const current = transaction.get<unknown>(DEVICE_ID_KEY);
          if (current !== null && !validDeviceId(current)) {
            throw new Error('Stored device identity is invalid');
          }
          const storedKeys = transaction.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
          if (storedKeys && !validDeviceId(storedKeys.deviceId)) {
            throw new Error('Stored device key identity is invalid');
          }
          deviceId = current
            ?? storedKeys?.deviceId
            ?? globalThis.crypto.randomUUID();
          transaction.set(DEVICE_ID_KEY, deviceId);
        },
      );
      return deviceId;
    }

    const currentDeviceId = await this.storage.get<unknown>(DEVICE_ID_KEY);
    if (currentDeviceId !== null && !validDeviceId(currentDeviceId)) {
      throw new Error('Stored device identity is invalid');
    }
    let deviceId: string | null = currentDeviceId;
    if (!deviceId) {
      const storedKeys = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
      if (storedKeys && !validDeviceId(storedKeys.deviceId)) {
        throw new Error('Stored device key identity is invalid');
      }
      deviceId = storedKeys?.deviceId ?? globalThis.crypto.randomUUID();
      await this.storage.set(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }

  private async persistMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
    existingDeviceId?: string,
  ): Promise<PairingKeyInstallation> {
    if (!this.storage.transact) {
      throw new Error('Device key persistence requires atomic client storage transactions');
    }
    const deviceId = existingDeviceId ?? await this.getDeviceId();
    const wrappingKey = await generateDeviceWrappingKey();
    const masterKeyEnvelope = await wrapMasterKeyForDevice(masterKey, wrappingKey, deviceId, instanceId);
    const fingerprintStorageKey = fingerprintKey(instanceId);
    const fingerprint = await masterKeyFingerprint(masterKey);
    const storedKeys: StoredDeviceKeys = {
      id: 'current',
      version: 2,
      instanceId,
      deviceId,
      generation: globalThis.crypto.randomUUID(),
      wrappingKey,
      masterKeyEnvelope,
    };
    await this.storage.transact(
      [DEVICE_ID_KEY, DEVICE_KEYS_KEY, fingerprintStorageKey],
      transaction => {
        const currentDeviceId = transaction.get<unknown>(DEVICE_ID_KEY);
        const currentKeys = transaction.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
        const repairsLegacyIdentity = currentDeviceId === null
          && Boolean(existingDeviceId)
          && currentKeys?.deviceId === deviceId
          && !currentKeys.instanceId;
        if (
          (currentDeviceId !== deviceId && !repairsLegacyIdentity)
          || (
            existingDeviceId
              ? !currentKeys
                || currentKeys.deviceId !== deviceId
                || Boolean(currentKeys.instanceId)
              : currentKeys !== null
          )
        ) {
          throw new Error('Device access changed while storing the vault key');
        }
        transaction.set(DEVICE_ID_KEY, deviceId);
        transaction.set(fingerprintStorageKey, fingerprint);
        transaction.set(DEVICE_KEYS_KEY, storedKeys);
      },
    );
    return {
      deviceId,
      snapshot: { storedKeys, fingerprint },
    };
  }

  private async persistCompatibleMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
  ): Promise<PairingKeyInstallation> {
    if (!this.storage.transact) {
      throw new Error('Device key persistence requires atomic client storage transactions');
    }
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
        return this.persistMasterKey(masterKey, instanceId, existing.deviceId);
      } else {
        const key = fingerprintKey(instanceId);
        const fingerprint = await masterKeyFingerprint(masterKey);
        const storedKeys = existing.generation
          ? existing
          : { ...existing, generation: globalThis.crypto.randomUUID() };
        await this.storage.transact([DEVICE_KEYS_KEY, key], transaction => {
          const current = transaction.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
          if (!sameStoredKeys(current, existing)) {
            throw new Error('Device access changed while storing the vault fingerprint');
          }
          transaction.set(DEVICE_KEYS_KEY, storedKeys);
          transaction.set(key, fingerprint);
        });
        return {
          deviceId: existing.deviceId,
          snapshot: { storedKeys, fingerprint },
        };
      }
    }
    return this.persistMasterKey(masterKey, instanceId);
  }

  async installPairedMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
  ): Promise<PairingKeyInstallation> {
    return this.persistCompatibleMasterKey(masterKey, instanceId);
  }

  async persistPairedMasterKey(
    masterKey: Uint8Array<ArrayBuffer>,
    instanceId: string,
  ): Promise<string> {
    return (await this.installPairedMasterKey(masterKey, instanceId)).deviceId;
  }

  async snapshotPairingAccess(instanceId: string): Promise<PairingKeySnapshot> {
    const key = fingerprintKey(instanceId);
    if (this.storage.transact) {
      let snapshot: PairingKeySnapshot | undefined;
      await this.storage.transact([DEVICE_KEYS_KEY, key], transaction => {
        snapshot = {
          storedKeys: transaction.get<StoredDeviceKeys>(DEVICE_KEYS_KEY),
          fingerprint: transaction.get<string>(key),
        };
      });
      return snapshot!;
    }
    return {
      storedKeys: await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY),
      fingerprint: await this.storage.get<string>(key),
    };
  }

  async restorePairingAccess(
    snapshot: PairingKeySnapshot,
    instanceId: string,
    expectedCurrent?: PairingKeySnapshot,
  ): Promise<void> {
    const key = fingerprintKey(instanceId);
    if (!this.storage.transact) {
      throw new Error('Device key rollback requires atomic client storage transactions');
    }
    await this.storage.transact([DEVICE_KEYS_KEY, key], transaction => {
      const current = {
        storedKeys: transaction.get<StoredDeviceKeys>(DEVICE_KEYS_KEY),
        fingerprint: transaction.get<string>(key),
      };
      if (
        expectedCurrent
        && !pairingKeySnapshotsEqual(current, expectedCurrent)
      ) {
        throw new Error('Device key state changed while pairing rollback was pending');
      }
      if (snapshot.storedKeys) transaction.set(DEVICE_KEYS_KEY, snapshot.storedKeys);
      else transaction.delete(DEVICE_KEYS_KEY);
      if (snapshot.fingerprint) transaction.set(key, snapshot.fingerprint);
      else transaction.delete(key);
    });
  }

  async provisionFirstDevice(instanceId: string): Promise<ProvisionedKeys> {
    if (!this.storage.transact) {
      throw new Error('Device key persistence requires atomic client storage transactions');
    }
    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (existing) throw new Error('This device already has encryption keys');
    const masterKey = generateMasterKey();
    const { deviceId } = await this.persistMasterKey(masterKey, instanceId);
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
    if (!this.storage.transact) {
      throw new Error('Device key clearing requires atomic client storage transactions');
    }
    await this.storage.transact(
      [DEVICE_KEYS_KEY, DEVICE_ID_KEY],
      transaction => {
        transaction.delete(DEVICE_KEYS_KEY);
        transaction.delete(DEVICE_ID_KEY);
      },
    );
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

  async validateLegacyRecovery(
    serializedKit: string,
    expectedInstanceId: string,
  ): Promise<void> {
    const kit = importRecoveryKit(serializedKit);
    if (kit.version !== 1) throw new Error('Expected a legacy v1 recovery kit');
    const masterKey = await recoverLegacyMasterKey(kit);
    const fingerprint = await masterKeyFingerprint(masterKey);
    const retained = await this.storage.get<string>(fingerprintKey(expectedInstanceId));
    if (retained && retained !== fingerprint) throw new VaultKeyMismatchError();

    const existing = await this.storage.get<StoredDeviceKeys>(DEVICE_KEYS_KEY);
    if (!existing) return;
    if (existing.instanceId && existing.instanceId !== expectedInstanceId) {
      throw new VaultInstanceMismatchError();
    }
    const storedMasterKey = await unwrapMasterKeyForDevice(
      existing.masterKeyEnvelope,
      existing.wrappingKey,
      existing.deviceId,
      existing.instanceId,
    );
    if (!sameKey(storedMasterKey, masterKey)) throw new VaultKeyMismatchError();
  }

  async restoreLegacyDeviceFromRecovery(
    serializedKit: string,
    expectedInstanceId: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    await this.validateLegacyRecovery(serializedKit, expectedInstanceId);
    const kit = importRecoveryKit(serializedKit);
    if (kit.version !== 1) throw new Error('Expected a legacy v1 recovery kit');
    const masterKey = await recoverLegacyMasterKey(kit);
    await this.persistCompatibleMasterKey(masterKey, expectedInstanceId);
    return masterKey;
  }
}
