import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseSharePayload, stashPendingShare, takePendingShares } from './shareTarget.js';

describe('parseSharePayload', () => {
  it('parses a bare URL-encoded fragment as text (iOS Shortcut path)', () => {
    const payload = parseSharePayload('', '#Hello%20from%20the%20share%20sheet');
    expect(payload).toEqual({ title: '', text: 'Hello from the share sheet' });
  });

  it('decodes unicode in a bare fragment', () => {
    const payload = parseSharePayload('', `#${encodeURIComponent('café 🌍 你好')}`);
    expect(payload).toEqual({ title: '', text: 'café 🌍 你好' });
  });

  it('parses param-style fragments', () => {
    const payload = parseSharePayload('', '#title=Groceries&text=milk%20and%20eggs');
    expect(payload).toEqual({ title: 'Groceries', text: 'milk and eggs' });
  });

  it('parses query params (Android share_target path)', () => {
    const payload = parseSharePayload('?title=Article&text=worth%20reading&url=https%3A%2F%2Fexample.com', '');
    expect(payload).toEqual({ title: 'Article', text: 'worth reading\nhttps://example.com' });
  });

  it('uses url param alone as content', () => {
    const payload = parseSharePayload('?url=https%3A%2F%2Fexample.com', '');
    expect(payload).toEqual({ title: '', text: 'https://example.com' });
  });

  it('treats encoded text containing no equals sign as bare text even with & present', () => {
    const payload = parseSharePayload('', '#fish%20%26%20chips');
    expect(payload).toEqual({ title: '', text: 'fish & chips' });
  });

  it('keeps encoded equals signs as text', () => {
    const payload = parseSharePayload('', '#E%20%3D%20mc2');
    expect(payload).toEqual({ title: '', text: 'E = mc2' });
  });

  it('falls back to bare text when a fragment with a literal = has no known params', () => {
    const payload = parseSharePayload('', '#x=y');
    expect(payload).toEqual({ title: '', text: 'x=y' });
  });

  it('returns null when nothing was shared', () => {
    expect(parseSharePayload('', '')).toBeNull();
    expect(parseSharePayload('?foo=bar', '')).toBeNull();
    expect(parseSharePayload('', '#%20%20')).toBeNull();
  });

  it('returns null for a malformed percent-encoded fragment', () => {
    expect(parseSharePayload('', '#%E0%A4%A')).toBeNull();
  });
});

describe('stashPendingShare/takePendingShares', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('returns stashed shares once, in order', () => {
    stashPendingShare({ title: 'a', text: 'first' });
    stashPendingShare({ title: '', text: 'second' });
    expect(takePendingShares()).toEqual([
      { title: 'a', text: 'first' },
      { title: '', text: 'second' },
    ]);
    expect(takePendingShares()).toEqual([]);
  });

  it('ignores corrupt stash data', () => {
    localStorage.setItem('unkeep-pending-shares', 'not json');
    expect(takePendingShares()).toEqual([]);
    localStorage.setItem('unkeep-pending-shares', '[{"bogus":true},{"title":"t","text":"x"}]');
    expect(takePendingShares()).toEqual([{ title: 't', text: 'x' }]);
  });
});
