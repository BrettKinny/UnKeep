import { describe, expect, it } from 'vitest';
import {
  CURRENT_NOTE_SCHEMA_VERSION,
  normalizeNoteRecord,
  UnsupportedNoteSchemaVersionError,
} from './noteMigrations.js';

describe('normalizeNoteRecord', () => {
  it('upgrades an unversioned legacy note without mutating the stored record', () => {
    const legacy = {
      id: 'legacy-note',
      content: 'Old but useful',
      createdAt: 100,
      updatedAt: 200,
    };

    expect(normalizeNoteRecord(legacy)).toEqual({
      ...legacy,
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
      pinned: false,
      archived: false,
    });
    expect(legacy).not.toHaveProperty('schemaVersion');
  });

  it('rejects a record written by a newer note schema', () => {
    expect(() => normalizeNoteRecord({
      schemaVersion: CURRENT_NOTE_SCHEMA_VERSION + 1,
      id: 'from-the-future',
      content: 'Do not downgrade me',
      createdAt: 100,
      updatedAt: 200,
      pinned: false,
      archived: false,
    })).toThrow(UnsupportedNoteSchemaVersionError);
  });
});
