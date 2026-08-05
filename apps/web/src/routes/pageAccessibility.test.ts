import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('main page responsive shell', () => {
  it('keeps the home control named when its visible text is hidden', () => {
    expect(source).toMatch(/aria-label="Show notes"[\s\S]*<img src="\/icon\.svg" alt=""/);
  });

  it('uses one responsive header without a hamburger or persistent sidebar', () => {
    expect(source).toContain('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(source).toContain('<AppMenu');
    expect(source).not.toContain('aria-label="Toggle navigation"');
    expect(source).not.toContain('<aside');
  });

  it('keeps Trash navigation and permanent deletion explicit', () => {
    expect(source).toContain('aria-label="Back to notes"');
    expect(source).toContain('Empty Trash…');
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('This cannot be undone.');
  });
});
