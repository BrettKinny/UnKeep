import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('application bootstrap security policy', () => {
  it('allows SvelteKit static adapter inline bootstrap scripts', () => {
    const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
    const policy = html.match(/Content-Security-Policy" content="([^"]+)/)?.[1];

    expect(policy).toBeDefined();
    expect(policy).toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
