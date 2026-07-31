#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.github.com';
const MAX_PAGES = 100;
const PER_PAGE = 100;

function fail(message) {
  throw new Error(message);
}

function routeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    fail(`${label} is not a valid GitHub route segment`);
  }
  return value;
}

async function githubJson(path, token, fetchImpl) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    fail(`GitHub package inventory returned HTTP ${response.status} for ${path}`);
  }
  return response.json();
}

async function paginated(path, token, fetchImpl) {
  const values = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await githubJson(
      `${path}${separator}per_page=${PER_PAGE}&page=${page}`,
      token,
      fetchImpl,
    );
    if (!Array.isArray(result) || result.length > PER_PAGE) {
      fail('GitHub package inventory returned an invalid page');
    }
    values.push(...result);
    if (result.length < PER_PAGE) return values;
  }
  fail(`GitHub package inventory exceeded ${MAX_PAGES} pages`);
}

export async function inventoryGhcr({
  owner,
  packageName,
  token,
  fetchImpl = fetch,
}) {
  owner = routeSegment(owner, 'GitHub owner');
  packageName = routeSegment(packageName, 'GHCR package name');
  if (typeof token !== 'string' || !token) fail('GH_TOKEN is required');

  const ownerRecord = await githubJson(
    `/users/${encodeURIComponent(owner)}`,
    token,
    fetchImpl,
  );
  const namespace = ownerRecord?.type === 'User'
    ? 'users'
    : ownerRecord?.type === 'Organization'
      ? 'orgs'
      : fail('GitHub owner has an unsupported account type');

  // Listing the namespace first distinguishes a genuinely absent package from
  // an inaccessible or otherwise ambiguous package-version 404.
  const packages = await paginated(
    `/${namespace}/${encodeURIComponent(owner)}/packages?package_type=container`,
    token,
    fetchImpl,
  );
  for (const [index, value] of packages.entries()) {
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || typeof value.name !== 'string'
      || value.package_type !== 'container'
    ) {
      fail(`GitHub package inventory returned an invalid package record at index ${index}`);
    }
  }

  const caseFoldedMatches = packages.filter(
    value => value.name.toLowerCase() === packageName.toLowerCase(),
  );
  if (caseFoldedMatches.some(value => value.name !== packageName)) {
    fail('GitHub package inventory returned an ambiguous package name');
  }
  const matches = caseFoldedMatches;
  if (matches.length > 1) fail('GitHub package inventory returned duplicate packages');
  if (matches.length === 0) return [];

  return paginated(
    `/${namespace}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions`,
    token,
    fetchImpl,
  );
}

async function main(args) {
  if (args.length !== 3) {
    fail('Usage: inventory-ghcr.mjs <owner> <package-name> <output-jsonl>');
  }
  const [owner, packageName, outputPath] = args;
  const versions = await inventoryGhcr({
    owner,
    packageName,
    token: process.env.GH_TOKEN,
  });
  writeFileSync(
    resolve(outputPath),
    versions.map(value => JSON.stringify(value)).join('\n') + (versions.length ? '\n' : ''),
    { encoding: 'utf8', mode: 0o600 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
