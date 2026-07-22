// Receives content shared into UnKeep from outside the app.
//
// Two delivery paths land on /share:
// - iOS Shortcut ("Save to UnKeep"): content is URL-encoded into the fragment
//   (`/share#<encoded text>` or `/share#text=...&title=...`), so it never
//   leaves the browser.
// - Android/Chrome share sheet (manifest share_target, method GET): content
//   arrives as `?title=...&text=...&url=...` query params.
//
// Saving requires the vault to be unlocked, so the share page stashes the
// payload in localStorage and redirects to `/`, which drains the stash once
// the note store is ready.

export interface SharePayload {
  title: string;
  text: string;
}

const PENDING_SHARES_KEY = 'unkeep-pending-shares';

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
      if (text) return { title: '', text };
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
  return { title, text: content };
}

export function stashPendingShare(payload: SharePayload): void {
  const pending = readPending();
  pending.push(payload);
  localStorage.setItem(PENDING_SHARES_KEY, JSON.stringify(pending));
}

export function takePendingShares(): SharePayload[] {
  const pending = readPending();
  if (pending.length) localStorage.removeItem(PENDING_SHARES_KEY);
  return pending;
}

function readPending(): SharePayload[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_SHARES_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is SharePayload =>
        typeof p === 'object' && p !== null &&
        typeof (p as SharePayload).title === 'string' &&
        typeof (p as SharePayload).text === 'string'
    );
  } catch {
    return [];
  }
}
