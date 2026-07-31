import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalBase64Size,
  isValidRecordId,
  normalizeRecordEnvelope,
} from '../src/recordValidation.mjs';

const envelope = {
  version: 1,
  algorithm: 'AES-GCM',
  keyId: 'note-one',
  iv: Buffer.alloc(12, 1).toString('base64'),
  ciphertext: Buffer.alloc(16, 2).toString('base64'),
};

test('accepts and strips a canonical context-bound AES-GCM envelope', () => {
  assert.deepEqual(
    normalizeRecordEnvelope({ ...envelope, ignored: 'metadata' }, 'note-one', 16),
    envelope,
  );
});

test('rejects cross-record, unsupported, malformed, truncated, and oversized envelopes', () => {
  for (const candidate of [
    { ...envelope, keyId: 'other-note' },
    { ...envelope, algorithm: 'AES-CBC' },
    { ...envelope, iv: 'not base64' },
    { ...envelope, ciphertext: Buffer.alloc(15).toString('base64') },
    { ...envelope, ciphertext: Buffer.alloc(17).toString('base64') },
    { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}A=` },
  ]) {
    assert.equal(normalizeRecordEnvelope(candidate, 'note-one', 16), null);
  }
});

test('enforces the shared route-safe record identity boundary', () => {
  assert.equal(isValidRecordId('a'.repeat(128)), true);
  for (const id of ['', 'a'.repeat(129), 'bad.dot', '../note', 'note%2Fother']) {
    assert.equal(isValidRecordId(id), false);
    assert.equal(
      normalizeRecordEnvelope(
        { ...envelope, keyId: id },
        id,
        16,
      ),
      null,
    );
  }
});

test('computes only canonical padded base64 sizes', () => {
  assert.equal(canonicalBase64Size('AA=='), 1);
  assert.equal(canonicalBase64Size('AAA='), 2);
  assert.equal(canonicalBase64Size('AAAA'), 3);
  assert.equal(canonicalBase64Size('AB=='), null);
  assert.equal(canonicalBase64Size('AAB='), null);
  assert.equal(canonicalBase64Size('AA=A'), null);
  assert.equal(canonicalBase64Size(''), null);
});
