import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  bindBundle,
  compareRuntimeCorrespondence,
  compareAlpineInventories,
  downloadWithFallback,
  fetchCommits,
  normalizeSourceSymlinks,
  parseDockerfileBase,
  parseInstalledDatabase,
  platformImageReference,
  requireDescriptorDigest,
  validateArchiveListings,
  verifyBinding,
  verifyBundle,
} from './container-source-bundle.mjs';

const installed = `
C:Q1example
P:busybox
V:1.37.0-r31
A:x86_64
L:GPL-2.0-only
o:busybox
c:c3ef5d10e6ef6528852c51f0564963e2f8c1be19
F:bin
R:busybox

C:Q1example
P:musl
V:1.2.6-r2
A:x86_64
L:MIT
o:musl
c:f5640d3a10f664c9119720c60515265d3d6f6d01
`;

const fixtureVersion = '0.2.0-rc.3';
const fixtureRevision = 'a'.repeat(40);
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createVerifiedFixture({ extraFile = false, symlink = false } = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'unkeep-source-fixture-'));
  const assets = join(temporaryRoot, 'assets');
  const rootName = `unkeep-${fixtureVersion}-container-sources`;
  const root = join(temporaryRoot, rootName);
  mkdirSync(assets);
  mkdirSync(root);
  const baseImage = parseDockerfileBase();
  const baseDigest = baseImage.slice(baseImage.indexOf('sha256:') + 7);
  const platformDigests = {
    amd64: `sha256:${'1'.repeat(64)}`,
    arm64: `sha256:${'2'.repeat(64)}`,
  };
  const amd64Packages = parseInstalledDatabase(installed);
  const arm64Packages = parseInstalledDatabase(
    installed.replaceAll('A:x86_64', 'A:aarch64'),
  );
  const spdxCommit = 'd46e94e2c78ceede1cfc63cfa0396472d2798d4c';
  const licensePaths = [
    'licenses/spdx/GPL-2.0-only.txt',
    'licenses/spdx/MIT.txt',
    'licenses/node/LICENSE',
  ];
  for (const path of licensePaths) {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), `${path} fixture\n`);
  }
  const licenseMapping = {
    schemaVersion: 1,
    spdxLicenseList: {
      repository: 'https://github.com/spdx/license-list-data.git',
      commit: spdxCommit,
    },
    alpinePackages: amd64Packages.map(entry => ({
      name: entry.name,
      version: entry.version,
      origin: entry.origin,
      sourceRecipe: `alpine/${entry.origin}/recipe`,
      sourceDistfiles: `alpine/${entry.origin}/distfiles`,
      licenseExpression: entry.license,
      licenseTexts: [`licenses/spdx/${entry.license}.txt`],
    })),
    node: {
      version: '22.23.2',
      licenseText: 'licenses/node/LICENSE',
      amd64BinaryInput: 'node/node-v22.23.2-linux-x64-musl.tar.xz',
      arm64BuildInput: 'node/node-v22.23.2.tar.xz',
    },
  };
  writeFileSync(
    join(root, 'CONTAINER-LICENSES.json'),
    `${JSON.stringify(licenseMapping, null, 2)}\n`,
  );
  const inventory = {
    schemaVersion: 1,
    baseImage,
    baseDigest,
    basePlatforms: {
      amd64: { digest: platformDigests.amd64 },
      arm64: { digest: platformDigests.arm64 },
    },
    architectures: {
      amd64: amd64Packages,
      arm64: arm64Packages,
    },
    licenses: {
      mapping: 'CONTAINER-LICENSES.json',
      spdxLicenseListCommit: spdxCommit,
    },
    node: {
      version: '22.23.2',
      amd64RuntimeSha256: '3'.repeat(64),
      arm64RuntimeSha256: '4'.repeat(64),
      licenseSha256: sha256(join(root, 'licenses', 'node', 'LICENSE')),
    },
  };
  writeFileSync(
    join(root, 'SOURCE-INVENTORY.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  const manifestFiles = [
    'CONTAINER-LICENSES.json',
    'README.md',
    'SOURCE-INVENTORY.json',
    ...licensePaths,
  ].sort().map(path => ({
    path,
    sha256: sha256(join(root, path)),
    size: readFileSync(join(root, path)).length,
  }));
  writeFileSync(
    join(root, 'SOURCE-MANIFEST.json'),
    `${JSON.stringify({ schemaVersion: 1, files: manifestFiles }, null, 2)}\n`,
  );
  if (extraFile) writeFileSync(join(root, 'UNMANIFESTED'), 'extra\n');
  if (symlink) symlinkSync('README.md', join(root, 'LINK'));

  const bundleName = `${rootName}.tar.gz`;
  const bundlePath = join(assets, bundleName);
  const tar = spawnSync('tar', [
    '-czf',
    bundlePath,
    '-C',
    temporaryRoot,
    rootName,
  ], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const metadataName = `${rootName}.json`;
  const metadataPath = join(assets, metadataName);
  const metadata = {
    schemaVersion: 1,
    releaseVersion: fixtureVersion,
    releaseRevision: fixtureRevision,
    baseImage,
    baseDigest,
    basePlatformDigests: platformDigests,
    nodeVersion: '22.23.2',
    dockerNodeRecipeCommit: 'bc0a422bce0f729dd85790639d9f1918143f1235',
    bundleFile: bundleName,
    bundleSha256: sha256(bundlePath),
    sourceManifestSha256: sha256(join(root, 'SOURCE-MANIFEST.json')),
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    assets,
    bundlePath,
    metadata,
    metadataPath,
    temporaryRoot,
  };
}

function verifyFixtureOptions(fixture) {
  return {
    version: fixtureVersion,
    revision: fixtureRevision,
    assets: fixture.assets,
    'bundle-sha': fixture.metadata.bundleSha256,
    'metadata-sha': sha256(fixture.metadataPath),
  };
}

test('parses only source identity fields from an Alpine installed database', () => {
  assert.deepEqual(parseInstalledDatabase(installed), [
    {
      name: 'busybox',
      version: '1.37.0-r31',
      architecture: 'x86_64',
      license: 'GPL-2.0-only',
      origin: 'busybox',
      aportsCommit: 'c3ef5d10e6ef6528852c51f0564963e2f8c1be19',
    },
    {
      name: 'musl',
      version: '1.2.6-r2',
      architecture: 'x86_64',
      license: 'MIT',
      origin: 'musl',
      aportsCommit: 'f5640d3a10f664c9119720c60515265d3d6f6d01',
    },
  ]);
});

test('rejects path-capable package origins before using them as paths', () => {
  assert.throws(
    () => parseInstalledDatabase(installed.replace('o:busybox', 'o:../busybox')),
    /Invalid Alpine source origin/,
  );
});

test('requires identical package source identities across architectures', () => {
  const amd64 = parseInstalledDatabase(installed);
  const arm64 = parseInstalledDatabase(
    installed.replaceAll('A:x86_64', 'A:aarch64'),
  );
  assert.doesNotThrow(() => compareAlpineInventories(amd64, arm64));
  arm64[0].aportsCommit = '0'.repeat(40);
  assert.throws(
    () => compareAlpineInventories(amd64, arm64),
    /source inventories do not match/,
  );
});

test('requires controlled license, build, and runtime stages with one base', () => {
  const base = `node:22-alpine@sha256:${'a'.repeat(64)}`;
  const valid = [
    'ARG NODE_LICENSE_PLATFORM=linux/amd64',
    `FROM --platform=\${NODE_LICENSE_PLATFORM} ${base} AS node-license`,
    `FROM ${base} AS build`,
    `FROM ${base}`,
    'COPY --from=node-license /usr/local/LICENSE /usr/local/LICENSE',
  ].join('\n');
  assert.equal(
    parseDockerfileBase(valid),
    base,
  );
  for (const dockerfile of [
    `FROM ${base} AS build\nFROM node:22-alpine\n`,
    `FROM ${base} AS build\nFROM ${base}\nFROM scratch\n`,
    valid.replace(
      'NODE_LICENSE_PLATFORM=linux/amd64',
      'NODE_LICENSE_PLATFORM=linux/arm64',
    ),
    valid.replace(
      '--platform=${NODE_LICENSE_PLATFORM}',
      '--platform=linux/amd64',
    ),
    valid.replace(' AS node-license', ''),
    valid.replace(
      'COPY --from=node-license /usr/local/LICENSE /usr/local/LICENSE',
      'COPY --from=node-license /usr/local/LICENSE /tmp/LICENSE',
    ),
    valid.replace(`FROM ${base} AS build`, 'FROM node:22-alpine AS build'),
  ]) {
    assert.throws(
      () => parseDockerfileBase(dockerfile),
      /controlled Node license, build, and runtime stages/,
    );
  }
});

test('addresses each platform manifest directly instead of reusing an index tag', () => {
  const index = `node:22-alpine@sha256:${'a'.repeat(64)}`;
  const platform = `sha256:${'b'.repeat(64)}`;
  assert.equal(
    platformImageReference(index, platform),
    `node:22-alpine@${platform}`,
  );
  assert.throws(
    () => platformImageReference('node:22-alpine', platform),
    /Invalid digest-pinned image index/,
  );
});

test('fetches multiple immutable source commits in one shallow transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-git-fetch-test-'));
  const remote = join(root, 'remote');
  const checkout = join(root, 'checkout');
  try {
    mkdirSync(remote);
    git(remote, ['init', '--quiet']);
    git(remote, ['config', 'user.email', 'fixture@example.invalid']);
    git(remote, ['config', 'user.name', 'Fixture']);
    const commits = [];
    for (const value of ['one', 'two', 'three']) {
      writeFileSync(join(remote, 'value'), `${value}\n`);
      git(remote, ['add', 'value']);
      git(remote, ['commit', '--quiet', '-m', value]);
      commits.push(git(remote, ['rev-parse', 'HEAD']));
    }
    mkdirSync(checkout);
    git(checkout, ['init', '--quiet']);
    git(checkout, ['remote', 'add', 'origin', remote]);
    assert.doesNotThrow(() =>
      fetchCommits(checkout, [commits[0], commits[2], commits[0]]));
    for (const commit of [commits[0], commits[2]]) {
      assert.equal(
        git(checkout, [
          'rev-parse',
          `refs/unkeep-sources/${commit}^{commit}`,
        ]),
        commit,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses an allowlisted fallback only after primary failure and verifies it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-fallback-test-'));
  const destination = join(root, 'zlib-1.3.1.tar.gz');
  const primary = 'https://zlib.net/fossils/zlib-1.3.1.tar.gz';
  const fallback =
    'https://github.com/madler/zlib/releases/download/v1.3.1/'
    + 'zlib-1.3.1.tar.gz';
  const bytes = Buffer.from('verified zlib fixture\n');
  const expectedSha512 = createHash('sha512').update(bytes).digest('hex');
  try {
    await downloadWithFallback({
      primaryUrl: primary,
      fallbackUrls: [fallback],
      destination,
      expectedSha512,
      fetcher: async (url, path) => {
        if (url === primary) throw new Error('primary unavailable');
        writeFileSync(path, bytes);
      },
    });
    assert.deepEqual(readFileSync(destination), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a fallback source fails the APKBUILD checksum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-fallback-test-'));
  const destination = join(root, 'zlib-1.3.1.tar.gz');
  try {
    await assert.rejects(
      downloadWithFallback({
        primaryUrl: 'https://zlib.net/fossils/zlib-1.3.1.tar.gz',
        fallbackUrls: [
          'https://github.com/madler/zlib/releases/download/v1.3.1/'
          + 'zlib-1.3.1.tar.gz',
        ],
        destination,
        expectedSha512: 'a'.repeat(128),
        fetcher: async (url, path) => {
          if (url.startsWith('https://zlib.net/')) {
            throw new Error('primary unavailable');
          }
          writeFileSync(path, 'tampered fallback bytes');
        },
      }),
      /All Alpine distfile sources failed.*SHA-512/s,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashes exact raw OCI descriptor bytes against their claimed digest', () => {
  const bytes = '{"schemaVersion":2}';
  const digest =
    'sha256:bafebd36189ad3688b7b3915ea55d461e0bfcfbdde11e54b0a123999fb6be50f';
  assert.doesNotThrow(() =>
    requireDescriptorDigest(bytes, digest, 'fixture descriptor'));
  assert.throws(
    () => requireDescriptorDigest(`${bytes}\n`, digest, 'fixture descriptor'),
    /bytes do not match/,
  );
});

test('requires staged runtime packages, Node, and its license to match sources', () => {
  const packages = parseInstalledDatabase(installed);
  const source = {
    architectures: { amd64: packages },
    node: {
      version: '22.23.2',
      amd64RuntimeSha256: 'a'.repeat(64),
      licenseSha256: 'c'.repeat(64),
    },
  };
  const runtime = {
    packages: structuredClone(packages),
    nodeVersion: 'v22.23.2',
    nodeSha256: 'a'.repeat(64),
    nodeLicenseSha256: 'c'.repeat(64),
  };
  assert.doesNotThrow(() =>
    compareRuntimeCorrespondence(source, runtime, 'amd64'));
  for (const mutate of [
    value => { value.packages[0].version = '9.9.9-r0'; },
    value => { value.nodeVersion = 'v22.23.3'; },
    value => { value.nodeSha256 = 'b'.repeat(64); },
    value => { value.nodeLicenseSha256 = 'd'.repeat(64); },
  ]) {
    const changed = structuredClone(runtime);
    mutate(changed);
    assert.throws(
      () => compareRuntimeCorrespondence(source, changed, 'amd64'),
      /differ.*corresponding-source inventory/,
    );
  }
});

test('rejects duplicate package records', () => {
  assert.throws(
    () => parseInstalledDatabase(`${installed}\n${installed}`),
    /Duplicate Alpine package/,
  );
});

test('accepts a bounded archive containing only regular files and directories', () => {
  assert.doesNotThrow(() => validateArchiveListings(
    ['root/', 'root/file.txt'],
    [
      'drwxr-xr-x 0/0 0 1970-01-01 00:00:00 root/',
      '-rw-r--r-- 0/0 12 1970-01-01 00:00:00 root/file.txt',
    ],
    'root',
  ));
});

test('rejects traversal, duplicate normalized names, and option-like paths', () => {
  const regular = '-rw-r--r-- 0/0 1 1970-01-01 00:00:00 root/file';
  for (const entry of [
    '../root/file',
    '/root/file',
    'root/../file',
    'root/./file',
    'root//file',
    'root/file//',
    String.raw`root\file`,
    'root/\u0001file',
    '-root/file',
  ]) {
    assert.throws(
      () => validateArchiveListings([entry], [regular], 'root'),
      /Unsafe container source archive entry/,
    );
  }
  assert.throws(
    () => validateArchiveListings(
      ['root/file', 'root/file/'],
      [regular, regular],
      'root',
    ),
    /Duplicate container source archive entry/,
  );
});

test('rejects links, devices, oversized members, and listing disagreements', () => {
  assert.throws(
    () => validateArchiveListings(
      ['root/link'],
      ['lrwxrwxrwx 0/0 0 1970-01-01 00:00:00 root/link -> target'],
      'root',
    ),
    /non-regular entry/,
  );
  assert.throws(
    () => validateArchiveListings(
      ['root/file'],
      ['-rw-r--r-- 0/0 536870913 1970-01-01 00:00:00 root/file'],
      'root',
    ),
    /member exceeds the size limit/,
  );
  assert.throws(
    () => validateArchiveListings(
      ['root/file'],
      [],
      'root',
    ),
    /listings disagree/,
  );
});

test('normalizes safe recipe symlinks and records their original targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-link-test-'));
  try {
    mkdirSync(join(root, 'recipe'));
    writeFileSync(join(root, 'recipe', 'script'), 'source\n');
    symlinkSync('script', join(root, 'recipe', 'alias'));
    normalizeSourceSymlinks(root);
    assert.equal(lstatSync(join(root, 'recipe', 'alias')).isFile(), true);
    assert.equal(readFileSync(join(root, 'recipe', 'alias'), 'utf8'), 'source\n');
    const record = JSON.parse(
      readFileSync(join(root, 'NORMALIZED-SYMLINKS.json'), 'utf8'),
    );
    assert.deepEqual(record.symlinks, [{
      path: 'recipe/alias',
      originalTarget: 'script',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalizes one nested recipe symlink exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-nested-link-test-'));
  try {
    mkdirSync(join(root, 'one', 'two'), { recursive: true });
    writeFileSync(join(root, 'one', 'target'), 'nested source\n');
    symlinkSync('../target', join(root, 'one', 'two', 'alias'));
    normalizeSourceSymlinks(root);
    const record = JSON.parse(
      readFileSync(join(root, 'NORMALIZED-SYMLINKS.json'), 'utf8'),
    );
    assert.deepEqual(record.symlinks, [{
      path: 'one/two/alias',
      originalTarget: '../target',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects recipe symlinks that escape the source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-source-link-test-'));
  try {
    symlinkSync('/etc/passwd', join(root, 'escape'));
    assert.throws(
      () => normalizeSourceSymlinks(root),
      /Unsafe source-recipe symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifies a complete fixture against independent producer hashes', () => {
  const fixture = createVerifiedFixture();
  try {
    assert.doesNotThrow(() => verifyBundle(verifyFixtureOptions(fixture)));
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects tampered producer hashes and release identity', () => {
  const fixture = createVerifiedFixture();
  try {
    assert.throws(
      () => verifyBundle({
        ...verifyFixtureOptions(fixture),
        'bundle-sha': 'f'.repeat(64),
      }),
      /differs from the producer job output/,
    );

    const metadata = {
      ...fixture.metadata,
      releaseRevision: 'b'.repeat(40),
    };
    writeFileSync(
      fixture.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    assert.throws(
      () => verifyBundle({
        ...verifyFixtureOptions({ ...fixture, metadata }),
        'metadata-sha': sha256(fixture.metadataPath),
      }),
      /does not match the validated release/,
    );
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects real archives with unmanifested files or links', () => {
  for (const options of [{ extraFile: true }, { symlink: true }]) {
    const fixture = createVerifiedFixture(options);
    try {
      assert.throws(
        () => verifyBundle(verifyFixtureOptions(fixture)),
        /contents differ from the internal manifest|non-regular entry/,
      );
    } finally {
      rmSync(fixture.temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('verify-binding rejects swapped, duplicated, and wrongly hashed digests', () => {
  const fixture = createVerifiedFixture();
  const amd64 = `sha256:${'5'.repeat(64)}`;
  const arm64 = `sha256:${'6'.repeat(64)}`;
  const bindingPath = join(
    fixture.assets,
    `unkeep-${fixtureVersion}-container-source-binding.json`,
  );
  const binding = {
    schemaVersion: 1,
    releaseVersion: fixtureVersion,
    releaseRevision: fixtureRevision,
    sourceBundle: `unkeep-${fixtureVersion}-container-sources.tar.gz`,
    sourceBundleSha256: fixture.metadata.bundleSha256,
    sourceMetadata: `unkeep-${fixtureVersion}-container-sources.json`,
    sourceMetadataSha256: sha256(fixture.metadataPath),
    baseImage: fixture.metadata.baseImage,
    basePlatformDigests: fixture.metadata.basePlatformDigests,
    stagedPlatformDigests: { amd64, arm64 },
  };
  const common = verifyFixtureOptions(fixture);
  try {
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    assert.doesNotThrow(() => verifyBinding({
      ...common,
      'amd64-digest': amd64,
      'arm64-digest': arm64,
      'binding-sha': sha256(bindingPath),
    }));

    assert.throws(
      () => verifyBinding({
        ...common,
        'amd64-digest': arm64,
        'arm64-digest': amd64,
      }),
      /wrong amd64 image digest/,
    );

    binding.stagedPlatformDigests.arm64 = amd64;
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    assert.throws(
      () => verifyBinding({
        ...common,
        'amd64-digest': amd64,
        'arm64-digest': amd64,
      }),
      /reuses one digest/,
    );

    binding.stagedPlatformDigests.arm64 = arm64;
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
    assert.throws(
      () => verifyBinding({
        ...common,
        'amd64-digest': amd64,
        'arm64-digest': arm64,
        'binding-sha': '7'.repeat(64),
      }),
      /differs from the staging job output/,
    );
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('bind rejects duplicate staged digests before inspecting an image', () => {
  const fixture = createVerifiedFixture();
  const digest = `sha256:${'8'.repeat(64)}`;
  try {
    assert.throws(
      () => bindBundle({
        ...verifyFixtureOptions(fixture),
        'image-repository': 'ghcr.io/brettkinny/unkeep',
        'amd64-digest': digest,
        'arm64-digest': digest,
      }),
      /must differ/,
    );
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
