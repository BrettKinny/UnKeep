import { nanoid } from 'nanoid';
import {
  MAX_ATTACHMENT_MIME_TYPE_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_ITEM_TEXT_LENGTH,
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_LABEL_LENGTH,
  MAX_NOTE_LABELS,
  MAX_NOTE_TEXT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  normalizeNoteRecord,
  type ChecklistItem,
  type Note,
  type NoteAttachment,
  type NoteColor,
} from '@unkeep/core';
import { attachmentSizeError } from './attachments';

interface KeepAttachment {
  filePath?: string;
  mimetype?: string;
  mimeType?: string;
}

interface KeepNote {
  color?: string;
  isTrashed?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  textContent?: string;
  title?: string;
  userEditedTimestampUsec?: number;
  createdTimestampUsec?: number;
  listContent?: { text: string; isChecked: boolean }[];
  attachments?: KeepAttachment[];
  labels?: { name?: string }[];
}

interface ImportSource {
  path: string;
  file: File;
}

export interface ImportedAttachment {
  noteId: string;
  attachment: NoteAttachment;
  bytes: Uint8Array<ArrayBuffer>;
}

const colorMap: Record<string, NoteColor> = {
  DEFAULT: 'default',
  RED: 'red',
  ORANGE: 'orange',
  YELLOW: 'yellow',
  GREEN: 'green',
  TEAL: 'teal',
  BLUE: 'blue',
  PURPLE: 'purple',
  PINK: 'pink',
  BROWN: 'brown',
  GRAY: 'gray',
  CERULEAN: 'blue',
  WHITE: 'default',
};

export const MAX_KEEP_JSON_SIZE = 4 * 1024 * 1024;
export const MAX_KEEP_IMPORT_FILES = 10_000;
export const MAX_KEEP_IMPORT_BYTES = 512 * 1024 * 1024;
export const MAX_KEEP_ATTACHMENT_REFERENCES = 10_000;
export const MAX_KEEP_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MAX_ZIP_SIZE = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_UNCOMPRESSED_SIZE = 512 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 200;

function mapColor(keepColor?: string): NoteColor {
  if (!keepColor) return 'default';
  return colorMap[keepColor.toUpperCase()] ?? 'default';
}

function convertKeepNote(keep: KeepNote): Note {
  const now = Date.now();
  let content = keep.textContent ?? '';
  const labels = [...new Set((keep.labels ?? []).map(label => label.name?.trim()).filter((name): name is string => Boolean(name)))];

  let checkboxes: ChecklistItem[] | undefined;
  if (keep.listContent && keep.listContent.length > 0) {
    checkboxes = keep.listContent.map(item => ({
      id: nanoid(),
      text: item.text,
      checked: item.isChecked,
    }));
    content = '';
  }

  return {
    id: nanoid(),
    title: keep.title || undefined,
    content,
    createdAt: keep.createdTimestampUsec ? Math.floor(keep.createdTimestampUsec / 1000) : now,
    updatedAt: keep.userEditedTimestampUsec ? Math.floor(keep.userEditedTimestampUsec / 1000) : now,
    pinned: keep.isPinned ?? false,
    archived: keep.isArchived ?? false,
    color: mapColor(keep.color),
    checkboxes,
    labels: labels.length ? labels : undefined,
    deleted: keep.isTrashed ? true : undefined,
  };
}

export interface ImportPreview {
  total: number;
  notes: number;
  checklists: number;
  pinned: number;
  archived: number;
  trashed: number;
  samples: Note[];
}

export interface KeepImportResult {
  notes: Note[];
  attachments: ImportedAttachment[];
  preview: ImportPreview;
}

export function summarizeImport(notes: Note[]): ImportPreview {
  return {
    total: notes.length,
    notes: notes.filter(n => !n.checkboxes).length,
    checklists: notes.filter(n => n.checkboxes && n.checkboxes.length > 0).length,
    pinned: notes.filter(n => n.pinned).length,
    archived: notes.filter(n => n.archived).length,
    trashed: notes.filter(n => n.deleted).length,
    samples: notes.slice(0, 5),
  };
}

export async function parseKeepFiles(files: File[]): Promise<KeepImportResult> {
  assertRawImportBounds(files);
  return parseKeepSources(files.flatMap(file => {
    const path = normalizeArchivePath(file.webkitRelativePath || file.name);
    return path ? [{ path, file }] : [];
  }));
}

async function parseKeepSources(sources: ImportSource[]): Promise<KeepImportResult> {
  const notes: Note[] = [];
  const attachments: ImportedAttachment[] = [];
  const loadedMedia = new Map<ImportSource, Uint8Array<ArrayBuffer>>();
  let attachmentReferences = 0;
  let loadedAttachmentBytes = 0;

  for (const source of sources) {
    if (!source.path.toLowerCase().endsWith('.json')) continue;
    if (source.file.size > MAX_KEEP_JSON_SIZE) {
      throw new Error(
        `Google Keep note ${source.path} is too large. Note JSON files must be 4 MiB or smaller.`,
      );
    }
    let keepNote: KeepNote;
    try {
      const text = await source.file.text();
      keepNote = JSON.parse(text);
    } catch {
      // Skip files that aren't valid Keep JSON
      continue;
    }
    assertKeepNoteBounds(keepNote, source.path);
    const note = convertKeepNote(keepNote);
    for (const keepAttachment of keepNote.attachments ?? []) {
      if (!keepAttachment.filePath) continue;
      attachmentReferences++;
      if (attachmentReferences > MAX_KEEP_ATTACHMENT_REFERENCES) {
        throw new Error(
          `Google Keep import references too many attachments. The limit is ${MAX_KEEP_ATTACHMENT_REFERENCES}.`,
        );
      }
      const media = findAttachmentSource(sources, source.path, keepAttachment.filePath);
      if (!media) {
        throw new Error(
          `Incomplete Google Keep import: ${source.path} references missing media "${keepAttachment.filePath}"`,
        );
      }
      const sizeError = attachmentSizeError(media.file);
      if (sizeError) {
        throw new Error(`Cannot import Google Keep attachment referenced by ${source.path}: ${sizeError}`);
      }
      const attachmentName = basename(media.path);
      const mimeType = attachmentMimeType(
        media.path,
        keepAttachment.mimetype || keepAttachment.mimeType,
        media.file.type,
      );
      if (attachmentName.length > MAX_ATTACHMENT_NAME_LENGTH) {
        throw new Error(`Cannot import Google Keep attachment referenced by ${source.path}: filename is too long`);
      }
      if (mimeType.length > MAX_ATTACHMENT_MIME_TYPE_LENGTH) {
        throw new Error(`Cannot import Google Keep attachment referenced by ${source.path}: media type is too long`);
      }
      const attachment: NoteAttachment = {
        id: nanoid(),
        name: attachmentName,
        mimeType,
        size: media.file.size,
      };
      note.images = [...(note.images ?? []), attachment];
      let bytes = loadedMedia.get(media);
      if (!bytes) {
        loadedAttachmentBytes += media.file.size;
        if (loadedAttachmentBytes > MAX_KEEP_ATTACHMENT_BYTES) {
          throw new Error('Google Keep attachments exceed the 512 MiB import limit.');
        }
        bytes = new Uint8Array(await media.file.arrayBuffer());
        loadedMedia.set(media, bytes);
      }
      attachments.push({
        noteId: note.id,
        attachment,
        bytes,
      });
    }
    // Keep data is untrusted even after JSON parsing. Apply the same portable
    // record boundary used for decrypted relay notes and CLI input.
    normalizeNoteRecord(note);
    notes.push(note);
  }

  const preview = summarizeImport(notes);

  return { notes, attachments, preview };
}

export async function parseKeepZip(file: File): Promise<KeepImportResult> {
  if (file.size > MAX_ZIP_SIZE) {
    throw new Error('Google Takeout ZIP is too large. Archives must be 256 MiB or smaller.');
  }
  const buffer = await file.arrayBuffer();
  const sources = await extractZipFiles(buffer);
  return parseKeepSources(sources.filter(source => isKeepArchivePath(source.path)));
}

function assertRawImportBounds(files: File[]): void {
  if (files.length > MAX_KEEP_IMPORT_FILES) {
    throw new Error(`Google Keep import has too many files. The limit is ${MAX_KEEP_IMPORT_FILES}.`);
  }
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_KEEP_IMPORT_BYTES) {
      throw new Error('Google Keep import exceeds the 512 MiB file limit.');
    }
  }
}

function assertKeepNoteBounds(value: KeepNote, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Google Keep note: ${path}`);
  }
  if (typeof value.title === 'string' && value.title.length > MAX_NOTE_TITLE_LENGTH) {
    throw new Error(`Google Keep note ${path} has an oversized title.`);
  }
  if (value.listContent !== undefined) {
    if (!Array.isArray(value.listContent) || value.listContent.length > MAX_CHECKLIST_ITEMS) {
      throw new Error(`Google Keep note ${path} has too many checklist items.`);
    }
    if (value.listContent.some(item =>
      !item
      || typeof item.text !== 'string'
      || item.text.length > MAX_CHECKLIST_ITEM_TEXT_LENGTH
      || typeof item.isChecked !== 'boolean')) {
      throw new Error(`Google Keep note ${path} has an invalid checklist.`);
    }
  }
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels) || value.labels.length > MAX_NOTE_LABELS) {
      throw new Error(`Google Keep note ${path} has too many labels.`);
    }
    if (value.labels.some(label =>
      !label
      || (label.name !== undefined
        && (typeof label.name !== 'string' || label.name.length > MAX_NOTE_LABEL_LENGTH)))) {
      throw new Error(`Google Keep note ${path} has an invalid label.`);
    }
  }
  if (value.attachments !== undefined
    && (!Array.isArray(value.attachments) || value.attachments.length > MAX_NOTE_ATTACHMENTS)) {
    throw new Error(`Google Keep note ${path} has too many attachments.`);
  }
  const outputTextLength = (value.title?.length ?? 0)
    + (value.listContent?.length
      ? value.listContent.reduce((total, item) => total + item.text.length, 0)
      : (value.textContent?.length ?? 0))
    + (value.labels?.reduce((total, label) => total + (label.name?.trim().length ?? 0), 0) ?? 0);
  if (outputTextLength > MAX_NOTE_TEXT_LENGTH) {
    throw new Error(`Google Keep note ${path} exceeds the note text limit.`);
  }
}

async function extractZipFiles(buffer: ArrayBuffer): Promise<ImportSource[]> {
  // Parse via the central directory: local file headers cannot be trusted for
  // sizes — streamed zips (e.g. Google Takeout) write 0 there and put the real
  // sizes in a trailing data descriptor.
  const view = new DataView(buffer);
  const files: ImportSource[] = [];

  const eocd = findEndOfCentralDirectory(view);
  if (eocd === -1) return files;

  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`Google Takeout ZIP has too many entries. The limit is ${MAX_ZIP_ENTRIES}.`);
  }
  let offset = view.getUint32(eocd + 16, true);
  let totalUncompressedSize = 0;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.byteLength) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break; // Central directory entry signature

    const compMethod = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const nextOffset = offset + 46 + nameLen + extraLen + commentLen;
    if (nextOffset > buffer.byteLength) {
      throw new Error('Invalid Google Takeout ZIP central directory');
    }
    const nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
    const name = normalizeArchivePath(new TextDecoder().decode(nameBytes));
    offset = nextOffset;

    if (!name || name.endsWith('/') || (compMethod !== 0 && compMethod !== 8)) continue;
    // Takeout exports can contain many unrelated products. Never inflate files
    // outside a Keep directory.
    if (!isKeepArchivePath(name)) continue;

    if (name.toLowerCase().endsWith('.json') && uncompressedSize > MAX_KEEP_JSON_SIZE) {
      throw new Error(
        `Google Keep note ${name} is too large. Note JSON files must be 4 MiB or smaller.`,
      );
    }
    const sizeError = attachmentSizeError({ name: basename(name), size: uncompressedSize });
    if (sizeError) throw new Error(`Cannot import Google Keep ZIP entry ${name}: ${sizeError}`);
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_ZIP_UNCOMPRESSED_SIZE) {
      throw new Error('Google Takeout ZIP expands beyond the 512 MiB import limit.');
    }
    if (
      uncompressedSize > 0
      && (compSize === 0 || uncompressedSize / compSize > MAX_ZIP_COMPRESSION_RATIO)
    ) {
      throw new Error(`Google Takeout ZIP entry ${name} has an unsafe compression ratio.`);
    }
    if (localOffset + 30 > buffer.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) continue;

    // Name/extra lengths in the local header can differ from the central
    // directory's, so re-read them to locate the data.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buffer.byteLength) continue;
    const rawData = new Uint8Array(buffer, dataStart, compSize);

    let data: Uint8Array;
    if (compMethod === 8) {
      data = await inflateRaw(rawData, uncompressedSize, name);
    } else {
      data = rawData;
    }
    if (data.byteLength !== uncompressedSize) {
      throw new Error(
        `Invalid Google Takeout ZIP entry ${name}: declared ${uncompressedSize} bytes but extracted ${data.byteLength}`,
      );
    }
    files.push({ path: name, file: new File([data as BlobPart], basename(name)) });
  }

  return files;
}

function normalizeArchivePath(path: string): string | null {
  const value = path.replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.includes('\0')) return null;
  const segments = value.split('/').filter(segment => segment && segment !== '.');
  if (segments.some(segment => segment === '..')) return null;
  return segments.join('/');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function attachmentMimeType(path: string, declared?: string, browserType?: string): string {
  const explicit = declared?.trim();
  if (explicit && explicit !== 'application/octet-stream') return explicit;
  if (browserType) return browserType;
  const extension = basename(path).toLowerCase().split('.').pop() ?? '';
  const inferred: Record<string, string> = {
    avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
    jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
  };
  return inferred[extension] ?? explicit ?? 'application/octet-stream';
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function isKeepArchivePath(path: string): boolean {
  return path.toLowerCase().split('/').includes('keep');
}

function findAttachmentSource(sources: ImportSource[], notePath: string, reference: string): ImportSource | undefined {
  const safeReference = normalizeArchivePath(reference);
  if (!safeReference) return undefined;
  const relativePath = normalizeArchivePath(`${dirname(notePath)}/${safeReference}`);
  const direct = sources.find(source => source.path === relativePath || source.path === safeReference);
  if (direct) return direct;

  // A browser FileList can lose directory information. Only fall back to a
  // basename when it identifies exactly one file, avoiding cross-note mixups.
  const matches = sources.filter(source => basename(source.path) === basename(safeReference));
  return matches.length === 1 ? matches[0] : undefined;
}

function findEndOfCentralDirectory(view: DataView): number {
  // EOCD is at the very end of the file, preceded only by an optional comment
  // of up to 65535 bytes.
  const min = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(
  rawData: Uint8Array<ArrayBuffer>,
  maximumBytes: number,
  entryName: string,
): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writing = (async () => {
    await writer.write(rawData);
    await writer.close();
  })();
  // Cancellation on an oversized or malformed entry can reject the writer
  // before the reader's error path awaits it.
  void writing.catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLen += value.length;
      if (totalLen > maximumBytes) {
        throw new Error(
          `Invalid Google Takeout ZIP entry ${entryName}: extracted data exceeds its declared size`,
        );
      }
      chunks.push(value);
    }
    await writing;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writing.catch(() => undefined);
    throw error;
  }
  const data = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    data.set(chunk, pos);
    pos += chunk.length;
  }
  return data;
}
