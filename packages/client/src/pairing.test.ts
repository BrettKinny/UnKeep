import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvePairingRequest, createPairingRequest, inspectPairingCode, waitForPairing } from './pairing.js';
import { DeviceKeyStore } from './deviceKeys.js';
import { RelaySessionStore } from './session.js';
import { MemoryClientStorage } from './storage.js';
import type { RelaySession } from './relay.js';

const session: RelaySession = {
  endpoint: 'https://relay.example.test',
  instanceId: 'vault-one',
  deviceId: 'owner-device',
  credential: 'owner-credential',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class DeferredReadStorage extends MemoryClientStorage {
  private nextRead: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;

  deferNextRead() {
    this.nextRead = { started: deferred<void>(), release: deferred<void>() };
    return this.nextRead;
  }

  override async get<T>(key: string): Promise<T | null> {
    const pending = this.nextRead;
    if (pending) {
      this.nextRead = null;
      pending.started.resolve(undefined);
      await pending.release.promise;
    }
    return super.get<T>(key);
  }
}

async function approvedPairing(keyStore: DeviceKeyStore) {
  const setupFetch = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      requestId: 'pairing-one',
      code: 'ABCD2345',
      pollSecret: 'poll-secret',
      expiresAt: '2999-01-01T00:00:00.000Z',
    }, 201))
    .mockResolvedValueOnce(jsonResponse({ approved: true }));
  vi.stubGlobal('fetch', setupFetch);
  const pairing = await createPairingRequest(session.endpoint, keyStore, 'New device');
  const creation = JSON.parse(setupFetch.mock.calls[0]![1].body as string) as { publicKey: JsonWebKey };
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  await approvePairingRequest(session, {
    id: pairing.requestId,
    deviceId: await keyStore.getDeviceId(),
    deviceName: 'New device',
    publicKey: creation.publicKey,
    expiresAt: pairing.expiresAt,
    endpoint: pairing.endpoint,
  }, masterKey);
  const approval = JSON.parse(setupFetch.mock.calls[1]![1].body as string) as { response: unknown };
  return { pairing, masterKey, response: approval.response };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pairing approval review', () => {
  it('returns requester identity without approving the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'pairing-one',
      deviceId: 'new-device-id',
      deviceName: 'Brett’s phone',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(inspectPairingCode(session, ' abcd-2345 ')).resolves.toMatchObject({
      id: 'pairing-one',
      deviceId: 'new-device-id',
      deviceName: 'Brett’s phone',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/code/ABCD2345',
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Device owner-credential' }),
    });
  });
});

describe('pairing cancellation', () => {
  it('stops after resolving device identity when cancellation wins that await', async () => {
    const storage = new DeferredReadStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const approved = await approvedPairing(keyStore);
    const deviceIdRead = storage.deferNextRead();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        response: approved.response,
        deviceCredential: 'new-device-credential',
        consumed: false,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await deviceIdRead.started.promise;
    controller.abort();
    deviceIdRead.release.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('stops after decrypting the key when cancellation wins that await', async () => {
    const keyStore = new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const approved = await approvedPairing(keyStore);
    const decryptStarted = deferred<void>();
    const releaseDecrypt = deferred<void>();
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((async (
      ...args: Parameters<SubtleCrypto['decrypt']>
    ) => {
      const result = originalDecrypt(...args);
      decryptStarted.resolve(undefined);
      await releaseDecrypt.promise;
      return result;
    }) as SubtleCrypto['decrypt']);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        response: approved.response,
        deviceCredential: 'new-device-credential',
        consumed: false,
      }))
      .mockResolvedValueOnce(new Response('invalid status response', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await decryptStarted.promise;
    controller.abort();
    releaseDecrypt.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('stops after key derivation when cancellation wins that await', async () => {
    const keyStore = new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const approved = await approvedPairing(keyStore);
    const deriveStarted = deferred<void>();
    const releaseDerive = deferred<void>();
    const originalDerive = crypto.subtle.deriveKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'deriveKey').mockImplementation((async (
      ...args: Parameters<SubtleCrypto['deriveKey']>
    ) => {
      const result = originalDerive(...args);
      deriveStarted.resolve(undefined);
      await releaseDerive.promise;
      return result;
    }) as SubtleCrypto['deriveKey']);
    const invalidResponse = {
      ...(approved.response as Record<string, unknown>),
      ciphertext: 'not-valid-base64%',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      response: invalidResponse,
      deviceCredential: 'new-device-credential',
      consumed: false,
    })));
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await deriveStarted.promise;
    controller.abort();
    releaseDerive.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('persists no vault access when cancelled during relay verification', async () => {
    const keyStore = new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const approved = await approvedPairing(keyStore);
    const status = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        response: approved.response,
        deviceCredential: 'new-device-credential',
        consumed: false,
      }))
      .mockImplementationOnce(() => status.promise)
      .mockResolvedValueOnce(jsonResponse({ consumed: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();
    status.resolve(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('cancels immediately while waiting between approval polls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      response: null,
      deviceCredential: null,
      consumed: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const waiting = waitForPairing({
      requestId: 'pairing-one',
      code: 'ABCD2345',
      pollSecret: 'poll-secret',
      expiresAt: '2030-01-01T00:00:00.000Z',
      privateKey: {} as CryptoKey,
      endpoint: session.endpoint,
    }, {
      keyStore: new DeviceKeyStore(new MemoryClientStorage()),
      sessionStore: new RelaySessionStore(new MemoryClientStorage()),
      signal: controller.signal,
    });
    let rejection: unknown;
    void waiting.catch(error => { rejection = error; });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      controller.abort();
      await Promise.resolve();
      await Promise.resolve();

      expect(rejection).toMatchObject({ name: 'AbortError' });
    } finally {
      await vi.runAllTimersAsync();
      await waiting.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('passes cancellation through to the active relay poll', async () => {
    let resolvePoll!: (response: Response) => void;
    const pendingPoll = new Promise<Response>(resolve => { resolvePoll = resolve; });
    const fetchMock = vi.fn(() => pendingPoll);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const keyStore = new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const waiting = waitForPairing({
      requestId: 'pairing-one',
      code: 'ABCD2345',
      pollSecret: 'poll-secret',
      expiresAt: '2030-01-01T00:00:00.000Z',
      privateKey: {} as CryptoKey,
      endpoint: session.endpoint,
    }, { keyStore, sessionStore, signal: controller.signal });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>)[0]![1]!;
    controller.abort();
    resolvePoll(new Response(JSON.stringify({
      response: null,
      deviceCredential: null,
      consumed: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.signal).toBe(controller.signal);
  });

  it('does not persist vault access when an in-flight approval poll resolves after cancellation', async () => {
    let resolvePoll!: (response: Response) => void;
    const pendingPoll = new Promise<Response>(resolve => { resolvePoll = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        requestId: 'pairing-one',
        code: 'ABCD2345',
        pollSecret: 'poll-secret',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ approved: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockImplementationOnce(() => pendingPoll)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: 1,
        instanceId: 'vault-one',
        initialized: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ consumed: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const keyStore = new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore = new RelaySessionStore(new MemoryClientStorage());
    const pairing = await createPairingRequest(session.endpoint, keyStore, 'New device');
    const creation = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { publicKey: JsonWebKey };
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    await approvePairingRequest(session, {
      id: pairing.requestId,
      deviceId: await keyStore.getDeviceId(),
      deviceName: 'New device',
      publicKey: creation.publicKey,
      expiresAt: pairing.expiresAt,
      endpoint: pairing.endpoint,
    }, masterKey);
    const approval = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as { response: unknown };
    const controller = new AbortController();

    const waiting = waitForPairing(pairing, { keyStore, sessionStore, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();
    resolvePoll(new Response(JSON.stringify({
      response: approval.response,
      deviceCredential: 'new-device-credential',
      consumed: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });
});
