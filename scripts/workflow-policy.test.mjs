import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageFiles = [
  '../packages/core/package.json',
  '../packages/client/package.json',
  '../apps/cli/package.json',
].map(path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));

test('release publication stays container-only and amd64-only', () => {
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /tags:\n\s+- "v\*"/);
  assert.match(release, /environment: release/);
  assert.match(release, /platforms: linux\/amd64/);
  assert.match(release, /packages: write/);
  assert.match(release, /contents: write/);
  assert.doesNotMatch(release, /linux\/arm64|setup-qemu|npm publish|id-token: write/);
});

test('ordinary CI uses the supported Node and container architecture', () => {
  assert.match(ci, /node-version: 22/);
  assert.match(ci, /--platform linux\/amd64/);
  assert.doesNotMatch(ci, /node-version: 20|linux\/arm64|setup-qemu|smoke:packages/);
});

test('workspace packages cannot be published accidentally', () => {
  for (const packageFile of packageFiles) {
    assert.equal(packageFile.private, true, `${packageFile.name} must remain private`);
    assert.equal(packageFile.publishConfig, undefined, `${packageFile.name} must not configure publication`);
  }
});
