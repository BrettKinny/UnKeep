import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function componentSource(name: string): string {
  return readFileSync(new URL(`./${name}.svelte`, import.meta.url), 'utf8');
}

describe('component accessibility contracts', () => {
  it('keeps a polite toast status region mounted for announcements', () => {
    const source = componentSource('Toast');

    expect(source).toMatch(/<div[^>]*role="status"[^>]*aria-live="polite"/s);
    expect(source.indexOf('role="status"')).toBeLessThan(source.indexOf('{#if toastStore.toasts.length'));
  });

  it('uses a named native button to open a note with Enter or Space', () => {
    const source = componentSource('NoteCard');

    expect(source).toContain('<article');
    expect(source).not.toContain('role="button"');
    expect(source).not.toContain('onkeydown=');
    expect(source).toMatch(
      /<button\s+type="button"[^>]*aria-label=\{editLabel\}[^>]*onclick=\{\(\) => onEdit\(note\)\}/s,
    );
  });

  it('keeps note actions above the full-card edit target for pointer input', () => {
    const source = componentSource('NoteCard');

    expect(source).toMatch(
      /class="note-actions relative z-20[^"]*"/,
    );
    expect(source).toContain('class:pointer-events-none={!actionsVisible}');
    expect(source).toContain('class:pointer-events-auto={actionsVisible}');
    expect(source).not.toMatch(/class="pointer-events-none relative z-0"/);
  });

  it('prevents duplicate Trash mutations while persistence is pending', () => {
    const source = componentSource('NoteCard');

    expect(source).toContain('if (mutatingTrash) return;');
    expect(source).toContain('disabled={mutatingTrash}');
    expect(source).toContain('void handleRestore()');
  });
  it('gives note creation controls native button and label semantics', () => {
    const source = componentSource('NoteInput');

    expect(source).not.toContain('role="button"');
    expect(source).toMatch(/<button\s+type="button"[^>]*aria-label="Create a new note"/s);
    expect(source).toContain('<label for="new-note-title"');
    expect(source).toContain('id="new-note-title"');
    expect(source).toContain('<label for="new-note-content"');
    expect(source).toContain('id="new-note-content"');
  });

  it('focuses the import dialog and lets Escape close it', () => {
    const source = componentSource('KeepImporter');

    expect(source).toContain("import { onMount } from 'svelte';");
    expect(source).toContain('bind:this={dialogEl}');
    expect(source).toContain('onkeydown={handleDialogKeydown}');
    expect(source).toMatch(/if \(event\.key === 'Escape'\)[\s\S]*onClose\(\)/);
    expect(source).toMatch(/onMount\([\s\S]*dialogEl\?\.focus\(\)/);
    expect(source).toContain('previouslyFocused.focus()');
    expect(source).toMatch(/<button\s+type="button"\s+onclick=\{onClose\}[^>]*aria-label="Close import dialog"/s);
  });

  it('wraps forward and reverse Tab focus within the import dialog', () => {
    const source = componentSource('KeepImporter');

    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain('querySelectorAll<HTMLElement>');
    expect(source).toContain('active === dialogEl');
    expect(source).toMatch(
      /event\.shiftKey[\s\S]*active === first[\s\S]*event\.preventDefault\(\)[\s\S]*last\.focus\(\)/,
    );
    expect(source).toMatch(
      /!event\.shiftKey[\s\S]*active === last[\s\S]*event\.preventDefault\(\)[\s\S]*first\.focus\(\)/,
    );
  });

  it('keeps import controls scrollable within a short viewport', () => {
    const source = componentSource('KeepImporter');

    expect(source).toMatch(
      /class="[^"]*max-h-\[calc\(100dvh-2rem\)\][^"]*overflow-hidden[^"]*"/,
    );
    expect(source).toMatch(/class="[^"]*min-h-0[^"]*overflow-y-auto[^"]*p-4[^"]*"/);
  });

  it('provides a keyboard-focusable, visibly focused import file picker', () => {
    const source = componentSource('KeepImporter');

    expect(source).toMatch(
      /<input[^>]*id="keep-import-files"[^>]*type="file"[^>]*class="peer sr-only"/s,
    );
    expect(source).toMatch(
      /<label[^>]*for="keep-import-files"[^>]*peer-focus-visible:ring-2[^>]*>[\s\S]*Browse files[\s\S]*<\/label>/,
    );
  });

  it('focuses, traps Tab within, and restores focus from the note editor dialog', () => {
    const source = componentSource('NoteEditor');

    expect(source).toContain("import { onMount } from 'svelte';");
    expect(source).toContain('bind:this={dialogEl}');
    expect(source).toMatch(/if \(event\.key === 'Tab'[^)]*\)/);
    expect(source).toContain('previouslyFocused.focus()');
    expect(source).toContain('<label for="edit-note-title"');
    expect(source).toContain('<label for="edit-note-content"');
    expect(source).toContain('<label for="edit-note-labels"');
  });

  it('offers note deletion with Undo from the expanded editor', () => {
    const source = componentSource('NoteEditor');

    expect(source).toContain('async function handleDelete()');
    expect(source).toContain('if (deleting) return;');
    expect(source).toContain('await noteStore.deleteNote(note.id)');
    expect(source).toContain("toastStore.show('Note deleted'");
    expect(source).toContain('fn: () => noteStore.undoDelete(deleted)');
    expect(source).toMatch(
      /<button\s+type="button"[^>]*onclick=\{handleDelete\}[^>]*aria-label="Delete"/s,
    );
    expect(source).toContain('disabled={deleting}');
  });

  it('labels Quick Send as an unencrypted snapshot before it is copied', () => {
    const source = componentSource('NoteEditor');

    expect(source).toContain(
      'aria-label="Quick Send — copy unencrypted snapshot link"',
    );
    expect(source).toContain(
      'Unencrypted Quick Send snapshot copied; anyone with the link can read it',
    );
  });

  it('renders attachment links only after the local object-URL guard passes', () => {
    const source = componentSource('AttachmentChip');

    expect(source).toContain("import { formatAttachmentSize, hasLocalAttachmentUrl } from '$lib/attachments';");
    expect(source).toContain('{#if hasLocalAttachmentUrl(attachment)}');
    expect(source).not.toContain('{#if attachment.url}');
  });

  it('announces quarantine separately as a polite amber warning without retry semantics', () => {
    const source = componentSource('SyncStatus');
    const warningStart = source.indexOf('{#if noteStore.syncQuarantineCount > 0}');
    const warningEnd = source.indexOf('{/if}', warningStart);
    const warning = source.slice(warningStart, warningEnd);

    expect(warningStart).toBeGreaterThan(-1);
    expect(warning).toContain('text-amber-700');
    expect(warning).toContain('role="status"');
    expect(warning).toContain('aria-live="polite"');
    expect(warning).toContain('aria-hidden="true"');
    expect(warning).toContain('<span class="sr-only">{quarantineLabel}</span>');
    expect(warning).not.toContain('noteStore.sync()');
    expect(source).toMatch(
      /\{#if noteStore\.syncStatus === 'error'\}[\s\S]*onclick=\{\(\) => noteStore\.sync\(\)\}/,
    );
  });
});
