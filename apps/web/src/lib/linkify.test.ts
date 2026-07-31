import { describe, it, expect } from 'vitest';
import { linkify } from './linkify.js';

const links = (text: string) =>
  linkify(text)
    .filter(segment => segment.type === 'link')
    .map(segment => ({ value: segment.value, href: (segment as { href: string }).href }));

describe('linkify', () => {
  it('returns a single text segment when there is nothing to link', () => {
    expect(linkify('just some plain text')).toEqual([{ type: 'text', value: 'just some plain text' }]);
  });

  it('returns nothing for empty text', () => {
    expect(linkify('')).toEqual([]);
  });

  it('splits text around an http(s) URL', () => {
    expect(linkify('see https://example.com now')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com/' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('links bare www hosts over https', () => {
    expect(links('go to www.example.com')).toEqual([
      { value: 'www.example.com', href: 'https://www.example.com/' },
    ]);
  });

  it('links email addresses as mailto', () => {
    expect(links('ping brett@example.com.au please')).toEqual([
      { value: 'brett@example.com.au', href: 'mailto:brett@example.com.au' },
    ]);
  });

  it('keeps an explicit mailto scheme', () => {
    expect(links('mailto:brett@example.com')).toEqual([
      { value: 'mailto:brett@example.com', href: 'mailto:brett@example.com' },
    ]);
  });

  it('finds multiple links in one string', () => {
    expect(links('https://a.com and www.b.com and c@d.com')).toEqual([
      { value: 'https://a.com', href: 'https://a.com/' },
      { value: 'www.b.com', href: 'https://www.b.com/' },
      { value: 'c@d.com', href: 'mailto:c@d.com' },
    ]);
  });

  it('finds links across multiple lines', () => {
    expect(links('line one\nhttps://example.com/x\nline three')).toEqual([
      { value: 'https://example.com/x', href: 'https://example.com/x' },
    ]);
  });

  it('preserves query strings, fragments and ports', () => {
    expect(links('http://localhost:3000/a?b=1&c=2#frag')).toEqual([
      { value: 'http://localhost:3000/a?b=1&c=2#frag', href: 'http://localhost:3000/a?b=1&c=2#frag' },
    ]);
  });

  it('drops sentence punctuation that trails a URL', () => {
    expect(links('read https://example.com/docs.')[0].value).toBe('https://example.com/docs');
    expect(links('read https://example.com/docs, then go')[0].value).toBe('https://example.com/docs');
    expect(links('really? https://example.com!')[0].value).toBe('https://example.com');
  });

  it('keeps balanced parentheses inside a URL', () => {
    expect(links('https://en.wikipedia.org/wiki/Kiwi_(bird)')[0].value).toBe(
      'https://en.wikipedia.org/wiki/Kiwi_(bird)',
    );
  });

  it('drops an unbalanced closing bracket', () => {
    expect(links('(see https://example.com/a)')[0].value).toBe('https://example.com/a');
    expect(links('[https://example.com/a]')[0].value).toBe('https://example.com/a');
  });

  it('leaves trimmed punctuation in the surrounding text', () => {
    expect(linkify('see https://example.com.')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com', href: 'https://example.com/' },
      { type: 'text', value: '.' },
    ]);
  });

  it('does not link a www host inside an http URL twice', () => {
    expect(links('https://www.example.com/a')).toEqual([
      { value: 'https://www.example.com/a', href: 'https://www.example.com/a' },
    ]);
  });

  it('ignores javascript: and other non-web schemes', () => {
    expect(links('javascript:alert(1) and file:///etc/passwd')).toEqual([]);
  });

  it('ignores bare words that merely contain a dot or an at sign', () => {
    expect(links('version 1.2.3 released, cost @ 5 dollars, file.txt')).toEqual([]);
  });

  it('does not treat markup in the text as markup', () => {
    const segments = linkify('<script>alert(1)</script>');
    expect(segments).toEqual([{ type: 'text', value: '<script>alert(1)</script>' }]);
  });

  it('handles a link at the very start and end of the text', () => {
    expect(linkify('https://a.com')).toEqual([
      { type: 'link', value: 'https://a.com', href: 'https://a.com/' },
    ]);
    expect(linkify('go https://a.com')).toEqual([
      { type: 'text', value: 'go ' },
      { type: 'link', value: 'https://a.com', href: 'https://a.com/' },
    ]);
  });

  it('reassembles to the original text', () => {
    const text = 'a https://x.com/(y) b www.z.com, c d@e.com.';
    expect(linkify(text).map(segment => segment.value).join('')).toBe(text);
  });
});
