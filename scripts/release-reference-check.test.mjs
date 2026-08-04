import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findReleaseReferenceDrift,
  releaseTokens,
  checkReleaseReferences,
} from './release-reference-check.mjs';

test('extracts prerelease references with or without a v prefix', () => {
  assert.deepEqual(
    releaseTokens('v0.2.0-rc.1 and 0.2.0-rc.1; stable 0.2.0 is ignored'),
    ['0.2.0-rc.1', '0.2.0-rc.1'],
  );
});

test('reports stale references without treating stable history as drift', () => {
  assert.deepEqual(
    findReleaseReferenceDrift('0.2.0-rc.1', [
      ['README.md', 'v0.2.0-rc.1'],
      ['docs/self-hosting.md', '0.2.0-rc.2'],
      ['CHANGELOG.md', '0.1.1'],
    ]),
    [{ path: 'docs/self-hosting.md', version: '0.2.0-rc.2' }],
  );
});

test('the checked-in release surfaces agree', () => {
  const result = checkReleaseReferences();
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
});
