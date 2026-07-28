import { isValidNoteId, normalizeNoteRecord, type Note, type NoteAttachment, type NoteColor } from '@unkeep/core';
import type { AttachmentStore } from './attachmentStorage';
import { attachmentSizeError } from './attachments';

const FORMAT = 'unkeep-vault';
const VERSION = 1;

interface SerializedAttachment {
  noteId: string;
  attachment: NoteAttachment;
  dataBase64: string;
}

interface SerializedVaultExport {
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  notes: Note[];
  attachments: SerializedAttachment[];
}

export interface ParsedVaultAttachment {
  noteId: string;
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface ParsedVaultExport {
  exportedAt: string;
  notes: Note[];
  attachments: ParsedVaultAttachment[];
}

function portableAttachment(attachment: NoteAttachment): NoteAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

function portableNote(note: Note): Note {
  return {
    ...note,
    ...(note.images
      ? { images: note.images.map(portableAttachment) }
      : {}),
  };
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttachment(value: unknown): value is NoteAttachment {
  return isRecord(value)
    && typeof value.id === 'string'
    && isValidNoteId(value.id)
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.mimeType === 'string'
    && typeof value.size === 'number'
    && Number.isSafeInteger(value.size)
    && value.size >= 0;
}

const noteColors = new Set<NoteColor>([
  'default', 'red', 'orange', 'yellow', 'green', 'teal',
  'blue', 'purple', 'pink', 'brown', 'gray',
]);

function isChecklistItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && isValidNoteId(value.id)
    && typeof value.text === 'string'
    && typeof value.checked === 'boolean';
}

function isNote(value: unknown): value is Note {
  return isRecord(value)
    && typeof value.id === 'string'
    && isValidNoteId(value.id)
    && (value.schemaVersion === undefined || (Number.isSafeInteger(value.schemaVersion) && (value.schemaVersion as number) >= 0))
    && (value.title === undefined || typeof value.title === 'string')
    && typeof value.content === 'string'
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && typeof value.pinned === 'boolean'
    && typeof value.archived === 'boolean'
    && (value.color === undefined || (typeof value.color === 'string' && noteColors.has(value.color as NoteColor)))
    && (value.checkboxes === undefined || (Array.isArray(value.checkboxes) && value.checkboxes.every(isChecklistItem)))
    && (value.labels === undefined || (Array.isArray(value.labels) && value.labels.every(label => typeof label === 'string')))
    && (value.deleted === undefined || typeof value.deleted === 'boolean')
    && (value.images === undefined
      || (Array.isArray(value.images) && value.images.every(isAttachment)));
}

/**
 * Create a complete, portable vault backup. Export fails if any referenced
 * attachment bytes are unavailable so users never receive a silently partial
 * recovery file.
 */
export async function createVaultExport(
  notes: Note[],
  attachmentStore: AttachmentStore,
  now: () => number = Date.now,
): Promise<string> {
  const attachments: SerializedAttachment[] = [];
  const attachmentIds = new Set<string>();
  let unavailable = 0;

  for (const note of notes) {
    for (const attachment of note.images ?? []) {
      if (attachmentIds.has(attachment.id)) {
        throw new Error(`Cannot export duplicate attachment ID: ${attachment.id}`);
      }
      attachmentIds.add(attachment.id);
      const stored = await attachmentStore.get(note.id, attachment.id);
      if (!stored) {
        unavailable++;
        continue;
      }
      const expected = portableAttachment(attachment);
      const actual = portableAttachment(stored.attachment);
      if (stored.bytes.byteLength !== expected.size
        || actual.id !== expected.id
        || actual.name !== expected.name
        || actual.mimeType !== expected.mimeType
        || actual.size !== expected.size) {
        throw new Error(`Cannot export invalid attachment: ${attachment.name}`);
      }
      attachments.push({
        noteId: note.id,
        attachment: expected,
        dataBase64: toBase64(stored.bytes),
      });
    }
  }

  if (unavailable > 0) {
    const noun = unavailable === 1 ? 'attachment' : 'attachments';
    throw new Error(`Cannot export ${unavailable} unavailable ${noun}`);
  }

  const backup: SerializedVaultExport = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date(now()).toISOString(),
    notes: notes.map(portableNote),
    attachments,
  };
  return JSON.stringify(backup, null, 2);
}

export function parseVaultExport(serialized: string): ParsedVaultExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Invalid UnKeep vault export: malformed JSON');
  }

  if (!isRecord(parsed)
    || parsed.format !== FORMAT
    || parsed.version !== VERSION
    || typeof parsed.exportedAt !== 'string'
    || !Array.isArray(parsed.notes)
    || !parsed.notes.every(isNote)
    || !Array.isArray(parsed.attachments)) {
    throw new Error('Invalid or unsupported UnKeep vault export');
  }

  // Validate the declared schema version before any attachment bytes or notes
  // are written. The import boundary remains all-or-nothing for unsupported data.
  for (const note of parsed.notes) normalizeNoteRecord(note);

  const noteIds = new Set<string>();
  const expectedAttachments = new Map<string, { noteId: string; attachment: NoteAttachment }>();
  for (const note of parsed.notes) {
    if (noteIds.has(note.id)) throw new Error(`Invalid UnKeep vault export: duplicate note ID ${note.id}`);
    noteIds.add(note.id);
    for (const attachment of note.images ?? []) {
      const sizeError = attachmentSizeError(attachment);
      if (sizeError) throw new Error(`Cannot restore UnKeep vault: ${sizeError}`);
      if (expectedAttachments.has(attachment.id)) {
        throw new Error(`Invalid UnKeep vault export: duplicate attachment ID ${attachment.id}`);
      }
      expectedAttachments.set(attachment.id, { noteId: note.id, attachment: portableAttachment(attachment) });
    }
  }

  const importedAttachmentIds = new Set<string>();
  const attachments = parsed.attachments.map((value): ParsedVaultAttachment => {
    if (!isRecord(value)
      || typeof value.noteId !== 'string'
      || !isAttachment(value.attachment)
      || typeof value.dataBase64 !== 'string') {
      throw new Error('Invalid attachment in UnKeep vault export');
    }

    const expected = expectedAttachments.get(value.attachment.id);
    if (!expected || expected.noteId !== value.noteId) {
      throw new Error(`Invalid UnKeep vault export: orphaned attachment data for ${value.attachment.id}`);
    }
    if (importedAttachmentIds.has(value.attachment.id)) {
      throw new Error(`Invalid UnKeep vault export: duplicate attachment data for ${value.attachment.id}`);
    }
    const actualAttachment = portableAttachment(value.attachment);
    if (actualAttachment.name !== expected.attachment.name
      || actualAttachment.mimeType !== expected.attachment.mimeType
      || actualAttachment.size !== expected.attachment.size) {
      throw new Error(`Invalid UnKeep vault export: attachment metadata mismatch for ${value.attachment.id}`);
    }
    importedAttachmentIds.add(value.attachment.id);

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64(value.dataBase64);
    } catch {
      throw new Error('Invalid attachment data in UnKeep vault export');
    }
    if (bytes.byteLength !== value.attachment.size) {
      throw new Error(`Attachment size mismatch for ${value.attachment.name}`);
    }
    return {
      noteId: value.noteId,
      attachment: portableAttachment(value.attachment),
      bytes,
    };
  });

  for (const attachmentId of expectedAttachments.keys()) {
    if (!importedAttachmentIds.has(attachmentId)) {
      throw new Error(`Invalid UnKeep vault export: missing attachment data for ${attachmentId}`);
    }
  }

  return {
    exportedAt: parsed.exportedAt,
    notes: parsed.notes.map(portableNote),
    attachments,
  };
}
