import { describe, it, expect } from 'vitest';
import { validateNoteId, isValidNoteId } from './validation.js';

describe('validateNoteId', () => {
  it('returns the ID for valid alphanumeric IDs', () => {
    expect(validateNoteId('abc123')).toBe('abc123');
  });

  it('allows hyphens and underscores', () => {
    expect(validateNoteId('my-note_1')).toBe('my-note_1');
  });

  it('allows single character IDs', () => {
    expect(validateNoteId('a')).toBe('a');
  });

  it('allows nanoid-style IDs', () => {
    expect(validateNoteId('V1StGXR8_Z5jdHi6B-myT')).toBe('V1StGXR8_Z5jdHi6B-myT');
  });

  it('throws for empty string', () => {
    expect(() => validateNoteId('')).toThrow('Invalid note ID');
  });

  it('throws for IDs with spaces', () => {
    expect(() => validateNoteId('has space')).toThrow('Invalid note ID');
  });

  it('throws for IDs with dots', () => {
    expect(() => validateNoteId('file.md')).toThrow('Invalid note ID');
  });

  it('throws for IDs with slashes', () => {
    expect(() => validateNoteId('path/to/note')).toThrow('Invalid note ID');
  });

  it('throws for IDs with special characters', () => {
    expect(() => validateNoteId('note@#$')).toThrow('Invalid note ID');
  });

  it('throws for IDs with unicode', () => {
    expect(() => validateNoteId('café')).toThrow('Invalid note ID');
  });

  it('throws for IDs longer than the route-safe limit', () => {
    expect(() => validateNoteId('a'.repeat(129))).toThrow('1-128 characters');
  });
});

describe('isValidNoteId', () => {
  it('returns true for valid IDs', () => {
    expect(isValidNoteId('abc123')).toBe(true);
    expect(isValidNoteId('my-note_1')).toBe(true);
    expect(isValidNoteId('V1StGXR8_Z5jdHi6B-myT')).toBe(true);
  });

  it('returns false for invalid IDs', () => {
    expect(isValidNoteId('')).toBe(false);
    expect(isValidNoteId('has space')).toBe(false);
    expect(isValidNoteId('file.md')).toBe(false);
    expect(isValidNoteId('path/to')).toBe(false);
    expect(isValidNoteId('a'.repeat(129))).toBe(false);
  });
});
