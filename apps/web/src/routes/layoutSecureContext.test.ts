import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');
const notice = readFileSync(
  new URL('../lib/components/InsecureContextNotice.svelte', import.meta.url),
  'utf8',
);

describe('root layout secure-context gate', () => {
  it('renders the app only in a secure context', () => {
    expect(layout).toMatch(
      /\{#if window\.isSecureContext\}\s*\{@render children\(\)\}\s*\{:else\}\s*<InsecureContextNotice \/>/,
    );
  });

  it('explains the HTTPS requirement and links to the setup guide', () => {
    expect(notice).toContain('UnKeep needs HTTPS');
    expect(notice).toContain('self-hosting.md#serve-it-over-https');
    expect(notice).toContain('rel="noopener noreferrer"');
  });
});
