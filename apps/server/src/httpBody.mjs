const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export class HttpRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpRequestError';
    this.status = status;
    this.code = code;
  }
}

function requestTooLarge() {
  return new HttpRequestError(413, 'Request too large');
}

export function assertJsonContentType(request) {
  const contentTypeHeader = request.headers?.['content-type'];
  const contentType = (Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0]
    : contentTypeHeader
  )?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpRequestError(415, 'unsupported_media_type');
  }
}

export async function readJsonObject(request, limit) {
  assertJsonContentType(request);
  const declaredLength = Number(request.headers?.['content-length']);
  if (Number.isSafeInteger(declaredLength) && declaredLength > limit) {
    throw requestTooLarge();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw requestTooLarge();
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};

  let parsed;
  try {
    const text = utf8Decoder.decode(Buffer.concat(chunks));
    parsed = JSON.parse(text);
  } catch {
    throw new HttpRequestError(400, 'invalid_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRequestError(400, 'invalid_json');
  }
  return parsed;
}
