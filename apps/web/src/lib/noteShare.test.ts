import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@unkeep/core';
import {
  downloadNoteMarkdown,
  noteShareFilename,
  noteShareTitle,
  noteToShareMarkdown,
  noteToShareText,
  obsidianNewNoteUrl,
} from './noteShare.js';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'private-record-id',
    title: 'Packing list',
    content: 'Before Friday',
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('outbound note sharing', () => {
  it('formats a readable Markdown snapshot without private record metadata', () => {
    const markdown = noteToShareMarkdown(note({
      content: '',
      checkboxes: [
        { id: 'one', text: 'Passport', checked: true },
        { id: 'two', text: 'Charger', checked: false },
      ],
      labels: ['travel', 'soon'],
      images: [{ id: 'secret-attachment-id', name: 'ticket.pdf', mimeType: 'application/pdf', size: 42 }],
    }));

    expect(markdown).toBe([
      '# Packing list',
      '- [x] Passport\n- [ ] Charger',
      '**Labels:** travel, soon',
      '**Attachments:** ticket.pdf',
    ].join('\n\n'));
    expect(markdown).not.toContain('private-record-id');
    expect(markdown).not.toContain('secret-attachment-id');
    expect(markdown).not.toContain('createdAt');
  });

  it('formats a generic plain-text snapshot and retains an empty checklist', () => {
    expect(noteToShareText(note({
      checkboxes: [],
      labels: undefined,
      images: undefined,
    }))).toBe('Packing list');
    expect(noteToShareText(note({ title: undefined }))).toBe('Before Friday');
  });

  it('keeps title line breaks from changing the Markdown structure', () => {
    const value = note({ title: 'First line\n# Injected heading' });
    expect(noteShareTitle(value)).toBe('First line # Injected heading');
    expect(noteToShareMarkdown(value).startsWith('# First line # Injected heading\n\n')).toBe(true);
  });

  it('creates a route-safe cross-platform filename from an untrusted title', () => {
    expect(noteShareFilename(note({ title: '../../CON:<draft>? ' })))
      .toBe('-..-CON--draft--.md');
    expect(noteShareFilename(note({ title: 'NUL' }))).toBe('_NUL.md');
    expect(noteShareFilename(note({ title: 'con.txt' }))).toBe('_con.txt.md');
    expect(noteShareFilename(note({ title: '\u0000 / \\' }))).toBe('- - -.md');
    expect(noteShareFilename(note({ title: 'report\u202Efdp.exe' }))).toBe('report-fdp.exe.md');
    expect(noteShareFilename(note({ title: '' }))).toBe('UnKeep note.md');
    expect(noteShareFilename(note({ title: '🧭'.repeat(121) })))
      .toBe(`${'🧭'.repeat(120)}.md`);
  });

  it('shares an empty untitled note as a named snapshot', () => {
    const empty = note({ title: undefined, content: '' });
    expect(noteToShareText(empty)).toBe('UnKeep note');
    expect(noteToShareMarkdown(empty)).toBe('# UnKeep note');
  });

  it('opens Obsidian with only a safe name in the URI and the body on the clipboard', () => {
    const url = obsidianNewNoteUrl(note({
      title: 'Plans & private?',
      content: 'must not appear in an OS URL log',
    }));
    expect(url).toBe('obsidian://new?name=Plans%20%26%20private-&clipboard');
    expect(url).not.toContain('must');
  });

  it('keeps the object URL alive through the Markdown download gesture', () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { href: '', download: '', click, remove };
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:shared-note'),
      revokeObjectURL,
    });

    downloadNoteMarkdown(note());

    expect(anchor.download).toBe('Packing list.md');
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:shared-note');
  });
});
