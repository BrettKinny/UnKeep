const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += ALPHABET[first >> 2];
    result += ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    result += second === undefined ? '=' : ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    result += third === undefined ? '=' : ALPHABET[third & 63];
  }
  return result;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const result = new Uint8Array(value.length / 4 * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = ALPHABET.indexOf(value[index]);
    const second = ALPHABET.indexOf(value[index + 1]);
    const third = value[index + 2] === '=' ? 0 : ALPHABET.indexOf(value[index + 2]);
    const fourth = value[index + 3] === '=' ? 0 : ALPHABET.indexOf(value[index + 3]);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) throw new Error('Invalid base64');
    if (offset < result.length) result[offset++] = (first << 2) | (second >> 4);
    if (offset < result.length) result[offset++] = ((second & 15) << 4) | (third >> 2);
    if (offset < result.length) result[offset++] = ((third & 3) << 6) | fourth;
  }
  return result;
}
