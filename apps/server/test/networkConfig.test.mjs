import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listenHostForUrl,
  validatedListenHost,
} from '../src/networkConfig.mjs';

test('defaults direct relay startup to IPv4 loopback', () => {
  assert.equal(validatedListenHost(undefined), '127.0.0.1');
  assert.equal(validatedListenHost(''), '127.0.0.1');
});

test('accepts explicit IP literals and safe DNS hostnames', () => {
  assert.equal(validatedListenHost('0.0.0.0'), '0.0.0.0');
  assert.equal(validatedListenHost('::'), '::');
  assert.equal(validatedListenHost('::1'), '::1');
  assert.equal(validatedListenHost('LOCALHOST'), 'localhost');
  assert.equal(validatedListenHost('unkeep.internal'), 'unkeep.internal');
  assert.equal(listenHostForUrl('::1'), '[::1]');
  assert.equal(listenHostForUrl('127.0.0.1'), '127.0.0.1');
});

test('rejects ambiguous, unsafe, and log-injecting listen hosts', () => {
  for (const value of [
    '0',
    '127.1',
    '*',
    '[::1]',
    ' localhost',
    'localhost ',
    'local_host',
    '-unkeep.local',
    'unkeep-.local',
    'unkeep..local',
    'unkeep.local\nforged-log',
    `unkeep.${'a'.repeat(64)}`,
    'a'.repeat(254),
  ]) {
    assert.throws(
      () => validatedListenHost(value),
      /UNKEEP_HOST must be an IP literal or ASCII DNS hostname without whitespace/,
      value,
    );
  }
});
