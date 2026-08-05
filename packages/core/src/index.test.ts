import { describe, expect, it } from 'vitest';
import {
  CURRENT_NOTE_SCHEMA_VERSION,
  normalizeNoteRecord,
} from './index.js';
import {
  LEGACY_LOCAL_DATABASE_NAME,
  localDatabaseName,
} from './experimental.js';

describe('@unkeep/core public schema API', () => {
  it('exports supported note normalization', () => {
    expect(CURRENT_NOTE_SCHEMA_VERSION).toBe(2);
    expect(normalizeNoteRecord({
      id: 'legacy',
      content: '',
      createdAt: 1,
      updatedAt: 1,
    })).toMatchObject({ schemaVersion: 2, pinned: false, archived: false });
  });

  it('keeps local adapter database naming on the experimental surface', () => {
    expect(LEGACY_LOCAL_DATABASE_NAME).toBe('unkeep');
    expect(localDatabaseName({ vaultNamespace: 'public-vault' }))
      .toBe('unkeep-vault-public-vault');
  });
});
