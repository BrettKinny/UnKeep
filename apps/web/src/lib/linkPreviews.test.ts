import { describe, expect, it, vi } from 'vitest';
import {
  isBareLinkNote,
  LinkPreviewStore,
  previewUrls,
  type CachedLinkPreview,
  type LinkPreviewCache,
} from './linkPreviews.svelte';

function memoryCache(initial: CachedLinkPreview[] = []): LinkPreviewCache & { values: Map<string, CachedLinkPreview> } {
  const values = new Map(initial.map(value => [value.url, value]));
  return {
    values,
    get: async url => values.get(url),
    put: async value => { values.set(value.url, value); },
    clear: async () => { values.clear(); },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('previewUrls', () => {
  it('collects unique http(s) links in order, capped per note', () => {
    expect(previewUrls({
      content: 'see https://a.example/x and www.b.example, mail me@c.example, again https://a.example/x and https://d.example',
    })).toEqual(['https://a.example/x', 'https://www.b.example/']);
  });

  it('reads checklist items instead of hidden content', () => {
    expect(previewUrls({
      content: 'https://ignored.example',
      checkboxes: [{ id: 'one', text: 'buy https://shop.example/item', checked: false }],
    })).toEqual(['https://shop.example/item']);
  });

  it('detects notes that are only a link', () => {
    expect(isBareLinkNote({ content: '  https://www.reddit.com/r/tui/comments/1tsjdst/\n' })).toBe(true);
    expect(isBareLinkNote({ content: 'look https://example.com' })).toBe(false);
    expect(isBareLinkNote({ content: 'me@example.com' })).toBe(false);
  });
});

describe('LinkPreviewStore', () => {
  it('serves fresh cache entries without fetching and caches new results', async () => {
    const now = 1_000_000_000_000;
    const cache = memoryCache([
      { url: 'https://cached.example/', preview: { title: 'Cached' }, fetchedAt: now - 1_000 },
    ]);
    const fetcher = vi.fn(async (url: string) => ({ title: `Fetched ${url}` }));
    const store = new LinkPreviewStore(cache, () => now);
    store.setFetcher(fetcher);

    store.request(['https://cached.example/', 'https://new.example/']);
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://new.example/');
    expect(store.previews.get('https://cached.example/')).toEqual({ title: 'Cached' });
    expect(store.previews.get('https://new.example/')).toEqual({ title: 'Fetched https://new.example/' });
    expect(cache.values.get('https://new.example/')).toEqual({
      url: 'https://new.example/', preview: { title: 'Fetched https://new.example/' }, fetchedAt: now,
    });

    store.request(['https://new.example/']);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows stale entries immediately, then refreshes them', async () => {
    const now = 1_000_000_000_000;
    const cache = memoryCache([
      { url: 'https://stale.example/', preview: null, fetchedAt: now - 4 * 24 * 60 * 60_000 },
    ]);
    const store = new LinkPreviewStore(cache, () => now);
    store.setFetcher(async () => ({ title: 'Back online' }));
    store.request(['https://stale.example/']);
    await settle();
    expect(store.previews.get('https://stale.example/')).toEqual({ title: 'Back online' });
  });

  it('defers requests until a relay is connected and does not cache relay failures', async () => {
    const cache = memoryCache();
    const store = new LinkPreviewStore(cache);
    store.request(['https://later.example/']);
    await settle();
    expect(store.previews.has('https://later.example/')).toBe(false);

    const disabled = Object.assign(new Error('link_previews_disabled'), { status: 404, code: 'link_previews_disabled' });
    const failing = vi.fn(async () => { throw disabled; });
    store.setFetcher(failing);
    await settle();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cache.values.size).toBe(0);

    store.request(['https://another.example/']);
    await settle();
    expect(failing).toHaveBeenCalledTimes(1);

    const working = vi.fn(async () => null);
    store.setFetcher(working);
    await settle();
    expect(working).toHaveBeenCalledTimes(2);
    expect(store.previews.get('https://later.example/')).toBeNull();
    expect(cache.values.get('https://later.example/')?.preview).toBeNull();
  });

  it('clear drops in-flight results and the local cache', async () => {
    const cache = memoryCache();
    let resolveFetch!: (value: { title: string }) => void;
    const store = new LinkPreviewStore(cache);
    store.setFetcher(() => new Promise(resolve => { resolveFetch = resolve; }));
    store.request(['https://slow.example/']);
    await settle();
    await store.clear();
    resolveFetch({ title: 'Too late' });
    await settle();
    expect(store.previews.size).toBe(0);
    expect(cache.values.size).toBe(0);
  });
});
