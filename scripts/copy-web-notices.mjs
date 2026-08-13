#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
const outputDirectory = join(repositoryRoot, 'apps/web/build');
const destination = join(outputDirectory, 'THIRD_PARTY_NOTICES.md');

if (!readFileSync(source, 'utf8').trim()) {
  throw new Error('THIRD_PARTY_NOTICES.md is empty; run `pnpm notices` first');
}

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(source, destination);
process.stdout.write('Copied THIRD_PARTY_NOTICES.md into the standalone web build.\n');
