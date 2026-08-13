#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/extract-release-notes.mjs <version>');
}

const changelog = readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf8')
  .replace(/\r\n?/g, '\n');
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](?: - .+)?$`, 'm');
const match = heading.exec(changelog);
if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`);

const bodyStart = match.index + match[0].length;
const remainder = changelog.slice(bodyStart);
const nextHeading = /^## \[/m.exec(remainder);
const body = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);

process.stdout.write(`${body}\n`);
