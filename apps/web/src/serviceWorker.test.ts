import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./service-worker.ts', import.meta.url), 'utf8');

describe('service worker', () => {
  it('precaches the complete generated application shell', () => {
    expect(source).toMatch(/import \{ build, files, prerendered, version \} from '\$service-worker'/);
    expect(source).toMatch(/cache\.addAll\(APP_SHELL\)/);
  });

  it('always sends API requests to the network', () => {
    expect(source).toMatch(
      /if \(url\.pathname\.startsWith\('\/api\/'\)\) \{\s*event\.respondWith\(fetch\(event\.request\)\);\s*return;\s*\}/
    );
  });
});
