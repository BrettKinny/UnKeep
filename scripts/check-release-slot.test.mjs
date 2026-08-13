import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatConsumedReleaseSlot,
  inspectReleaseSlot,
} from './check-release-slot.mjs';

const version = '0.2.0-rc.1';
const releaseSha = '0123456789abcdef0123456789abcdef01234567';
const image = 'ghcr.io/brettkinny/unkeep';

function npmEntries(existing = []) {
  return ['@unkeep/core', '@unkeep/client', '@unkeep/cli'].map((packageName) => ({
    package: packageName,
    exists: existing.includes(packageName),
    ...(existing.includes(packageName) ? { version } : {}),
  }));
}

function ghcrEntry(...tags) {
  return { metadata: { container: { tags } } };
}

test('accepts an unused release slot and ignores untagged candidate manifests', () => {
  const result = inspectReleaseSlot({
    version,
    releaseSha,
    image,
    npmEntries: npmEntries(),
    ghcrEntries: [ghcrEntry()],
  });
  assert.deepEqual(result, { collisions: [], nextVersion: '0.2.0-rc.2' });
});

test('reports every npm and GHCR collision and directs recovery to the next RC', () => {
  const result = inspectReleaseSlot({
    version,
    releaseSha,
    image,
    npmEntries: npmEntries(['@unkeep/core', '@unkeep/cli']),
    ghcrEntries: [
      ghcrEntry(version),
      ghcrEntry(`sha-${releaseSha}`),
    ],
  });
  assert.deepEqual(result.collisions, [
    `npm @unkeep/core@${version}`,
    `npm @unkeep/cli@${version}`,
    `GHCR ${image}:${version}`,
    `GHCR ${image}:sha-${releaseSha}`,
  ]);
  assert.equal(result.nextVersion, '0.2.0-rc.2');
  assert.match(
    formatConsumedReleaseSlot({ version, ...result }),
    /deliberately cannot resume a partially published release/,
  );
  assert.match(
    formatConsumedReleaseSlot({ version, ...result }),
    /advance every[\s\S]*0\.2\.0-rc\.2/,
  );
});

test('fails closed when the npm inventory is incomplete or inconsistent', () => {
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries().slice(1),
      ghcrEntries: [],
    }),
    /npm inventory is missing package: @unkeep\/core/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: [
        ...npmEntries(),
        { package: '@unkeep/core', exists: false },
      ],
      ghcrEntries: [],
    }),
    /duplicate package/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries(['@unkeep/core']).map((entry) => (
        entry.package === '@unkeep/core' ? { ...entry, version: '0.2.0-rc.9' } : entry
      )),
      ghcrEntries: [],
    }),
    /expected 0\.2\.0-rc\.1/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries().map((entry) => (
        entry.package === '@unkeep/core' ? { ...entry, version } : entry
      )),
      ghcrEntries: [],
    }),
    /marks @unkeep\/core absent but also supplies a version/,
  );
});

test('fails closed on malformed or duplicate GHCR tag inventory', () => {
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries(),
      ghcrEntries: [{ metadata: { container: { tags: [42] } } }],
    }),
    /string array/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries(),
      ghcrEntries: [ghcrEntry(version), ghcrEntry(version)],
    }),
    /duplicate active tag entries/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version,
      releaseSha,
      image,
      npmEntries: npmEntries(),
      ghcrEntries: [ghcrEntry(version, version)],
    }),
    /duplicate tags/,
  );
  assert.throws(
    () => inspectReleaseSlot({
      version: '0.2.0-rc.01',
      releaseSha,
      image,
      npmEntries: npmEntries(),
      ghcrEntries: [],
    }),
    /Invalid release-candidate version/,
  );
});
