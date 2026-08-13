import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_ADMINISTRATIVE_TOKEN_LENGTH = 32;
export const MAX_ADMINISTRATIVE_TOKEN_LENGTH = 256;

const ADMINISTRATIVE_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export function validateAdministrativeToken(name, token, { required = true } = {}) {
  if (token === '' && !required) return token;
  if (
    typeof token !== 'string' ||
    token.length < MIN_ADMINISTRATIVE_TOKEN_LENGTH
    || token.length > MAX_ADMINISTRATIVE_TOKEN_LENGTH
    || !ADMINISTRATIVE_TOKEN_PATTERN.test(token)
  ) {
    throw new Error(
      `${name} must be ${MIN_ADMINISTRATIVE_TOKEN_LENGTH}-${MAX_ADMINISTRATIVE_TOKEN_LENGTH} printable ASCII characters without whitespace; generate it with "openssl rand -base64 32"`,
    );
  }
  return token;
}

export function resolveRecoveryToken({
  configuredToken,
  setupToken,
  allowSetupTokenRecovery,
}) {
  if (!configuredToken && !allowSetupTokenRecovery) {
    throw new Error(
      'UNKEEP_RECOVERY_TOKEN is required; setup-token recovery requires explicit UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1',
    );
  }
  if (
    configuredToken
    && configuredToken === setupToken
    && !allowSetupTokenRecovery
  ) {
    throw new Error(
      'UNKEEP_RECOVERY_TOKEN must differ from UNKEEP_SETUP_TOKEN unless UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1',
    );
  }

  return validateAdministrativeToken(
    'UNKEEP_RECOVERY_TOKEN',
    configuredToken || setupToken,
  );
}

export function timingSafeSecretEqual(supplied, expected) {
  const suppliedDigest = createHash('sha256')
    .update(typeof supplied === 'string' ? supplied : '')
    .digest();
  const expectedDigest = createHash('sha256')
    .update(typeof expected === 'string' ? expected : '')
    .digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function authorizeAdministrativeSecret({
  rateLimiter,
  source,
  supplied,
  expected,
}) {
  const rate = rateLimiter.status(source);
  if (!rate.allowed) {
    return {
      authorized: false,
      rateLimited: true,
      retryAfterMs: rate.retryAfterMs,
    };
  }
  if (!expected || !timingSafeSecretEqual(supplied, expected)) {
    rateLimiter.recordFailure(source);
    return { authorized: false, rateLimited: false };
  }
  return { authorized: true, rateLimited: false };
}

export function createFailedSecretRateLimiter({
  windowMs,
  sourceLimit,
  globalLimit,
  now = Date.now,
}) {
  let globalFailures = [];
  const failuresBySource = new Map();

  function normalizedSource(source) {
    const value = typeof source === 'string' ? source : 'unknown';
    return value.slice(0, 128) || 'unknown';
  }

  function activeFailures(failures, currentTime) {
    const cutoff = currentTime - windowMs;
    let firstActive = 0;
    while (
      firstActive < failures.length
      && failures[firstActive] <= cutoff
    ) {
      firstActive += 1;
    }
    return firstActive === 0 ? failures : failures.slice(firstActive);
  }

  function prune(currentTime) {
    globalFailures = activeFailures(globalFailures, currentTime);
    for (const [source, failures] of failuresBySource) {
      const active = activeFailures(failures, currentTime);
      if (active.length) failuresBySource.set(source, active);
      else failuresBySource.delete(source);
    }
  }

  function retryAfter(failures, currentTime) {
    return Math.max(
      1,
      Math.min(windowMs, failures[0] + windowMs - currentTime),
    );
  }

  function statusAt(source, currentTime) {
    const sourceFailures = failuresBySource.get(source) ?? [];
    if (sourceFailures.length >= sourceLimit) {
      return {
        allowed: false,
        scope: 'source',
        retryAfterMs: retryAfter(sourceFailures, currentTime),
      };
    }
    if (globalFailures.length >= globalLimit) {
      return {
        allowed: false,
        scope: 'global',
        retryAfterMs: retryAfter(globalFailures, currentTime),
      };
    }
    return { allowed: true };
  }

  return {
    status(source) {
      const currentTime = now();
      const normalized = normalizedSource(source);
      prune(currentTime);
      return statusAt(normalized, currentTime);
    },

    recordFailure(source) {
      const currentTime = now();
      const normalized = normalizedSource(source);
      prune(currentTime);
      const status = statusAt(normalized, currentTime);
      if (!status.allowed) return status;

      const sourceFailures = failuresBySource.get(normalized) ?? [];
      sourceFailures.push(currentTime);
      failuresBySource.set(normalized, sourceFailures);
      globalFailures.push(currentTime);
      return { allowed: true };
    },

    retainedSourceCount() {
      prune(now());
      return failuresBySource.size;
    },
  };
}
