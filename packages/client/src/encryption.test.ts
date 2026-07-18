import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted } from './encryption.js';

describe('encrypt/decrypt', () => {
  it('roundtrips plaintext', async () => {
    const encrypted = await encrypt('Hello, World!', 'test-password-123');
    expect(await decrypt(encrypted, 'test-password-123')).toBe('Hello, World!');
  });

  it('roundtrips empty, unicode, multiline, and long content', async () => {
    for (const plaintext of ['', '你好世界 🌍 café résumé', 'Line 1\nLine 2\n\nLine 4', 'x'.repeat(10000)]) {
      expect(await decrypt(await encrypt(plaintext, 'pass'), 'pass')).toBe(plaintext);
    }
  });

  it('uses a fresh salt and IV', async () => {
    expect(await encrypt('same', 'pass')).not.toBe(await encrypt('same', 'pass'));
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    await expect(decrypt(await encrypt('secret', 'correct-password'), 'wrong-password')).rejects.toThrow();
  });
});

describe('isEncrypted', () => {
  it('recognizes encrypted content', async () => {
    expect(isEncrypted(await encrypt('test', 'pass'))).toBe(true);
  });

  it.each(['short', 'This is just a regular note with some content that is long enough', ''])('rejects plaintext %#', value => {
    expect(isEncrypted(value)).toBe(false);
  });
});
