import { nanoid } from 'nanoid';
import type { Note, NoteAttachment, NoteColor, ChecklistItem } from '@unkeep/core';
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
  return parseKeepSources(files.flatMap(file => {
    const path = normalizeArchivePath(file.webkitRelativePath || file.name);
    return path ? [{ path, file }] : [];
  }));
}

async function parseKeepSources(sources: ImportSource[]): Promise<KeepImportResult> {
  const notes: Note[] = [];
  const attachments: ImportedAttachment[] = [];

  for (const source of sources) {
    if (!source.path.toLowerCase().endsWith('.json')) continue;
    let keepNote: KeepNote;
    let note: Note;
    try {
      const text = await source.file.text();
      keepNote = JSON.parse(text);
      note = convertKeepNote(keepNote);
    } catch {
      // Skip files that aren't valid Keep JSON
      continue;
    }
    for (const keepAttachment of keepNote.attachments ?? []) {
      if (!keepAttachment.filePath) continue;
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
      const attachment: NoteAttachment = {
        id: nanoid(),
        name: basename(media.path),
        mimeType: attachmentMimeType(
          media.path,
          keepAttachment.mimetype || keepAttachment.mimeType,
          media.file.type,
        ),
        size: media.file.size,
      };
      note.images = [...(note.images ?? []), attachment];
      attachments.push({
        noteId: note.id,
        attachment,
        bytes: new Uint8Array(await media.file.arrayBuffer()),
      });
    }
    notes.push(note);
  }

  const preview = summarizeImport(notes);

  return { notes, attachments, preview };
}

export async function parseKeepZip(file: File): Promise<KeepImportResult> {
  // Use JSZip-like approach with the browser's native decompression
  // We'll use a lightweight ZIP parser
  const buffer = await file.arrayBuffer();
  const sources = await extractZipFiles(buffer);
  return parseKeepSources(sources.filter(source => isKeepArchivePath(source.path)));
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
  let offset = view.getUint32(eocd + 16, true);

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

    const nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
    const name = normalizeArchivePath(new TextDecoder().decode(nameBytes));
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || (compMethod !== 0 && compMethod !== 8)) continue;
    if (isKeepArchivePath(name)) {
      const sizeError = attachmentSizeError({ name: basename(name), size: uncompressedSize });
      if (sizeError) throw new Error(`Cannot import Google Keep ZIP entry ${name}: ${sizeError}`);
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
      data = await inflateRaw(rawData);
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

async function inflateRaw(rawData: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(rawData);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const data = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    data.set(chunk, pos);
    pos += chunk.length;
  }
  return data;
}
