import type { Note } from './types.js';

export const CURRENT_NOTE_SCHEMA_VERSION = 1;

export class UnsupportedNoteSchemaVersionError extends Error {
  constructor(readonly version: number) {
    super(`Note schema version ${version} is newer than supported version ${CURRENT_NOTE_SCHEMA_VERSION}`);
    this.name = 'UnsupportedNoteSchemaVersionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRequiredFields(value: Record<string, unknown>): void {
  if (typeof value.id !== 'string' || !value.id) throw new Error('Invalid note record: id must be a non-empty string');
  if (typeof value.content !== 'string') throw new Error('Invalid note record: content must be a string');
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new Error('Invalid note record: createdAt must be a finite number');
  }
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    throw new Error('Invalid note record: updatedAt must be a finite number');
  }
}

export function normalizeNoteRecord(value: unknown): Note {
  if (!isRecord(value)) throw new Error('Invalid note record: expected an object');
  assertRequiredFields(value);

  const version = value.schemaVersion ?? 0;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new Error('Invalid note record: schemaVersion must be a non-negative safe integer');
  }
  if ((version as number) > CURRENT_NOTE_SCHEMA_VERSION) {
    throw new UnsupportedNoteSchemaVersionError(version as number);
  }

  return {
    ...value,
    schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
    pinned: typeof value.pinned === 'boolean' ? value.pinned : false,
    archived: typeof value.archived === 'boolean' ? value.archived : false,
  } as unknown as Note;
}
