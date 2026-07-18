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

describe('E2EE envelopes', () => {
  it('round trips a note and authenticates its owner and id', async () => {
    const masterKey = generateMasterKey();
    const envelope = await encryptNote(note, masterKey, { ownerId: 'owner-1', noteId: note.id });

    await expect(decryptNote(envelope, masterKey, { ownerId: 'owner-1', noteId: note.id })).resolves.toEqual(note);
    await expect(decryptNote(envelope, masterKey, { ownerId: 'owner-2', noteId: note.id })).rejects.toThrow();
  });

  it('rejects modified ciphertext', async () => {
    const masterKey = generateMasterKey();
    const envelope = await encryptNote(note, masterKey, { ownerId: 'owner-1', noteId: note.id });
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` };

    await expect(decryptNote(tampered, masterKey, { ownerId: 'owner-1', noteId: note.id })).rejects.toThrow();
  });

  it('wraps a master key with a non-exportable device key', async () => {
    const masterKey = generateMasterKey();
    const deviceKey = await generateDeviceWrappingKey();
    expect(deviceKey.extractable).toBe(false);

    const envelope = await wrapMasterKeyForDevice(masterKey, deviceKey, 'device-1');
    await expect(unwrapMasterKeyForDevice(envelope, deviceKey, 'device-1')).resolves.toEqual(masterKey);
    await expect(unwrapMasterKeyForDevice(envelope, deviceKey, 'device-2')).rejects.toThrow();
  });

  it('exports and imports a recovery kit that restores the master key', async () => {
    const masterKey = generateMasterKey();
    const serialized = exportRecoveryKit(await createRecoveryKit(masterKey, 'recovery-1'));
    const restored = await recoverMasterKey(importRecoveryKit(serialized));

    expect(restored).toEqual(masterKey);
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
