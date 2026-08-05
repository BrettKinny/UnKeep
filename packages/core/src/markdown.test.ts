import { describe, it, expect } from 'vitest';
import { noteToMarkdown, markdownToNote } from './markdown.js';
import type { Note } from './types.js';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'test-id',
    content: 'Hello world',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    pinned: false,
    archived: false,
    ...overrides,
  };
}

describe('noteToMarkdown', () => {
  it('generates frontmatter with required fields', () => {
    const md = noteToMarkdown(makeNote());
    expect(md).toContain('---');
    expect(md).toContain('id: test-id');
    expect(md).toContain('createdAt: 1700000000000');
    expect(md).toContain('updatedAt: 1700000001000');
    expect(md).toContain('pinned: false');
    expect(md).toContain('archived: false');
    expect(md).toContain('\n\nHello world');
  });

  it('includes color when set', () => {
    const md = noteToMarkdown(makeNote({ color: 'blue' }));
    expect(md).toContain('color: blue');
  });

  it('omits color when not set', () => {
    const md = noteToMarkdown(makeNote());
    expect(md).not.toContain('color:');
  });

  it('includes deleted when true', () => {
    const md = noteToMarkdown(makeNote({ deleted: true }));
    expect(md).toContain('deleted: true');
  });

  it('roundtrips recoverable Trash state', () => {
    const original = makeNote({ trashedAt: 1700000002000 });
    const markdown = noteToMarkdown(original);
    expect(markdown).toContain('trashedAt: 1700000002000');
    expect(markdownToNote(markdown).trashedAt).toBe(1700000002000);
  });

  it('omits deleted when not set', () => {
    const md = noteToMarkdown(makeNote());
    expect(md).not.toContain('deleted:');
  });

  it('includes checkboxes as JSON', () => {
    const checkboxes = [{ id: 'c1', text: 'Buy milk', checked: false }];
    const md = noteToMarkdown(makeNote({ checkboxes }));
    expect(md).toContain('checkboxes: [{"id":"c1","text":"Buy milk","checked":false}]');
  });

  it('handles empty content', () => {
    const md = noteToMarkdown(makeNote({ content: '' }));
    expect(md).toMatch(/---\n\n$/);
  });
});

describe('markdownToNote', () => {
  it('parses frontmatter and body', () => {
    const md = noteToMarkdown(makeNote());
    const note = markdownToNote(md);
    expect(note.id).toBe('test-id');
    expect(note.content).toBe('Hello world');
    expect(note.createdAt).toBe(1700000000000);
    expect(note.updatedAt).toBe(1700000001000);
    expect(note.pinned).toBe(false);
    expect(note.archived).toBe(false);
  });

  it('parses pinned and archived as true', () => {
    const md = noteToMarkdown(makeNote({ pinned: true, archived: true }));
    const note = markdownToNote(md);
    expect(note.pinned).toBe(true);
    expect(note.archived).toBe(true);
  });

  it('parses color', () => {
    const md = noteToMarkdown(makeNote({ color: 'red' }));
    const note = markdownToNote(md);
    expect(note.color).toBe('red');
  });

  it('parses deleted', () => {
    const md = noteToMarkdown(makeNote({ deleted: true }));
    const note = markdownToNote(md);
    expect(note.deleted).toBe(true);
  });

  it('parses checkboxes', () => {
    const checkboxes = [
      { id: 'c1', text: 'Buy milk', checked: false },
      { id: 'c2', text: 'Walk dog', checked: true },
    ];
    const md = noteToMarkdown(makeNote({ checkboxes }));
    const note = markdownToNote(md);
    expect(note.checkboxes).toEqual(checkboxes);
  });

  it('throws for content without frontmatter', () => {
    expect(() => markdownToNote('Just plain text')).toThrow('Invalid note format');
  });

  it('handles empty body', () => {
    const md = noteToMarkdown(makeNote({ content: '' }));
    const note = markdownToNote(md);
    expect(note.content).toBe('');
  });

  it('handles multiline content', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const md = noteToMarkdown(makeNote({ content }));
    const note = markdownToNote(md);
    expect(note.content).toBe(content);
  });

  it('roundtrips all fields', () => {
    const original = makeNote({
      pinned: true,
      archived: true,
      color: 'teal',
      deleted: true,
      checkboxes: [{ id: 'x', text: 'test', checked: true }],
      content: 'Multiline\ncontent\nhere',
    });
    const roundtripped = markdownToNote(noteToMarkdown(original));
    expect(roundtripped).toEqual(original);
  });
});
