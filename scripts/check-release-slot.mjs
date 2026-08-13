#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ghcrEntries,
}) {
  const nextVersion = nextReleaseCandidate(version);
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    fail(`Invalid 40-character release SHA: ${releaseSha}`);
  }
  if (typeof image !== 'string' || !image.startsWith('ghcr.io/')) {
    fail(`Invalid GHCR image reference: ${image}`);
  }

  const ghcrVersions = validateGhcrInventory(ghcrEntries);
  const collisions = [];

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
  if (args.length !== 4) {
    fail(
      'Usage: node scripts/check-release-slot.mjs '
      + '<version> <release-sha> <image> <ghcr-inventory.jsonl>',
    );
  }
  const [version, releaseSha, image, ghcrPath] = args;
  const result = inspectReleaseSlot({
    version,
    releaseSha,
    image,
    ghcrEntries: parseJsonLines(ghcrPath, 'GHCR inventory'),
  });
  if (result.collisions.length) {
    process.stderr.write(`${formatConsumedReleaseSlot({ version, ...result })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Release candidate ${version} has no immutable GHCR tags; publication may proceed.\n`,
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
