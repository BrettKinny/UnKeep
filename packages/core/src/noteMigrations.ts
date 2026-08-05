import type { ChecklistItem, Note, NoteAttachment, NoteColor } from './types.js';
import { isValidNoteId } from './validation.js';

export const CURRENT_NOTE_SCHEMA_VERSION = 2;
export const MAX_NOTE_TITLE_LENGTH = 10_000;
export const MAX_NOTE_CONTENT_LENGTH = 1_000_000;
export const MAX_NOTE_TEXT_LENGTH = 1_000_000;
export const MAX_CHECKLIST_ITEMS = 10_000;
export const MAX_CHECKLIST_ITEM_TEXT_LENGTH = 1_000_000;
export const MAX_NOTE_LABELS = 1_000;
export const MAX_NOTE_LABEL_LENGTH = 1_024;
export const MAX_NOTE_ATTACHMENTS = 1_000;
export const MAX_NOTE_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_LENGTH = 1_024;
export const MAX_ATTACHMENT_MIME_TYPE_LENGTH = 255;

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
  if (typeof value.id !== 'string' || !isValidNoteId(value.id)) {
    throw new Error('Invalid note record: id must be a route-safe identifier');
  }
  if (typeof value.content !== 'string') throw new Error('Invalid note record: content must be a string');
  if (value.content.length > MAX_NOTE_CONTENT_LENGTH) {
    throw new Error(`Invalid note record: content exceeds ${MAX_NOTE_CONTENT_LENGTH} characters`);
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new Error('Invalid note record: createdAt must be a finite number');
  }
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    throw new Error('Invalid note record: updatedAt must be a finite number');
  }
}

const NOTE_COLORS = new Set<NoteColor>([
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
  'gray',
]);

function optionalString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid note record: ${field} must be a string`);
  if (value.length > maximumLength) {
    throw new Error(`Invalid note record: ${field} exceeds ${maximumLength} characters`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Invalid note record: ${field} must be a boolean`);
  return value;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid note record: ${field} must be a non-negative finite number`);
  }
  return value;
}

function normalizeChecklistItems(value: unknown): ChecklistItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid note record: checkboxes must be an array');
  if (value.length > MAX_CHECKLIST_ITEMS) {
    throw new Error(`Invalid note record: checkboxes exceeds ${MAX_CHECKLIST_ITEMS} items`);
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || !isValidNoteId(item.id)
      || typeof item.text !== 'string'
      || item.text.length > MAX_CHECKLIST_ITEM_TEXT_LENGTH
      || typeof item.checked !== 'boolean') {
      throw new Error(`Invalid note record: checkboxes[${index}] must be a checklist item`);
    }
    if (ids.has(item.id)) {
      throw new Error(`Invalid note record: duplicate checklist item ID ${item.id}`);
    }
    ids.add(item.id);
    return { id: item.id, text: item.text, checked: item.checked };
  });
}

function normalizeLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)
    || value.length > MAX_NOTE_LABELS
    || value.some(label => typeof label !== 'string' || label.length > MAX_NOTE_LABEL_LENGTH)) {
    throw new Error('Invalid note record: labels must be an array of strings');
  }
  return [...value] as string[];
}

function normalizeAttachments(value: unknown): NoteAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid note record: images must be an array');
  if (value.length > MAX_NOTE_ATTACHMENTS) {
    throw new Error(`Invalid note record: images exceeds ${MAX_NOTE_ATTACHMENTS} attachments`);
  }
  const ids = new Set<string>();
  return value.map((attachment, index) => {
    if (!isRecord(attachment)
      || typeof attachment.id !== 'string'
      || !isValidNoteId(attachment.id)
      || typeof attachment.name !== 'string'
      || !attachment.name
      || attachment.name.length > MAX_ATTACHMENT_NAME_LENGTH
      || typeof attachment.mimeType !== 'string'
      || !attachment.mimeType
      || attachment.mimeType.length > MAX_ATTACHMENT_MIME_TYPE_LENGTH
      || typeof attachment.size !== 'number'
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || attachment.size > MAX_NOTE_ATTACHMENT_SIZE) {
      throw new Error(`Invalid note record: images[${index}] must be portable attachment metadata`);
    }
    if (ids.has(attachment.id)) {
      throw new Error(`Invalid note record: duplicate attachment ID ${attachment.id}`);
    }
    ids.add(attachment.id);
    // Attachment URLs are local capabilities. They are deliberately never
    // accepted from persistence, imports, agents, or decrypted relay records.
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  });
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

  const pinned = optionalBoolean(value.pinned, 'pinned') ?? false;
  const archived = optionalBoolean(value.archived, 'archived') ?? false;
  const title = optionalString(value.title, 'title', MAX_NOTE_TITLE_LENGTH);
  const checkboxes = normalizeChecklistItems(value.checkboxes);
  const labels = normalizeLabels(value.labels);
  const images = normalizeAttachments(value.images);
  const trashedAt = optionalTimestamp(value.trashedAt, 'trashedAt');
  const deleted = optionalBoolean(value.deleted, 'deleted');
  if (deleted && trashedAt !== undefined) {
    throw new Error('Invalid note record: permanently deleted notes cannot remain in Trash');
  }
  const textLength = (value.content as string).length
    + (title?.length ?? 0)
    + (checkboxes?.reduce((total, item) => total + item.text.length, 0) ?? 0)
    + (labels?.reduce((total, label) => total + label.length, 0) ?? 0);
  if (textLength > MAX_NOTE_TEXT_LENGTH) {
    throw new Error(`Invalid note record: aggregate text exceeds ${MAX_NOTE_TEXT_LENGTH} characters`);
  }
  if (value.color !== undefined
    && (typeof value.color !== 'string' || !NOTE_COLORS.has(value.color as NoteColor))) {
    throw new Error('Invalid note record: color is not supported');
  }

  const note: Note = {
    schemaVersion: CURRENT_NOTE_SCHEMA_VERSION,
    id: value.id as string,
    content: value.content as string,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    pinned,
    archived,
  };
  // Preserve explicit undefined on known optional fields for compatibility
  // with callers that distinguish it from an absent own property.
  if (Object.hasOwn(value, 'title')) note.title = title;
  if (Object.hasOwn(value, 'color')) note.color = value.color as NoteColor | undefined;
  if (Object.hasOwn(value, 'checkboxes')) note.checkboxes = checkboxes;
  if (Object.hasOwn(value, 'labels')) note.labels = labels;
  if (Object.hasOwn(value, 'images')) note.images = images;
  if (Object.hasOwn(value, 'trashedAt')) note.trashedAt = trashedAt;
  if (Object.hasOwn(value, 'deleted')) note.deleted = deleted;
  return note;
}
