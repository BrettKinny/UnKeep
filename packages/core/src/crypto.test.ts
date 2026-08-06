import { describe, expect, it } from 'vitest';
import type { Note, NoteAttachment } from './types.js';
import {
  createRecoveryKit,
  decryptAttachment,
  decryptNote,
  encryptAttachment,
  encryptNote,
  exportRecoveryKit,
  generateDeviceWrappingKey,
  generateMasterKey,
  importRecoveryKit,
  recoverMasterKey,
  unwrapMasterKeyForDevice,
  wrapMasterKeyForDevice,
  type EncryptedEnvelopeV1,
  type NoteEncryptionContext,
} from './crypto.js';

const note: Note = {
  id: 'note-1',
  content: 'private content',
  createdAt: 1,
  updatedAt: 2,
  pinned: true,
  archived: false,
  color: 'teal',
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptRawNote(
  value: unknown,
  masterKey: Uint8Array<ArrayBuffer>,
  context: NoteEncryptionContext,
): Promise<EncryptedEnvelopeV1> {
  const key = await crypto.subtle.importKey('raw', masterKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(
    `unkeep:1:note:${context.ownerId}:${context.noteId}:${context.noteId}`,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    version: 1,
    algorithm: 'AES-GCM',
    keyId: context.noteId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

describe('E2EE envelopes', () => {
  it('round trips a note and authenticates its owner and id', async () => {
    const masterKey = generateMasterKey();
    const envelope = await encryptNote(note, masterKey, { ownerId: 'owner-1', noteId: note.id });

    await expect(decryptNote(envelope, masterKey, { ownerId: 'owner-1', noteId: note.id })).resolves.toEqual({
      ...note,
      schemaVersion: 2,
    });
    await expect(decryptNote(envelope, masterKey, { ownerId: 'owner-2', noteId: note.id })).rejects.toThrow();
  });

  it('rejects modified ciphertext', async () => {
    const masterKey = generateMasterKey();
    const envelope = await encryptNote(note, masterKey, { ownerId: 'owner-1', noteId: note.id });
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` };

    await expect(decryptNote(tampered, masterKey, { ownerId: 'owner-1', noteId: note.id })).rejects.toThrow();
  });

  it('normalizes decrypted notes and discards executable attachment URLs', async () => {
    const masterKey = generateMasterKey();
    const hostile = {
      ...note,
      images: [{
        id: 'attachment-1',
        name: 'payload.txt',
        mimeType: 'text/plain',
        size: 7,
        url: 'javascript:alert(document.domain)',
      }],
    };
    const context = { ownerId: 'owner-1', noteId: hostile.id };
    const envelope = await encryptRawNote(hostile, masterKey, context);

    await expect(decryptNote(envelope, masterKey, context)).resolves.toEqual({
      ...note,
      schemaVersion: 2,
      images: [{
        id: 'attachment-1',
        name: 'payload.txt',
        mimeType: 'text/plain',
        size: 7,
      }],
    });
  });

  it('rejects a decrypted note whose identity differs from its envelope context', async () => {
    const masterKey = generateMasterKey();
    const envelope = await encryptRawNote(
      { ...note, id: 'other-note' },
      masterKey,
      { ownerId: 'owner-1', noteId: 'note-1' },
    );

    await expect(decryptNote(envelope, masterKey, {
      ownerId: 'owner-1',
      noteId: 'note-1',
    })).rejects.toThrow();
  });

  it('wraps a master key with a non-exportable device key', async () => {
    const masterKey = generateMasterKey();
    const deviceKey = await generateDeviceWrappingKey();
    expect(deviceKey.extractable).toBe(false);

    const envelope = await wrapMasterKeyForDevice(masterKey, deviceKey, 'device-1', 'vault-1');
    await expect(unwrapMasterKeyForDevice(envelope, deviceKey, 'device-1', 'vault-1')).resolves.toEqual(masterKey);
    await expect(unwrapMasterKeyForDevice(envelope, deviceKey, 'device-2', 'vault-1')).rejects.toThrow();
    await expect(unwrapMasterKeyForDevice(envelope, deviceKey, 'device-1', 'vault-2')).rejects.toThrow();
  });

  it('exports and imports a recovery kit that restores the master key', async () => {
    const masterKey = generateMasterKey();
    const serialized = exportRecoveryKit(await createRecoveryKit(masterKey, 'vault-1', 'recovery-1'));
    const restored = await recoverMasterKey(importRecoveryKit(serialized), 'vault-1');

    expect(restored).toEqual(masterKey);
  });

  it('authenticates the relay instance in a v2 recovery kit', async () => {
    const masterKey = generateMasterKey();
    const kit = await createRecoveryKit(masterKey, 'vault-1', 'recovery-1');

    expect(kit).toMatchObject({ version: 2, instanceId: 'vault-1' });
    await expect(recoverMasterKey(kit, 'vault-1')).resolves.toEqual(masterKey);
    await expect(recoverMasterKey({ ...kit, instanceId: 'vault-2' }, 'vault-2')).rejects.toThrow();
    await expect(recoverMasterKey(kit, 'vault-2')).rejects.toThrow('different relay');
  });

  it('parses v1 recovery kits only as an explicit legacy format', async () => {
    const legacy = importRecoveryKit(JSON.stringify({
      version: 1,
      recoveryKey: 'legacy-key',
      masterKeyEnvelope: {
        version: 1,
        algorithm: 'AES-GCM',
        keyId: 'legacy-recovery',
        iv: 'legacy-iv',
        ciphertext: 'legacy-ciphertext',
      },
    }));

    expect(legacy.version).toBe(1);
    await expect(recoverMasterKey(legacy, 'vault-1'))
      .rejects.toThrow('explicit migration flow');
  });

  it('rejects an oversized recovery kit before parsing JSON', () => {
    expect(() => importRecoveryKit(' '.repeat(64 * 1024 + 1)))
      .toThrow('Recovery kit is too large');
  });

  it('round trips a non-image attachment envelope', async () => {
    const masterKey = generateMasterKey();
    const bytes = new TextEncoder().encode('%PDF-1.7\nprivate document');
    const attachment = {
      id: 'document-1',
      name: 'private.pdf',
      mimeType: 'application/pdf',
      size: bytes.byteLength,
    } satisfies NoteAttachment;
    const context = { ownerId: 'owner-1', noteId: 'note-1', attachmentId: attachment.id };
    const envelope = await encryptAttachment(bytes, masterKey, context);

    await expect(decryptAttachment(envelope, masterKey, context)).resolves.toEqual(bytes);
  });

  it('authenticates attachment owner, note, and attachment context', async () => {
    const masterKey = generateMasterKey();
    const context = { ownerId: 'owner-1', noteId: 'note-1', attachmentId: 'image-1' };
    const envelope = await encryptAttachment(new Uint8Array([1, 2, 3]), masterKey, context);

    await expect(decryptAttachment(envelope, masterKey, { ...context, ownerId: 'owner-2' })).rejects.toThrow();
    await expect(decryptAttachment(envelope, masterKey, { ...context, noteId: 'note-2' })).rejects.toThrow();
    await expect(decryptAttachment(envelope, masterKey, { ...context, attachmentId: 'image-2' })).rejects.toThrow();
  });

  it('rejects tampered attachment ciphertext', async () => {
    const masterKey = generateMasterKey();
    const context = { ownerId: 'owner-1', noteId: 'note-1', attachmentId: 'image-1' };
    const envelope = await encryptAttachment(new Uint8Array([1, 2, 3]), masterKey, context);
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` };

    await expect(decryptAttachment(tampered, masterKey, context)).rejects.toThrow();
  });
});
