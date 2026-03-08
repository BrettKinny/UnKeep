import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted } from './encryption.js';

describe('encrypt/decrypt', () => {
  it('roundtrips plaintext', async () => {
    const plaintext = 'Hello, World!';
    const passphrase = 'test-password-123';

    const encrypted = await encrypt(plaintext, passphrase);
    const decrypted = await decrypt(encrypted, passphrase);

    expect(decrypted).toBe(plaintext);
  });

  it('roundtrips empty string', async () => {
    const encrypted = await encrypt('', 'pass');
    const decrypted = await decrypt(encrypted, 'pass');
    expect(decrypted).toBe('');
  });

  it('roundtrips unicode content', async () => {
    const plaintext = '你好世界 🌍 café résumé';
    const encrypted = await encrypt(plaintext, 'pass');
    const decrypted = await decrypt(encrypted, 'pass');
    expect(decrypted).toBe(plaintext);
  });

  it('roundtrips multiline content', async () => {
    const plaintext = 'Line 1\nLine 2\n\nLine 4';
    const encrypted = await encrypt(plaintext, 'pass');
    const decrypted = await decrypt(encrypted, 'pass');
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext each time (random salt/IV)', async () => {
    const a = await encrypt('same', 'pass');
    const b = await encrypt('same', 'pass');
    expect(a).not.toBe(b);
  });

  it('produces base64 output', async () => {
    const encrypted = await encrypt('test', 'pass');
    // Should be valid base64
    expect(() => atob(encrypted)).not.toThrow();
  });

  it('fails to decrypt with wrong passphrase', async () => {
    const encrypted = await encrypt('secret', 'correct-password');
    await expect(decrypt(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('handles long content', async () => {
    const plaintext = 'x'.repeat(10000);
    const encrypted = await encrypt(plaintext, 'pass');
    const decrypted = await decrypt(encrypted, 'pass');
    expect(decrypted).toBe(plaintext);
  });
});

describe('isEncrypted', () => {
  it('returns true for encrypted content', async () => {
    const encrypted = await encrypt('test', 'pass');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('returns false for short strings', () => {
    expect(isEncrypted('short')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(isEncrypted('This is just a regular note with some content that is long enough')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isEncrypted('')).toBe(false);
  });
});
