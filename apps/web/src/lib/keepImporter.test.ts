import { describe, it, expect, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  MAX_CHECKLIST_ITEMS,
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_LABELS,
  MAX_NOTE_TEXT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
} from '@unkeep/core';
import { MAX_ATTACHMENT_SIZE } from './attachments';

// Mock nanoid before importing the module
vi.mock('nanoid', () => {
  let counter = 0;
  return {
    nanoid: () => `mock-id-${counter++}`,
  };
});

// Import after mock setup
const {
  MAX_KEEP_IMPORT_BYTES,
  MAX_KEEP_IMPORT_FILES,
  MAX_KEEP_ATTACHMENT_REFERENCES,
  MAX_KEEP_JSON_SIZE,
  parseKeepFiles,
} = await import('./keepImporter.js');

function makeFile(name: string, content: object): File {
  return new File([JSON.stringify(content)], name, { type: 'application/json' });
}

describe('parseKeepFiles', () => {
  it('parses a simple text note', async () => {
    const files = [makeFile('note.json', {
      textContent: 'Hello world',
      userEditedTimestampUsec: 1700000000000000,
      createdTimestampUsec: 1699000000000000,
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('Hello world');
    expect(notes[0].updatedAt).toBe(1700000000000);
    expect(notes[0].createdAt).toBe(1699000000000);
  });

  it('preserves a Keep title separately from the note body', async () => {
    const files = [makeFile('note.json', {
      title: 'My Title',
      textContent: 'Body text',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].title).toBe('My Title');
    expect(notes[0].content).toBe('Body text');
  });

  it('handles title-only note', async () => {
    const files = [makeFile('note.json', {
      title: 'Just a title',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].title).toBe('Just a title');
    expect(notes[0].content).toBe('');
  });

  it('handles content-only note', async () => {
    const files = [makeFile('note.json', {
      textContent: 'Just content',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].content).toBe('Just content');
  });

  it('preserves Keep labels without duplicates or blank names', async () => {
    const files = [makeFile('note.json', {
      textContent: 'Labelled',
      labels: [{ name: 'work' }, { name: 'work' }, { name: ' ' }, { name: 'ideas' }],
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].labels).toEqual(['work', 'ideas']);
  });

  it('converts checklist notes', async () => {
    const files = [makeFile('note.json', {
      title: 'Shopping',
      listContent: [
        { text: 'Milk', isChecked: false },
        { text: 'Bread', isChecked: true },
      ],
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].title).toBe('Shopping');
    expect(notes[0].content).toBe('');
    expect(notes[0].checkboxes).toHaveLength(2);
    expect(notes[0].checkboxes![0].text).toBe('Milk');
    expect(notes[0].checkboxes![0].checked).toBe(false);
    expect(notes[0].checkboxes![1].text).toBe('Bread');
    expect(notes[0].checkboxes![1].checked).toBe(true);
  });

  it('maps colors correctly', async () => {
    const tests = [
      ['RED', 'red'],
      ['BLUE', 'blue'],
      ['GREEN', 'green'],
      ['YELLOW', 'yellow'],
      ['TEAL', 'teal'],
      ['PURPLE', 'purple'],
      ['PINK', 'pink'],
      ['ORANGE', 'orange'],
      ['BROWN', 'brown'],
      ['GRAY', 'gray'],
      ['DEFAULT', 'default'],
      ['WHITE', 'default'],
      ['CERULEAN', 'blue'],
    ];

    for (const [keepColor, expected] of tests) {
      const files = [makeFile('note.json', { textContent: 'test', color: keepColor })];
      const { notes } = await parseKeepFiles(files);
      expect(notes[0].color).toBe(expected);
    }
  });

  it('maps unknown color to default', async () => {
    const files = [makeFile('note.json', { textContent: 'test', color: 'MAGENTA' })];
    const { notes } = await parseKeepFiles(files);
    expect(notes[0].color).toBe('default');
  });

  it('handles pinned notes', async () => {
    const files = [makeFile('note.json', { textContent: 'test', isPinned: true })];
    const { notes } = await parseKeepFiles(files);
    expect(notes[0].pinned).toBe(true);
  });

  it('handles archived notes', async () => {
    const files = [makeFile('note.json', { textContent: 'test', isArchived: true })];
    const { notes } = await parseKeepFiles(files);
    expect(notes[0].archived).toBe(true);
  });

  it('handles trashed notes', async () => {
    const files = [makeFile('note.json', { textContent: 'test', isTrashed: true })];
    const { notes } = await parseKeepFiles(files);
    expect(notes[0].deleted).toBe(true);
  });

  it('skips non-JSON files', async () => {
    const jsonFile = makeFile('note.json', { textContent: 'test' });
    const txtFile = new File(['not json'], 'note.txt');
    const { notes } = await parseKeepFiles([jsonFile, txtFile]);
    expect(notes).toHaveLength(1);
  });

  it('skips invalid JSON', async () => {
    const badFile = new File(['{invalid json'], 'bad.json');
    const goodFile = makeFile('good.json', { textContent: 'test' });
    const { notes } = await parseKeepFiles([badFile, goodFile]);
    expect(notes).toHaveLength(1);
  });

  it('rejects excessive raw file counts and aggregate bytes before reading input', async () => {
    const unread = makeFile('unread.json', { textContent: 'must not be read' });
    const text = vi.fn(async () => { throw new Error('must not read'); });
    Object.defineProperty(unread, 'text', { value: text });

    await expect(parseKeepFiles(
      Array.from({ length: MAX_KEEP_IMPORT_FILES + 1 }, () => unread),
    )).rejects.toThrow(`The limit is ${MAX_KEEP_IMPORT_FILES}`);
    expect(text).not.toHaveBeenCalled();

    const first = new File([], 'first.bin');
    const second = new File([], 'second.bin');
    Object.defineProperty(first, 'size', { value: Math.floor(MAX_KEEP_IMPORT_BYTES / 2) + 1 });
    Object.defineProperty(second, 'size', { value: Math.floor(MAX_KEEP_IMPORT_BYTES / 2) + 1 });
    await expect(parseKeepFiles([first, second])).rejects.toThrow('512 MiB file limit');
  });

  it('rejects an oversized Keep JSON file before allocating its text', async () => {
    const oversized = makeFile('large.json', { textContent: 'small fixture' });
    const text = vi.fn(async () => { throw new Error('must not read'); });
    Object.defineProperty(oversized, 'size', { value: MAX_KEEP_JSON_SIZE + 1 });
    Object.defineProperty(oversized, 'text', { value: text });

    await expect(parseKeepFiles([oversized])).rejects.toThrow(
      'Note JSON files must be 4 MiB or smaller',
    );
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'x'.repeat(MAX_NOTE_TITLE_LENGTH + 1) }, 'oversized title'],
    ['aggregate text', { textContent: 'x'.repeat(MAX_NOTE_TEXT_LENGTH + 1) }, 'note text limit'],
    ['checklist', {
      listContent: Array.from(
        { length: MAX_CHECKLIST_ITEMS + 1 },
        () => ({ text: '', isChecked: false }),
      ),
    }, 'too many checklist items'],
    ['labels', {
      labels: Array.from({ length: MAX_NOTE_LABELS + 1 }, () => ({ name: 'label' })),
    }, 'too many labels'],
    ['attachments', {
      attachments: Array.from(
        { length: MAX_NOTE_ATTACHMENTS + 1 },
        () => ({ filePath: 'shared.bin' }),
      ),
    }, 'too many attachments'],
  ])('rejects a Keep note beyond the %s limit', async (_field, value, message) => {
    await expect(parseKeepFiles([makeFile('bounded.json', value)]))
      .rejects.toThrow(message);
  });

  it('rejects an incomplete import when a Keep note references missing media', async () => {
    const files = [makeFile('Photo note.json', {
      title: 'Photo note',
      attachments: [{ filePath: 'Photo note.png', mimetype: 'image/png' }],
    })];

    await expect(parseKeepFiles(files)).rejects.toThrow(
      'Incomplete Google Keep import: Photo note.json references missing media "Photo note.png"',
    );
  });

  it('rejects referenced media over the web client attachment limit before reading its bytes', async () => {
    const noteFile = makeFile('Video note.json', {
      attachments: [{ filePath: 'large.mov', mimetype: 'video/quicktime' }],
    });
    const media = new File([], 'large.mov', { type: 'video/quicktime' });
    Object.defineProperty(media, 'size', { value: MAX_ATTACHMENT_SIZE + 1 });
    Object.defineProperty(media, 'arrayBuffer', {
      value: vi.fn(async () => { throw new Error('oversized bytes must not be read'); }),
    });

    await expect(parseKeepFiles([noteFile, media])).rejects.toThrow(
      'large.mov is too large. Attachments must be 25 MB or smaller.',
    );
  });

  it('reads a repeatedly referenced media file only once', async () => {
    const noteFile = makeFile('Photo note.json', {
      attachments: [
        { filePath: 'shared.png', mimetype: 'image/png' },
        { filePath: 'shared.png', mimetype: 'image/png' },
      ],
    });
    const media = new File([new Uint8Array([1, 2, 3])], 'shared.png', { type: 'image/png' });
    const originalArrayBuffer = media.arrayBuffer.bind(media);
    const arrayBuffer = vi.fn(() => originalArrayBuffer());
    Object.defineProperty(media, 'arrayBuffer', { value: arrayBuffer });

    const result = await parseKeepFiles([noteFile, media]);

    expect(result.attachments).toHaveLength(2);
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(result.attachments[0].bytes).toBe(result.attachments[1].bytes);
  });

  it('bounds attachment references across the complete import', async () => {
    const referencesPerNote = MAX_NOTE_ATTACHMENTS;
    const notes = Array.from(
      { length: Math.floor(MAX_KEEP_ATTACHMENT_REFERENCES / referencesPerNote) + 1 },
      (_, noteIndex) => makeFile(`note-${noteIndex}.json`, {
        attachments: Array.from(
          { length: referencesPerNote },
          () => ({ filePath: 'shared.bin', mimetype: 'application/octet-stream' }),
        ),
      }),
    );
    const media = new File([new Uint8Array([1])], 'shared.bin');

    await expect(parseKeepFiles([...notes, media])).rejects.toThrow(
      `The limit is ${MAX_KEEP_ATTACHMENT_REFERENCES}`,
    );
  });

  it('generates correct preview', async () => {
    const files = [
      makeFile('a.json', { textContent: 'normal' }),
      makeFile('b.json', { textContent: 'pinned', isPinned: true }),
      makeFile('c.json', { textContent: 'archived', isArchived: true }),
      makeFile('d.json', { textContent: 'trashed', isTrashed: true }),
      makeFile('e.json', { listContent: [{ text: 'item', isChecked: false }] }),
    ];

    const { preview } = await parseKeepFiles(files);
    expect(preview.total).toBe(5);
    expect(preview.notes).toBe(4); // notes without checkboxes
    expect(preview.checklists).toBe(1);
    expect(preview.pinned).toBe(1);
    expect(preview.archived).toBe(1);
    expect(preview.trashed).toBe(1);
    expect(preview.samples).toHaveLength(5);
  });

  it('limits samples to 5', async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`note${i}.json`, { textContent: `Note ${i}` })
    );
    const { preview } = await parseKeepFiles(files);
    expect(preview.samples).toHaveLength(5);
  });
});

const { parseKeepZip } = await import('./keepImporter.js');

interface ZipEntry {
  name: string;
  content: string | Uint8Array;
  compressed?: boolean;
  declaredUncompressedSize?: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds a stored (uncompressed) zip. With `streamed: true` it mimics Google
// Takeout: local headers carry flag bit 3 with zero sizes, and the real sizes
// follow each entry in a data descriptor.
function buildZip(entries: ZipEntry[], { streamed = false } = {}): File {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const storedData = entry.compressed ? new Uint8Array(deflateRawSync(data)) : data;
    const compressionMethod = entry.compressed ? 8 : 0;
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const crc = crc32(data);
    const flags = streamed ? 0x0808 : 0x0800;
    const localSizes = streamed ? [0, 0, 0] : [crc, storedData.length, declaredUncompressedSize];

    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(compressionMethod), ...u16(0), ...u16(0),
      ...u32(localSizes[0]), ...u32(localSizes[1]), ...u32(localSizes[2]),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes,
    ]);
    parts.push(local, storedData);
    let entryLen = local.length + storedData.length;
    if (streamed) {
      parts.push(new Uint8Array([
        ...u32(0x08074b50),
        ...u32(crc),
        ...u32(storedData.length),
        ...u32(declaredUncompressedSize),
      ]));
      entryLen += 16;
    }

    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(compressionMethod), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(storedData.length), ...u32(declaredUncompressedSize),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    ]));
    offset += entryLen;
  }

  const centralStart = offset;
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(centralStart), ...u16(0),
  ]);

  return new File([...parts, ...central, eocd] as BlobPart[], 'takeout.zip', { type: 'application/zip' });
}

describe('parseKeepZip', () => {
  const entries: ZipEntry[] = [
    { name: 'Takeout/Keep/note.json', content: JSON.stringify({ textContent: 'From zip' }) },
    { name: 'Takeout/Keep/note.html', content: '<html>ignored</html>' },
    { name: 'Takeout/archive_browser.html', content: '<html>not keep</html>' },
  ];

  it('parses a conventional zip', async () => {
    const { notes } = await parseKeepZip(buildZip(entries));
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('From zip');
  });

  it('parses a streamed zip with data descriptors (Google Takeout format)', async () => {
    const { notes } = await parseKeepZip(buildZip(entries, { streamed: true }));
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('From zip');
  });

  it('rejects an oversized archive before reading it into memory', async () => {
    const archive = buildZip(entries);
    const arrayBuffer = vi.fn(() => File.prototype.arrayBuffer.call(archive));
    Object.defineProperty(archive, 'size', { value: 256 * 1024 * 1024 + 1 });
    Object.defineProperty(archive, 'arrayBuffer', { value: arrayBuffer });

    await expect(parseKeepZip(archive)).rejects.toThrow(
      'Google Takeout ZIP is too large. Archives must be 256 MiB or smaller.',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('does not inflate compressed entries belonging to other Takeout products', async () => {
    const { notes } = await parseKeepZip(buildZip([
      entries[0],
      {
        name: 'Takeout/Drive/unrelated.bin',
        content: new Uint8Array([1, 2, 3]),
        compressed: true,
        declaredUncompressedSize: MAX_ATTACHMENT_SIZE + 1,
      },
    ]));

    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('From zip');
  });

  it('rejects a Keep entry with an unsafe declared compression ratio', async () => {
    const archive = buildZip([{
      name: 'Takeout/Keep/repetitive.json',
      content: JSON.stringify({ textContent: 'a'.repeat(100_000) }),
      compressed: true,
    }]);

    await expect(parseKeepZip(archive)).rejects.toThrow(
      'Google Takeout ZIP entry Takeout/Keep/repetitive.json has an unsafe compression ratio.',
    );
  });

  it('associates referenced Takeout images with their note and preserves the bytes', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { notes, attachments } = await parseKeepZip(buildZip([
      {
        name: 'Takeout/Keep/Photo note.json',
        content: JSON.stringify({
          title: 'Photo note',
          attachments: [{ filePath: 'Photo note.png', mimetype: 'image/png' }],
        }),
      },
      { name: 'Takeout/Keep/Photo note.png', content: imageBytes },
    ], { streamed: true }));

    expect(notes[0].images).toEqual([
      expect.objectContaining({ name: 'Photo note.png', mimeType: 'image/png', size: imageBytes.length }),
    ]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ noteId: notes[0].id, attachment: notes[0].images![0] });
    expect(attachments[0].bytes).toEqual(imageBytes);
  });

  it('rejects an oversized compressed media entry from its ZIP declaration before inflating it', async () => {
    const archive = buildZip([
      {
        name: 'Takeout/Keep/Video note.json',
        content: JSON.stringify({ attachments: [{ filePath: 'large.mov', mimetype: 'video/quicktime' }] }),
      },
      {
        name: 'Takeout/Keep/large.mov',
        content: new Uint8Array([1, 2, 3]),
        compressed: true,
        declaredUncompressedSize: MAX_ATTACHMENT_SIZE + 1,
      },
    ], { streamed: true });

    await expect(parseKeepZip(archive)).rejects.toThrow(
      'large.mov is too large. Attachments must be 25 MB or smaller.',
    );
  });

  it('rejects a ZIP entry whose extracted bytes disagree with its declared size', async () => {
    const archive = buildZip([
      {
        name: 'Takeout/Keep/Photo note.json',
        content: JSON.stringify({ attachments: [{ filePath: 'photo.png', mimetype: 'image/png' }] }),
      },
      {
        name: 'Takeout/Keep/photo.png',
        content: new Uint8Array([1, 2, 3]),
        compressed: true,
        declaredUncompressedSize: 4,
      },
    ]);

    await expect(parseKeepZip(archive)).rejects.toThrow(
      'Invalid Google Takeout ZIP entry Takeout/Keep/photo.png: declared 4 bytes but extracted 3',
    );
  });

  it('stops inflating as soon as output exceeds the declared size', async () => {
    const archive = buildZip([{
      name: 'Takeout/Keep/expanding.json',
      content: new Uint8Array(1024).fill(1),
      compressed: true,
      declaredUncompressedSize: 4,
    }]);

    await expect(parseKeepZip(archive)).rejects.toThrow(
      'Invalid Google Takeout ZIP entry Takeout/Keep/expanding.json: extracted data exceeds its declared size',
    );
  });

  it('infers an image MIME type from Takeout filenames when metadata omits it', async () => {
    const { notes } = await parseKeepZip(buildZip([
      {
        name: 'Takeout/Keep/Photo.json',
        content: JSON.stringify({ attachments: [{ filePath: 'Photo.JPG' }] }),
      },
      { name: 'Takeout/Keep/Photo.JPG', content: new Uint8Array([0xff, 0xd8, 0xff]) },
    ]));

    expect(notes[0].images?.[0]).toMatchObject({
      name: 'Photo.JPG',
      mimeType: 'image/jpeg',
    });
  });

  it('returns no notes for a non-zip file', async () => {
    const { notes } = await parseKeepZip(new File(['not a zip'], 'bogus.zip'));
    expect(notes).toHaveLength(0);
  });
});
