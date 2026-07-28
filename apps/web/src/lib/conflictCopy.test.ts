import { describe, expect, it } from 'vitest';
import type { Note } from '@unkeep/core';
import { createConflictCopy } from './conflictCopy';

const original: Note = {
  id: 'original',
  title: 'Shared list',
  content: 'local edit',
  createdAt: 1,
  updatedAt: 2,
  pinned: true,
  archived: true,
  deleted: true,
  labels: ['team'],
  checkboxes: [{ id: 'item', text: 'Keep me', checked: false }],
  images: [{ id: 'image', name: 'proof.png', mimeType: 'image/png', size: 3, url: 'blob:local' }],
};

describe('createConflictCopy', () => {
  it('turns a stale local write into a visible independent note', () => {
    const ids = ['copy-note', 'copy-image'];
    const copy = createConflictCopy(original, () => ids.shift()!, 100);

    expect(copy).toEqual({
      ...original,
      id: 'copy-note',
      title: 'Shared list (conflict copy)',
      createdAt: 100,
      updatedAt: 100,
      pinned: false,
      archived: false,
      deleted: undefined,
      checkboxes: [{ id: 'item', text: 'Keep me', checked: false }],
      images: [{ id: 'copy-image', name: 'proof.png', mimeType: 'image/png', size: 3 }],
    });
    expect(copy.checkboxes).not.toBe(original.checkboxes);
  });

  it('gives an untitled note a clear recovery title', () => {
    const copy = createConflictCopy({ ...original, title: undefined, images: undefined }, () => 'copy', 100);
    expect(copy.title).toBe('Conflict copy');
  });
});
