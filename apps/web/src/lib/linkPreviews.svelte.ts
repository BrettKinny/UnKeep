import type { LinkPreview } from '@unkeep/client';
import type { Note } from '@unkeep/core';
import { SvelteMap } from 'svelte/reactivity';
import { linkify } from './linkify';

export const MAX_PREVIEWS_PER_NOTE = 2;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60_000;
const FAILURE_TTL_MS = 3 * 24 * 60 * 60_000;
const MAX_CONCURRENT_FETCHES = 2;
/** Notes change on every keystroke; wait for a URL to stop changing before fetching it. */
export const PREVIEW_REQUEST_DELAY_MS = 800;

export interface CachedLinkPreview {
  url: string;
  /** Null records that the page could not be previewed, so it is not refetched every load. */
  preview: LinkPreview | null;
  fetchedAt: number;
}

export interface LinkPreviewCache {
  get(url: string): Promise<CachedLinkPreview | undefined>;
  put(value: CachedLinkPreview): Promise<void>;
  clear(): Promise<void>;
}

export type LinkPreviewFetcher = (url: string) => Promise<LinkPreview | null>;

function linkHrefs(text: string): string[] {
  return linkify(text)
    .filter(segment => segment.type === 'link' && /^https?:/i.test(segment.href))
    .map(segment => (segment as { href: string }).href);
}

/** The http(s) URLs in a note that get preview cards, in reading order. */
export function previewUrls(note: Pick<Note, 'content' | 'checkboxes'>): string[] {
  const hrefs = note.checkboxes?.length
    ? note.checkboxes.flatMap(item => linkHrefs(item.text))
    : linkHrefs(note.content);
  return [...new Set(hrefs)].slice(0, MAX_PREVIEWS_PER_NOTE);
}

/** A note whose whole body is one URL, so its preview can stand in for the text. */
export function isBareLinkNote(note: Pick<Note, 'content' | 'checkboxes'>): boolean {
  if (note.checkboxes?.length) return false;
  const segments = linkify(note.content.trim());
  return segments.length === 1 && segments[0].type === 'link' && /^https?:/i.test(segments[0].href);
}

export function hasPreviewContent(preview: LinkPreview | null | undefined): preview is LinkPreview {
  return !!preview && !!(preview.title || preview.imageUrl);
}

function isFresh(cached: CachedLinkPreview, now: number): boolean {
  const ttl = cached.preview ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  return now - cached.fetchedAt < ttl;
}

function isDisabledError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  return candidate?.status === 404 && candidate.code === 'link_previews_disabled';
}

/**
 * Device-local, unsynced preview cache. Keeping previews out of the note record
 * means a background fetch can never race a real edit into a conflict copy.
 */
export class LinkPreviewStore {
  readonly previews = new SvelteMap<string, LinkPreview | null>();
  private readonly requested = new Set<string>();
  private readonly deferred = new Set<string>();
  private readonly queue: string[] = [];
  private active = 0;
  private fetcher: LinkPreviewFetcher | null = null;
  private disabled = false;
  private generation = 0;

  constructor(
    private readonly cache: LinkPreviewCache = indexedDbLinkPreviewCache,
    private readonly now: () => number = Date.now,
  ) {}

  /** Connects the relay. Null pauses fetching; cached previews still render. */
  setFetcher(fetcher: LinkPreviewFetcher | null): void {
    this.fetcher = fetcher;
    this.disabled = false;
    if (!fetcher) return;
    for (const url of this.deferred) this.queue.push(url);
    this.deferred.clear();
    this.pump();
  }

  request(urls: readonly string[]): void {
    for (const url of urls) {
      if (this.requested.has(url)) continue;
      this.requested.add(url);
      this.queue.push(url);
    }
    this.pump();
  }

  async clear(): Promise<void> {
    this.generation += 1;
    this.queue.length = 0;
    this.requested.clear();
    this.deferred.clear();
    this.previews.clear();
    await this.cache.clear();
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_FETCHES && this.queue.length) {
      const url = this.queue.shift()!;
      this.active += 1;
      void this.load(url, this.generation).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async load(url: string, generation: number): Promise<void> {
    let cached: CachedLinkPreview | undefined;
    try {
      cached = await this.cache.get(url);
    } catch {
      cached = undefined;
    }
    if (generation !== this.generation) return;
    if (cached) this.previews.set(url, cached.preview);
    if (cached && isFresh(cached, this.now())) return;

    const fetcher = this.fetcher;
    if (!fetcher || this.disabled) {
      this.deferred.add(url);
      return;
    }
    try {
      const preview = await fetcher(url);
      if (generation !== this.generation) return;
      this.previews.set(url, preview);
      await this.cache.put({ url, preview, fetchedAt: this.now() }).catch(() => undefined);
    } catch (error) {
      if (generation !== this.generation) return;
      // Relay-side failures (offline, rate limited, disabled) are not facts
      // about the page, so they are retried on the next connection instead
      // of being cached.
      if (isDisabledError(error)) this.disabled = true;
      this.deferred.add(url);
    }
  }
}

const DB_NAME = 'unkeep-link-previews';
const STORE = 'previews';

function openPreviewDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'url' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openPreviewDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const indexedDbLinkPreviewCache: LinkPreviewCache = {
  get: url => withStore<CachedLinkPreview | undefined>('readonly', store => store.get(url)),
  put: value => withStore<void>('readwrite', store => store.put(value)),
  clear: () => withStore<void>('readwrite', store => store.clear()),
};

export const linkPreviews = new LinkPreviewStore();
