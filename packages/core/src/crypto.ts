import type { Note } from './types.js';
import { normalizeNoteRecord } from './noteMigrations.js';

const ENVELOPE_VERSION = 1 as const;
const RECOVERY_KIT_VERSION = 2 as const;
const ALGORITHM = 'AES-GCM' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
export const MAX_RECOVERY_KIT_SERIALIZED_LENGTH = 64 * 1024;

export interface EncryptedEnvelopeV1 {
  version: typeof ENVELOPE_VERSION;
  algorithm: typeof ALGORITHM;
  keyId: string;
  iv: string;
  ciphertext: string;
}

export type EncryptedEnvelope = EncryptedEnvelopeV1;

export interface RecoveryKitV1 {
  version: typeof ENVELOPE_VERSION;
  recoveryKey: string;
  masterKeyEnvelope: EncryptedEnvelopeV1;
}

export interface RecoveryKitV2 {
  version: typeof RECOVERY_KIT_VERSION;
  instanceId: string;
  recoveryKey: string;
  masterKeyEnvelope: EncryptedEnvelopeV1;
}

export type RecoveryKit = RecoveryKitV1 | RecoveryKitV2;

export interface NoteEncryptionContext {
  ownerId: string;
  noteId: string;
}

export interface AttachmentEncryptionContext extends NoteEncryptionContext {
  attachmentId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function aad(purpose: string, keyId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`unkeep:${ENVELOPE_VERSION}:${purpose}:${keyId}`));
}

async function importAesKey(rawKey: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  if (rawKey.byteLength !== KEY_BYTES) throw new Error('An UnKeep key must be 256 bits');
  return crypto.subtle.importKey('raw', rawKey, { name: ALGORITHM }, false, usages);
}

async function encryptBytes(
  plaintext: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  keyId: string,
  purpose: string
): Promise<EncryptedEnvelopeV1> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: aad(purpose, keyId), tagLength: 128 },
    key,
    plaintext
  );
  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    keyId,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptBytes(
  envelope: EncryptedEnvelope,
  key: CryptoKey,
  purpose: string
): Promise<Uint8Array<ArrayBuffer>> {
  assertSupportedEnvelope(envelope);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      iv: base64ToBytes(envelope.iv),
      additionalData: aad(purpose, envelope.keyId),
      tagLength: 128,
    },
    key,
    base64ToBytes(envelope.ciphertext)
  );
  return new Uint8Array(plaintext);
}

export function assertSupportedEnvelope(envelope: EncryptedEnvelope): asserts envelope is EncryptedEnvelopeV1 {
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported encryption envelope version or algorithm`);
  }
}

/** Generates exportable raw key material. Callers should persist it only after wrapping it. */
export function generateMasterKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Generates a non-exportable per-device key suitable for storage as a CryptoKey in IndexedDB. */
export function generateDeviceWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function wrapMasterKeyForDevice(
  masterKey: Uint8Array<ArrayBuffer>,
  deviceKey: CryptoKey,
  deviceId: string,
  instanceId?: string,
): Promise<EncryptedEnvelopeV1> {
  const purpose = instanceId ? `device-master-key:${instanceId}` : 'device-master-key';
  return encryptBytes(masterKey, deviceKey, deviceId, purpose);
}

export async function unwrapMasterKeyForDevice(
  envelope: EncryptedEnvelope,
  deviceKey: CryptoKey,
  deviceId: string,
  instanceId?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.keyId !== deviceId) throw new Error('Device key envelope does not belong to this device');
  const purpose = instanceId ? `device-master-key:${instanceId}` : 'device-master-key';
  return await decryptBytes(envelope, deviceKey, purpose);
}

/** Creates a self-contained recovery kit. Treat the returned object like a password. */
export async function createRecoveryKit(
  masterKey: Uint8Array<ArrayBuffer>,
  instanceId: string,
  keyId: string = crypto.randomUUID()
): Promise<RecoveryKitV2> {
  if (!instanceId) throw new Error('Recovery kit requires a relay instance');
  const recoveryKeyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const recoveryKey = await importAesKey(recoveryKeyBytes, ['encrypt']);
  return {
    version: RECOVERY_KIT_VERSION,
    instanceId,
    recoveryKey: bytesToBase64(recoveryKeyBytes),
    masterKeyEnvelope: await encryptBytes(
      masterKey,
      recoveryKey,
      keyId,
      `recovery-master-key:${instanceId}`,
    ),
  };
}

export async function recoverMasterKey(
  kit: RecoveryKit,
  expectedInstanceId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (kit.version !== RECOVERY_KIT_VERSION) {
    throw new Error('Legacy recovery kit requires the explicit migration flow');
  }
  if (kit.instanceId !== expectedInstanceId) {
    throw new Error('Recovery kit belongs to a different relay instance');
  }
  const recoveryKey = await importAesKey(base64ToBytes(kit.recoveryKey), ['decrypt']);
  return decryptBytes(
    kit.masterKeyEnvelope,
    recoveryKey,
    `recovery-master-key:${kit.instanceId}`,
  );
}

export async function recoverLegacyMasterKey(
  kit: RecoveryKitV1,
): Promise<Uint8Array<ArrayBuffer>> {
  if (kit.version !== ENVELOPE_VERSION) throw new Error('Expected a legacy recovery kit');
  const recoveryKey = await importAesKey(base64ToBytes(kit.recoveryKey), ['decrypt']);
  return decryptBytes(kit.masterKeyEnvelope, recoveryKey, 'recovery-master-key');
}

export function exportRecoveryKit(kit: RecoveryKit): string {
  return JSON.stringify(kit);
}

export function importRecoveryKit(serialized: string): RecoveryKit {
  if (serialized.length > MAX_RECOVERY_KIT_SERIALIZED_LENGTH) {
    throw new Error('Recovery kit is too large');
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid recovery kit');
  const kit = parsed as Partial<RecoveryKit>;
  if (
    (kit.version !== ENVELOPE_VERSION && kit.version !== RECOVERY_KIT_VERSION)
    || typeof kit.recoveryKey !== 'string'
    || !kit.masterKeyEnvelope
    || (kit.version === RECOVERY_KIT_VERSION && typeof kit.instanceId !== 'string')
  ) {
    throw new Error('Invalid or unsupported recovery kit');
  }
  assertSupportedEnvelope(kit.masterKeyEnvelope);
  return kit as RecoveryKit;
}

function notePurpose(context: NoteEncryptionContext): string {
  return `note:${context.ownerId}:${context.noteId}`;
}

export async function encryptNote(
  note: Note,
  masterKey: Uint8Array<ArrayBuffer>,
  context: NoteEncryptionContext
): Promise<EncryptedEnvelopeV1> {
  const portable = normalizeNoteRecord(note);
  if (portable.id !== context.noteId) throw new Error('Note ID does not match encryption context');
  const key = await importAesKey(masterKey, ['encrypt']);
  return encryptBytes(encoder.encode(JSON.stringify(portable)), key, context.noteId, notePurpose(context));
}

export async function decryptNote(
  envelope: EncryptedEnvelope,
  masterKey: Uint8Array<ArrayBuffer>,
  context: NoteEncryptionContext
): Promise<Note> {
  if (envelope.keyId !== context.noteId) throw new Error('Encrypted note does not match requested note');
  const key = await importAesKey(masterKey, ['decrypt']);
  const note = normalizeNoteRecord(
    JSON.parse(decoder.decode(await decryptBytes(envelope, key, notePurpose(context)))) as unknown,
  );
  if (note.id !== context.noteId) throw new Error('Decrypted note does not match requested note');
  return note;
}

function attachmentPurpose(context: AttachmentEncryptionContext): string {
  return `attachment:${context.ownerId}:${context.noteId}:${context.attachmentId}`;
}

/** Encrypts arbitrary attachment bytes without interpreting their format or metadata. */
export async function encryptAttachment(
  attachment: Uint8Array<ArrayBuffer>,
  masterKey: Uint8Array<ArrayBuffer>,
  context: AttachmentEncryptionContext
): Promise<EncryptedEnvelopeV1> {
  const key = await importAesKey(masterKey, ['encrypt']);
  return encryptBytes(attachment, key, context.attachmentId, attachmentPurpose(context));
}

export async function decryptAttachment(
  envelope: EncryptedEnvelope,
  masterKey: Uint8Array<ArrayBuffer>,
  context: AttachmentEncryptionContext
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.keyId !== context.attachmentId) {
    throw new Error('Encrypted attachment does not match requested attachment');
  }
  const key = await importAesKey(masterKey, ['decrypt']);
  return decryptBytes(envelope, key, attachmentPurpose(context));
}
