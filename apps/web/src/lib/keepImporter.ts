import { nanoid } from 'nanoid';
import type { Note, NoteColor, ChecklistItem } from '@unkeep/core';

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

  let content = '';
  if (keep.title && keep.textContent) {
    content = `${keep.title}\n\n${keep.textContent}`;
  } else if (keep.title) {
    content = keep.title;
  } else if (keep.textContent) {
    content = keep.textContent;
  }

  let checkboxes: ChecklistItem[] | undefined;
  if (keep.listContent && keep.listContent.length > 0) {
    checkboxes = keep.listContent.map(item => ({
      id: nanoid(),
      text: item.text,
      checked: item.isChecked,
    }));
    // If there's a title, put it in content; clear textContent from content
    if (keep.title) {
      content = keep.title;
    } else {
      content = '';
    }
  }

  return {
    id: nanoid(),
    content,
    createdAt: keep.createdTimestampUsec ? Math.floor(keep.createdTimestampUsec / 1000) : now,
    updatedAt: keep.userEditedTimestampUsec ? Math.floor(keep.userEditedTimestampUsec / 1000) : now,
    pinned: keep.isPinned ?? false,
    archived: keep.isArchived ?? false,
    color: mapColor(keep.color),
    checkboxes,
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

export async function parseKeepFiles(files: File[]): Promise<{ notes: Note[]; preview: ImportPreview }> {
  const notes: Note[] = [];

  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;
    try {
      const text = await file.text();
      const keepNote: KeepNote = JSON.parse(text);
      notes.push(convertKeepNote(keepNote));
    } catch {
      // Skip files that aren't valid Keep JSON
    }
  }

  const preview: ImportPreview = {
    total: notes.length,
    notes: notes.filter(n => !n.checkboxes).length,
    checklists: notes.filter(n => n.checkboxes && n.checkboxes.length > 0).length,
    pinned: notes.filter(n => n.pinned).length,
    archived: notes.filter(n => n.archived).length,
    trashed: notes.filter(n => n.deleted).length,
    samples: notes.slice(0, 5),
  };

  return { notes, preview };
}

export async function parseKeepZip(file: File): Promise<{ notes: Note[]; preview: ImportPreview }> {
  // Use JSZip-like approach with the browser's native decompression
  // We'll use a lightweight ZIP parser
  const buffer = await file.arrayBuffer();
  const files = await extractZipJsonFiles(buffer);
  return parseKeepFiles(files);
}

async function extractZipJsonFiles(buffer: ArrayBuffer): Promise<File[]> {
  // Parse via the central directory: local file headers cannot be trusted for
  // sizes — streamed zips (e.g. Google Takeout) write 0 there and put the real
  // sizes in a trailing data descriptor.
  const view = new DataView(buffer);
  const files: File[] = [];

  const eocd = findEndOfCentralDirectory(view);
  if (eocd === -1) return files;

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.byteLength) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break; // Central directory entry signature

    const compMethod = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
    const name = new TextDecoder().decode(nameBytes);
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name.endsWith('.json') || !(name.includes('Keep/') || name.includes('keep/'))) continue;

    // Name/extra lengths in the local header can differ from the central
    // directory's, so re-read them to locate the data.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const rawData = new Uint8Array(buffer, dataStart, compSize);

    let data: Uint8Array;
    if (compMethod === 8) {
      data = await inflateRaw(rawData);
    } else {
      data = rawData;
    }
    const filename = name.split('/').pop() || name;
    files.push(new File([data as BlobPart], filename, { type: 'application/json' }));
  }

  return files;
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
