import { isIP } from 'node:net';

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function validatedListenHost(value) {
  if (value === undefined || value === null || value === '') return '127.0.0.1';
  if (
    typeof value !== 'string'
    || value.length > 253
    || value.trim() !== value
  ) {
    throw new Error(
      'UNKEEP_HOST must be an IP literal or ASCII DNS hostname without whitespace',
    );
  }

  if (isIP(value)) return value;
  if (
    !/[A-Za-z]/.test(value)
    || value.split('.').some(label => !HOSTNAME_LABEL.test(label))
  ) {
    throw new Error(
      'UNKEEP_HOST must be an IP literal or ASCII DNS hostname without whitespace',
    );
  }
  return value.toLowerCase();
}

export function listenHostForUrl(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}
