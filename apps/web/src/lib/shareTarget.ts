// Receives content shared into UnKeep from outside the app.
//
// Two delivery paths land on /share:
// - iOS Shortcut ("Save to UnKeep"): content is URL-encoded into the fragment
//   (`/share#<encoded text>` or `/share#text=...&title=...`), so it never
//   leaves the browser.
// - Android/Chrome share sheet (manifest share_target, method POST): the
//   service worker turns the form body into a fragment without forwarding it
//   to the relay.
//
// The share page asks for confirmation before stashing the payload. Pending
// shares stay in localStorage until the selected vault has saved them durably.

import { nanoid } from 'nanoid';
import { MAX_SHARE_PAYLOAD_CHARACTERS } from './shareLimits';

export { MAX_SHARE_PAYLOAD_CHARACTERS } from './shareLimits';

export interface SharePayload {
  title: string;
  text: string;
}

export interface PendingShare extends SharePayload {
  id: string;
  targetInstanceId: string | null;
  createdAt: number;
}

const PENDING_SHARES_KEY = 'unkeep-pending-shares';
const PENDING_SHARE_PREFIX = 'unkeep-pending-share:';
export const MAX_PENDING_SHARES = 20;

function validPayload(payload: SharePayload): boolean {
  return payload.title.length + payload.text.length <= MAX_SHARE_PAYLOAD_CHARACTERS;
}

export function parseSharePayload(search: string, hash: string): SharePayload | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (fragment) {
    // `key=value` fragments are parsed as params; anything else is treated as
    // bare URL-encoded text, which keeps the iOS Shortcut a single action:
    // Open URL `…/share#` + URL-encoded shortcut input.
    if (fragment.includes('=')) {
      const payload = fromParams(new URLSearchParams(fragment));
      if (payload) return payload;
    }
    try {
      const text = decodeURIComponent(fragment).trim();
      if (text && validPayload({ title: '', text })) return { title: '', text };
    } catch {
      return null;
    }
  }
  return fromParams(new URLSearchParams(search));
}

function fromParams(params: URLSearchParams): SharePayload | null {
  const title = params.get('title')?.trim() ?? '';
  const text = params.get('text')?.trim() ?? '';
  const url = params.get('url')?.trim() ?? '';
  const content = [text, url].filter(Boolean).join('\n');
  if (!content && !title) return null;
  const payload = { title, text: content };
  return validPayload(payload) ? payload : null;
}

export function stashPendingShare(
  payload: SharePayload,
  targetInstanceId: string | null = null,
): PendingShare {
  if (!validPayload(payload)) throw new Error('The shared content is too large for UnKeep');
  const share: PendingShare = {
    ...payload,
    id: nanoid(),
    targetInstanceId,
    createdAt: Date.now(),
  };
  const pending = listPendingShares();
  if (pending.length >= MAX_PENDING_SHARES) {
    throw new Error('Too many shared notes are already waiting to be saved');
  }
  localStorage.setItem(pendingShareKey(share.id), JSON.stringify(share));
  return share;
}

export function listPendingShares(): PendingShare[] {
  migrateLegacyPendingShares();
  const shares: PendingShare[] = [];
  const keys = new Set<string>();
  // localStorage has no snapshot API. Re-scan once so an entry added while
  // keys are being enumerated is normally visible immediately; every record
  // remains durable for a later scan even under more adversarial timing.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(PENDING_SHARE_PREFIX)) keys.add(key);
    }
  }
  for (const key of keys) {
    const share = readPendingShareRecord(key);
    if (share) shares.push(share);
  }
  return shares.sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function removePendingShares(ids: Iterable<string>): void {
  migrateLegacyPendingShares();
  for (const id of new Set(ids)) {
    if (typeof id === 'string' && id) localStorage.removeItem(pendingShareKey(id));
  }
}

function pendingShareKey(id: string): string {
  return `${PENDING_SHARE_PREFIX}${id}`;
}

function validPendingShare(value: unknown): value is PendingShare {
  if (!value || typeof value !== 'object') return false;
  const share = value as Partial<PendingShare>;
  return typeof share.id === 'string'
    && /^[A-Za-z0-9_-]+$/.test(share.id)
    && typeof share.title === 'string'
    && typeof share.text === 'string'
    && validPayload({ title: share.title, text: share.text })
    && (share.targetInstanceId === null || typeof share.targetInstanceId === 'string')
    && typeof share.createdAt === 'number'
    && Number.isFinite(share.createdAt);
}

function readPendingShareRecord(key: string): PendingShare | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!validPendingShare(value) || key !== pendingShareKey(value.id)) return null;
    return value;
  } catch {
    return null;
  }
}

function normalizeLegacyPendingShares(raw: unknown[]): {
  shares: PendingShare[];
  normalized: boolean;
} {
  let normalized = false;
  const shares = raw.flatMap((value, index): PendingShare[] => {
    if (
      typeof value !== 'object' || value === null
      || typeof (value as SharePayload).title !== 'string'
      || typeof (value as SharePayload).text !== 'string'
    ) return [];
    const candidate = value as Partial<PendingShare> & SharePayload;
    if (!validPayload(candidate)) return [];
    const id = typeof candidate.id === 'string' && /^[A-Za-z0-9_-]+$/.test(candidate.id)
      ? candidate.id
      : `legacy-${index}`;
    const targetInstanceId = typeof candidate.targetInstanceId === 'string'
      ? candidate.targetInstanceId
      : null;
    const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? candidate.createdAt
      : 0;
    if (
      id !== candidate.id
      || targetInstanceId !== candidate.targetInstanceId
      || createdAt !== candidate.createdAt
    ) normalized = true;
    return [{ id, targetInstanceId, createdAt, title: candidate.title, text: candidate.text }];
  });
  if (shares.length !== raw.length) normalized = true;
  return { shares, normalized };
}

function migrateLegacyPendingShares(): void {
  const serialized = localStorage.getItem(PENDING_SHARES_KEY);
  if (serialized === null) return;
  try {
    const raw = JSON.parse(serialized);
    if (!Array.isArray(raw)) {
      localStorage.removeItem(PENDING_SHARES_KEY);
      return;
    }
    const pending = normalizeLegacyPendingShares(raw);
    // Persist generated IDs/timestamps first. If the browser stops while
    // copying individual records, the next migration retries the same keys.
    if (pending.normalized) {
      localStorage.setItem(PENDING_SHARES_KEY, JSON.stringify(pending.shares));
    }
    for (const share of pending.shares) {
      const key = pendingShareKey(share.id);
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify(share));
      }
    }
    localStorage.removeItem(PENDING_SHARES_KEY);
  } catch {
    // Invalid legacy state is not a valid share and must not block new
    // per-record queue entries.
    localStorage.removeItem(PENDING_SHARES_KEY);
  }
}
