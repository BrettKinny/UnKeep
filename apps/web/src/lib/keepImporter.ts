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
  // Simple ZIP parser for JSON files
  const view = new DataView(buffer);
  const files: File[] = [];
  let offset = 0;

  while (offset < buffer.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const compMethod = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = new Uint8Array(buffer, offset + 30, nameLen);
    const name = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = new Uint8Array(buffer, dataStart, compSize);

    if (name.endsWith('.json') && (name.includes('Keep/') || name.includes('keep/'))) {
      let data: Uint8Array;
      if (compMethod === 8) {
        // Deflate — use DecompressionStream
        const ds = new DecompressionStream('raw');
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
        data = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) {
          data.set(chunk, pos);
          pos += chunk.length;
        }
      } else {
        data = rawData;
      }
      const filename = name.split('/').pop() || name;
      files.push(new File([data], filename, { type: 'application/json' }));
    }

    offset = dataStart + compSize;
  }

  return files;
}
