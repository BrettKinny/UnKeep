import {
  MAX_SHARE_PAYLOAD_CHARACTERS,
  MAX_SHARE_POST_BYTES,
} from './shareLimits';

class SharePostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SharePostError';
  }
}

export async function redirectSharedPost(
  request: Request,
  origin: string,
): Promise<Response> {
  try {
    const params = await readSharedPostParams(request);
    return redirectSharedParams(params, origin);
  } catch (error) {
    if (error instanceof SharePostError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response('The shared content could not be read.', { status: 400 });
  }
}

export function redirectSharedParams(
  params: URLSearchParams,
  origin: string,
): Response {
  const fragment = new URLSearchParams();
  let totalLength = 0;
  for (const key of ['title', 'text', 'url']) {
    const value = params.get(key)?.trim() ?? '';
    totalLength += value.length;
    if (value) fragment.set(key, value);
  }
  if (totalLength > MAX_SHARE_PAYLOAD_CHARACTERS) {
    return new Response('The shared content is too large for UnKeep.', { status: 413 });
  }
  const target = new URL('/share', origin);
  if (fragment.size) target.hash = fragment.toString();
  return Response.redirect(target, 303);
}

async function readSharedPostParams(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new SharePostError(
      415,
      'The shared content must use application/x-www-form-urlencoded.',
    );
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength)) {
      throw new SharePostError(400, 'The shared content has an invalid length.');
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new SharePostError(400, 'The shared content has an invalid length.');
    }
    if (parsedLength > MAX_SHARE_POST_BYTES) {
      throw new SharePostError(413, 'The shared content is too large for UnKeep.');
    }
  }

  if (!request.body) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SHARE_POST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SharePostError(413, 'The shared content is too large for UnKeep.');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SharePostError(400, 'The shared content is not valid UTF-8.');
  }
  return new URLSearchParams(decoded);
}
