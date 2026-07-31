const BASE64 = /^[A-Za-z0-9+/]*(?:={1,2})?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const AES_GCM_TAG_BYTES = 16;
export const MAX_RECORD_ID_LENGTH = 128;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidRecordId(value) {
  return typeof value === 'string' && RECORD_ID.test(value);
}

export function canonicalBase64Size(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !BASE64.test(value)
  ) return null;

  const firstPadding = value.indexOf('=');
  const padding = firstPadding === -1 ? 0 : value.length - firstPadding;
  if (padding > 2 || (padding && firstPadding < value.length - 2)) return null;

  const lastData = BASE64_ALPHABET.indexOf(value[value.length - padding - 1]);
  if (lastData < 0) return null;
  if (padding === 2 && (lastData & 0b1111) !== 0) return null;
  if (padding === 1 && (lastData & 0b11) !== 0) return null;
  return value.length / 4 * 3 - padding;
}

export function normalizeRecordEnvelope(value, expectedKeyId, maximumCiphertextBytes) {
  if (
    !isValidRecordId(expectedKeyId)
    || !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return null;
  if (
    value.version !== 1
    || value.algorithm !== 'AES-GCM'
    || value.keyId !== expectedKeyId
    || canonicalBase64Size(value.iv) !== 12
  ) return null;
  const ciphertextBytes = canonicalBase64Size(value.ciphertext);
  if (
    ciphertextBytes === null
    || ciphertextBytes < AES_GCM_TAG_BYTES
    || ciphertextBytes > maximumCiphertextBytes
  ) return null;
  return {
    version: 1,
    algorithm: 'AES-GCM',
    keyId: expectedKeyId,
    iv: value.iv,
    ciphertext: value.ciphertext,
  };
}
