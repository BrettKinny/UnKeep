import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../static/sw.js', import.meta.url), 'utf8');

describe('service worker', () => {
  it('always sends API requests to the network', () => {
    expect(source).toMatch(
      /if \(url\.pathname\.startsWith\('\/api\/'\)\) \{\s*event\.respondWith\(fetch\(event\.request\)\);\s*return;\s*\}/
    );
  });
});
