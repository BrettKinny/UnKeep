import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const releasingGuide = readFileSync(new URL('../docs/releasing.md', import.meta.url), 'utf8');

function workflowJobs(source) {
  const marker = '\njobs:\n';
  const offset = source.indexOf(marker);
  assert.notEqual(offset, -1, 'release workflow must contain jobs');
  const jobs = new Map();
  let name;
  let lines = [];
  for (const line of source.slice(offset + marker.length).split('\n')) {
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (name) jobs.set(name, lines.join('\n'));
      name = header[1];
      lines = [line];
    } else if (name) lines.push(line);
  }
  if (name) jobs.set(name, lines.join('\n'));
  return jobs;
}

function jobEnvironment(block) {
  return /^    environment:\s*([A-Za-z0-9_-]+)\s*$/m.exec(block)?.[1];
}

function jobPermissions(block) {
  const permissions = new Map();
  const lines = block.split('\n');
  const start = lines.findIndex(line => line === '    permissions:');
  if (start === -1) return permissions;
  for (const line of lines.slice(start + 1)) {
    const match = /^      ([a-z-]+):\s*(read|write|none)\s*$/.exec(line);
    if (!match) break;
    permissions.set(match[1], match[2]);
  }
  return permissions;
}

test('release workflow has no npm publication surface', () => {
  assert.doesNotMatch(workflow, /npm publish|registry\.npmjs\.org|publish_npm|release-npm|dist-tags/);
  assert.doesNotMatch(releasingGuide, /npm publish|registry\.npmjs\.org|release-npm|dist-tags/);
  for (const manifestPath of [
    '../packages/core/package.json',
    '../packages/client/package.json',
    '../apps/cli/package.json',
  ]) {
    const manifest = JSON.parse(readFileSync(new URL(manifestPath, import.meta.url), 'utf8'));
    assert.equal(manifest.private, true, `${manifest.name} must remain private`);
    assert.equal(manifest.publishConfig, undefined, `${manifest.name} must not configure publication`);
  }
});

test('only image promotion receives an OIDC identity', () => {
  const jobs = workflowJobs(workflow);
  const oidcJobs = [...jobs]
    .filter(([, block]) => jobPermissions(block).get('id-token') === 'write')
    .map(([name]) => name);
  assert.deepEqual(oidcJobs, ['promote_image']);
  assert.equal(jobEnvironment(jobs.get('promote_image')), 'release');
  assert.equal(jobPermissions(jobs.get('promote_image')).get('contents'), 'write');
});

test('every external write requires the reviewed release guards', () => {
  const jobs = workflowJobs(workflow);
  assert.equal(jobs.has('draft_release'), false);
  for (const name of ['stage_container', 'promote_image', 'finalize_release']) {
    const block = jobs.get(name);
    assert.ok(block, `${name} job must exist`);
    assert.equal(jobEnvironment(block), 'release');
    assert.match(block, /UNKEEP_IMMUTABLE_RELEASES_GUARD/);
    assert.match(block, /BrettKinny\/UnKeep:immutable-releases-reviewed:v1/);
    assert.match(block, /UNKEEP_CONTAINER_COMPLIANCE_GUARD/);
  }
});

test('container sources are built without publication authority and bound before writes', () => {
  const jobs = workflowJobs(workflow);
  const sources = jobs.get('container-sources');
  assert.ok(sources);
  assert.equal(jobEnvironment(sources), undefined);
  assert.deepEqual(Object.fromEntries(jobPermissions(sources)), { contents: 'read' });
  assert.match(sources, /container-source-bundle\.mjs build/);
  assert.match(sources, /container-source-bundle\.mjs verify/);

  const stage = jobs.get('stage_container');
  for (const gate of ['verify', 'verify-node-20', 'verify-container', 'container-sources']) {
    assert.match(stage, new RegExp(`^      - ${gate}$`, 'm'));
  }
  const dryRun = jobs.get('dry-run-container');
  for (const gate of ['verify', 'verify-node-20', 'verify-container', 'container-sources']) {
    assert.match(dryRun, new RegExp(`^      - ${gate}$`, 'm'));
  }
  assert.ok(stage.indexOf('container-source-bundle.mjs verify') < stage.indexOf('Log in to GHCR'));
  assert.ok(stage.indexOf('container-source-bundle.mjs bind') < stage.indexOf('Record the exact staging bundle'));
  for (const name of ['promote_image', 'finalize_release']) {
    assert.match(jobs.get(name), /container-source-bundle\.mjs verify-binding/);
  }
});

test('draft creation and image promotion share one protected token', () => {
  const jobs = workflowJobs(workflow);
  const promote = jobs.get('promote_image');
  assert.equal(jobs.has('draft_release'), false);
  assert.match(promote, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(promote, /Promote only the verified platform digests/);
  assert.ok(
    promote.indexOf('gh release create "$GITHUB_REF_NAME"') <
      promote.indexOf('Promote only the verified platform digests'),
  );
  assert.match(promote, /contents: write/);
  assert.match(promote, /packages: write/);
  assert.match(promote, /attestations: write/);
  assert.match(promote, /id-token: write/);
});

test('release metadata and public assets are revalidated', () => {
  const jobs = workflowJobs(workflow);
  for (const name of ['promote_image', 'finalize_release']) {
    const block = jobs.get(name);
    assert.match(block, /extract-release-notes\.mjs "\$VERSION"/);
    assert.match(block, /--json body,isDraft,isPrerelease,name/);
    assert.match(block, /\bcmp\b/);
  }
  const finalize = jobs.get('finalize_release');
  assert.match(finalize, /--json body,isDraft,isImmutable,isPrerelease,name/);
  assert.match(finalize, /gh release verify-asset/);
});

test('release slot checks authenticated GHCR tags and fails closed on ambiguous errors', () => {
  const jobs = workflowJobs(workflow);
  const stage = jobs.get('stage_container');
  assert.ok(stage.indexOf('Log in to GHCR') < stage.indexOf('Require unused immutable GHCR tags'));
  for (const block of [stage, jobs.get('promote_image')]) {
    assert.match(block, /docker buildx imagetools inspect "\$reference"/);
    assert.match(block, /manifest unknown\|not found/);
    assert.match(block, /Could not prove that immutable release tag/);
    assert.doesNotMatch(block, /inventory-ghcr|check-release-slot|npm-release-state/);
  }
});
