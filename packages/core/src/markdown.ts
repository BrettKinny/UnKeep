import type { Note } from './types.js';

export function noteToMarkdown(note: Note): string {
  const frontmatter = [
    '---',
    `id: ${note.id}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    `pinned: ${note.pinned}`,
    `archived: ${note.archived}`,
    note.color ? `color: ${note.color}` : null,
    note.deleted ? `deleted: ${note.deleted}` : null,
    note.checkboxes ? `checkboxes: ${JSON.stringify(note.checkboxes)}` : null,
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}\n\n${note.content}`;
}

export function markdownToNote(content: string): Note {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error('Invalid note format: no frontmatter');

  const fm = fmMatch[1];
  const body = fmMatch[2] || '';

  function getVal(key: string): string | undefined {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.trim();
  }

  const checkboxesRaw = getVal('checkboxes');
  let checkboxes;
  if (checkboxesRaw) {
    try { checkboxes = JSON.parse(checkboxesRaw); } catch { /* ignore */ }
  }

  return {
    id: getVal('id') || '',
    createdAt: parseInt(getVal('createdAt') || '0', 10),
    updatedAt: parseInt(getVal('updatedAt') || '0', 10),
    pinned: getVal('pinned') === 'true',
    archived: getVal('archived') === 'true',
    color: (getVal('color') as Note['color']) || undefined,
    deleted: getVal('deleted') === 'true' ? true : undefined,
    checkboxes,
    content: body,
  };
}
