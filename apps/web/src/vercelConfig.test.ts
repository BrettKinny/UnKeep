import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hosted PWA response policy', () => {
  it('matches the self-hosted browser protections and never caches the service worker', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
    ) as {
      headers: Array<{
        source: string;
        headers: Array<{ key: string; value: string }>;
      }>;
    };
    const allRoutes = Object.fromEntries(
      config.headers.find(entry => entry.source === '/(.*)')!.headers
        .map(header => [header.key.toLowerCase(), header.value]),
    );
    expect(allRoutes['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(allRoutes['content-security-policy']).toContain("script-src-attr 'none'");
    expect(allRoutes['permissions-policy']).toContain('camera=()');
    expect(allRoutes['referrer-policy']).toBe('no-referrer');
    expect(allRoutes['x-content-type-options']).toBe('nosniff');
    expect(allRoutes['x-frame-options']).toBe('DENY');

    const serviceWorker = Object.fromEntries(
      config.headers.find(entry => entry.source === '/service-worker.js')!.headers
        .map(header => [header.key.toLowerCase(), header.value]),
    );
    expect(serviceWorker['cache-control']).toContain('no-store');
  });
});
