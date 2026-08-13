import { describe, expect, it } from 'vitest';
import { MAX_SHARE_POST_BYTES } from './shareLimits';
import { redirectSharedPost } from './serviceWorkerShare';

const origin = 'https://notes.example';

function post(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request(`${origin}/share`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...headers,
    },
  });
}

describe('service-worker share POST handling', () => {
  it('moves accepted form fields into a fragment without a query string', async () => {
    const response = await redirectSharedPost(
      post('title=%20Heading%20&text=Body&url=https%3A%2F%2Fexample.com'),
      origin,
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${origin}/share`);
    expect(location.search).toBe('');
    expect(new URLSearchParams(location.hash.slice(1))).toEqual(new URLSearchParams({
      title: 'Heading',
      text: 'Body',
      url: 'https://example.com',
    }));
  });

  it('rejects unsupported content types before consuming the body', async () => {
    const request = post('title=private', { 'content-type': 'text/plain' });
    const response = await redirectSharedPost(request, origin);

    expect(response.status).toBe(415);
    expect(request.bodyUsed).toBe(false);
  });

  it('rejects an excessive declared length before consuming the body', async () => {
    const request = post('title=private', {
      'content-length': String(MAX_SHARE_POST_BYTES + 1),
    });
    const response = await redirectSharedPost(request, origin);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it('stops streaming once an undeclared body crosses the byte limit', async () => {
    const request = post('x'.repeat(MAX_SHARE_POST_BYTES + 1));
    const response = await redirectSharedPost(request, origin);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(true);
  });

  it('rejects malformed UTF-8 and decoded payloads over the semantic limit', async () => {
    const malformed = await redirectSharedPost(post(new Uint8Array([0xff])), origin);
    expect(malformed.status).toBe(400);

    const excessive = await redirectSharedPost(post(`text=${'x'.repeat(256_001)}`), origin);
    expect(excessive.status).toBe(413);
  });
});
