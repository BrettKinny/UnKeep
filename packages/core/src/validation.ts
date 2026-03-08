const VALID_NOTE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a note ID. Throws if the ID contains characters outside [a-zA-Z0-9_-].
 * Returns the ID if valid.
 */
export function validateNoteId(id: string): string {
  if (!VALID_NOTE_ID.test(id)) {
    throw new Error(`Invalid note ID: "${id}". IDs must match /^[a-zA-Z0-9_-]+$/.`);
  }
  return id;
}

/**
 * Tests whether a note ID is valid without throwing.
 */
export function isValidNoteId(id: string): boolean {
  return VALID_NOTE_ID.test(id);
}
