#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_NPM_PACKAGES = [
  '@unkeep/core',
  '@unkeep/client',
  '@unkeep/cli',
];

function fail(message) {
  throw new Error(message);
}

function parseJsonLines(path, label) {
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  return content.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${label} line ${index + 1} is not valid JSON`);
    }
  });
}

function nextReleaseCandidate(version) {
  const numericIdentifier = '(?:0|[1-9]\\d*)';
  const match = new RegExp(
    `^(${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier})-rc\\.(${numericIdentifier})$`,
  ).exec(version);
  if (!match) fail(`Invalid release-candidate version: ${version}`);
  return `${match[1]}-rc.${BigInt(match[2]) + 1n}`;
}

function validateNpmInventory(entries, version) {
  const byPackage = new Map();
  for (const entry of entries) {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof entry.package !== 'string'
      || typeof entry.exists !== 'boolean'
    ) {
      fail('npm inventory entries require string package and boolean exists fields');
    }
    if (!EXPECTED_NPM_PACKAGES.includes(entry.package)) {
      fail(`npm inventory contains unexpected package: ${entry.package}`);
    }
    if (byPackage.has(entry.package)) {
      fail(`npm inventory contains duplicate package: ${entry.package}`);
    }
    if (entry.exists && entry.version !== version) {
      fail(`npm inventory returned ${entry.package}@${entry.version ?? 'unknown'}; expected ${version}`);
    }
    if (!entry.exists && 'version' in entry) {
      fail(`npm inventory marks ${entry.package} absent but also supplies a version`);
    }
    byPackage.set(entry.package, entry);
  }

  for (const packageName of EXPECTED_NPM_PACKAGES) {
    if (!byPackage.has(packageName)) {
      fail(`npm inventory is missing package: ${packageName}`);
    }
  }
  return byPackage;
}

function validateGhcrInventory(entries) {
  for (const entry of entries) {
    const tags = entry?.metadata?.container?.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
      fail('GHCR inventory entries require metadata.container.tags as a string array');
    }
    if (new Set(tags).size !== tags.length) {
      fail('GHCR inventory entry contains duplicate tags');
    }
  }
  return entries;
}

export function inspectReleaseSlot({
  version,
  releaseSha,
  image,
  npmEntries,
  ghcrEntries,
}) {
  const nextVersion = nextReleaseCandidate(version);
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    fail(`Invalid 40-character release SHA: ${releaseSha}`);
  }
  if (typeof image !== 'string' || !image.startsWith('ghcr.io/')) {
    fail(`Invalid GHCR image reference: ${image}`);
  }

  const npmByPackage = validateNpmInventory(npmEntries, version);
  const ghcrVersions = validateGhcrInventory(ghcrEntries);
  const collisions = [];

  for (const packageName of EXPECTED_NPM_PACKAGES) {
    if (npmByPackage.get(packageName).exists) {
      collisions.push(`npm ${packageName}@${version}`);
    }
  }

  for (const tag of [version, `sha-${releaseSha}`]) {
    const matches = ghcrVersions.filter((entry) => entry.metadata.container.tags.includes(tag));
    if (matches.length > 1) {
      fail(`GHCR inventory contains duplicate active tag entries: ${image}:${tag}`);
    }
    if (matches.length === 1) collisions.push(`GHCR ${image}:${tag}`);
  }

  return { collisions, nextVersion };
}

export function formatConsumedReleaseSlot({ version, collisions, nextVersion }) {
  return [
    `Release candidate ${version} is already consumed by immutable registry state:`,
    ...collisions.map((collision) => `  - ${collision}`),
    '',
    'This workflow deliberately cannot resume a partially published release.',
    'It cannot prove that a rebuilt multi-platform image is byte-for-byte identical',
    'to existing GHCR manifests, so matching labels or package names are insufficient.',
    `Preserve the existing tag, registry objects, draft release, and logs; advance every`,
    `package, CLI, changelog, and release reference to ${nextVersion}.`,
    'Follow docs/releasing.md#partial-publication-runbook.',
  ].join('\n');
}

function main(args) {
  if (args.length !== 5) {
    fail(
      'Usage: node scripts/check-release-slot.mjs '
      + '<version> <release-sha> <image> <npm-inventory.jsonl> <ghcr-inventory.jsonl>',
    );
  }
  const [version, releaseSha, image, npmPath, ghcrPath] = args;
  const result = inspectReleaseSlot({
    version,
    releaseSha,
    image,
    npmEntries: parseJsonLines(npmPath, 'npm inventory'),
    ghcrEntries: parseJsonLines(ghcrPath, 'GHCR inventory'),
  });
  if (result.collisions.length) {
    process.stderr.write(`${formatConsumedReleaseSlot({ version, ...result })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Release candidate ${version} has no npm versions or immutable GHCR tags; publication may proceed.\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Release-slot check failed closed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
