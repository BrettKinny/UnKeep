import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  authorizeAdministrativeSecret,
  createFailedSecretRateLimiter,
  MAX_ADMINISTRATIVE_TOKEN_LENGTH,
  MIN_ADMINISTRATIVE_TOKEN_LENGTH,
  resolveRecoveryToken,
  timingSafeSecretEqual,
  validateAdministrativeToken,
} from '../src/administrativeSecurity.mjs';

const STRONG_SETUP_TOKEN = 'setup-token-0123456789abcdefghijkl';
const STRONG_RECOVERY_TOKEN = 'recovery-token-0123456789abcdefgh';
const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

test('administrative tokens fail closed outside the printable length boundary', () => {
  assert.equal(
    validateAdministrativeToken('UNKEEP_SETUP_TOKEN', '', { required: false }),
    '',
  );
  assert.equal(
    validateAdministrativeToken('UNKEEP_SETUP_TOKEN', STRONG_SETUP_TOKEN),
    STRONG_SETUP_TOKEN,
  );

  for (const invalid of [
    'x'.repeat(MIN_ADMINISTRATIVE_TOKEN_LENGTH - 1),
    'x'.repeat(MAX_ADMINISTRATIVE_TOKEN_LENGTH + 1),
    `x${'a'.repeat(MIN_ADMINISTRATIVE_TOKEN_LENGTH - 2)}\n`,
    `é${'a'.repeat(MIN_ADMINISTRATIVE_TOKEN_LENGTH - 1)}`,
  ]) {
    assert.throws(
      () => validateAdministrativeToken('UNKEEP_SETUP_TOKEN', invalid),
      /UNKEEP_SETUP_TOKEN must be 32-256 printable ASCII characters/,
    );
  }
});

test('recovery token resolution preserves separation and validates legacy fallback', () => {
  assert.equal(resolveRecoveryToken({
    configuredToken: STRONG_RECOVERY_TOKEN,
    setupToken: STRONG_SETUP_TOKEN,
    allowSetupTokenRecovery: false,
  }), STRONG_RECOVERY_TOKEN);

  assert.throws(() => resolveRecoveryToken({
    configuredToken: '',
    setupToken: STRONG_SETUP_TOKEN,
    allowSetupTokenRecovery: false,
  }), /UNKEEP_RECOVERY_TOKEN is required/);
  assert.throws(() => resolveRecoveryToken({
    configuredToken: STRONG_SETUP_TOKEN,
    setupToken: STRONG_SETUP_TOKEN,
    allowSetupTokenRecovery: false,
  }), /UNKEEP_RECOVERY_TOKEN must differ/);
  assert.throws(() => resolveRecoveryToken({
    configuredToken: '',
    setupToken: 'legacy-but-short',
    allowSetupTokenRecovery: true,
  }), /UNKEEP_RECOVERY_TOKEN must be 32-256 printable ASCII characters/);
  assert.equal(resolveRecoveryToken({
    configuredToken: '',
    setupToken: STRONG_SETUP_TOKEN,
    allowSetupTokenRecovery: true,
  }), STRONG_SETUP_TOKEN);
});

test('secret comparison hashes both different-length inputs before fixed-length comparison', () => {
  assert.equal(timingSafeSecretEqual(STRONG_RECOVERY_TOKEN, STRONG_RECOVERY_TOKEN), true);
  assert.equal(timingSafeSecretEqual('x', STRONG_RECOVERY_TOKEN), false);
  assert.equal(timingSafeSecretEqual(undefined, STRONG_RECOVERY_TOKEN), false);
});

test('failed-secret limiter enforces source and global windows deterministically', () => {
  let currentTime = 10_000;
  const sourceLimiter = createFailedSecretRateLimiter({
    windowMs: 1_000,
    sourceLimit: 2,
    globalLimit: 3,
    now: () => currentTime,
  });

  assert.deepEqual(sourceLimiter.status('source-a'), { allowed: true });
  assert.deepEqual(sourceLimiter.recordFailure('source-a'), { allowed: true });
  assert.deepEqual(sourceLimiter.recordFailure('source-a'), { allowed: true });
  assert.deepEqual(sourceLimiter.status('source-a'), {
    allowed: false,
    scope: 'source',
    retryAfterMs: 1_000,
  });
  assert.deepEqual(sourceLimiter.recordFailure('source-a'), {
    allowed: false,
    scope: 'source',
    retryAfterMs: 1_000,
  });

  assert.deepEqual(sourceLimiter.recordFailure('source-b'), { allowed: true });
  assert.deepEqual(sourceLimiter.status('source-c'), {
    allowed: false,
    scope: 'global',
    retryAfterMs: 1_000,
  });
  assert.equal(sourceLimiter.retainedSourceCount(), 2);

  currentTime += 999;
  assert.equal(sourceLimiter.status('source-a').allowed, false);
  currentTime += 1;
  assert.deepEqual(sourceLimiter.status('source-a'), { allowed: true });
  assert.equal(sourceLimiter.retainedSourceCount(), 0);
});

test('administrative authorization counts only failures and blocks correct secrets after the limit', () => {
  const limiter = createFailedSecretRateLimiter({
    windowMs: 60_000,
    sourceLimit: 2,
    globalLimit: 10,
    now: () => 1_000,
  });
  const authorize = (source, supplied) => authorizeAdministrativeSecret({
    rateLimiter: limiter,
    source,
    supplied,
    expected: STRONG_RECOVERY_TOKEN,
  });

  assert.deepEqual(authorize('source-a', 'wrong-one'), {
    authorized: false,
    rateLimited: false,
  });
  assert.deepEqual(authorize('source-a', STRONG_RECOVERY_TOKEN), {
    authorized: true,
    rateLimited: false,
  });
  assert.deepEqual(authorize('source-a', 'wrong-two'), {
    authorized: false,
    rateLimited: false,
  });
  assert.deepEqual(authorize('source-a', STRONG_RECOVERY_TOKEN), {
    authorized: false,
    rateLimited: true,
    retryAfterMs: 60_000,
  });
  assert.deepEqual(authorize('source-b', STRONG_RECOVERY_TOKEN), {
    authorized: true,
    rateLimited: false,
  });
});

test('blocked and spoofed sources cannot grow limiter memory beyond global failures', () => {
  let currentTime = 1;
  const limiter = createFailedSecretRateLimiter({
    windowMs: 1_000,
    sourceLimit: 10,
    globalLimit: 4,
    now: () => currentTime,
  });

  for (let index = 0; index < 4; index += 1) {
    assert.deepEqual(limiter.recordFailure(`source-${index}`), { allowed: true });
  }
  for (let index = 4; index < 10_000; index += 1) {
    assert.equal(limiter.recordFailure(`source-${index}`).allowed, false);
  }
  assert.equal(limiter.retainedSourceCount(), 4);

  currentTime += 1_000;
  assert.equal(limiter.retainedSourceCount(), 0);
});

test('runtime and container smoke fixtures satisfy administrative token startup rules', () => {
  const fixtureFiles = [
    ['apps/server/test/harness.mjs', 1],
    ['e2e/start-relay.mjs', 2],
    ['.github/workflows/ci.yml', 2],
    ['.github/workflows/release.yml', 2],
    ['.claude/skills/verify/SKILL.md', 2],
  ];

  for (const [relativePath, expectedCount] of fixtureFiles) {
    const source = readFileSync(new URL(relativePath, REPOSITORY_ROOT), 'utf8');
    let fixtureCount = 0;
    for (const [name, pattern] of [
      ['UNKEEP_SETUP_TOKEN', /UNKEEP_SETUP_TOKEN(?:\s*:\s*'|=)([A-Za-z0-9_-]+)/g],
      ['UNKEEP_RECOVERY_TOKEN', /UNKEEP_RECOVERY_TOKEN(?:\s*:\s*'|=)([A-Za-z0-9_-]+)/g],
    ]) {
      for (const match of source.matchAll(pattern)) {
        fixtureCount += 1;
        assert.doesNotThrow(
          () => validateAdministrativeToken(name, match[1]),
          `${relativePath} contains an invalid ${name} fixture`,
        );
      }
    }
    assert.equal(
      fixtureCount,
      expectedCount,
      `${relativePath} administrative fixture count changed`,
    );
  }
});
