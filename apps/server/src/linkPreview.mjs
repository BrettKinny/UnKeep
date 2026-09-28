import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const MAX_LINK_PREVIEW_URL_LENGTH = 2_048;
export const MAX_LINK_PREVIEW_TITLE_LENGTH = 300;
export const MAX_LINK_PREVIEW_SITE_NAME_LENGTH = 100;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_HTML_BYTES = 1024 * 1024;
// Many sites (Reddit, WordPress security plugins) only serve Open Graph tags to
// recognised preview crawlers. Lead with the de facto preview token but keep
// an honest product identifier.
const USER_AGENT = 'facebookexternalhit/1.1 (compatible; UnKeep-LinkPreview/1.0; +https://github.com/BrettKinny/UnKeep)';

// Previews are fetched on behalf of an authenticated device, but the URL is
// untrusted note content. Refuse every non-public destination so a note (or an
// agent that wrote one) cannot turn the relay into a probe of the LAN.
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) blockedAddresses.addSubnet(network, prefix, 'ipv6');

function embeddedIpv4(address) {
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses reach
  // the embedded IPv4 destination, so they inherit its classification.
  const match = address.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (!match) return null;
  if (match[1]) return match[1];
  const high = parseInt(match[2], 16);
  const low = parseInt(match[3], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = embeddedIpv4(address);
  if (mapped) return isPublicAddress(mapped);
  return !blockedAddresses.check(address, 'ipv6');
}

const TRANSIENT_ERRORS = new Set(['upstream_unavailable', 'timeout', 'fetch_failed']);

export class LinkPreviewError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LinkPreviewError';
    this.code = code;
  }

  /** True when retrying later may succeed, so clients should not cache the miss. */
  get transient() {
    return TRANSIENT_ERRORS.has(this.code);
  }
}

/** Returns a canonical http(s) URL safe to request, or null. */
export function normalizePreviewTarget(value, { anyPort = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_LINK_PREVIEW_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!anyPort && url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) return null;
  url.hash = '';
  return url;
}

function guardedLookup(isAllowedAddress, lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      // Reject the whole name if any answer is private: the socket may try
      // every address, and a mixed answer is a classic rebinding setup.
      if (!addresses.length || addresses.some(entry => !isAllowedAddress(entry.address))) {
        return callback(new LinkPreviewError('forbidden_address'));
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function decoderFor(label) {
  try {
    return new TextDecoder(label || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

function responseCharset(contentType, bytes) {
  const header = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (header) return header;
  const head = bytes.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
}

function readBody(response, maxBytes) {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  let stream = response;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
  else if (encoding && encoding !== 'identity') {
    response.destroy();
    return Promise.reject(new LinkPreviewError('unsupported_encoding'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      response.destroy();
      resolve(Buffer.concat(chunks));
    };
    stream.on('data', chunk => {
      if (settled) return;
      const remaining = maxBytes - size;
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      size += Math.min(chunk.length, remaining);
      // Metadata lives in <head>; stop downloading once it has closed or the
      // cap is reached. Truncation is not an error for a best-effort preview.
      if (size >= maxBytes || /<\/head\s*>/i.test(chunk.toString('latin1'))) finish();
    });
    stream.on('end', finish);
    stream.on('error', error => {
      if (settled) return;
      settled = true;
      response.destroy();
      reject(error);
    });
  });
}

function fetchOnce(url, { lookup, signal, maxHtmlBytes }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      lookup,
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.5,*/*;q=0.1',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en;q=0.9,*;q=0.5',
        'user-agent': USER_AGENT,
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: response.headers.location });
        return;
      }
      if (status !== 200) {
        response.resume();
        // Throttling and server errors say nothing lasting about the page.
        reject(new LinkPreviewError(status === 429 || status >= 500 ? 'upstream_unavailable' : 'upstream_status'));
        return;
      }
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      if (contentType.startsWith('image/')) {
        response.destroy();
        resolve({ contentType, body: null });
        return;
      }
      if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml+xml')) {
        response.destroy();
        reject(new LinkPreviewError('unsupported_content_type'));
        return;
      }
      readBody(response, maxHtmlBytes)
        .then(body => resolve({ contentType, body }))
        .catch(reject);
    });
    request.on('error', reject);
    request.end();
  });
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function cleanText(value, maximumLength) {
  if (!value) return undefined;
  // Strip control characters and collapse layout whitespace. The client
  // renders these as text nodes, so no markup escaping is needed here.
  const text = decodeEntities(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > maximumLength ? `${text.slice(0, maximumLength - 1)}…` : text;
}

function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s"'=<>/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of tag.replace(/^<\w+|\/?>$/g, '').matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!(name in attributes)) attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function previewImageUrl(value, baseUrl) {
  if (!value) return undefined;
  try {
    const url = new URL(decodeEntities(value.trim()), baseUrl);
    // The PWA may only load https: images; upgrading http: is best-effort
    // and the browser simply shows no thumbnail if the host does not serve it.
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    const href = url.href;
    return href.length <= MAX_LINK_PREVIEW_URL_LENGTH ? href : undefined;
  } catch {
    return undefined;
  }
}

export function parseHtmlPreview(html, pageUrl) {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const meta = new Map();
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag);
    const key = (attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    if (key && attributes.content !== undefined && !meta.has(key)) meta.set(key, attributes.content);
  }
  let imageSrcLink;
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag);
    if ((attributes.rel || '').toLowerCase().split(/\s+/).includes('image_src')) {
      imageSrcLink = attributes.href;
      break;
    }
  }
  const documentTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const url = new URL(pageUrl);
  const title = cleanText(
    meta.get('og:title') || meta.get('twitter:title') || documentTitle || meta.get('title'),
    MAX_LINK_PREVIEW_TITLE_LENGTH,
  );
  const siteName = cleanText(
    meta.get('og:site_name') || meta.get('application-name'),
    MAX_LINK_PREVIEW_SITE_NAME_LENGTH,
  );
  const imageUrl = previewImageUrl(
    meta.get('og:image:secure_url')
      || meta.get('og:image')
      || meta.get('og:image:url')
      || meta.get('twitter:image')
      || meta.get('twitter:image:src')
      || meta.get('image')
      || imageSrcLink,
    url,
  );
  return {
    ...(title ? { title } : {}),
    ...(siteName ? { siteName } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

export function createLinkPreviewFetcher({
  isAllowedAddress = isPublicAddress,
  lookup = dnsLookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxHtmlBytes = DEFAULT_MAX_HTML_BYTES,
  // Test seam only: loopback fixtures cannot listen on 80/443.
  anyPort = false,
} = {}) {
  const connectLookup = guardedLookup(isAllowedAddress, lookup);

  return async function fetchLinkPreview(target) {
    let url = normalizePreviewTarget(target, { anyPort });
    if (!url) throw new LinkPreviewError('invalid_url');
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Node skips the lookup hook for IP literals, so check them here.
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) && !isAllowedAddress(literal)) throw new LinkPreviewError('forbidden_address');
      let result;
      try {
        result = await fetchOnce(url, { lookup: connectLookup, signal, maxHtmlBytes });
      } catch (error) {
        if (error instanceof LinkPreviewError) throw error;
        if (error?.cause instanceof LinkPreviewError) throw error.cause;
        throw new LinkPreviewError(signal.aborted ? 'timeout' : 'fetch_failed');
      }
      if (result.redirect !== undefined) {
        let next;
        try {
          next = normalizePreviewTarget(new URL(result.redirect, url).href, { anyPort });
        } catch {
          next = null;
        }
        if (!next) throw new LinkPreviewError('invalid_redirect');
        url = next;
        continue;
      }
      if (result.body === null) {
        const imageUrl = previewImageUrl(url.href, url);
        return imageUrl ? { imageUrl } : {};
      }
      const html = decoderFor(responseCharset(result.contentType, result.body)).decode(result.body);
      return parseHtmlPreview(html, url.href);
    }
    throw new LinkPreviewError('too_many_redirects');
  };
}
