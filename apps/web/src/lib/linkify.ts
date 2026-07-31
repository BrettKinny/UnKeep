export type LinkSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string };

// Explicit scheme, bare www. host, or a plain email address. Ordered so an
// explicit scheme wins over the www./email branches inside the same URL.
const LINK_PATTERN =
  /(?:https?:\/\/|mailto:)\S+|\bwww\.\S+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi;

const TRAILING_PUNCTUATION = new Set([...'.,;:!?\'"`*_~’”)]}']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Trims punctuation that trails a URL in prose ("see https://x.com.") without
 * eating characters the URL legitimately ends with — a closing bracket is kept
 * when the match opened it, so `https://en.wikipedia.org/wiki/Foo_(bar)` stays
 * intact but `(https://x.com)` drops the paren.
 */
function trimTrailingPunctuation(match: string): string {
  let end = match.length;
  while (end > 0) {
    const char = match[end - 1];
    if (!TRAILING_PUNCTUATION.has(char)) break;
    const opener = CLOSERS[char];
    if (opener) {
      const candidate = match.slice(0, end);
      const opened = candidate.split(opener).length - 1;
      const closed = candidate.split(char).length - 1;
      if (closed <= opened) break;
    }
    end -= 1;
  }
  return match.slice(0, end);
}

function toHref(value: string): string | null {
  const hasScheme = /^(?:https?:|mailto:)/i.test(value);
  let candidate = value;
  if (!hasScheme) candidate = value.includes('@') ? `mailto:${value}` : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!ALLOWED_PROTOCOLS.has(url.protocol.toLowerCase())) return null;
    if (url.protocol.toLowerCase() !== 'mailto:' && !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Splits plain text into renderable segments so URLs and email addresses can be
 * rendered as anchors. Text is never treated as markup — callers render each
 * segment's `value` as a text node.
 */
export function linkify(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const value = trimTrailingPunctuation(match[0]);
    if (!value) continue;
    const href = toHref(value);
    if (!href) continue;

    if (start > cursor) segments.push({ type: 'text', value: text.slice(cursor, start) });
    segments.push({ type: 'link', value, href });
    cursor = start + value.length;
  }

  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}
