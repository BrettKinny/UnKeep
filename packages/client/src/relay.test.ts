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
  it('stages an exact attachment payload under a stable bundle mutation and validates the stage receipt', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      stageHash: 'a'.repeat(64),
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const payload = {
        noteId: 'note-one',
        envelope: { iv: 'iv', ciphertext: 'ciphertext' },
      };
      await expect(new RelayClient('http://localhost:3000', 'credential')
        .stageNoteAttachment('mutation-one', 'attachment-one', payload))
        .resolves.toEqual({ stageHash: 'a'.repeat(64) });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/note-mutations/mutation-one/attachments/attachment-one',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it('rejects a malformed attachment stage receipt', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      stageHash: '../not-a-hash',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      await expect(new RelayClient('http://localhost:3000', 'credential')
        .stageNoteAttachment('mutation-one', 'attachment-one', {
          noteId: 'note-one',
          envelope: {},
        }))
        .rejects.toThrow(/invalid attachment stage receipt/i);
    } finally {
      fetch.mockRestore();
    }
  });

  it('finalizes a staged note bundle and validates its exact revision manifest', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      revision: 12,
      attachmentRevisions: [
        { id: 'attachment-one', revision: 10 },
        { id: 'attachment-two', revision: 11 },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const payload = {
        mutationId: 'mutation-one',
        baseRevision: 3,
        envelope: { iv: 'iv', ciphertext: 'ciphertext' },
        deleted: false as const,
        newAttachments: [
          { id: 'attachment-one', stageHash: 'a'.repeat(64) },
          { id: 'attachment-two', stageHash: 'b'.repeat(64) },
        ],
      };
      await expect(new RelayClient('http://localhost:3000', 'credential')
        .finalizeNoteWithAttachments('note-one', payload))
        .resolves.toEqual({
          revision: 12,
          attachmentRevisions: [
            { id: 'attachment-one', revision: 10 },
            { id: 'attachment-two', revision: 11 },
          ],
        });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/notes/note-one/compound',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it('rejects a final receipt that does not exactly match the requested attachment manifest', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      revision: 8,
      attachmentRevisions: [{ id: 'substituted-attachment', revision: 7 }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      await expect(new RelayClient('http://localhost:3000', 'credential')
        .finalizeNoteWithAttachments('note-one', {
          mutationId: 'mutation-one',
          baseRevision: 0,
          envelope: {},
          deleted: false,
          newAttachments: [{ id: 'attachment-one', stageHash: 'a'.repeat(64) }],
        }))
        .rejects.toThrow(/invalid compound note receipt/i);
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses the device collection endpoint for emergency revoke-all', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    try {
      await new RelayClient(
        'http://localhost:3000',
        'device-credential',
      ).revokeAllDevices();

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/v1/devices',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            authorization: 'Device device-credential',
          }),
        }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it('mints read-only service credentials by default and forwards explicit read-write scope', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      id: 'service-one',
      name: 'Agent',
      scope: 'read-only',
      createdAt: '2026-07-30 00:00:00',
      issuedByDeviceId: 'device-one',
      serviceCredential: 'secret',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const relay = new RelayClient('http://localhost:3000', 'device-credential');
      await relay.mintServiceCredential('Reader');
      await relay.mintServiceCredential('Writer', 'read-write');

      expect(fetch.mock.calls[0]![1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ name: 'Reader', scope: 'read-only' }),
      });
      expect(fetch.mock.calls[1]![1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ name: 'Writer', scope: 'read-write' }),
      });
    } finally {
      fetch.mockRestore();
    }
  });

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

  it('keeps the pairing secret out of the poll URL and forwards cancellation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      instanceId: 'vault-one',
      response: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const controller = new AbortController();
    try {
      await new RelayClient('http://localhost:3000')
        .pollPairing('pairing-one', 'poll-secret', controller.signal);

      expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/api/v1/pairings/pairing-one');
      expect(fetch.mock.calls[0]![1]).toMatchObject({
        signal: controller.signal,
        headers: expect.objectContaining({ 'unkeep-pairing-secret': 'poll-secret' }),
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('binds setup claim and recovery requests to the previously observed relay instance', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      instanceId: 'vault-one',
      deviceCredential: 'credential',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const relay=new RelayClient('http://localhost:3000');
      await relay.claimSetup('setup-token','vault-one','first-device','First device');
      await relay.reclaimSetup('recovery-token','vault-one','recovered-device','Recovered device');

      expect(fetch.mock.calls[0]![1]).toMatchObject({
        body:JSON.stringify({
          expectedInstanceId:'vault-one',
          deviceId:'first-device',
          name:'First device',
        }),
      });
      expect(fetch.mock.calls[1]![1]).toMatchObject({
        body:JSON.stringify({
          expectedInstanceId:'vault-one',
          deviceId:'recovered-device',
          name:'Recovered device',
        }),
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it('cancels a pairing with the poll secret in a header', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 204,
    }));
    try {
      await new RelayClient('http://localhost:3000')
        .cancelPairing('pairing-one', 'poll-secret');

      expect(fetch.mock.calls[0]![0]).toBe('http://localhost:3000/api/v1/pairings/pairing-one');
      expect(fetch.mock.calls[0]![1]).toMatchObject({
        method: 'DELETE',
        headers: expect.objectContaining({ 'unkeep-pairing-secret': 'poll-secret' }),
      });
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
