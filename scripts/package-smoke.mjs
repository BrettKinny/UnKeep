#!/usr/bin/env node

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'unkeep-package-smoke-'));
const tarballDirectory = join(temporaryRoot, 'tarballs');
const consumerDirectory = join(temporaryRoot, 'consumer');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const repositoryLicense = readFileSync(join(repositoryRoot, 'LICENSE'), 'utf8');
const suppliedTarballs = process.argv.slice(2).map((path) => resolve(path));

const packages = [
  { name: '@unkeep/core', directory: 'packages/core', library: true, internalDependencies: [] },
  {
    name: '@unkeep/client',
    directory: 'packages/client',
    library: true,
    internalDependencies: ['@unkeep/core'],
  },
  {
    name: '@unkeep/cli',
    directory: 'apps/cli',
    bin: 'unkeep',
    internalDependencies: ['@unkeep/client', '@unkeep/core'],
  },
];

function fail(message) {
  throw new Error(message);
}

if (suppliedTarballs.length !== 0 && suppliedTarballs.length !== packages.length) {
  fail(`Expected no tarball arguments or exactly ${packages.length}, received ${suppliedTarballs.length}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_UPDATE_NOTIFIER: '1' },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`);
  }
  return result.stdout.trim();
}

function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) return [relativePath];
    return walk(join(directory, entry.name), relativePath);
  });
}

function installedPackageDirectory(name) {
  return join(consumerDirectory, 'node_modules', ...name.split('/'));
}

if (!suppliedTarballs.length) mkdirSync(tarballDirectory);
mkdirSync(consumerDirectory);

try {
  const tarballs = [...suppliedTarballs];

  if (!tarballs.length) {
    for (const packageDefinition of packages) {
      const before = new Set(readdirSync(tarballDirectory));
      run(
        pnpm,
        ['pack', '--pack-destination', tarballDirectory],
        join(repositoryRoot, packageDefinition.directory),
      );
      const created = readdirSync(tarballDirectory).filter((file) => file.endsWith('.tgz') && !before.has(file));
      if (created.length !== 1) fail(`Expected one tarball for ${packageDefinition.name}, found ${created.length}`);
      tarballs.push(join(tarballDirectory, created[0]));
    }
  } else {
    for (const tarball of tarballs) {
      if (!existsSync(tarball) || !statSync(tarball).isFile()) {
        fail(`Supplied package tarball does not exist: ${tarball}`);
      }
    }
  }

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'unkeep-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
  );

  run(
    npm,
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...tarballs],
    consumerDirectory,
  );

  const installedVersions = new Map();
  for (const packageDefinition of packages) {
    const directory = installedPackageDirectory(packageDefinition.name);
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) fail(`${packageDefinition.name} was not installed`);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.version !== 'string' || !manifest.version) fail(`${packageDefinition.name} is missing a version`);
    installedVersions.set(packageDefinition.name, manifest.version);
    if (manifest.private !== true) fail(`${packageDefinition.name} must remain private`);
    if (manifest.license !== 'MIT') fail(`${packageDefinition.name} is missing its MIT license metadata`);
    if (manifest.publishConfig !== undefined) fail(`${packageDefinition.name} must not define publishConfig`);
    if (!manifest.engines?.node) fail(`${packageDefinition.name} is missing a Node engine requirement`);
    if (!manifest.repository?.url) fail(`${packageDefinition.name} is missing repository metadata`);
    for (const dependency of packageDefinition.internalDependencies) {
      if (manifest.dependencies?.[dependency] !== manifest.version) {
        fail(
          `${packageDefinition.name} must depend on ${dependency} at its exact release version `
          + `${manifest.version}; received ${JSON.stringify(manifest.dependencies?.[dependency])}`,
        );
      }
    }
    if (readFileSync(join(directory, 'LICENSE'), 'utf8') !== repositoryLicense) {
      fail(`${packageDefinition.name} does not contain the repository license text`);
    }

    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        if (String(version).startsWith('workspace:')) {
          fail(`${packageDefinition.name} still has an unresolved workspace dependency on ${dependency}`);
        }
      }
    }

    const files = walk(directory);
    const requiredFiles = ['README.md', 'LICENSE'];
    if (packageDefinition.library) requiredFiles.push('dist/index.js', 'dist/index.d.ts');
    for (const requiredFile of requiredFiles) {
      if (!files.includes(requiredFile)) fail(`${packageDefinition.name} is missing ${requiredFile}`);
    }
    if (files.some((file) => /(?:^|\/)(?:src|test|tests)(?:\/|$)/.test(file))) {
      fail(`${packageDefinition.name} contains source or test directories`);
    }
    if (files.some((file) => /(?:^|\/)[^/]*(?:\.integration)?\.test\./.test(file))) {
      fail(`${packageDefinition.name} contains compiled test artifacts`);
    }

    if (packageDefinition.library) {
      for (const [field, target] of [
        ['main', manifest.main],
        ['types', manifest.types],
        ['exports.import', manifest.exports?.['.']?.import],
        ['exports.types', manifest.exports?.['.']?.types],
      ]) {
        if (typeof target !== 'string' || !existsSync(join(directory, target.replace(/^\.\//, '')))) {
          fail(`${packageDefinition.name} has an invalid ${field} target`);
        }
      }
    } else if (Object.keys(manifest.exports ?? {}).length !== 0) {
      fail(`${packageDefinition.name} must remain a binary-only package`);
    }
    if (packageDefinition.bin) {
      const target = manifest.bin?.[packageDefinition.bin];
      if (typeof target !== 'string' || !existsSync(join(directory, target.replace(/^\.\//, '')))) {
        fail(`${packageDefinition.name} has an invalid ${packageDefinition.bin} bin target`);
      }
    }
  }

  const expectedCliVersion = installedVersions.get('@unkeep/cli');
  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import * as core from '@unkeep/core';
import { LocalOnlyAdapter, generateCodeVerifier } from '@unkeep/core/experimental';
import { cleanRelayEndpoint, MemoryClientStorage } from '@unkeep/client';

const key = core.generateMasterKey();
if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error('core import failed');
if ('LocalOnlyAdapter' in core || 'generateCodeVerifier' in core) throw new Error('experimental core API leaked from package root');
if (typeof LocalOnlyAdapter !== 'function' || generateCodeVerifier().length < 43) throw new Error('core experimental import failed');
if (cleanRelayEndpoint('https://notes.example.com/path') !== 'https://notes.example.com') throw new Error('client import failed');
const storage = new MemoryClientStorage();
await storage.set('ready', true);
if (await storage.get('ready') !== true) throw new Error('client storage failed');
`,
  );
  run(node, ['smoke.mjs'], consumerDirectory);

  const cliBin = join(consumerDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'unkeep.cmd' : 'unkeep');
  if (!statSync(cliBin).isFile()) fail('The unkeep executable was not installed');
  const version = run(cliBin, ['--version'], consumerDirectory);
  if (version !== expectedCliVersion) {
    fail(`Expected unkeep ${expectedCliVersion}, received ${JSON.stringify(version)}`);
  }

  console.log('Packed and installed @unkeep/core, @unkeep/client, and @unkeep/cli successfully.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
