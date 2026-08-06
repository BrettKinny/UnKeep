import type { Note } from '@unkeep/core';

const FALLBACK_NOTE_NAME = 'UnKeep note';
const MAX_FILE_BASENAME_LENGTH = 120;
const UNSAFE_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');

function isBidirectionalControl(codePoint: number): boolean {
  return codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function noteBody(note: Note, checkboxPrefix: (checked: boolean) => string): string {
  if (note.checkboxes) {
    return note.checkboxes
      .map(item => `${checkboxPrefix(item.checked)}${item.text}`)
      .join('\n');
  }
  return note.content;
}

function attachmentList(note: Note): string[] {
  return (note.images ?? []).map(attachment => attachment.name);
}

export function noteShareTitle(note: Note): string {
  const title = note.title?.replace(/[\r\n]+/g, ' ').trim();
  return title || FALLBACK_NOTE_NAME;
}

/** A portable snapshot for apps which accept plain text from the OS share sheet. */
export function noteToShareText(note: Note): string {
  const sections = [
    note.title?.trim(),
    noteBody(note, checked => checked ? '☑ ' : '☐ ').trim(),
    note.labels?.length ? `Labels: ${note.labels.join(', ')}` : undefined,
    attachmentList(note).length
      ? `Attachments: ${attachmentList(note).join(', ')}`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return sections.join('\n\n') || FALLBACK_NOTE_NAME;
}

/** A human-facing Markdown export without UnKeep IDs or internal timestamps. */
export function noteToShareMarkdown(note: Note): string {
  const sections = [
    note.title?.trim() ? `# ${noteShareTitle(note)}` : undefined,
    noteBody(note, checked => checked ? '- [x] ' : '- [ ] ').trim(),
    note.labels?.length ? `**Labels:** ${note.labels.join(', ')}` : undefined,
    attachmentList(note).length
      ? `**Attachments:** ${attachmentList(note).join(', ')}`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return sections.join('\n\n') || `# ${FALLBACK_NOTE_NAME}`;
}

export function noteShareFilename(note: Note): string {
  let basename = [...noteShareTitle(note)]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32
        || codePoint === 127
        || isBidirectionalControl(codePoint)
        || UNSAFE_FILENAME_CHARACTERS.has(character)
        ? '-'
        : character;
    })
    .join('')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  basename = [...basename]
    .slice(0, MAX_FILE_BASENAME_LENGTH)
    .join('')
    .replace(/[ .]+$/g, '');
  if (!basename) basename = 'unkeep-note';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) basename = `_${basename}`;
  return `${basename}.md`;
}

/**
 * Obsidian reads the note body from the clipboard. Keeping plaintext out of
 * the custom-protocol URL avoids URI length limits and accidental URL logs.
 */
export function obsidianNewNoteUrl(note: Note): string {
  const name = noteShareFilename(note).slice(0, -3);
  return `obsidian://new?name=${encodeURIComponent(name)}&clipboard`;
}

export function downloadNoteMarkdown(note: Note): void {
  const blob = new Blob([noteToShareMarkdown(note)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = noteShareFilename(note);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
