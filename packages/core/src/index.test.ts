import { describe, expect, it } from 'vitest';
import {
  CURRENT_NOTE_SCHEMA_VERSION,
  LEGACY_LOCAL_DATABASE_NAME,
  localDatabaseName,
  normalizeNoteRecord,
} from './index.js';

describe('@unkeep/core public schema API', () => {
  it('exports note normalization and vault database naming', () => {
    expect(CURRENT_NOTE_SCHEMA_VERSION).toBe(1);
    expect(LEGACY_LOCAL_DATABASE_NAME).toBe('unkeep');
    expect(localDatabaseName({ vaultNamespace: 'public-vault' })).toBe('unkeep-vault-public-vault');
    expect(normalizeNoteRecord({
      id: 'legacy',
      content: '',
      createdAt: 1,
      updatedAt: 1,
    })).toMatchObject({ schemaVersion: 1, pinned: false, archived: false });
  });
});
