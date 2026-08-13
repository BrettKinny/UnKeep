import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('application bootstrap security policy', () => {
  it('delegates the static bootstrap policy to SvelteKit hash generation', () => {
    const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../svelte.config.js', import.meta.url), 'utf8');

    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
    expect(config).toContain("mode: 'hash'");
    expect(config).toContain("'script-src': ['self']");
    expect(config).not.toMatch(/'script-src':\s*\[[^\]]*'unsafe-inline'/);
    expect(config).toContain("'script-src-attr': ['none']");
    expect(config).toContain("'object-src': ['none']");
    expect(config).toContain("'base-uri': ['none']");
    expect(config).toContain("'form-action': ['none']");
  });

  it('uses an immutable release identity instead of a build timestamp', () => {
    const config = readFileSync(new URL('../svelte.config.js', import.meta.url), 'utf8');

    expect(config).toContain('UNKEEP_BUILD_VERSION');
    expect(config).toContain('UNKEEP_BUILD_REVISION');
    expect(config).toContain('releaseRevision ? `${buildVersion}-${buildRevision}`');
    expect(config).toContain(": 'dev'");
  });
});
