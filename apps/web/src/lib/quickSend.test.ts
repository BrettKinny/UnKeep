import { describe, it, expect } from 'vitest';
import { encodeNote, decodeNote } from './quickSend.js';

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
});
