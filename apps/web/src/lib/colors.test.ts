import { describe, it, expect } from 'vitest';
import { colorMap } from './colors.js';

describe('colorMap', () => {
  it('maps all NoteColor values to CSS variables', () => {
    const expectedColors = [
      'default', 'red', 'orange', 'yellow', 'green',
      'teal', 'blue', 'purple', 'pink', 'brown', 'gray',
    ];

    for (const color of expectedColors) {
      expect(colorMap[color]).toBe(`var(--color-note-${color})`);
    }
  });

  it('has exactly 11 color entries', () => {
    expect(Object.keys(colorMap)).toHaveLength(11);
  });

  it('all values are CSS custom properties', () => {
    for (const value of Object.values(colorMap)) {
      expect(value).toMatch(/^var\(--color-note-\w+\)$/);
    }
  });
});
