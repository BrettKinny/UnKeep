import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySecurityHeaders,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
} from '../src/httpSecurity.mjs';

test('sets a fail-closed browser policy without pretending plaintext transport is HTTPS', () => {
  const actual = new Map();
  applySecurityHeaders({
    setHeader(name, value) {
      actual.set(name, value);
    },
  });

  assert.deepEqual(Object.fromEntries(actual), SECURITY_HEADERS);
  assert.match(CONTENT_SECURITY_POLICY, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /(?:^|; )object-src 'none'(?:;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /(?:^|; )script-src-attr 'none'(?:;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /(?:^|; )base-uri 'none'(?:;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /(?:^|; )form-action 'none'(?:;|$)/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /upgrade-insecure-requests/);
  assert.equal('strict-transport-security' in SECURITY_HEADERS, false);
});
