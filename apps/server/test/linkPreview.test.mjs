import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import {
  createLinkPreviewFetcher,
  isPublicAddress,
  normalizePreviewTarget,
  parseHtmlPreview,
} from '../src/linkPreview.mjs';
import { startTestServer } from './harness.mjs';

const SETUP_TOKEN = 'test-setup-token-0000000000000001';

async function startSite(handler) {
  const site = createServer(handler);
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${site.address().port}`,
    close: () => new Promise(resolve => site.close(resolve)),
  };
}

// Test sites listen on loopback on an ephemeral port, both of which the real
// policy forbids. Relax exactly those two checks.
function loopbackFetcher(options = {}) {
  return createLinkPreviewFetcher({
    isAllowedAddress: address => address === '127.0.0.1' || isPublicAddress(address),
    anyPort: true,
    ...options,
  });
}

test('classifies private, local, and special-purpose addresses as non-public', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '64:ff9b::a00:1',
    '2002:c0a8:101::1', 'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '142.250.70.206', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('only default-port http(s) URLs without credentials are preview targets', () => {
  assert.equal(normalizePreviewTarget('https://example.com/a#frag')?.href, 'https://example.com/a');
  assert.equal(normalizePreviewTarget('http://example.com:80/')?.href, 'http://example.com/');
  for (const value of [
    'ftp://example.com/', 'file:///etc/passwd', 'https://user:pw@example.com/',
    'https://example.com:8443/', 'http://example.com:22/', 'javascript:alert(1)', '',
    `https://example.com/${'a'.repeat(2_100)}`, 42,
  ]) {
    assert.equal(normalizePreviewTarget(value), null, String(value).slice(0, 40));
  }
});

test('parses Open Graph metadata with fallbacks, entities, and relative images', () => {
  assert.deepEqual(parseHtmlPreview(`<!doctype html><html><head>
    <title>Ignored  title</title>
    <meta property="og:title" content="Tom &amp; Jerry&#39;s &#x2014; Show">
    <meta content='Example Site' property='og:site_name'>
    <meta property="og:image" content="/img/cover.jpg?x=1&amp;y=2">
  </head><body><meta property="og:title" content="body is ignored"></body></html>`, 'https://example.com/post/1'), {
    title: "Tom & Jerry's — Show",
    siteName: 'Example Site',
    imageUrl: 'https://example.com/img/cover.jpg?x=1&y=2',
  });
  assert.deepEqual(parseHtmlPreview(`<head><title>
    Plain   title </title><meta name="twitter:image" content="http://cdn.example.com/a.png"></head>`, 'https://example.com/'), {
    title: 'Plain title',
    imageUrl: 'https://cdn.example.com/a.png',
  });
  assert.deepEqual(
    parseHtmlPreview('<head><meta property="og:image" content="javascript:alert(1)"></head>', 'https://example.com/'),
    {},
  );
  const long = parseHtmlPreview(`<head><title>${'x'.repeat(500)}</title></head>`, 'https://example.com/');
  assert.equal(long.title.length, 300);
});

test('fetches through redirects, decompresses, and stops at the size cap', async t => {
  const site = await startSite((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/page' });
      res.end();
    } else if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(gzipSync('<head><meta property="og:title" content="Café"><meta property="og:image" content="https://img.example.com/c.jpg"></head>'));
    } else if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(10));
    } else if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write(`<head><title>Huge</title>${' '.repeat(64 * 1024)}`);
      res.write(' '.repeat(64 * 1024));
      res.end('</head>');
    } else if (req.url === '/busy') {
      res.writeHead(429);
      res.end();
    } else if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  t.after(site.close);
  const fetchPreview = loopbackFetcher({ maxHtmlBytes: 1024 });

  assert.deepEqual(await fetchPreview(`${site.origin}/start`), {
    title: 'Café',
    imageUrl: 'https://img.example.com/c.jpg',
  });
  assert.deepEqual(await fetchPreview(`${site.origin}/image`), {
    imageUrl: `${site.origin.replace('http:', 'https:')}/image`,
  });
  assert.deepEqual(await fetchPreview(`${site.origin}/huge`), { title: 'Huge' });
  await assert.rejects(fetchPreview(`${site.origin}/json`), { code: 'unsupported_content_type' });
  await assert.rejects(fetchPreview(`${site.origin}/missing`), { code: 'upstream_status', transient: false });
  await assert.rejects(fetchPreview(`${site.origin}/busy`), { code: 'upstream_unavailable', transient: true });
});

test('the default policy refuses loopback, LAN names, and rebinding answers', async () => {
  const fetchPreview = createLinkPreviewFetcher();
  await assert.rejects(fetchPreview('http://127.0.0.1/'), { code: 'forbidden_address' });
  await assert.rejects(fetchPreview('http://[::1]/'), { code: 'forbidden_address' });
  await assert.rejects(fetchPreview('http://192.168.1.1/'), { code: 'forbidden_address' });
  await assert.rejects(fetchPreview('http://169.254.169.254/latest/meta-data/'), { code: 'forbidden_address' });
  await assert.rejects(fetchPreview('http://localhost/'), { code: 'forbidden_address' });
  await assert.rejects(fetchPreview('http://127.0.0.1:3000/'), { code: 'invalid_url' });

  // A public-looking name with any private answer is refused at connect time.
  const rebinding = createLinkPreviewFetcher({
    lookup: (hostname, options, callback) => callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]),
  });
  await assert.rejects(rebinding('http://public.example/'), { code: 'forbidden_address' });
});

test('redirects into the LAN are refused before the private hop is requested', async t => {
  let privateRequests = 0;
  const lan = await startSite((req, res) => {
    privateRequests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>router admin</title>');
  });
  t.after(lan.close);
  const redirector = await startSite((req, res) => {
    // Named host so the hop goes through the guarded lookup, not the literal check.
    res.writeHead(302, { location: `http://router.lan:${new URL(lan.origin).port}/` });
    res.end();
  });
  t.after(redirector.close);
  const fetchPreview = loopbackFetcher({
    lookup: (hostname, options, callback) => callback(null, [{
      address: hostname === 'router.lan' ? '192.168.1.1' : '127.0.0.1',
      family: 4,
    }]),
  });
  await assert.rejects(fetchPreview(`http://public.example:${new URL(redirector.origin).port}/`), {
    code: 'forbidden_address',
  });
  assert.equal(privateRequests, 0);
});

test('the relay endpoint is disabled by default and device-only when enabled', async t => {
  const disabled = await startTestServer({ setupToken: SETUP_TOKEN });
  t.after(disabled.stop);
  let response = await fetch(`${disabled.endpoint}/setup/claim`, {
    method: 'POST',
    headers: { authorization: `Setup ${SETUP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedInstanceId: disabled.instanceId, deviceId: 'device-one', name: 'Test' }),
  });
  let claimed = await response.json();
  response = await fetch(`${disabled.endpoint}/link-preview`, {
    method: 'POST',
    headers: { authorization: `Device ${claimed.deviceCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'link_previews_disabled' });

  const site = await startSite((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<head><meta property="og:title" content="Hello"></head>');
  });
  t.after(site.close);
  const relay = await startTestServer({
    setupToken: SETUP_TOKEN,
    env: { UNKEEP_LINK_PREVIEWS: '1', UNKEEP_TEST_LINK_PREVIEW_ALLOW_ALL: '1' },
  });
  t.after(relay.stop);
  response = await fetch(`${relay.endpoint}/setup/claim`, {
    method: 'POST',
    headers: { authorization: `Setup ${SETUP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedInstanceId: relay.instanceId, deviceId: 'device-one', name: 'Test' }),
  });
  claimed = await response.json();
  const deviceHeaders = { authorization: `Device ${claimed.deviceCredential}`, 'content-type': 'application/json' };

  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST', headers: deviceHeaders, body: JSON.stringify({ name: 'Agent', scope: 'read-write' }),
  });
  const { serviceCredential } = await response.json();
  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST',
    headers: { authorization: `Service ${serviceCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST', headers: deviceHeaders, body: JSON.stringify({ url: 'mailto:someone@example.com' }),
  });
  assert.equal(response.status, 400);

  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST', headers: deviceHeaders, body: JSON.stringify({ url: `${site.origin}/` }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { preview: { title: 'Hello' } });

  // A page that cannot be previewed gets a cacheable null preview; a network
  // failure is reported as retryable instead.
  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST', headers: deviceHeaders, body: JSON.stringify({ url: `${site.origin}/missing` }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { preview: null });
  response = await fetch(`${relay.endpoint}/link-preview`, {
    method: 'POST', headers: deviceHeaders, body: JSON.stringify({ url: 'http://no-such-host.invalid/' }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'link_preview_unavailable' });
});
