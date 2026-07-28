import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('main page responsive navigation', () => {
  it('keeps the home control named when its visible text is hidden', () => {
    expect(source).toMatch(/aria-label="Show notes"[\s\S]*<img src="\/icon\.svg" alt=""/);
  });

  it('tracks the desktop breakpoint and only auto-closes navigation on mobile', () => {
    expect(source).toContain("media.addEventListener('change'");
    expect(source).toContain('closeSidebarOnMobile()');
    expect(source).toContain('if (!media.matches) sidebarOpen = false');
  });
});
