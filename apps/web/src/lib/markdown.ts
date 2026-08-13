export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'lineBreak' }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'link'; text: string; href: string };

export type MarkdownBlock =
  | { type: 'heading'; level: number; content: MarkdownInline[] }
  | { type: 'paragraph'; content: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; start?: number; items: MarkdownInline[][] }
  | { type: 'codeBlock'; language?: string; text: string };

interface ListMarker {
  ordered: boolean;
  start?: number;
  value: string;
}

function appendText(content: MarkdownInline[], value: string): void {
  if (!value) return;
  const previous = content.at(-1);
  if (previous?.type === 'text') previous.text += value;
  else content.push({ type: 'text', text: value });
}

function safeHttpUrl(value: string): string | null {
  if (!value || [...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  })) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function parseInline(value: string): MarkdownInline[] {
  const content: MarkdownInline[] = [];
  let plainStart = 0;
  let index = 0;

  while (index < value.length) {
    if (value[index] === '[') {
      const labelEnd = value.indexOf('](', index + 1);
      const urlEnd = labelEnd === -1 ? -1 : value.indexOf(')', labelEnd + 2);
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const href = safeHttpUrl(value.slice(labelEnd + 2, urlEnd));
        if (href) {
          appendText(content, value.slice(plainStart, index));
          content.push({ type: 'link', text: value.slice(index + 1, labelEnd), href });
          index = urlEnd + 1;
          plainStart = index;
          continue;
        }
      }
    }
    let marker = '';
    let type: 'code' | 'emphasis' | 'strong' | null = null;
    if (value[index] === '`') {
      marker = '`';
      type = 'code';
    } else if (value.startsWith('**', index) || value.startsWith('__', index)) {
      marker = value.slice(index, index + 2);
      type = 'strong';
    } else if (value[index] === '*' || value[index] === '_') {
      marker = value[index];
      type = 'emphasis';
    }
    if (!type) {
      index++;
      continue;
    }

    const close = value.indexOf(marker, index + marker.length);
    if (close <= index + marker.length) {
      index++;
      continue;
    }
    appendText(content, value.slice(plainStart, index));
    content.push({ type, text: value.slice(index + marker.length, close) });
    index = close + marker.length;
    plainStart = index;
  }
  appendText(content, value.slice(plainStart));
  return content;
}

function paragraphContent(lines: string[]): MarkdownInline[] {
  const content: MarkdownInline[] = [];
  lines.forEach((line, index) => {
    if (index) content.push({ type: 'lineBreak' });
    content.push(...parseInline(line));
  });
  return content;
}

function listMarker(line: string): ListMarker | null {
  const unordered = /^\s*[-+*][ \t]+(.*)$/.exec(line);
  if (unordered) return { ordered: false, value: unordered[1] };
  const ordered = /^\s*(\d+)[.)][ \t]+(.*)$/.exec(line);
  if (!ordered) return null;
  return { ordered: true, start: Number(ordered[1]), value: ordered[2] };
}

function codeFence(line: string): string | null {
  const match = /^ {0,3}```([^`]*)$/.exec(line);
  return match ? match[1].trim() : null;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }

    const language = codeFence(lines[index]);
    if (language !== null) {
      index++;
      const code: string[] = [];
      while (index < lines.length && !/^ {0,3}```[ \t]*$/.test(lines[index])) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({ type: 'codeBlock', ...(language ? { language } : {}), text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(lines[index]);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, content: parseInline(heading[2]) });
      index++;
      continue;
    }

    const firstItem = listMarker(lines[index]);
    if (firstItem) {
      const items: MarkdownInline[][] = [];
      const ordered = firstItem.ordered;
      const start = firstItem.start;
      while (index < lines.length) {
        const item = listMarker(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(parseInline(item.value));
        index++;
      }
      blocks.push({ type: 'list', ordered, ...(ordered ? { start } : {}), items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^(#{1,6})[ \t]+/.test(lines[index])
      && !listMarker(lines[index])
      && codeFence(lines[index]) === null
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ type: 'paragraph', content: paragraphContent(paragraph) });
  }

  return blocks;
}
