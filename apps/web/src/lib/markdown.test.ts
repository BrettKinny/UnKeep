import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';

describe('parseMarkdown', () => {
  it('parses headings and preserves line breaks inside paragraphs', () => {
    expect(parseMarkdown('# Heading\n\nFirst line\nsecond line')).toEqual([
      { type: 'heading', level: 1, content: [{ type: 'text', text: 'Heading' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'First line' },
          { type: 'lineBreak' },
          { type: 'text', text: 'second line' },
        ],
      },
    ]);
  });

  it('parses unordered and ordered lists as separate blocks', () => {
    expect(parseMarkdown('- apples\n* pears\n\n3. third\n4. fourth')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'text', text: 'apples' }],
          [{ type: 'text', text: 'pears' }],
        ],
      },
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          [{ type: 'text', text: 'third' }],
          [{ type: 'text', text: 'fourth' }],
        ],
      },
    ]);
  });

  it('keeps fenced code literal and records its language', () => {
    expect(parseMarkdown('```ts\nconst value = `raw`;\n**not bold**\n```')).toEqual([
      {
        type: 'codeBlock',
        language: 'ts',
        text: 'const value = `raw`;\n**not bold**',
      },
    ]);
  });

  it('parses inline code, emphasis, and strong text without producing HTML', () => {
    expect(parseMarkdown('Use `code`, *care*, and **strength**.')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Use ' },
          { type: 'code', text: 'code' },
          { type: 'text', text: ', ' },
          { type: 'emphasis', text: 'care' },
          { type: 'text', text: ', and ' },
          { type: 'strong', text: 'strength' },
          { type: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('creates links only for safe HTTP URLs and leaves HTML or unsafe links as text', () => {
    expect(parseMarkdown(
      '[secure](https://example.com/docs) [plain](http://example.com) '
      + '[bad](javascript:alert%281%29) [relative](/admin) <script>alert(1)</script>',
    )).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'link', text: 'secure', href: 'https://example.com/docs' },
          { type: 'text', text: ' ' },
          { type: 'link', text: 'plain', href: 'http://example.com' },
          {
            type: 'text',
            text: ' [bad](javascript:alert%281%29) [relative](/admin) <script>alert(1)</script>',
          },
        ],
      },
    ]);
  });
});
