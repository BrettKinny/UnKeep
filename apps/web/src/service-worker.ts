/// <reference lib="webworker" />

import { build, files, prerendered, version } from '$service-worker';
import { redirectSharedParams, redirectSharedPost } from './lib/serviceWorkerShare';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = `unkeep-${version}`;
const APP_SHELL = [...new Set([...build, ...files, ...prerendered])];

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await worker.clients.claim();
  })());
});

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;

  // The installed Android share target POSTs into the service worker. Convert
  // the form to a fragment locally so note content never reaches relay or
  // reverse-proxy request logs. Also absorb legacy GET share targets locally.
  if (url.pathname === '/share' && event.request.method === 'POST') {
    event.respondWith(redirectSharedPost(event.request, worker.location.origin));
    return;
  }
  if (url.pathname === '/share' && event.request.method === 'GET' && url.search) {
    event.respondWith(redirectSharedParams(url.searchParams, worker.location.origin));
    return;
  }

  if (event.request.method !== 'GET') return;

  // API state must always come from the relay. Replaying cached setup,
  // credential, pairing, or sync responses would be both stale and unsafe.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  event.respondWith(cacheFirst(event.request));
});

async function networkFirstNavigation(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const cacheKey = new Request(`${requestUrl.origin}${requestUrl.pathname}`);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    return await caches.match(cacheKey)
      ?? await caches.match('/')
      ?? Response.error();
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}
