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

const DB_NAME = 'unkeep-keys';
const DB_VERSION = 1;
const STORE_NAME = 'device-keys';
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeKeys(keys: StoredDeviceKeys): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(keys);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function readKeys(): Promise<StoredDeviceKeys | null> {
  const db = await openDb();
  const value = await new Promise<StoredDeviceKeys | undefined>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value ?? null;
}

export function getDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

async function persistMasterKey(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const deviceId = getDeviceId();
  const wrappingKey = await generateDeviceWrappingKey();
  const masterKeyEnvelope = await wrapMasterKeyForDevice(masterKey, wrappingKey, deviceId);
  await writeKeys({ id: 'current', deviceId, wrappingKey, masterKeyEnvelope });
  return deviceId;
}

/** Persists a master key received over an authenticated device-pairing channel. */
export async function persistPairedMasterKey(masterKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const existing = await readKeys();
  if (existing) throw new Error('This device already has encryption keys');
  return persistMasterKey(masterKey);
}

export async function provisionFirstDevice(): Promise<ProvisionedKeys> {
  const existing = await readKeys();
  if (existing) throw new Error('This device already has encryption keys');
  const masterKey = generateMasterKey();
  const deviceId = await persistMasterKey(masterKey);
  const recoveryKit = exportRecoveryKit(await createRecoveryKit(masterKey));
  return { deviceId, masterKey, recoveryKit };
}

export async function unlockDevice(): Promise<Uint8Array<ArrayBuffer> | null> {
  const stored = await readKeys();
  if (!stored) return null;
  return unwrapMasterKeyForDevice(stored.masterKeyEnvelope, stored.wrappingKey, stored.deviceId);
}

export async function restoreDeviceFromRecovery(serializedKit: string): Promise<Uint8Array<ArrayBuffer>> {
  const masterKey = await recoverMasterKey(importRecoveryKit(serializedKit));
  await persistMasterKey(masterKey);
  return masterKey;
}

export function downloadRecoveryKit(serializedKit: string): void {
  const blob = new Blob([serializedKit], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'unkeep-recovery-kit.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
