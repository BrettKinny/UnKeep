import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPairingRateLimiter,
  normalizePairingPublicKey,
} from '../src/pairingSecurity.mjs';

const VALID_PUBLIC_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'TVC4DDeSdLtCXIcq4O3JN23gk9PQGNby_E1GyWuqEdk',
  y: 'wqByzVBixoTLN9eZYpkKJTON632EX5KTuqyGhA_XjY4',
};

test('normalizes a public P-256 JWK without retaining optional metadata', () => {
  assert.deepEqual(
    normalizePairingPublicKey({ ...VALID_PUBLIC_KEY, ext: true, key_ops: [] }),
    VALID_PUBLIC_KEY,
  );
  assert.equal(normalizePairingPublicKey({
    ...VALID_PUBLIC_KEY,
    d: VALID_PUBLIC_KEY.x,
  }), null);
});

test('pairing rate windows reset deterministically without retaining stale sources', () => {
  let currentTime = 1_000;
  const limiter = createPairingRateLimiter({
    windowMs: 1_000,
    sourceLimit: 1,
    globalLimit: 2,
    now: () => currentTime,
  });

  assert.deepEqual(limiter.attempt('source-a'), { allowed: true });
  assert.deepEqual(limiter.attempt('source-a'), {
    allowed: false,
    scope: 'source',
    retryAfterMs: 1_000,
  });
  assert.deepEqual(limiter.attempt('source-b'), { allowed: true });
  assert.deepEqual(limiter.attempt('source-c'), {
    allowed: false,
    scope: 'global',
    retryAfterMs: 1_000,
  });

  currentTime += 1_000;
  assert.deepEqual(limiter.attempt('source-a'), { allowed: true });
  assert.deepEqual(limiter.attempt('source-c'), { allowed: true });
});
