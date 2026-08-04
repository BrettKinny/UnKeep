#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const prereleasePattern = /\bv?(\d+\.\d+\.\d+-rc\.\d+)\b/g;

export const releaseReferenceFiles = [
  'README.md',
  'docs/agent-scratchpad.md',
  'docs/releasing.md',
  'docs/self-hosting.md',
  'packages/core/README.md',
  'packages/client/README.md',
  'apps/cli/README.md',
  'compose.release.yaml',
];

export function releaseTokens(text) {
  return [...text.matchAll(prereleasePattern)].map(match => match[1]);
}

export function findReleaseReferenceDrift(expectedVersion, files) {
  const drift = [];
  for (const [path, text] of files) {
    for (const version of releaseTokens(text)) {
      if (version !== expectedVersion) drift.push({ path, version });
    }
  }
  return drift;
}

export function checkReleaseReferences(root = repositoryRoot) {
  const packagePaths = [
    'packages/core/package.json',
    'packages/client/package.json',
    'apps/cli/package.json',
  ];
  const packages = packagePaths.map(path => ({
    path,
    value: JSON.parse(readFileSync(join(root, path), 'utf8')),
  }));
  const expectedVersion = packages[0].value.version;
  const errors = [];

  for (const { path, value } of packages) {
    if (value.version !== expectedVersion) {
      errors.push(`${path} declares ${value.version}; expected ${expectedVersion}`);
    }
  }

  const help = readFileSync(join(root, 'apps/cli/src/help.ts'), 'utf8');
  const cliVersion = help.match(/export const VERSION = '([^']+)'/)?.[1];
  if (cliVersion !== expectedVersion) {
    errors.push(`apps/cli/src/help.ts declares ${cliVersion ?? 'no version'}; expected ${expectedVersion}`);
  }

  const files = releaseReferenceFiles.map(path => [
    path,
    readFileSync(join(root, path), 'utf8'),
  ]);
  for (const { path, version } of findReleaseReferenceDrift(expectedVersion, files)) {
    errors.push(`${path} contains stale release reference ${version}; expected ${expectedVersion}`);
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`## [${expectedVersion}]`)) {
    errors.push(`CHANGELOG.md has no release section for ${expectedVersion}`);
  }

  return { expectedVersion, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkReleaseReferences();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Release references agree on ${result.expectedVersion}.`);
  }
}
