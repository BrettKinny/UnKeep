import { describe, expect, it, vi } from 'vitest';
import { cleanRelayEndpoint, RecordConflictError, RelayClient } from './relay.js';

describe('cleanRelayEndpoint', () => {
  it.each([
    ['https://public.example.com/sync', 'https://public.example.com'],
    ['https://8.8.8.8:8443/path', 'https://8.8.8.8:8443'],
    ['http://localhost:3000/api/v1', 'http://localhost:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://127.42.0.1', 'http://127.42.0.1'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://10.0.0.1', 'http://10.0.0.1'],
    ['http://10.255.255.255', 'http://10.255.255.255'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://172.31.255.255', 'http://172.31.255.255'],
    ['http://192.168.0.1', 'http://192.168.0.1'],
    ['http://unkeep:3000/api/v1', 'http://unkeep:3000'],
    ['http://unkeep.internal:3000', 'http://unkeep.internal:3000'],
    ['http://relay.prod.internal', 'http://relay.prod.internal'],
  ])('accepts %s', (endpoint, origin) => {
    expect(cleanRelayEndpoint(endpoint)).toBe(origin);
  });

  it.each([
    'http://public.example.com',
    'http://8.8.8.8',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.167.255.255',
    'http://192.169.0.1',
    'http://[2001:4860:4860::8888]',
    'http://unkeep.local',
  ])('rejects unsafe plain HTTP endpoint %s with override guidance', endpoint => {
    expect(() => cleanRelayEndpoint(endpoint)).toThrow(/allowInsecure: true/);
  });

  it('allows an unsafe plain HTTP endpoint with an explicit override', () => {
    expect(cleanRelayEndpoint('http://public.example.com/path', { allowInsecure: true })).toBe('http://public.example.com');
    expect(new RelayClient('http://public.example.com/path', { allowInsecure: true }).endpoint).toBe('http://public.example.com');
    expect(new RelayClient('http://public.example.com/path', 'credential', { allowInsecure: true }).endpoint).toBe('http://public.example.com');
  });

  it('rejects unsupported protocols even with the insecure override', () => {
    expect(() => cleanRelayEndpoint('ftp://unkeep', { allowInsecure: true })).toThrow(/HTTP or HTTPS/);
  });
});

describe('RelayClient errors', () => {
  it('exposes typed record-conflict metadata returned by the relay', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'record_conflict',
      currentRevision: 42,
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const error = await new RelayClient('http://localhost:3000', 'credential')
        .putNote('conflicted-note', { baseRevision: 1 })
        .catch(value => value);

      expect(error).toBeInstanceOf(RecordConflictError);
      expect(error).toMatchObject({
        name: 'RecordConflictError',
        status: 409,
        code: 'record_conflict',
        currentRevision: 42,
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('forwards an abort signal to a pairing poll request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      response: null,
      deviceCredential: null,
      consumed: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const controller = new AbortController();
    try {
      await new RelayClient('http://localhost:3000')
        .pollPairing('pairing-one', 'poll-secret', controller.signal);

      expect(fetch.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
    } finally {
      fetch.mockRestore();
    }
  });

  it('forwards an abort signal to relay status', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      protocol: 1,
      instanceId: 'vault-one',
      initialized: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const controller = new AbortController();
    try {
      await new RelayClient('http://localhost:3000').status(controller.signal);

      expect(fetch.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
    } finally {
      fetch.mockRestore();
    }
  });
});
