import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listPendingShares,
  MAX_PENDING_SHARES,
  MAX_SHARE_PAYLOAD_CHARACTERS,
  parseSharePayload,
  removePendingShares,
  stashPendingShare,
} from './shareTarget.js';

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

  it('rejects oversized fragment and parameter payloads', () => {
    const oversized = 'x'.repeat(MAX_SHARE_PAYLOAD_CHARACTERS + 1);
    expect(parseSharePayload('', `#${oversized}`)).toBeNull();
    expect(parseSharePayload(`?text=${oversized}`, '')).toBeNull();
  });
});

describe('pending shares', () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key); },
      setItem: (key: string, value: string) => { values.set(key, value); },
    } satisfies Storage);
  });

  it('keeps shares queued until each durable save is acknowledged', () => {
    const first = stashPendingShare({ title: 'a', text: 'first' }, 'vault-a');
    const second = stashPendingShare({ title: '', text: 'second' });
    expect(listPendingShares()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, title: 'a', text: 'first', targetInstanceId: 'vault-a' }),
      expect.objectContaining({ id: second.id, title: '', text: 'second', targetInstanceId: null }),
    ]));
    expect(listPendingShares()).toHaveLength(2);

    removePendingShares([first.id]);
    expect(listPendingShares()).toEqual([
      expect.objectContaining({ id: second.id, text: 'second' }),
    ]);

    removePendingShares([second.id]);
    expect(listPendingShares()).toEqual([]);
  });

  it('ignores corrupt entries and migrates legacy shares as unbound', () => {
    localStorage.setItem('unkeep-pending-shares', 'not json');
    expect(listPendingShares()).toEqual([]);
    localStorage.setItem('unkeep-pending-shares', '[{"bogus":true},{"title":"t","text":"x"}]');
    expect(listPendingShares()).toEqual([
      expect.objectContaining({ title: 't', text: 'x', targetInstanceId: null }),
    ]);
  });

  it('migrates an ID-less legacy share once under a two-tab interleaving', () => {
    localStorage.setItem(
      'unkeep-pending-shares',
      JSON.stringify([{ title: 'legacy', text: 'one logical share' }]),
    );
    const originalSet = localStorage.setItem.bind(localStorage);
    let nested = false;
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'unkeep-pending-shares' && !nested) {
        nested = true;
        listPendingShares();
        nested = false;
      }
      originalSet(key, value);
    });

    const migrated = listPendingShares();
    set.mockRestore();

    expect(migrated).toEqual([{
      id: 'legacy-0',
      targetInstanceId: null,
      createdAt: 0,
      title: 'legacy',
      text: 'one logical share',
    }]);
    expect(listPendingShares()).toEqual(migrated);
    expect([...values.keys()].filter(key => key.startsWith('unkeep-pending-share:')))
      .toEqual(['unkeep-pending-share:legacy-0']);
  });

  it('bounds both individual shares and the durable pending queue', () => {
    expect(() => stashPendingShare({
      title: '',
      text: 'x'.repeat(MAX_SHARE_PAYLOAD_CHARACTERS + 1),
    })).toThrow('too large');
    for (let index = 0; index < MAX_PENDING_SHARES; index += 1) {
      stashPendingShare({ title: '', text: `share-${index}` });
    }
    expect(() => stashPendingShare({ title: '', text: 'one too many' }))
      .toThrow('Too many shared notes');
  });

  it('does not lose distinct stashes or removals under cross-tab interleaving', () => {
    const originalSet = localStorage.setItem.bind(localStorage);
    let nested = false;
    let second: ReturnType<typeof stashPendingShare> | null = null;
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('unkeep-pending-share:') && !nested) {
        nested = true;
        second = stashPendingShare({ title: '', text: 'second tab' });
        nested = false;
      }
      originalSet(key, value);
    });
    const first = stashPendingShare({ title: '', text: 'first tab' });
    set.mockRestore();

    expect(listPendingShares().map(share => share.id)).toEqual(
      expect.arrayContaining([first.id, second!.id]),
    );
    expect(listPendingShares()).toHaveLength(2);

    const originalRemove = localStorage.removeItem.bind(localStorage);
    let third: ReturnType<typeof stashPendingShare> | null = null;
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation(key => {
      if (key.endsWith(first.id) && !third) {
        third = stashPendingShare({ title: '', text: 'arrived during removal' });
      }
      originalRemove(key);
    });
    removePendingShares([first.id]);
    remove.mockRestore();

    expect(listPendingShares().map(share => share.id)).toEqual(
      expect.arrayContaining([second!.id, third!.id]),
    );
    expect(listPendingShares()).toHaveLength(2);
  });
});
