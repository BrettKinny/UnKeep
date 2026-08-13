import { createPublicKey } from 'node:crypto';

export const MAX_PAIRING_BODY_BYTES = 4 * 1024;

const PUBLIC_JWK_FIELDS = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);

function isCanonicalCoordinate(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

export function normalizePairingPublicKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(field => !PUBLIC_JWK_FIELDS.has(field))) return null;
  if (value.kty !== 'EC' || value.crv !== 'P-256') return null;
  if (!isCanonicalCoordinate(value.x) || !isCanonicalCoordinate(value.y)) return null;
  if (value.ext !== undefined && value.ext !== true) return null;
  if (value.key_ops !== undefined && (!Array.isArray(value.key_ops) || value.key_ops.length !== 0)) return null;

  const normalized = {
    kty: 'EC',
    crv: 'P-256',
    x: value.x,
    y: value.y,
  };
  try {
    const key = createPublicKey({ key: normalized, format: 'jwk' });
    if (
      key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) return null;
  } catch {
    return null;
  }
  return normalized;
}

export function createPairingRateLimiter({
  windowMs,
  sourceLimit,
  globalLimit,
  now = Date.now,
}) {
  let globalAttempts = [];
  const attemptsBySource = new Map();

  function activeAttempts(attempts, currentTime) {
    const cutoff = currentTime - windowMs;
    return attempts.filter(timestamp => timestamp > cutoff);
  }

  function retryAfter(attempts, currentTime) {
    return Math.max(1, attempts[0] + windowMs - currentTime);
  }

  return {
    attempt(source) {
      const currentTime = now();
      globalAttempts = activeAttempts(globalAttempts, currentTime);
      for (const [knownSource, attempts] of attemptsBySource) {
        const active = activeAttempts(attempts, currentTime);
        if (active.length) attemptsBySource.set(knownSource, active);
        else attemptsBySource.delete(knownSource);
      }

      const sourceAttempts = attemptsBySource.get(source) ?? [];
      if (sourceAttempts.length >= sourceLimit) {
        return {
          allowed: false,
          scope: 'source',
          retryAfterMs: retryAfter(sourceAttempts, currentTime),
        };
      }
      if (globalAttempts.length >= globalLimit) {
        return {
          allowed: false,
          scope: 'global',
          retryAfterMs: retryAfter(globalAttempts, currentTime),
        };
      }

      sourceAttempts.push(currentTime);
      attemptsBySource.set(source, sourceAttempts);
      globalAttempts.push(currentTime);
      return { allowed: true };
    },
  };
}
