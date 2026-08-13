import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const releasingGuide = readFileSync(
  new URL('../docs/releasing.md', import.meta.url),
  'utf8',
);

function workflowJobs(source) {
  const jobsMarker = '\njobs:\n';
  const jobsOffset = source.indexOf(jobsMarker);
  assert.notEqual(jobsOffset, -1, 'release workflow must contain a jobs mapping');

  const jobs = new Map();
  let currentName;
  let currentLines = [];

  for (const line of source.slice(jobsOffset + jobsMarker.length).split('\n')) {
    const jobHeader = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHeader) {
      if (currentName) jobs.set(currentName, currentLines.join('\n'));
      currentName = jobHeader[1];
      currentLines = [line];
    } else if (currentName) {
      currentLines.push(line);
    }
  }
  if (currentName) jobs.set(currentName, currentLines.join('\n'));
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
    const permission = /^      ([a-z-]+):\s*(read|write|none)\s*$/.exec(line);
    if (!permission) break;
    permissions.set(permission[1], permission[2]);
  }
  return permissions;
}

test('only publish_npm can mint the npm trusted-publisher identity', () => {
  const jobs = workflowJobs(workflow);
  const publishNpm = jobs.get('publish_npm');
  const promoteImage = jobs.get('promote_image');
  assert.ok(publishNpm, 'publish_npm job must exist');
  assert.ok(promoteImage, 'promote_image job must exist');

  const npmEnvironmentJobs = [...jobs]
    .filter(([, block]) => jobEnvironment(block) === 'release-npm')
    .map(([name]) => name);
  assert.deepEqual(npmEnvironmentJobs, ['publish_npm']);

  const oidcJobs = [...jobs]
    .filter(([, block]) => jobPermissions(block).get('id-token') === 'write')
    .map(([name]) => name)
    .sort();
  assert.deepEqual(oidcJobs, ['promote_image', 'publish_npm']);

  const npmOidcJobs = oidcJobs.filter(
    name => jobEnvironment(jobs.get(name)) === 'release-npm',
  );
  assert.deepEqual(npmOidcJobs, ['publish_npm']);
  assert.equal(jobEnvironment(promoteImage), 'release');

  assert.deepEqual(
    Object.fromEntries(jobPermissions(publishNpm)),
    { contents: 'read', 'id-token': 'write' },
  );
  assert.match(
    publishNpm,
    /\$\{\{ vars\.UNKEEP_NPM_RELEASE_GUARD \}\}/,
  );
  assert.match(publishNpm, /BrettKinny\/UnKeep:release-npm:v1/);
  assert.match(
    publishNpm,
    /\$\{\{ vars\.UNKEEP_CONTAINER_COMPLIANCE_GUARD \}\}/,
  );
  assert.doesNotMatch(publishNpm, /UNKEEP_RELEASE_GUARD/);

  assert.match(
    publishNpm,
    /STAGED_RELEASE_ATTEMPT: \$\{\{ needs\.stage_container\.outputs\.release_attempt \}\}/,
  );
  assert.match(
    publishNpm,
    /\$STAGED_RELEASE_ATTEMPT" != "\$GITHUB_RUN_ID:\$GITHUB_RUN_ATTEMPT/,
  );
  assert.match(publishNpm, /^      - promote_image$/m);
  assert.match(publishNpm, /^      - stage_container$/m);
});

test('release documentation configures the isolated npm identity', () => {
  assert.match(
    releasingGuide,
    /\| Environment \| `release-npm` \|/,
  );
  assert.match(
    releasingGuide,
    /UNKEEP_NPM_RELEASE_GUARD[\s\S]*BrettKinny\/UnKeep:release-npm:v1/,
  );
  assert.match(
    releasingGuide,
    /only job with both `environment: release-npm` and `id-token: write`/,
  );
});

test('npm publication treats every tarball as an explicit local path', () => {
  for (const name of ['core', 'client', 'cli']) {
    assert.match(
      workflow,
      new RegExp(
        `npm publish [^\\n]*"\\./release-assets/unkeep-${name}-`
        + '\\$VERSION\\.tgz"',
      ),
      `dry-run publication must use a local ${name} tarball path`,
    );
    assert.match(
      workflow,
      new RegExp(
        `publish_package @unkeep/${name} `
        + `"\\./npm-artifacts/unkeep-${name}-\\$VERSION\\.tgz"`,
      ),
      `trusted publication must use a local ${name} tarball path`,
    );
    assert.match(
      releasingGuide,
      new RegExp(
        `\\./release-assets/unkeep-${name}-`
        + '0\\.0\\.0-bootstrap\\.0\\.tgz',
      ),
      `bootstrap documentation must use a local ${name} tarball path`,
    );
  }
});

test('every external write requires the manually reviewed immutable-release guard', () => {
  const jobs = workflowJobs(workflow);
  const externalWriteJobs = [
    'stage_container',
    'draft_release',
    'promote_image',
    'publish_npm',
    'finalize_release',
  ];

  assert.doesNotMatch(
    jobs.get('prepare'),
    /repos\/\$GITHUB_REPOSITORY\/immutable-releases/,
    'GITHUB_TOKEN cannot read the repository Administration endpoint',
  );
  for (const name of externalWriteJobs) {
    const block = jobs.get(name);
    assert.ok(block, `${name} job must exist`);
    assert.match(
      block,
      /\$\{\{ vars\.UNKEEP_IMMUTABLE_RELEASES_GUARD \}\}/,
      `${name} must read the protected-environment guard`,
    );
    assert.match(
      block,
      /BrettKinny\/UnKeep:immutable-releases-reviewed:v1/,
      `${name} must require the exact immutable-release sentinel`,
    );
  }

  assert.match(
    releasingGuide,
    /UNKEEP_IMMUTABLE_RELEASES_GUARD[\s\S]*BrettKinny\/UnKeep:immutable-releases-reviewed:v1/,
  );
  assert.match(
    releasingGuide,
    /workflow's short-lived[\s\S]*GITHUB_TOKEN[\s\S]*cannot read repository Administration settings/,
  );
  assert.match(
    releasingGuide,
    /Re-run the administrator check immediately before creating a release tag/,
  );
});

test('registry transitions bind release title and body to the validated source', () => {
  const jobs = workflowJobs(workflow);
  for (const name of ['promote_image', 'publish_npm', 'finalize_release']) {
    const block = jobs.get(name);
    assert.ok(block, `${name} job must exist`);
    assert.match(
      block,
      /node scripts\/extract-release-notes\.mjs "\$VERSION"/,
      `${name} must extract release notes from its validated checkout`,
    );
    assert.match(
      block,
      /--json body,isDraft,isPrerelease,name/,
      `${name} must fetch the exact remote title and body`,
    );
    assert.match(block, /jq -j '\.body'/);
    assert.match(block, /"UnKeep \$VERSION"/);
    assert.match(block, /\bcmp\b/);
  }

  const promoteImage = jobs.get('promote_image');
  assert.ok(
    promoteImage.indexOf('immediate-prepromotion-release-metadata.json')
      < promoteImage.indexOf('docker buildx imagetools create'),
    'release metadata must be rechecked immediately before image promotion',
  );

  const publishNpm = jobs.get('publish_npm');
  assert.match(
    publishNpm,
    /publish_package\(\)[\s\S]*immediate-prenpm-release-metadata\.json[\s\S]*npm publish/,
    'each package publication must recheck exact release metadata',
  );

  const finalizeRelease = jobs.get('finalize_release');
  assert.match(
    finalizeRelease,
    /gh release edit "\$GITHUB_REF_NAME" \\\n\s+--title "UnKeep \$VERSION" \\\n\s+--notes-file "\$RUNNER_TEMP\/release-notes\.md" \\\n\s+--draft=false/,
    'the publication request must restore source-derived metadata atomically',
  );
  assert.match(
    releasingGuide,
    /publication[\s\S]*request atomically restores the source-derived title and body/,
  );
});

test('published assets and metadata are verified against the local release bundle', () => {
  const finalizeRelease = workflowJobs(workflow).get('finalize_release');
  assert.ok(finalizeRelease, 'finalize_release job must exist');
  assert.match(
    finalizeRelease,
    /--json body,isDraft,isImmutable,isPrerelease,name[\s\S]*published-release-metadata\.json/,
  );
  assert.match(
    finalizeRelease,
    /cmp "\$RUNNER_TEMP\/release-notes\.md" "\$RUNNER_TEMP\/published-release-notes\.md"/,
  );
  assert.match(
    finalizeRelease,
    /for local_asset in release-assets\/\*; do\s+gh release verify-asset "\$GITHUB_REF_NAME" "\$local_asset"\s+done/,
  );
});

test('container corresponding sources are produced without publication authority', () => {
  const jobs = workflowJobs(workflow);
  const sources = jobs.get('container-sources');
  assert.ok(sources, 'container-sources job must exist');
  assert.equal(jobEnvironment(sources), undefined);
  assert.deepEqual(
    Object.fromEntries(jobPermissions(sources)),
    { contents: 'read' },
  );
  assert.match(sources, /^    needs: prepare$/m);
  assert.match(sources, /container-source-bundle\.mjs build/);
  assert.match(sources, /container-source-bundle\.mjs verify/);
  assert.match(
    sources,
    /container-source-assets-\$\{\{ needs\.prepare\.outputs\.version \}\}-\$\{\{ needs\.prepare\.outputs\.release_sha \}\}/,
  );
  assert.match(sources, /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
  assert.doesNotMatch(sources, /packages: write|id-token: write|contents: write/);

  const dryRun = jobs.get('dry-run-container');
  assert.match(dryRun, /^      - container-sources$/m);
  assert.match(dryRun, /container-source-bundle\.mjs verify/);
  assert.match(dryRun, /unkeep-\$VERSION-container-sources\.tar\.gz/);
});

test('source bytes are bound out of band before every publication boundary', () => {
  const jobs = workflowJobs(workflow);
  const stage = jobs.get('stage_container');
  assert.match(stage, /^      - container-sources$/m);
  assert.match(stage, /needs\.container-sources\.outputs\.bundle_sha256/);
  assert.match(stage, /needs\.container-sources\.outputs\.metadata_sha256/);
  assert.ok(
    stage.indexOf('container-source-bundle.mjs verify')
      < stage.indexOf('Log in to GHCR'),
    'source bytes must be verified before the first registry login',
  );
  assert.ok(
    stage.indexOf('container-source-bundle.mjs bind')
      < stage.indexOf('Record the exact staging bundle'),
    'exact staged platform digests must be bound into the release bundle',
  );
  assert.match(
    stage,
    /--image-repository "\$IMAGE"[\s\S]*--amd64-digest "\$AMD64_DIGEST"[\s\S]*--arm64-digest "\$ARM64_DIGEST"/,
  );
  assert.match(
    stage,
    /source_binding_sha256: \$\{\{ steps\.source_binding\.outputs\.binding_sha256 \}\}/,
  );

  for (const name of [
    'draft_release',
    'promote_image',
    'publish_npm',
    'finalize_release',
  ]) {
    const block = jobs.get(name);
    assert.match(
      block,
      /container-source-bundle\.mjs verify-binding/,
      `${name} must validate the source/image binding`,
    );
    for (const asset of [
      'container-source-binding.json',
      'container-sources.json',
      'container-sources.tar.gz',
    ]) {
      assert.match(block, new RegExp(asset.replaceAll('.', '\\.')));
    }
  }
});

test('container compliance review sentinel is pinned to the exact base digest', () => {
  const jobs = workflowJobs(workflow);
  const expected =
    'BrettKinny/UnKeep:container-compliance:'
    + 'c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32:v1';
  for (const name of [
    'stage_container',
    'draft_release',
    'promote_image',
    'publish_npm',
    'finalize_release',
  ]) {
    const block = jobs.get(name);
    assert.match(
      block,
      /BASE_DIGEST: \$\{\{ needs\.(?:container-sources|stage_container)\.outputs\.base_digest \}\}/,
    );
    assert.match(
      block,
      /expected_compliance_guard="BrettKinny\/UnKeep:container-compliance:\$\{BASE_DIGEST\}:v1"/,
    );
    assert.match(
      block,
      /CONTAINER_COMPLIANCE_GUARD" (?:!=|=) "\$expected_compliance_guard"/,
    );
  }
  assert.match(
    jobs.get('container-sources'),
    /base_digest: \$\{\{ steps\.sources\.outputs\.base_digest \}\}/,
  );
  assert.match(
    jobs.get('stage_container'),
    /base_digest: \$\{\{ needs\.container-sources\.outputs\.base_digest \}\}/,
  );
  assert.match(releasingGuide, new RegExp(expected));
  assert.match(
    releasingGuide,
    /workflow derives its expected sentinel from the source producer's\s+Dockerfile-bound base digest/,
  );
});

test('the large source archive is not duplicated in retained Actions artifacts', () => {
  const jobs = workflowJobs(workflow);
  const dryRun = jobs.get('dry-run-container');
  const dryRunUpload = dryRun.slice(
    dryRun.indexOf('Upload dry-run compliance assets'),
  );
  assert.doesNotMatch(dryRunUpload, /container-sources\.tar\.gz/);
  for (const name of ['stage_container', 'finalize_release']) {
    assert.match(
      jobs.get(name),
      /!release-assets\/unkeep-\$\{\{ env\.VERSION \}\}-container-sources\.tar\.gz/,
      `${name} must reuse the independently retained source artifact`,
    );
  }
  assert.match(
    releasingGuide,
    /logical release bundle is split across Actions artifacts/,
  );
});
