import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { assertJsonContentType, readJsonObject } from '../src/httpBody.mjs';

function request(chunks, contentLength, contentType = 'application/json') {
  const stream = Readable.from(chunks);
  stream.headers = {
    ...(contentLength === undefined ? {} : { 'content-length': String(contentLength) }),
    ...(contentType === null ? {} : { 'content-type': contentType }),
  };
  return stream;
}

test('accepts an empty body or one JSON object', async () => {
  assert.deepEqual(await readJsonObject(request([]), 32), {});
  assert.deepEqual(
    await readJsonObject(request([Buffer.from('{"deviceId":"one"}')]), 32),
    { deviceId: 'one' },
  );
});

test('rejects malformed UTF-8, malformed JSON, and non-object JSON', async () => {
  for (const chunks of [
    [Buffer.from([0xc3, 0x28])],
    [Buffer.from('{"broken"')],
    [Buffer.from('null')],
    [Buffer.from('[]')],
    [Buffer.from('"text"')],
  ]) {
    await assert.rejects(
      readJsonObject(request(chunks), 32),
      error => error?.status === 400 && error?.code === 'invalid_json',
    );
  }
});

test('requires an application/json media type before consuming a body', async () => {
  for (const contentType of [null, 'text/plain', 'application/x-www-form-urlencoded']) {
    assert.throws(
      () => assertJsonContentType(request([], undefined, contentType)),
      error => error?.status === 415 && error?.code === 'unsupported_media_type',
    );
    await assert.rejects(
      readJsonObject(request([Buffer.from('{}')], undefined, contentType), 32),
      error => error?.status === 415 && error?.code === 'unsupported_media_type',
    );
  }
  assert.deepEqual(
    await readJsonObject(request([Buffer.from('{}')], undefined, 'Application/JSON; charset=utf-8'), 32),
    {},
  );
});

test('rejects both declared and streamed bodies beyond the endpoint limit', async () => {
  await assert.rejects(
    readJsonObject(request([], 33), 32),
    error => error?.status === 413 && error?.code === 'Request too large',
  );
  await assert.rejects(
    readJsonObject(request([Buffer.alloc(20), Buffer.alloc(13)]), 32),
    error => error?.status === 413 && error?.code === 'Request too large',
  );
});
