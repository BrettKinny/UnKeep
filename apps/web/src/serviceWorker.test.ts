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

  it('handles share-target POST bodies locally before other requests', () => {
    expect(source).toContain("url.pathname === '/share' && event.request.method === 'POST'");
    expect(source).toContain('redirectSharedPost(event.request, worker.location.origin)');
    expect(source).not.toContain('request.formData()');
    expect(source.indexOf("url.pathname === '/share'")).toBeLessThan(
      source.indexOf("event.request.method !== 'GET'"),
    );
  });

  it('never stores navigation query strings as cache keys', () => {
    expect(source).toContain('const cacheKey = new Request(`${requestUrl.origin}${requestUrl.pathname}`)');
    expect(source).toContain('cache.put(cacheKey, response.clone())');
    expect(source).toContain('return await caches.match(cacheKey)');
  });
});
