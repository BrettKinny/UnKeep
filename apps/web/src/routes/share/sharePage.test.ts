import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('share confirmation route', () => {
  it('strips shared content before asking the user to confirm it', () => {
    expect(source).toContain("history.replaceState(null, '', resolve('/share'))");
    expect(source).toContain('Review this content before adding it to your current vault.');
    expect(source).toContain('onclick={() => void confirmShare()}');
    expect(source.slice(source.indexOf('onMount('), source.indexOf('async function confirmShare')))
      .not.toContain('stashPendingShare(payload');
  });

  it('binds confirmed content to the currently stored vault when available', () => {
    expect(source).toContain('const session = await relaySessionStore.load()');
    expect(source).toContain('stashPendingShare(payload, session?.instanceId ?? null)');
  });
});
