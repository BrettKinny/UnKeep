import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOCKER_NODE_REPOSITORY = 'https://github.com/nodejs/docker-node.git';
const DOCKER_NODE_RECIPE_COMMIT =
  'bc0a422bce0f729dd85790639d9f1918143f1235';
const APORTS_REPOSITORY =
  'https://gitlab.alpinelinux.org/alpine/aports.git';
const SPDX_LICENSE_LIST_REPOSITORY =
  'https://github.com/spdx/license-list-data.git';
const SPDX_LICENSE_LIST_COMMIT =
  'd46e94e2c78ceede1cfc63cfa0396472d2798d4c';
const NODE_RELEASE_KEY_FINGERPRINT =
  'CC68F5A3106FF448322E48ED27F5E38D5B0A215F';
// zlib.net has occasionally returned an HTML/error body with HTTP 200. Keep
// the fallback deliberately narrow: this is an alternate transport for the
// exact upstream zlib archive, not a general-purpose mirror selector.
const ZLIB_FALLBACK_HOSTS = [
  'https://github.com/madler/zlib/releases/download',
  'https://gstreamer.freedesktop.org/src/mirror/zlib',
];
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');

function fail(message) {
  throw new Error(message);
}

function validateToken(value, pattern, label) {
  if (!pattern.test(value)) fail(`Invalid ${label}: ${value}`);
  return value;
}

function validateVersion(value) {
  return validateToken(
    value,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/,
    'release version',
  );
}

function validateRevision(value) {
  return validateToken(value, /^[0-9a-f]{40}$/, 'release revision');
}

function validateSha256(value, label = 'SHA-256') {
  return validateToken(value, /^[0-9a-f]{64}$/, label);
}

function validateSha512(value, label = 'SHA-512') {
  return validateToken(value, /^[0-9a-f]{128}$/, label);
}

function validateGitCommit(value, label = 'Git commit') {
  return validateToken(value, /^[0-9a-f]{40}$/, label);
}

function validatePackageToken(value, label) {
  return validateToken(value, /^[A-Za-z0-9][A-Za-z0-9+_.-]*$/, label);
}

function licenseIdentifiers(expression) {
  return expression
    .match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)
    ?.filter(token => !['AND', 'OR', 'WITH'].includes(token)) ?? [];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    fail(
      `${command} ${args.join(' ')} exited with ${result.status}`
      + (output ? `\n${output}` : ''),
    );
  }
  return result.stdout ?? '';
}

function sha256File(path) {
  const hash = createHash('sha256');
  const content = readFileSync(path);
  hash.update(content);
  return hash.digest('hex');
}

function sha512File(path) {
  const hash = createHash('sha512');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function requireDescriptorDigest(rawDescriptor, expectedDigest, label) {
  const expected = validateToken(
    expectedDigest,
    /^sha256:[0-9a-f]{64}$/,
    `${label} digest`,
  );
  const actual = `sha256:${
    createHash('sha256').update(rawDescriptor).digest('hex')
  }`;
  if (actual !== expected) {
    fail(`${label} bytes do not match ${expected}`);
  }
}

export function parseInstalledDatabase(source) {
  const packages = [];
  for (const block of source.trim().split(/\n\n+/)) {
    const fields = new Map();
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
    }
    if (!fields.has('P')) continue;
    const entry = {
      name: validatePackageToken(fields.get('P'), 'Alpine package name'),
      version: validatePackageToken(fields.get('V'), 'Alpine package version'),
      architecture: validatePackageToken(
        fields.get('A'),
        'Alpine package architecture',
      ),
      license: fields.get('L'),
      origin: validatePackageToken(fields.get('o'), 'Alpine source origin'),
      aportsCommit: validateGitCommit(
        fields.get('c'),
        'Alpine aports commit',
      ),
    };
    if (
      !entry.license
      || entry.license.length > 256
      || /[\u0000-\u001f\u007f]/.test(entry.license)
    ) {
      fail(`Invalid license metadata for Alpine package ${entry.name}`);
    }
    packages.push(entry);
  }
  if (packages.length === 0) fail('The Alpine package database is empty');
  packages.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const names = new Set();
  for (const entry of packages) {
    if (names.has(entry.name)) fail(`Duplicate Alpine package ${entry.name}`);
    names.add(entry.name);
  }
  return packages;
}

export function compareAlpineInventories(amd64, arm64) {
  const comparable = packages => packages.map(({
    name,
    version,
    license,
    origin,
    aportsCommit,
  }) => ({ name, version, license, origin, aportsCommit }));
  const left = JSON.stringify(comparable(amd64));
  const right = JSON.stringify(comparable(arm64));
  if (left !== right) {
    fail('The amd64 and arm64 Alpine source inventories do not match');
  }
}

export function parseDockerfileBase(
  dockerfile = readFileSync(join(REPOSITORY_ROOT, 'Dockerfile'), 'utf8'),
) {
  const fromInstructions = dockerfile
    .split(/\r?\n/)
    .filter(line => /^\s*FROM(?:\s|$)/i.test(line));
  const licensePlatformArgs = dockerfile
    .split(/\r?\n/)
    .filter(line => /^\s*ARG\s+NODE_LICENSE_PLATFORM(?:=|\s|$)/i.test(line));
  const licenseCopies = dockerfile
    .split(/\r?\n/)
    .filter(line => /^\s*COPY\s+--from=node-license(?:\s|$)/i.test(line));
  const basePattern = '(node:22-alpine@sha256:[0-9a-f]{64})';
  const licenseStage = new RegExp(
    '^\\s*FROM\\s+--platform=\\$\\{NODE_LICENSE_PLATFORM\\}\\s+'
    + `${basePattern}`
    + '\\s+AS\\s+node-license\\s*$',
    'i',
  ).exec(fromInstructions[0] ?? '');
  const buildStage = new RegExp(
    `^\\s*FROM\\s+--platform=\\$\\{BUILDPLATFORM\\}\\s+${basePattern}\\s+AS\\s+build\\s*$`,
    'i',
  ).exec(fromInstructions[1] ?? '');
  const runtimeStage = new RegExp(
    `^\\s*FROM\\s+${basePattern}\\s*$`,
    'i',
  ).exec(fromInstructions[2] ?? '');
  const bases = [
    licenseStage?.[1],
    buildStage?.[1],
    runtimeStage?.[1],
  ];
  if (
    licensePlatformArgs.length !== 1
    || !/^\s*ARG\s+NODE_LICENSE_PLATFORM=linux\/amd64\s*$/i
      .test(licensePlatformArgs[0])
    || licenseCopies.length !== 1
    || !/^\s*COPY\s+--from=node-license\s+\/usr\/local\/LICENSE\s+\/usr\/local\/LICENSE\s*$/i
      .test(licenseCopies[0])
    || fromInstructions.length !== 3
    || bases.some(base => !base)
    || new Set(bases).size !== 1
  ) {
    fail(
      'Dockerfile must contain the controlled Node license, build, and runtime '
      + 'stages using one identical digest-pinned node:22-alpine base',
    );
  }
  return bases[0];
}

export function platformImageReference(indexReference, platformDigest) {
  const match = /^([^@\s]+)@sha256:[0-9a-f]{64}$/.exec(indexReference);
  if (!match) fail(`Invalid digest-pinned image index: ${indexReference}`);
  const digest = validateToken(
    platformDigest,
    /^sha256:[0-9a-f]{64}$/,
    'platform image digest',
  );
  return `${match[1]}@${digest}`;
}

function inspectPlatform(baseImage, platform, inspectNodeLicense = false) {
  const installed = run('docker', [
    'run',
    '--rm',
    '--platform',
    platform,
    '--entrypoint',
    'cat',
    baseImage,
    '/lib/apk/db/installed',
  ]);
  const nodeVersion = run('docker', [
    'run',
    '--rm',
    '--platform',
    platform,
    '--entrypoint',
    'node',
    baseImage,
    '--version',
  ]).trim();
  const nodeSha256 = run('docker', [
    'run',
    '--rm',
    '--platform',
    platform,
    '--entrypoint',
    'sha256sum',
    baseImage,
    '/usr/local/bin/node',
  ]).trim().split(/\s+/)[0];
  const nodeLicenseSha256 = inspectNodeLicense
    ? run('docker', [
      'run',
      '--rm',
      '--platform',
      platform,
      '--entrypoint',
      'sha256sum',
      baseImage,
      '/usr/local/LICENSE',
    ]).trim().split(/\s+/)[0]
    : undefined;
  validateToken(nodeVersion, /^v\d+\.\d+\.\d+$/, 'Node runtime version');
  validateSha256(nodeSha256, `${platform} Node runtime SHA-256`);
  if (inspectNodeLicense) {
    validateSha256(
      nodeLicenseSha256,
      `${platform} Node runtime license SHA-256`,
    );
  }
  return {
    nodeVersion,
    nodeSha256,
    nodeLicenseSha256,
    installedDatabase: installed,
    packages: parseInstalledDatabase(installed),
  };
}

function inspectOciBase(baseImage) {
  const rawIndex = run('docker', [
    'buildx',
    'imagetools',
    'inspect',
    '--raw',
    baseImage,
  ]);
  requireDescriptorDigest(
    rawIndex,
    `sha256:${baseImage.slice(baseImage.indexOf('sha256:') + 7)}`,
    'Base-image OCI index',
  );
  const index = JSON.parse(rawIndex);
  if (!Array.isArray(index.manifests)) fail('Base image has no OCI manifests');
  const platforms = {};
  for (const architecture of ['amd64', 'arm64']) {
    const candidates = index.manifests.filter(item =>
      item?.platform?.os === 'linux'
      && item.platform.architecture === architecture
    );
    if (candidates.length !== 1) {
      fail(`Expected one linux/${architecture} base-image manifest`);
    }
    const selected = candidates[0];
    validateToken(
      selected.digest,
      /^sha256:[0-9a-f]{64}$/,
      `${architecture} base platform digest`,
    );
    const annotations = selected.annotations ?? {};
    if (
      annotations['org.opencontainers.image.revision']
        !== DOCKER_NODE_RECIPE_COMMIT
      || annotations['org.opencontainers.image.base.name'] !== 'alpine:3.24'
      || !annotations['org.opencontainers.image.source']?.includes(
        `#${DOCKER_NODE_RECIPE_COMMIT}:22/alpine3.24`,
      )
    ) {
      fail(`Unexpected linux/${architecture} base-image provenance annotations`);
    }
    validateToken(
      annotations['org.opencontainers.image.base.digest'],
      /^sha256:[0-9a-f]{64}$/,
      `${architecture} Alpine base digest`,
    );
    const rawManifest = run('docker', [
      'buildx',
      'imagetools',
      'inspect',
      '--raw',
      `${baseImage.split('@')[0]}@${selected.digest}`,
    ]);
    requireDescriptorDigest(
      rawManifest,
      selected.digest,
      `linux/${architecture} base-image OCI manifest`,
    );
    platforms[architecture] = {
      digest: selected.digest,
      alpineBaseDigest:
        annotations['org.opencontainers.image.base.digest'],
      annotations,
      rawManifest,
    };
  }
  return { rawIndex, platforms };
}

function initializeRepository(path, remote) {
  mkdirSync(path, { recursive: true });
  run('git', ['init', '--quiet'], { cwd: path });
  run('git', ['remote', 'add', 'origin', remote], { cwd: path });
}

function fetchCommit(repository, commit) {
  run('git', ['fetch', '--quiet', '--depth=1', 'origin', commit], {
    cwd: repository,
  });
  const actual = run('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd: repository,
  }).trim();
  if (actual !== commit) {
    fail(`Fetched ${actual}; expected immutable commit ${commit}`);
  }
}

export function fetchCommits(repository, commits) {
  const uniqueCommits = [...new Set(commits.map(commit =>
    validateGitCommit(commit, 'source Git commit')))];
  if (uniqueCommits.length === 0) fail('No source Git commits were requested');
  const reference = commit => `refs/unkeep-sources/${commit}`;
  run('git', [
    'fetch',
    '--quiet',
    '--depth=1',
    '--no-tags',
    'origin',
    ...uniqueCommits.map(commit => `${commit}:${reference(commit)}`),
  ], { cwd: repository });
  for (const commit of uniqueCommits) {
    const actual = run('git', [
      'rev-parse',
      `${reference(commit)}^{commit}`,
    ], { cwd: repository }).trim();
    if (actual !== commit) {
      fail(`Fetched ${actual}; expected immutable commit ${commit}`);
    }
  }
}

function containerLicenseMapping(packages, nodeVersion) {
  const licenseText = identifier =>
    `licenses/spdx/${identifier}.txt`;
  return {
    schemaVersion: 1,
    spdxLicenseList: {
      repository: SPDX_LICENSE_LIST_REPOSITORY,
      commit: SPDX_LICENSE_LIST_COMMIT,
    },
    alpinePackages: packages.map(entry => ({
      name: entry.name,
      version: entry.version,
      origin: entry.origin,
      sourceRecipe: `alpine/${entry.origin}/recipe`,
      sourceDistfiles: `alpine/${entry.origin}/distfiles`,
      licenseExpression: entry.license,
      licenseTexts: licenseIdentifiers(entry.license).map(licenseText),
    })),
    node: {
      version: nodeVersion,
      licenseText: 'licenses/node/LICENSE',
      amd64BinaryInput:
        `node/node-v${nodeVersion}-linux-x64-musl.tar.xz`,
      arm64BuildInput: `node/node-v${nodeVersion}.tar.xz`,
    },
  };
}

function bundleLicenseTexts(
  temporaryRoot,
  bundleRoot,
  packages,
  nodeVersion,
  nodeSourcePath,
  nodeMuslPath,
) {
  const identifiers = [...new Set(packages.flatMap(entry =>
    licenseIdentifiers(entry.license)))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const spdxRepository = join(temporaryRoot, 'spdx-license-list-data.git');
  initializeRepository(spdxRepository, SPDX_LICENSE_LIST_REPOSITORY);
  fetchCommit(spdxRepository, SPDX_LICENSE_LIST_COMMIT);
  const spdxDirectory = join(bundleRoot, 'licenses', 'spdx');
  mkdirSync(spdxDirectory, { recursive: true });
  for (const identifier of identifiers) {
    validatePackageToken(identifier, 'SPDX license identifier');
    const text = run('git', [
      'show',
      `${SPDX_LICENSE_LIST_COMMIT}:text/${identifier}.txt`,
    ], { cwd: spdxRepository });
    if (!text.trim()) fail(`SPDX license text is empty: ${identifier}`);
    writeFileSync(join(spdxDirectory, `${identifier}.txt`), text);
  }

  const nodeLicensePath = join(bundleRoot, 'licenses', 'node', 'LICENSE');
  mkdirSync(dirname(nodeLicensePath), { recursive: true });
  const nodeRoot = `node-v${nodeVersion}`;
  const sourceLicense = run('tar', [
    '-xJOf',
    nodeSourcePath,
    `${nodeRoot}/LICENSE`,
  ]);
  const muslLicense = run('tar', [
    '-xJOf',
    nodeMuslPath,
    `${nodeRoot}-linux-x64-musl/LICENSE`,
  ]);
  if (!sourceLicense || sourceLicense !== muslLicense) {
    fail('Node source and x64-musl input archives have different licenses');
  }
  writeFileSync(nodeLicensePath, sourceLicense);

  const mapping = containerLicenseMapping(packages, nodeVersion);
  writeFileSync(
    join(bundleRoot, 'CONTAINER-LICENSES.json'),
    `${JSON.stringify(mapping, null, 2)}\n`,
  );
  return {
    mapping: 'CONTAINER-LICENSES.json',
    nodeLicenseSha256: sha256File(nodeLicensePath),
    spdxLicenseListCommit: SPDX_LICENSE_LIST_COMMIT,
  };
}

function listRecipePath(repository, commit, origin) {
  const files = run('git', [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
  ], { cwd: repository, maxBuffer: 128 * 1024 * 1024 });
  const suffix = `/${origin}/APKBUILD`;
  const candidates = files
    .split('\n')
    .filter(path => path.endsWith(suffix) && path.split('/').length === 3);
  if (candidates.length !== 1) {
    fail(
      `Expected one aports recipe for ${origin} at ${commit}; found `
      + candidates.length,
    );
  }
  return dirname(candidates[0]);
}

function archiveDirectory(repository, commit, sourcePath, destination) {
  const archive = join(dirname(destination), `${basename(destination)}.tar`);
  mkdirSync(destination, { recursive: true });
  run('git', [
    'archive',
    '--format=tar',
    `--output=${archive}`,
    commit,
    sourcePath,
  ], { cwd: repository });
  const components = sourcePath.split('/').length;
  run('tar', [
    '-xf',
    archive,
    `--strip-components=${components}`,
    '-C',
    destination,
  ]);
  rmSync(archive);
}

async function download(url, destination) {
  if (!url.startsWith('https://')) fail(`Refusing non-HTTPS source URL: ${url}`);
  await new Promise((resolvePromise, reject) => {
    const request = httpsGet(url, response => {
      if (
        response.statusCode
        && response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location
      ) {
        response.resume();
        download(new URL(response.headers.location, url).href, destination)
          .then(resolvePromise, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (
        Number.isFinite(declaredLength)
        && (declaredLength < 0 || declaredLength > 256 * 1024 * 1024)
      ) {
        response.resume();
        reject(new Error(`Download is too large: ${url}`));
        return;
      }
      const output = createWriteStream(destination, { flags: 'wx' });
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > 256 * 1024 * 1024) {
          request.destroy(new Error(`Download exceeded the size limit: ${url}`));
        }
      });
      response.pipe(output);
      output.on('finish', () => output.close(resolvePromise));
      output.on('error', reject);
    });
    request.setTimeout(60_000, () => {
      request.destroy(new Error(`Download timed out: ${url}`));
    });
    request.on('error', reject);
  });
}

function zlibFallbackUrls(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return [];
  }
  if (
    parsed.hostname !== 'zlib.net'
    && parsed.hostname !== 'www.zlib.net'
  ) return [];
  const filename = basename(parsed.pathname);
  const match = /^zlib-(\d+\.\d+(?:\.\d+)+)\.tar\.gz$/.exec(filename);
  if (!match) return [];
  const version = match[1];
  return [
    `${ZLIB_FALLBACK_HOSTS[0]}/v${version}/${filename}`,
    `${ZLIB_FALLBACK_HOSTS[1]}/${filename}`,
  ];
}

function parseRecipeDistfiles(recipePath) {
  const recipe = readFileSync(recipePath, 'utf8');
  const packageName = /^pkgname=(\S+)$/m.exec(recipe)?.[1];
  const packageVersion = /^pkgver=(\S+)$/m.exec(recipe)?.[1];
  const sourceBlock = /(?:^|\n)source\s*=\s*"([\s\S]*?)"/
    .exec(recipe)?.[1];
  const checksumBlock = /(?:^|\n)sha512sums\s*=\s*"([\s\S]*?)"/
    .exec(recipe)?.[1];
  if (!packageName || !packageVersion || !sourceBlock || !checksumBlock) {
    return [];
  }
  const substitutions = value => value
    .replaceAll('$pkgname', packageName)
    .replaceAll('${pkgname}', packageName)
    .replaceAll('$pkgver', packageVersion)
    .replaceAll('${pkgver}', packageVersion);
  const checksums = new Map();
  for (const line of checksumBlock.split(/\r?\n/)) {
    const match = /^\s*([0-9a-f]{128})\s+(\S+)\s*$/.exec(line);
    if (match) checksums.set(match[2], match[1]);
  }
  const distfiles = [];
  for (const source of sourceBlock.split(/\s+/).filter(Boolean)) {
    const separator = source.indexOf('::');
    const url = substitutions(
      separator >= 0 ? source.slice(separator + 2) : source,
    );
    if (!url.startsWith('https://')) continue;
    const filename = basename(new URL(url).pathname);
    const fallbackUrls = zlibFallbackUrls(url);
    if (fallbackUrls.length > 0) {
      distfiles.push({
        url,
        filename,
        sha512: checksums.get(filename),
        fallbackUrls,
      });
    }
  }
  return distfiles;
}

/**
 * Download a source from its primary URL, then from explicitly allowlisted
 * fallback URLs. Every candidate is checked against the APKBUILD SHA-512
 * before it can replace the destination. A successful HTTP response is not
 * considered success until this immutable recipe checksum matches.
 */
export async function downloadWithFallback({
  primaryUrl,
  fallbackUrls,
  destination,
  expectedSha512,
  fetcher = download,
}) {
  validateSha512(expectedSha512, 'Alpine distfile SHA-512');
  const urls = [primaryUrl, ...fallbackUrls];
  const errors = [];
  for (const [index, url] of urls.entries()) {
    const temporaryPath = `${destination}.candidate-${index}`;
    rmSync(temporaryPath, { force: true });
    try {
      await fetcher(url, temporaryPath);
      const actualSha512 = sha512File(temporaryPath);
      if (actualSha512 !== expectedSha512) {
        throw new Error(
          `SHA-512 ${actualSha512} does not match ${expectedSha512}`,
        );
      }
      renameSync(temporaryPath, destination);
      return url;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      rmSync(temporaryPath, { force: true });
    }
  }
  fail(
    `All Alpine distfile sources failed for ${primaryUrl}\n${errors.join('\n')}`,
  );
}

async function fetchFallbackDistfiles(bundleRoot, origins) {
  let recovered = 0;
  for (const item of origins) {
    const recipePath = join(
      bundleRoot,
      'alpine',
      item.origin,
      'recipe',
      'APKBUILD',
    );
    for (const distfile of parseRecipeDistfiles(recipePath)) {
      if (!distfile.sha512) {
        fail(
          `Fallback source for ${distfile.url} has no APKBUILD SHA-512 `
          + 'checksum',
        );
      }
      await downloadWithFallback({
        primaryUrl: distfile.url,
        fallbackUrls: distfile.fallbackUrls,
        expectedSha512: distfile.sha512,
        destination: join(
          bundleRoot,
          'alpine',
          item.origin,
          'distfiles',
          distfile.filename,
        ),
      });
      recovered += 1;
    }
  }
  return recovered;
}

async function fetchAlpineDistfiles(bundleRoot, origins) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail('Cannot determine the host user ID for the source-fetch container');
  }
  const listPath = join(bundleRoot, 'alpine', 'origins.txt');
  writeFileSync(listPath, `${origins.map(item => item.origin).join('\n')}\n`);
  chmodSync(listPath, 0o644);
  const fetchScript = [
    'set -eu',
    'apk add --no-cache abuild >/dev/null',
    'builder="$(awk -F: -v uid="$HOST_UID" \'$3 == uid { print $1; exit }\' /etc/passwd)"',
    'if [ -z "$builder" ]; then',
    '  adduser -D -u "$HOST_UID" sourcebuilder',
    '  builder=sourcebuilder',
    'fi',
    'mkdir -p /tmp/aports-work',
    'while IFS= read -r origin; do',
    '  case "$origin" in (*[!A-Za-z0-9+_.-]*|\"\") exit 70;; esac',
    '  work="/tmp/aports-work/$origin"',
    '  cp -a "/bundle/alpine/$origin/recipe" "$work"',
    '  mkdir -p "/bundle/alpine/$origin/distfiles"',
    '  chown -R "$HOST_UID" "$work" "/bundle/alpine/$origin/distfiles"',
    '  for architecture in x86_64 aarch64; do',
    '    attempt=1',
    '    while ! su "$builder" -s /bin/sh -c "cd \\"$work\\" && CARCH=\\"$architecture\\" SRCDEST=\\"/bundle/alpine/$origin/distfiles\\" abuild fetch"; do',
    '      if [ "$attempt" -ge 3 ]; then exit 71; fi',
    '      sleep "$((attempt * 5))"',
    '      attempt="$((attempt + 1))"',
    '    done',
    '  done',
    'done < /bundle/alpine/origins.txt',
  ].join('\n');
  const dockerArguments = [
    'run',
    '--rm',
    '--env',
    `HOST_UID=${uid}`,
    '--entrypoint',
    'sh',
    '--mount',
    `type=bind,src=${bundleRoot},dst=/bundle`,
    parseDockerfileBase(),
    '-c',
    fetchScript,
  ];
  try {
    run('docker', dockerArguments, { stdio: 'inherit', encoding: null });
    rmSync(listPath);
    return;
  } catch (primaryError) {
    try {
      const recovered = await fetchFallbackDistfiles(bundleRoot, origins);
      if (recovered === 0) {
        fail('No allowlisted Alpine distfile fallback applies');
      }
    } catch (fallbackError) {
      rmSync(listPath, { force: true });
      fail(
        `${primaryError.message}\nFallback Alpine distfile recovery failed: `
        + fallbackError.message,
      );
    }
    run('docker', dockerArguments, { stdio: 'inherit', encoding: null });
    rmSync(listPath);
  }
}

function verifyNodeReleaseSignature(
  temporaryRoot,
  keyPath,
  signaturePath,
  checksumsPath,
  exportedKeyPath,
) {
  const gpgHome = join(temporaryRoot, 'gnupg');
  mkdirSync(gpgHome, { mode: 0o700 });
  run('gpg', [
    '--homedir',
    gpgHome,
    '--batch',
    '--import',
    keyPath,
  ]);
  const fingerprints = run('gpg', [
    '--homedir',
    gpgHome,
    '--batch',
    '--with-colons',
    '--fingerprint',
  ]).split('\n')
    .filter(line => line.startsWith('fpr:'))
    .map(line => line.split(':')[9]);
  if (!fingerprints.includes(NODE_RELEASE_KEY_FINGERPRINT)) {
    fail('Downloaded Node release key has the wrong fingerprint');
  }
  const status = run('gpg', [
    '--homedir',
    gpgHome,
    '--batch',
    '--status-fd',
    '1',
    '--output',
    join(temporaryRoot, 'verified-node-shasums.txt'),
    '--decrypt',
    signaturePath,
  ]);
  if (!status.includes(`[GNUPG:] VALIDSIG ${NODE_RELEASE_KEY_FINGERPRINT} `)) {
    fail('Node release checksum signature is not from the pinned release key');
  }
  if (
    readFileSync(
      join(temporaryRoot, 'verified-node-shasums.txt'),
      'utf8',
    ).trimEnd() !== readFileSync(checksumsPath, 'utf8').trimEnd()
  ) {
    fail('Signed Node checksums differ from the separately fetched checksum file');
  }
  const exported = run('gpg', [
    '--homedir',
    gpgHome,
    '--batch',
    '--armor',
    '--export',
    NODE_RELEASE_KEY_FINGERPRINT,
  ]);
  writeFileSync(exportedKeyPath, exported);
}

function walkRegularFiles(root) {
  const files = [];
  let totalSize = 0;
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        visit(path);
      } else if (metadata.isFile()) {
        if (metadata.size > 512 * 1024 * 1024) {
          fail(`Source bundle file exceeds the size limit: ${path}`);
        }
        totalSize += metadata.size;
        if (totalSize > 1536 * 1024 * 1024) {
          fail('Container source bundle exceeds the expanded-size limit');
        }
        files.push(path);
        if (files.length > 50_000) {
          fail('Container source bundle exceeds the member-count limit');
        }
      } else {
        fail(`Source bundle contains a non-regular entry: ${path}`);
      }
    }
  };
  visit(root);
  return files;
}

export function normalizeSourceSymlinks(root) {
  const normalized = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        visit(path);
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (
          target.startsWith('/')
          || target.includes('\\')
          || /[\u0000-\u001f\u007f]/.test(target)
        ) {
          fail(`Unsafe source-recipe symlink: ${path} -> ${target}`);
        }
        const resolvedTarget = realpathSync(resolve(dirname(path), target));
        if (
          !resolvedTarget.startsWith(`${root}${sep}`)
          || !statSync(resolvedTarget).isFile()
        ) {
          fail(`Source-recipe symlink escapes the bundle: ${path} -> ${target}`);
        }
        unlinkSync(path);
        copyFileSync(resolvedTarget, path);
        normalized.push({
          path: relative(root, path).split(sep).join('/'),
          originalTarget: target,
        });
      }
    }
  };
  visit(root);
  if (normalized.length > 0) {
    writeFileSync(
      join(root, 'NORMALIZED-SYMLINKS.json'),
      `${JSON.stringify({ schemaVersion: 1, symlinks: normalized }, null, 2)}\n`,
    );
  }
}

function writeInternalManifest(root, manifestPath) {
  const files = walkRegularFiles(root)
    .filter(path => path !== manifestPath)
    .map(path => ({
      path: relative(root, path).split(sep).join('/'),
      sha256: sha256File(path),
      size: statSync(path).size,
    }));
  const manifest = {
    schemaVersion: 1,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function createDeterministicArchive(sourceRoot, archivePath) {
  const result = spawnSync(
    'tar',
    [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-cf',
      '-',
      '-C',
      dirname(sourceRoot),
      basename(sourceRoot),
    ],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 1536 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`tar exited with ${result.status}`);
  const gzip = spawnSync('gzip', ['-n', '-9'], {
    input: result.stdout,
    maxBuffer: 1536 * 1024 * 1024,
  });
  if (gzip.error) throw gzip.error;
  if (gzip.status !== 0) fail(`gzip exited with ${gzip.status}`);
  writeFileSync(archivePath, gzip.stdout);
}

function emitOutput(name, value) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const existing = existsSync(githubOutput)
      ? readFileSync(githubOutput, 'utf8')
      : '';
    writeFileSync(githubOutput, `${existing}${name}=${value}\n`);
  }
  process.stdout.write(`${name}=${value}\n`);
}

async function buildBundle(options) {
  const version = validateVersion(options.version);
  const revision = validateRevision(options.revision);
  const outputDirectory = resolve(options.output);
  mkdirSync(outputDirectory, { recursive: true });

  const baseImage = parseDockerfileBase();
  const baseDigest = baseImage.slice(baseImage.indexOf('sha256:') + 7);
  validateSha256(baseDigest, 'base-image digest');
  const oci = inspectOciBase(baseImage);
  const amd64 = inspectPlatform(
    platformImageReference(baseImage, oci.platforms.amd64.digest),
    'linux/amd64',
  );
  const arm64 = inspectPlatform(
    platformImageReference(baseImage, oci.platforms.arm64.digest),
    'linux/arm64',
  );
  compareAlpineInventories(amd64.packages, arm64.packages);
  if (amd64.nodeVersion !== arm64.nodeVersion) {
    fail('The amd64 and arm64 Node runtime versions do not match');
  }
  const nodeVersion = amd64.nodeVersion.slice(1);

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'unkeep-container-sources-'));
  try {
    const archiveRootName = `unkeep-${version}-container-sources`;
    const bundleRoot = join(temporaryRoot, archiveRootName);
    mkdirSync(join(bundleRoot, 'alpine'), { recursive: true });
    mkdirSync(join(bundleRoot, 'node'), { recursive: true });
    mkdirSync(join(bundleRoot, 'oci'), { recursive: true });
    writeFileSync(join(bundleRoot, 'oci', 'base-index.json'), oci.rawIndex);
    for (const architecture of ['amd64', 'arm64']) {
      writeFileSync(
        join(bundleRoot, 'oci', `${architecture}-manifest.json`),
        oci.platforms[architecture].rawManifest,
      );
      writeFileSync(
        join(bundleRoot, 'alpine', `${architecture}-installed`),
        architecture === 'amd64'
          ? amd64.installedDatabase
          : arm64.installedDatabase,
      );
    }

    const originMap = new Map();
    for (const entry of amd64.packages) {
      const existing = originMap.get(entry.origin);
      if (existing && existing !== entry.aportsCommit) {
        fail(`Alpine origin ${entry.origin} maps to multiple aports commits`);
      }
      originMap.set(entry.origin, entry.aportsCommit);
    }
    const origins = [...originMap]
      .map(([origin, aportsCommit]) => ({ origin, aportsCommit }))
      .sort((left, right) => left.origin.localeCompare(right.origin, 'en'));

    const aportsRepository = join(temporaryRoot, 'aports.git');
    initializeRepository(aportsRepository, APORTS_REPOSITORY);
    fetchCommits(
      aportsRepository,
      origins.map(item => item.aportsCommit),
    );
    for (const item of origins) {
      const recipePath = listRecipePath(
        aportsRepository,
        item.aportsCommit,
        item.origin,
      );
      item.recipePath = recipePath;
      const destination = join(
        bundleRoot,
        'alpine',
        item.origin,
        'recipe',
      );
      archiveDirectory(
        aportsRepository,
        item.aportsCommit,
        recipePath,
        destination,
      );
    }
    await fetchAlpineDistfiles(bundleRoot, origins);

    const dockerNodeRepository = join(temporaryRoot, 'docker-node.git');
    initializeRepository(dockerNodeRepository, DOCKER_NODE_REPOSITORY);
    fetchCommit(dockerNodeRepository, DOCKER_NODE_RECIPE_COMMIT);
    archiveDirectory(
      dockerNodeRepository,
      DOCKER_NODE_RECIPE_COMMIT,
      '22/alpine3.24',
      join(bundleRoot, 'node', 'docker-recipe'),
    );
    const dockerRecipe = readFileSync(
      join(bundleRoot, 'node', 'docker-recipe', 'Dockerfile'),
      'utf8',
    );
    if (!dockerRecipe.includes(`ENV NODE_VERSION=${nodeVersion}`)) {
      fail('The pinned Docker Node recipe does not match the runtime version');
    }

    const nodeSourceName = `node-v${nodeVersion}.tar.xz`;
    const nodeMuslName = `node-v${nodeVersion}-linux-x64-musl.tar.xz`;
    const checksumsName = 'SHASUMS256.txt';
    const checksumsSignatureName = 'SHASUMS256.txt.asc';
    const nodeDirectory = join(bundleRoot, 'node');
    await download(
      `https://nodejs.org/dist/v${nodeVersion}/${checksumsName}`,
      join(nodeDirectory, checksumsName),
    );
    await download(
      `https://nodejs.org/dist/v${nodeVersion}/${checksumsSignatureName}`,
      join(nodeDirectory, checksumsSignatureName),
    );
    await download(
      `https://nodejs.org/dist/v${nodeVersion}/${nodeSourceName}`,
      join(nodeDirectory, nodeSourceName),
    );
    const releaseKeyPath = join(nodeDirectory, 'node-release-key.asc');
    await download(
      `https://keys.openpgp.org/vks/v1/by-fingerprint/${NODE_RELEASE_KEY_FINGERPRINT}`,
      join(temporaryRoot, 'node-release-key.bin'),
    );
    verifyNodeReleaseSignature(
      temporaryRoot,
      join(temporaryRoot, 'node-release-key.bin'),
      join(nodeDirectory, checksumsSignatureName),
      join(nodeDirectory, checksumsName),
      releaseKeyPath,
    );
    const checksumLine = readFileSync(
      join(nodeDirectory, checksumsName),
      'utf8',
    ).split('\n').find(line => line.endsWith(`  ${nodeSourceName}`));
    if (!checksumLine) fail(`Node checksums omit ${nodeSourceName}`);
    const expectedNodeHash = validateSha256(
      checksumLine.split(/\s+/)[0],
      'Node source SHA-256',
    );
    if (sha256File(join(nodeDirectory, nodeSourceName)) !== expectedNodeHash) {
      fail('The downloaded Node source archive does not match SHASUMS256.txt');
    }
    const muslChecksum = /x86_64\)\s+ARCH='x64'\s+CHECKSUM="([0-9a-f]{64})"/
      .exec(dockerRecipe)?.[1];
    validateSha256(muslChecksum, 'Node x64-musl binary SHA-256');
    await download(
      `https://unofficial-builds.nodejs.org/download/release/v${nodeVersion}/${nodeMuslName}`,
      join(nodeDirectory, nodeMuslName),
    );
    if (sha256File(join(nodeDirectory, nodeMuslName)) !== muslChecksum) {
      fail('The Node x64-musl archive does not match the exact Docker recipe');
    }
    const extractedNodeDirectory = join(temporaryRoot, 'node-musl-runtime');
    mkdirSync(extractedNodeDirectory);
    run('tar', [
      '-xJf',
      join(nodeDirectory, nodeMuslName),
      '--strip-components=2',
      '-C',
      extractedNodeDirectory,
      `node-v${nodeVersion}-linux-x64-musl/bin/node`,
    ]);
    const muslRuntimeSha256 = sha256File(
      join(extractedNodeDirectory, 'node'),
    );
    if (muslRuntimeSha256 !== amd64.nodeSha256) {
      fail('The pinned base image Node binary differs from its x64-musl input');
    }
    const {
      nodeLicenseSha256,
      ...licenseEvidence
    } = bundleLicenseTexts(
      temporaryRoot,
      bundleRoot,
      amd64.packages,
      nodeVersion,
      join(nodeDirectory, nodeSourceName),
      join(nodeDirectory, nodeMuslName),
    );

    const inventory = {
      schemaVersion: 1,
      baseImage,
      baseDigest,
      basePlatforms: {
        amd64: {
          digest: oci.platforms.amd64.digest,
          alpineBaseDigest: oci.platforms.amd64.alpineBaseDigest,
        },
        arm64: {
          digest: oci.platforms.arm64.digest,
          alpineBaseDigest: oci.platforms.arm64.alpineBaseDigest,
        },
      },
      architectures: {
        amd64: amd64.packages,
        arm64: arm64.packages,
      },
      alpineOrigins: origins,
      licenses: licenseEvidence,
      node: {
        version: nodeVersion,
        sourceArchive: nodeSourceName,
        sourceSha256: expectedNodeHash,
        releaseKeyFingerprint: NODE_RELEASE_KEY_FINGERPRINT,
        amd64MuslArchive: nodeMuslName,
        amd64MuslSha256: muslChecksum,
        amd64RuntimeSha256: amd64.nodeSha256,
        arm64BuildInput: nodeSourceName,
        arm64RuntimeSha256: arm64.nodeSha256,
        licenseSha256: nodeLicenseSha256,
        dockerRecipeRepository: DOCKER_NODE_REPOSITORY,
        dockerRecipeCommit: DOCKER_NODE_RECIPE_COMMIT,
      },
    };
    writeFileSync(
      join(bundleRoot, 'SOURCE-INVENTORY.json'),
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    writeFileSync(
      join(bundleRoot, 'README.md'),
      [
        `# UnKeep ${version} container corresponding sources`,
        '',
        'This archive accompanies the exact digest-pinned Node/Alpine base used',
        `by UnKeep revision \`${revision}\`. It contains the complete Alpine`,
        'package inventory for both release architectures, each package’s exact',
        'aports recipe and verified upstream distfiles, the matching Node source',
        'archive and official checksum files, and the matching Docker Node recipe.',
        '',
        'See `SOURCE-INVENTORY.json` for immutable source identities and',
        '`SOURCE-MANIFEST.json` for the size and SHA-256 of every bundled file.',
        '`CONTAINER-LICENSES.json` maps every Alpine runtime package and Node',
        'input to the bundled license texts under `licenses/`.',
        '',
      ].join('\n'),
    );
    normalizeSourceSymlinks(bundleRoot);
    const internalManifestPath = join(bundleRoot, 'SOURCE-MANIFEST.json');
    writeInternalManifest(bundleRoot, internalManifestPath);

    const bundleName = `${archiveRootName}.tar.gz`;
    const metadataName = `${archiveRootName}.json`;
    const bundlePath = join(outputDirectory, bundleName);
    const metadataPath = join(outputDirectory, metadataName);
    createDeterministicArchive(bundleRoot, bundlePath);
    const metadata = {
      schemaVersion: 1,
      releaseVersion: version,
      releaseRevision: revision,
      baseImage,
      baseDigest,
      basePlatformDigests: {
        amd64: oci.platforms.amd64.digest,
        arm64: oci.platforms.arm64.digest,
      },
      nodeVersion,
      dockerNodeRecipeCommit: DOCKER_NODE_RECIPE_COMMIT,
      bundleFile: bundleName,
      bundleSha256: sha256File(bundlePath),
      sourceManifestSha256: sha256File(internalManifestPath),
    };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    emitOutput('base_digest', metadata.baseDigest);
    emitOutput('bundle_sha256', metadata.bundleSha256);
    emitOutput('metadata_sha256', sha256File(metadataPath));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateArchiveListings(entries, verboseLines, rootName) {
  if (entries.length === 0) fail('Container source archive is empty');
  if (entries.length > 50_001) {
    fail('Container source archive exceeds the member-count limit');
  }
  const seen = new Set();
  let expandedSize = 0;
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const pathSegments = normalized.split('/');
    if (
      entry.length > 512
      || /[\u0000-\u001f\u007f\ufffd]/.test(entry)
      || entry.startsWith('-')
      || entry.startsWith('/')
      || entry.includes('\\')
      || pathSegments.some(segment => segment === '' || segment === '.'
        || segment === '..')
      || !(normalized === rootName || normalized.startsWith(`${rootName}/`))
    ) {
      fail(`Unsafe container source archive entry: ${entry}`);
    }
    if (seen.has(normalized)) {
      fail(`Duplicate container source archive entry: ${entry}`);
    }
    seen.add(normalized);
  }
  for (const line of verboseLines) {
    if (!['-', 'd'].includes(line[0])) {
      fail(`Container source archive contains a non-regular entry: ${line}`);
    }
    const match = /^[\-d][^\s]*\s+\d+\/\d+\s+(\d+)\s+/.exec(line);
    if (!match) fail(`Cannot parse container source archive entry: ${line}`);
    const size = Number(match[1]);
    if (!Number.isSafeInteger(size) || size > 512 * 1024 * 1024) {
      fail(`Container source archive member exceeds the size limit: ${line}`);
    }
    expandedSize += size;
    if (expandedSize > 1536 * 1024 * 1024) {
      fail('Container source archive exceeds the expanded-size limit');
    }
  }
  if (verboseLines.length !== entries.length) {
    fail('Container source archive listings disagree');
  }
}

function comparablePackages(packages, label) {
  if (!Array.isArray(packages)) fail(`${label} package inventory is not an array`);
  return packages.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      fail(`${label} package ${index} is invalid`);
    }
    validatePackageToken(entry.name, `${label} package name`);
    validatePackageToken(entry.origin, `${label} source origin`);
    validateGitCommit(entry.aportsCommit, `${label} aports commit`);
    for (const [field, value] of [
      ['version', entry.version],
      ['license', entry.license],
    ]) {
      if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > 256
        || /[\u0000-\u001f\u007f]/.test(value)
      ) {
        fail(`Invalid ${label} package ${field}`);
      }
    }
    return {
      name: entry.name,
      version: entry.version,
      license: entry.license,
      origin: entry.origin,
      aportsCommit: entry.aportsCommit,
    };
  });
}

export function compareRuntimeCorrespondence(
  sourceInventory,
  runtimeInventory,
  architecture,
) {
  if (!['amd64', 'arm64'].includes(architecture)) {
    fail(`Unsupported runtime architecture: ${architecture}`);
  }
  const expectedPackages = comparablePackages(
    sourceInventory?.architectures?.[architecture],
    `source ${architecture}`,
  );
  const actualPackages = comparablePackages(
    runtimeInventory?.packages,
    `staged ${architecture}`,
  );
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    fail(
      `Staged ${architecture} Alpine package identities differ from `
      + 'the corresponding-source inventory',
    );
  }
  if (runtimeInventory?.nodeVersion !== `v${sourceInventory?.node?.version ?? ''}`) {
    fail(
      `Staged ${architecture} Node version differs from `
      + 'the corresponding-source inventory',
    );
  }
  const expectedNodeSha256 =
    sourceInventory.node?.[`${architecture}RuntimeSha256`];
  validateSha256(
    expectedNodeSha256,
    `source ${architecture} Node runtime SHA-256`,
  );
  if (runtimeInventory?.nodeSha256 !== expectedNodeSha256) {
    fail(
      `Staged ${architecture} Node binary differs from `
      + 'the corresponding-source inventory',
    );
  }
  validateSha256(
    sourceInventory.node?.licenseSha256,
    'source Node runtime license SHA-256',
  );
  if (
    runtimeInventory?.nodeLicenseSha256
      !== sourceInventory.node.licenseSha256
  ) {
    fail(
      `Staged ${architecture} Node runtime license differs from `
      + 'the corresponding-source inventory',
    );
  }
}

function safeArchiveEntries(archivePath, rootName) {
  if (statSync(archivePath).size > 1024 * 1024 * 1024) {
    fail('Container source archive exceeds the compressed-size limit');
  }
  const listing = run('tar', ['-tzf', archivePath]);
  const entries = listing.split('\n').filter(Boolean);
  const verbose = run('tar', [
    '--list',
    '--verbose',
    '--numeric-owner',
    '--full-time',
    '--quoting-style=escape',
    '-zf',
    archivePath,
  ]);
  validateArchiveListings(
    entries,
    verbose.split('\n').filter(Boolean),
    rootName,
  );
}

export function verifyBundle(options) {
  const version = validateVersion(options.version);
  const revision = validateRevision(options.revision);
  const assetDirectory = resolve(options.assets);
  const rootName = `unkeep-${version}-container-sources`;
  const bundleName = `${rootName}.tar.gz`;
  const metadataName = `${rootName}.json`;
  const bundlePath = join(assetDirectory, bundleName);
  const metadataPath = join(assetDirectory, metadataName);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const expectedKeys = [
    'baseDigest',
    'baseImage',
    'basePlatformDigests',
    'bundleFile',
    'bundleSha256',
    'dockerNodeRecipeCommit',
    'nodeVersion',
    'releaseRevision',
    'releaseVersion',
    'schemaVersion',
    'sourceManifestSha256',
  ].sort();
  if (
    JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)
  ) {
    fail('Container source metadata has unexpected fields');
  }
  if (
    metadata.schemaVersion !== 1
    || metadata.releaseVersion !== version
    || metadata.releaseRevision !== revision
    || metadata.baseImage !== parseDockerfileBase()
    || metadata.baseDigest
      !== metadata.baseImage.slice(metadata.baseImage.indexOf('sha256:') + 7)
    || metadata.dockerNodeRecipeCommit !== DOCKER_NODE_RECIPE_COMMIT
    || !/^22\.\d+\.\d+$/.test(metadata.nodeVersion)
    || metadata.bundleFile !== bundleName
  ) {
    fail('Container source metadata does not match the validated release');
  }
  if (
    !metadata.basePlatformDigests
    || Object.keys(metadata.basePlatformDigests).sort().join(',')
      !== 'amd64,arm64'
  ) {
    fail('Container source metadata omits a base platform digest');
  }
  for (const architecture of ['amd64', 'arm64']) {
    validateToken(
      metadata.basePlatformDigests[architecture],
      /^sha256:[0-9a-f]{64}$/,
      `${architecture} base platform digest`,
    );
  }
  validateSha256(metadata.bundleSha256, 'container-source bundle SHA-256');
  validateSha256(
    metadata.sourceManifestSha256,
    'container-source manifest SHA-256',
  );
  if (sha256File(bundlePath) !== metadata.bundleSha256) {
    fail('Container source archive does not match its release metadata');
  }
  const actualMetadataSha256 = sha256File(metadataPath);
  if (
    options['bundle-sha']
    && validateSha256(options['bundle-sha'], 'expected bundle SHA-256')
      !== metadata.bundleSha256
  ) {
    fail('Container source archive differs from the producer job output');
  }
  if (
    options['metadata-sha']
    && validateSha256(options['metadata-sha'], 'expected metadata SHA-256')
      !== actualMetadataSha256
  ) {
    fail('Container source metadata differs from the producer job output');
  }
  safeArchiveEntries(bundlePath, rootName);

  const extractionRoot = mkdtempSync(join(tmpdir(), 'unkeep-source-verify-'));
  let sourceInventory;
  try {
    run('tar', [
      '-xzf',
      bundlePath,
      '--no-same-owner',
      '--no-same-permissions',
      '-C',
      extractionRoot,
    ]);
    const root = join(extractionRoot, rootName);
    const manifestPath = join(root, 'SOURCE-MANIFEST.json');
    if (sha256File(manifestPath) !== metadata.sourceManifestSha256) {
      fail('The internal source manifest digest does not match release metadata');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
      fail('Invalid internal container source manifest');
    }
    const expected = new Map();
    for (const file of manifest.files) {
      if (
        !file
        || typeof file.path !== 'string'
        || file.path.startsWith('/')
        || file.path.includes('\\')
        || file.path.split('/').includes('..')
        || typeof file.size !== 'number'
      ) {
        fail('Unsafe entry in the internal container source manifest');
      }
      validateSha256(file.sha256, `source file digest for ${file.path}`);
      if (expected.has(file.path)) fail(`Duplicate source file ${file.path}`);
      expected.set(file.path, file);
    }
    const actualFiles = walkRegularFiles(root)
      .filter(path => path !== manifestPath)
      .map(path => relative(root, path).split(sep).join('/'));
    if (
      JSON.stringify([...expected.keys()].sort())
      !== JSON.stringify(actualFiles.sort())
    ) {
      fail('Container source archive contents differ from the internal manifest');
    }
    for (const [path, file] of expected) {
      const absolute = join(root, ...path.split('/'));
      if (
        statSync(absolute).size !== file.size
        || sha256File(absolute) !== file.sha256
      ) {
        fail(`Container source file does not match its manifest: ${path}`);
      }
    }
    sourceInventory = JSON.parse(
      readFileSync(join(root, 'SOURCE-INVENTORY.json'), 'utf8'),
    );
    if (
      sourceInventory.schemaVersion !== 1
      || sourceInventory.baseImage !== metadata.baseImage
      || sourceInventory.baseDigest !== metadata.baseDigest
      || sourceInventory.node?.version !== metadata.nodeVersion
      || Object.keys(sourceInventory.architectures ?? {}).sort().join(',')
        !== 'amd64,arm64'
      || JSON.stringify({
        amd64: sourceInventory.basePlatforms?.amd64?.digest,
        arm64: sourceInventory.basePlatforms?.arm64?.digest,
      }) !== JSON.stringify(metadata.basePlatformDigests)
    ) {
      fail('Container source inventory does not match release metadata');
    }
    for (const architecture of ['amd64', 'arm64']) {
      comparablePackages(
        sourceInventory.architectures[architecture],
        `source ${architecture}`,
      );
      validateSha256(
        sourceInventory.node[`${architecture}RuntimeSha256`],
        `source ${architecture} Node runtime SHA-256`,
      );
    }
    validateSha256(
      sourceInventory.node.licenseSha256,
      'source Node runtime license SHA-256',
    );
    if (
      sourceInventory.licenses?.mapping !== 'CONTAINER-LICENSES.json'
      || sourceInventory.licenses?.spdxLicenseListCommit
        !== SPDX_LICENSE_LIST_COMMIT
    ) {
      fail('Container source inventory omits the pinned license evidence');
    }
    const licenseMapping = JSON.parse(
      readFileSync(join(root, sourceInventory.licenses.mapping), 'utf8'),
    );
    const expectedLicenseMapping = containerLicenseMapping(
      sourceInventory.architectures.amd64,
      metadata.nodeVersion,
    );
    if (
      JSON.stringify(licenseMapping)
      !== JSON.stringify(expectedLicenseMapping)
    ) {
      fail('Container package/license mapping is incomplete or inconsistent');
    }
    for (const path of [
      licenseMapping.node.licenseText,
      ...licenseMapping.alpinePackages.flatMap(item => item.licenseTexts),
    ]) {
      if (!expected.has(path)) {
        fail(`Container license mapping references an unbundled file: ${path}`);
      }
    }
    if (
      expected.get(licenseMapping.node.licenseText)?.sha256
        !== sourceInventory.node.licenseSha256
    ) {
      fail('Container Node license digest does not match the source inventory');
    }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
  emitOutput('bundle_sha256', metadata.bundleSha256);
  emitOutput('metadata_sha256', actualMetadataSha256);
  return {
    assetDirectory,
    bundleName,
    bundleSha256: metadata.bundleSha256,
    metadata,
    metadataName,
    metadataSha256: actualMetadataSha256,
    sourceInventory,
  };
}

function validateImageDigest(value, label) {
  return validateToken(value, /^sha256:[0-9a-f]{64}$/, label);
}

function bindingName(version) {
  return `unkeep-${version}-container-source-binding.json`;
}

export function bindBundle(options) {
  const verified = verifyBundle(options);
  const amd64Digest = validateImageDigest(
    options['amd64-digest'],
    'staged amd64 image digest',
  );
  const arm64Digest = validateImageDigest(
    options['arm64-digest'],
    'staged arm64 image digest',
  );
  if (amd64Digest === arm64Digest) {
    fail('Staged amd64 and arm64 image digests must differ');
  }
  const imageRepository = validateToken(
    options['image-repository'],
    /^ghcr\.io\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/,
    'staged image repository',
  );
  for (const [architecture, digest] of [
    ['amd64', amd64Digest],
    ['arm64', arm64Digest],
  ]) {
    const runtimeInventory = inspectPlatform(
      `${imageRepository}@${digest}`,
      `linux/${architecture}`,
      true,
    );
    compareRuntimeCorrespondence(
      verified.sourceInventory,
      runtimeInventory,
      architecture,
    );
  }
  const binding = {
    schemaVersion: 1,
    releaseVersion: verified.metadata.releaseVersion,
    releaseRevision: verified.metadata.releaseRevision,
    sourceBundle: verified.bundleName,
    sourceBundleSha256: verified.bundleSha256,
    sourceMetadata: verified.metadataName,
    sourceMetadataSha256: verified.metadataSha256,
    baseImage: verified.metadata.baseImage,
    basePlatformDigests: verified.metadata.basePlatformDigests,
    stagedPlatformDigests: {
      amd64: amd64Digest,
      arm64: arm64Digest,
    },
  };
  const path = join(
    verified.assetDirectory,
    bindingName(verified.metadata.releaseVersion),
  );
  writeFileSync(path, `${JSON.stringify(binding, null, 2)}\n`);
  emitOutput('binding_sha256', sha256File(path));
}

export function verifyBinding(options) {
  const verified = verifyBundle(options);
  const path = join(
    verified.assetDirectory,
    bindingName(verified.metadata.releaseVersion),
  );
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  const expectedKeys = [
    'baseImage',
    'basePlatformDigests',
    'releaseRevision',
    'releaseVersion',
    'schemaVersion',
    'sourceBundle',
    'sourceBundleSha256',
    'sourceMetadata',
    'sourceMetadataSha256',
    'stagedPlatformDigests',
  ].sort();
  if (
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(expectedKeys)
    || binding.schemaVersion !== 1
    || binding.releaseVersion !== verified.metadata.releaseVersion
    || binding.releaseRevision !== verified.metadata.releaseRevision
    || binding.sourceBundle !== verified.bundleName
    || binding.sourceBundleSha256 !== verified.bundleSha256
    || binding.sourceMetadata !== verified.metadataName
    || binding.sourceMetadataSha256 !== verified.metadataSha256
    || binding.baseImage !== verified.metadata.baseImage
    || JSON.stringify(binding.basePlatformDigests)
      !== JSON.stringify(verified.metadata.basePlatformDigests)
    || Object.keys(binding.stagedPlatformDigests ?? {}).sort().join(',')
      !== 'amd64,arm64'
  ) {
    fail('Container source binding does not match the verified source assets');
  }
  for (const architecture of ['amd64', 'arm64']) {
    const expected = validateImageDigest(
      options[`${architecture}-digest`],
      `expected staged ${architecture} image digest`,
    );
    if (binding.stagedPlatformDigests?.[architecture] !== expected) {
      fail(`Container source binding has the wrong ${architecture} image digest`);
    }
  }
  if (
    binding.stagedPlatformDigests.amd64
    === binding.stagedPlatformDigests.arm64
  ) {
    fail('Container source binding reuses one digest for both architectures');
  }
  const actualBindingSha256 = sha256File(path);
  if (
    options['binding-sha']
    && validateSha256(options['binding-sha'], 'expected binding SHA-256')
      !== actualBindingSha256
  ) {
    fail('Container source binding differs from the staging job output');
  }
  emitOutput('binding_sha256', actualBindingSha256);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      fail(`Invalid argument list near ${name ?? '<end>'}`);
    }
    options[name.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'build') {
    if (!options.version || !options.revision || !options.output) {
      fail('build requires --version, --revision, and --output');
    }
    await buildBundle(options);
  } else if (command === 'verify') {
    if (!options.version || !options.revision || !options.assets) {
      fail('verify requires --version, --revision, and --assets');
    }
    verifyBundle(options);
  } else if (command === 'bind') {
    if (
      !options.version
      || !options.revision
      || !options.assets
      || !options['image-repository']
      || !options['amd64-digest']
      || !options['arm64-digest']
    ) {
      fail(
        'bind requires release/source options, --image-repository, '
        + 'and both staged image digests',
      );
    }
    bindBundle(options);
  } else if (command === 'verify-binding') {
    if (
      !options.version
      || !options.revision
      || !options.assets
      || !options['amd64-digest']
      || !options['arm64-digest']
    ) {
      fail(
        'verify-binding requires release/source options and both image digests',
      );
    }
    verifyBinding(options);
  } else {
    fail(
      'Usage: container-source-bundle.mjs '
      + '<build|verify|bind|verify-binding> [options]',
    );
  }
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
