import { describe, it, expect } from 'vitest';
import {
  decodeNote,
  decodeQuickSendNote,
  encodeNote,
  encodeQuickSendNote,
} from './quickSend.js';

describe('encodeNote/decodeNote', () => {
  it('roundtrips simple text', async () => {
    const content = 'Hello, World!';
    const encoded = await encodeNote(content);
    const decoded = await decodeNote(encoded);
    expect(decoded).toBe(content);
  });

  it('roundtrips empty string', async () => {
    const encoded = await encodeNote('');
    const decoded = await decodeNote(encoded);
    expect(decoded).toBe('');
  });

  it('roundtrips unicode content', async () => {
    const content = '你好世界 🌍 café résumé';
    const encoded = await encodeNote(content);
    const decoded = await decodeNote(encoded);
    expect(decoded).toBe(content);
  });

  it('roundtrips multiline content', async () => {
    const content = 'Line 1\nLine 2\n\nLine 4\n\ttabbed';
    const encoded = await encodeNote(content);
    const decoded = await decodeNote(encoded);
    expect(decoded).toBe(content);
  });

  it('produces base64url-safe output', async () => {
    const encoded = await encodeNote('test content');
    // base64url: no +, /, or = characters
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('compresses content (output smaller than input for repetitive text)', async () => {
    const content = 'a'.repeat(1000);
    const encoded = await encodeNote(content);
    expect(encoded.length).toBeLessThan(content.length);
  });

  it('rejects content over 100KB', async () => {
    const content = 'x'.repeat(102401);
    await expect(encodeNote(content)).rejects.toThrow('too large');
  });

  it('accepts content at exactly 100KB', async () => {
    const content = 'x'.repeat(102400);
    // Should not throw
    const encoded = await encodeNote(content);
    expect(encoded).toBeTruthy();
  });

  it('handles special characters', async () => {
    const content = '<script>alert("xss")</script> & "quotes" \'single\'';
    const encoded = await encodeNote(content);
    const decoded = await decodeNote(encoded);
    expect(decoded).toBe(content);
  });

  it('round-trips a versioned note with its title, checklist, labels, and color', async () => {
    const encoded = await encodeQuickSendNote({
      title: 'Packing list',
      content: 'Before Friday',
      checkboxes: [
        { id: 'one', text: 'Passport', checked: true },
        { id: 'two', text: 'Charger', checked: false },
      ],
      labels: ['Travel'],
      color: 'blue',
    });

    await expect(decodeQuickSendNote(encoded)).resolves.toEqual({
      version: 1,
      title: 'Packing list',
      content: 'Before Friday',
      checkboxes: [
        { id: 'one', text: 'Passport', checked: true },
        { id: 'two', text: 'Charger', checked: false },
      ],
      labels: ['Travel'],
      color: 'blue',
    });
  });

  it('preserves title-only notes and accepts legacy text-only links', async () => {
    const titleOnly = await encodeQuickSendNote({ title: 'Do not lose me', content: '' });
    await expect(decodeQuickSendNote(titleOnly)).resolves.toMatchObject({
      version: 1,
      title: 'Do not lose me',
      content: '',
    });

    const legacy = await encodeNote('A link from an older UnKeep');
    await expect(decodeQuickSendNote(legacy)).resolves.toEqual({
      version: 1,
      content: 'A link from an older UnKeep',
    });
  });

  it('round-trips small attachments byte-for-byte', async () => {
    const bytes = new Uint8Array([0, 255, 2, 3, 128]);
    const encoded = await encodeQuickSendNote({
      content: 'See attached',
      attachments: [{ name: 'proof.png', mimeType: 'image/png', size: bytes.byteLength, bytes }],
    });

    const decoded = await decodeQuickSendNote(encoded);
    expect(decoded.attachments).toEqual([
      { name: 'proof.png', mimeType: 'image/png', size: bytes.byteLength, bytes },
    ]);
  });

  it('refuses attachments that make a fragment exceed the 100KB share budget', async () => {
    const bytes = new Uint8Array(100_000);
    crypto.getRandomValues(bytes.subarray(0, 65_536));
    crypto.getRandomValues(bytes.subarray(65_536));
    await expect(encodeQuickSendNote({
      content: '',
      attachments: [{ name: 'huge.bin', mimeType: 'application/octet-stream', size: bytes.length, bytes }],
    })).rejects.toThrow('too large');
  });
});
