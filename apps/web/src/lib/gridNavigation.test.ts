import { describe, expect, it } from 'vitest';
import { nextNoteId, type NoteRect } from './gridNavigation.js';

/**
 * A three-column masonry layout with cards of uneven height, mirroring how the
 * CSS `columns` grid actually renders:
 *
 *   col 0        col 1        col 2
 *   ┌── a ──┐    ┌── b ──┐    ┌── c ──┐
 *   └───────┘    │       │    └───────┘
 *   ┌── d ──┐    └───────┘    ┌── f ──┐
 *   │       │    ┌── e ──┐    │       │
 *   └───────┘    └───────┘    └───────┘
 */
const rect = (id: string, left: number, top: number, bottom: number): NoteRect =>
  ({ id, left, top, right: left + 100, bottom });

const grid: NoteRect[] = [
  rect('a', 0, 0, 50),
  rect('b', 110, 0, 100),
  rect('c', 220, 0, 40),
  rect('d', 0, 60, 160),
  rect('e', 110, 110, 150),
  rect('f', 220, 50, 200),
];

describe('nextNoteId', () => {
  it('selects the first note when nothing is selected', () => {
    expect(nextNoteId(grid, null, 'down')).toBe('a');
    expect(nextNoteId(grid, null, 'right')).toBe('a');
  });

  it('selects the first note when the selection no longer exists', () => {
    expect(nextNoteId(grid, 'deleted-note', 'down')).toBe('a');
  });

  it('returns null for an empty grid', () => {
    expect(nextNoteId([], null, 'down')).toBeNull();
    expect(nextNoteId([], 'a', 'up')).toBeNull();
  });

  it('moves down its own column rather than to a nearer neighbour', () => {
    expect(nextNoteId(grid, 'a', 'down')).toBe('d');
    expect(nextNoteId(grid, 'b', 'down')).toBe('e');
  });

  it('moves up its own column', () => {
    expect(nextNoteId(grid, 'd', 'up')).toBe('a');
    expect(nextNoteId(grid, 'e', 'up')).toBe('b');
  });

  it('moves to the adjacent column, not across it', () => {
    expect(nextNoteId(grid, 'a', 'right')).toBe('b');
    expect(nextNoteId(grid, 'b', 'right')).toBe('c');
    expect(nextNoteId(grid, 'c', 'left')).toBe('b');
    expect(nextNoteId(grid, 'b', 'left')).toBe('a');
  });

  it('prefers the vertically overlapping card when changing columns', () => {
    expect(nextNoteId(grid, 'e', 'left')).toBe('d');
    expect(nextNoteId(grid, 'd', 'right')).toBe('e');
  });

  it('keeps the selection at the edges of the grid', () => {
    expect(nextNoteId(grid, 'a', 'up')).toBe('a');
    expect(nextNoteId(grid, 'a', 'left')).toBe('a');
    expect(nextNoteId(grid, 'c', 'right')).toBe('c');
    expect(nextNoteId(grid, 'f', 'down')).toBe('f');
  });

  it('handles a single-column layout as a plain list', () => {
    const column = [rect('a', 0, 0, 50), rect('b', 0, 60, 110), rect('c', 0, 120, 170)];
    expect(nextNoteId(column, 'a', 'down')).toBe('b');
    expect(nextNoteId(column, 'b', 'down')).toBe('c');
    expect(nextNoteId(column, 'c', 'up')).toBe('b');
    expect(nextNoteId(column, 'b', 'left')).toBe('b');
  });
});
