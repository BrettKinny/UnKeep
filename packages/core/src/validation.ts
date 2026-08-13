export const MAX_NOTE_ID_LENGTH = 128;
const VALID_NOTE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validates a note ID. Throws if the ID is longer than 128 characters or
 * contains characters outside [a-zA-Z0-9_-].
 * Returns the ID if valid.
 */
export function validateNoteId(id: string): string {
  if (!VALID_NOTE_ID.test(id)) {
    throw new Error(
      `Invalid note ID. IDs must contain 1-${MAX_NOTE_ID_LENGTH} characters from [a-zA-Z0-9_-].`,
    );
  }
  return id;
}

/**
 * Tests whether a note ID is valid without throwing.
 */
export function isValidNoteId(id: string): boolean {
  return VALID_NOTE_ID.test(id);
}
