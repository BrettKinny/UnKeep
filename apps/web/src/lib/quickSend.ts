import {
  normalizeNoteRecord,
  type ChecklistItem,
  type Note,
  type NoteColor,
} from '@unkeep/core';

const MAX_SHARE_BYTES = 102_400;
const MAX_DECODED_BYTES = MAX_SHARE_BYTES;
const QUICK_SEND_FORMAT = 'unkeep-quick-send';
const QUICK_SEND_VERSION = 1;

export interface QuickSendNote {
  version: typeof QUICK_SEND_VERSION;
  title?: string;
  content: string;
  checkboxes?: ChecklistItem[];
  labels?: string[];
  color?: NoteColor;
  attachments?: QuickSendAttachment[];
}

export type QuickSendDraft = Omit<QuickSendNote, 'version'>;

export interface QuickSendAttachment {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array<ArrayBuffer>;
}

interface SerializedQuickSendAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

interface QuickSendEnvelope extends Omit<QuickSendNote, 'attachments'> {
  format: typeof QUICK_SEND_FORMAT;
  attachments?: SerializedQuickSendAttachment[];
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function compressText(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  if (data.byteLength > MAX_SHARE_BYTES) {
    throw new Error('Note is too large to share via Quick Send (max 100KB)');
  }

  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const writing = writer.write(data).then(() => writer.close());
  // Attach a rejection observer immediately; the reader may fail or cancel
  // before this promise is awaited.
  void writing.catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
    await writing;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writing.catch(() => undefined);
    throw error;
  }

  const compressed = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, position);
    position += chunk.length;
  }
  return bytesToBase64Url(compressed);
}

async function decompressText(encoded: string): Promise<string> {
  // A valid 100KB payload cannot approach this URL length. Reject obvious
  // resource-exhaustion input before allocating or invoking decompression.
  if (encoded.length > MAX_DECODED_BYTES * 2) {
    throw new Error('Quick Send URL is too large');
  }

  const compressed = base64UrlToBytes(encoded);
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const writing = writer.write(compressed).then(() => writer.close());
  void writing.catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.length;
      if (totalLength > MAX_DECODED_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Decoded note exceeds the 100KB Quick Send limit');
      }
      chunks.push(value);
    }
    await writing;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writing.catch(() => undefined);
    throw error;
  }

  const data = new Uint8Array(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    data.set(chunk, position);
    position += chunk.length;
  }
  return new TextDecoder().decode(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeQuickSendFields(
  value: Record<string, unknown>,
  attachments: readonly Pick<SerializedQuickSendAttachment, 'name' | 'mimeType' | 'size'>[] | undefined,
): Note {
  return normalizeNoteRecord({
    id: 'quick_send_preview',
    content: value.content,
    createdAt: 0,
    updatedAt: 0,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.checkboxes !== undefined ? { checkboxes: value.checkboxes } : {}),
    ...(value.labels !== undefined ? { labels: value.labels } : {}),
    ...(value.color !== undefined ? { color: value.color } : {}),
    ...(attachments !== undefined
      ? {
          images: attachments.map((attachment, index) => ({
            id: `quick_send_attachment_${index}`,
            name: attachment.name,
            mimeType: attachment.mimeType || 'application/octet-stream',
            size: attachment.size,
          })),
        }
      : {}),
  });
}

function parseEnvelope(value: unknown): QuickSendNote {
  if (!isRecord(value)
    || value.format !== QUICK_SEND_FORMAT
    || value.version !== QUICK_SEND_VERSION
    || (value.attachments !== undefined
      && (!Array.isArray(value.attachments)
        || value.attachments.length > 20
        || !value.attachments.every(attachment =>
          isRecord(attachment)
          && typeof attachment.name === 'string'
          && attachment.name.length > 0
          && attachment.name.length <= 255
          && typeof attachment.mimeType === 'string'
          && attachment.mimeType.length <= 255
          && typeof attachment.size === 'number'
          && Number.isSafeInteger(attachment.size)
          && attachment.size >= 0
          && typeof attachment.dataBase64 === 'string')))
  ) {
    throw new Error('Invalid or unsupported Quick Send note');
  }

  const serializedAttachments = value.attachments as SerializedQuickSendAttachment[] | undefined;
  let normalized: Note;
  try {
    normalized = normalizeQuickSendFields(value, serializedAttachments);
  } catch {
    throw new Error('Invalid or unsupported Quick Send note');
  }

  const attachments = serializedAttachments?.map(attachment => {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64ToBytes(attachment.dataBase64);
    } catch {
      throw new Error('Invalid attachment data in Quick Send note');
    }
    if (bytes.byteLength !== attachment.size) {
      throw new Error(`Attachment size mismatch for ${attachment.name}`);
    }
    return {
      name: attachment.name,
      mimeType: attachment.mimeType || 'application/octet-stream',
      size: attachment.size,
      bytes,
    };
  });

  return {
    version: QUICK_SEND_VERSION,
    ...(normalized.title !== undefined ? { title: normalized.title } : {}),
    content: normalized.content,
    ...(normalized.checkboxes !== undefined ? { checkboxes: normalized.checkboxes } : {}),
    ...(normalized.labels !== undefined ? { labels: normalized.labels } : {}),
    ...(normalized.color !== undefined ? { color: normalized.color } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** Encode a legacy text-only Quick Send link. */
export async function encodeNote(content: string): Promise<string> {
  return compressText(content);
}

/** Decode the text carried by a legacy Quick Send link. */
export async function decodeNote(encoded: string): Promise<string> {
  return decompressText(encoded);
}

/** Encode the portable fields needed to faithfully recreate a note. */
export async function encodeQuickSendNote(note: QuickSendDraft): Promise<string> {
  const attachments = note.attachments?.map(attachment => {
    if (!(attachment.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || attachment.bytes.byteLength !== attachment.size) {
      throw new Error(`Invalid Quick Send attachment: ${attachment.name}`);
    }
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      dataBase64: bytesToBase64(attachment.bytes),
    };
  });
  let normalized: Note;
  try {
    normalized = normalizeQuickSendFields(
      note as unknown as Record<string, unknown>,
      attachments,
    );
  } catch {
    throw new Error('Invalid Quick Send note');
  }
  const envelope: QuickSendEnvelope = {
    format: QUICK_SEND_FORMAT,
    version: QUICK_SEND_VERSION,
    ...(normalized.title ? { title: normalized.title } : {}),
    content: normalized.content,
    ...(normalized.checkboxes?.length ? { checkboxes: normalized.checkboxes } : {}),
    ...(normalized.labels?.length ? { labels: normalized.labels } : {}),
    ...(normalized.color ? { color: normalized.color } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
  return compressText(JSON.stringify(envelope));
}

/** Decode current structured links while retaining old text-only link support. */
export async function decodeQuickSendNote(encoded: string): Promise<QuickSendNote> {
  const decoded = await decompressText(encoded);
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return { version: QUICK_SEND_VERSION, content: decoded };
  }
  if (isRecord(value) && value.format === QUICK_SEND_FORMAT) return parseEnvelope(value);
  return { version: QUICK_SEND_VERSION, content: decoded };
}

export function getShareUrl(encoded: string): string {
  return `${window.location.origin}/recv#${encoded}`;
}
