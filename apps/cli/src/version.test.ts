import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from './help.js';

describe('CLI release identity', () => {
  it('reports the package metadata version', () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      version?: unknown;
    };
    expect(VERSION).toBe(packageMetadata.version);
  });
});
