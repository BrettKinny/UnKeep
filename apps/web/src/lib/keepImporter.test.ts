import { describe, it, expect, vi } from 'vitest';

// Mock nanoid before importing the module
vi.mock('nanoid', () => {
  let counter = 0;
  return {
    nanoid: () => `mock-id-${counter++}`,
  };
});

// Import after mock setup
const { parseKeepFiles } = await import('./keepImporter.js');

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

    const { notes, preview } = await parseKeepFiles(files);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe('Hello world');
    expect(notes[0].updatedAt).toBe(1700000000000);
    expect(notes[0].createdAt).toBe(1699000000000);
  });

  it('combines title and content', async () => {
    const files = [makeFile('note.json', {
      title: 'My Title',
      textContent: 'Body text',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].content).toBe('My Title\n\nBody text');
  });

  it('handles title-only note', async () => {
    const files = [makeFile('note.json', {
      title: 'Just a title',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].content).toBe('Just a title');
  });

  it('handles content-only note', async () => {
    const files = [makeFile('note.json', {
      textContent: 'Just content',
    })];

    const { notes } = await parseKeepFiles(files);
    expect(notes[0].content).toBe('Just content');
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
    expect(notes[0].content).toBe('Shopping');
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
