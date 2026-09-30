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

describe('main page keyboard shortcuts', () => {
  it('registers and tears down a single global keydown listener', () => {
    expect(source).toContain("window.addEventListener('keydown', handleGlobalKeydown)");
    expect(source).toContain("window.removeEventListener('keydown', handleGlobalKeydown)");
  });

  it('defers to dialogs that already handled the key', () => {
    expect(source).toContain('if (event.defaultPrevented || !vaultReady) return;');
  });

  it('treats every dialog and the app menu as owning the keyboard', () => {
    expect(source).toMatch(
      /modalOpen: Boolean\(editingNote\) \|\| showImporter \|\| showAccessManager \|\| showShortcuts\s*\|\| deleteConfirmation !== null \|\| menuOpen/,
    );
    expect(source).toContain('bind:open={menuOpen}');
  });

  it('turns off note-changing shortcuts in Trash', () => {
    expect(source).toContain("inTrash: contentView === 'trash'");
  });

  it('never permanently deletes from the keyboard', () => {
    const shortcutHandlers = source.slice(
      source.indexOf('function runShortcut'),
      source.indexOf('let allTrashedNotes'),
    );
    expect(shortcutHandlers).toContain('await trashNoteWithUndo(id);');
    expect(shortcutHandlers).not.toContain('permanentlyDeleteNote');
    expect(shortcutHandlers).not.toContain('requestPermanentDelete');
  });

  it('drops the keyboard selection when its note leaves the current view', () => {
    expect(source).toMatch(
      /if \(activeNoteId && !visibleNotes\.some\(note => note\.id === activeNoteId\)\)[\s\S]*activeNoteId = null/,
    );
  });
});
