import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvePairingRequest,
  createPairingRequest,
  inspectPairingCode,
  pairingFingerprint,
  resumePairingFinalization,
  waitForPairing,
} from './pairing.js';
import { clearDeviceAccess } from './deviceAccess.js';
import {
  DEVICE_ID_KEY,
  DeviceKeyStore,
  deviceKeyFingerprintKey,
} from './deviceKeys.js';
import { RelaySessionStore } from './session.js';
import { MemoryClientStorage } from './storage.js';
import type { RelaySession } from './relay.js';

const session: RelaySession = {
  endpoint: 'https://relay.example.test',
  instanceId: 'vault-one',
  deviceId: 'owner-device',
  credential: 'owner-credential',
};
const VALID_PAIRING_PUBLIC_KEY:JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'TVC4DDeSdLtCXIcq4O3JN23gk9PQGNby_E1GyWuqEdk',
  y: 'wqByzVBixoTLN9eZYpkKJTON632EX5KTuqyGhA_XjY4',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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

class DeferredWriteStorage extends MemoryClientStorage {
  private nextWrite: {
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;

  deferNextWrite() {
    this.nextWrite = { started: deferred<void>(), release: deferred<void>() };
    return this.nextWrite;
  }

  override async set<T>(key: string, value: T): Promise<void> {
    const pending = this.nextWrite;
    if (pending) {
      this.nextWrite = null;
      pending.started.resolve(undefined);
      await pending.release.promise;
    }
    await super.set(key, value);
  }
}

class DeferredTransactionStorage extends MemoryClientStorage {
  private nextTransaction: {
    matches: (keys: readonly string[]) => boolean;
    skipMatches: number;
    started: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;

  deferNextTransactionMatching(
    matches: (keys: readonly string[]) => boolean,
    skipMatches = 0,
  ) {
    this.nextTransaction = {
      matches,
      skipMatches,
      started: deferred<void>(),
      release: deferred<void>(),
    };
    return this.nextTransaction;
  }

  override async transact(
    keys: readonly string[],
    change: Parameters<MemoryClientStorage['transact']>[1],
  ): Promise<void> {
    const pending = this.nextTransaction;
    if (pending?.matches(keys)) {
      if (pending.skipMatches > 0) {
        pending.skipMatches -= 1;
        await super.transact(keys, change);
        return;
      }
      this.nextTransaction = null;
      pending.started.resolve(undefined);
      await pending.release.promise;
    }
    await super.transact(keys, change);
  }
}

class FailingTransactionStorage extends MemoryClientStorage {
  failNextTransaction = false;

  override transact(
    keys: readonly string[],
    change: Parameters<MemoryClientStorage['transact']>[1],
  ): Promise<void> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      return Promise.reject(new Error('injected transaction failure'));
    }
    return super.transact(keys, change);
  }
}

async function approvedPairing(keyStore: DeviceKeyStore) {
  const setupFetch = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      protocol: 1,
      instanceId: session.instanceId,
      initialized: true,
    }))
    .mockResolvedValueOnce(jsonResponse({
      requestId: 'pairing-one',
      code: 'ABCD2345',
      pollSecret: 'poll-secret',
      expiresAt: '2999-01-01T00:00:00.000Z',
      instanceId: session.instanceId,
    }, 201))
    .mockResolvedValueOnce(jsonResponse({ approved: true }));
  vi.stubGlobal('fetch', setupFetch);
  const pairing = await createPairingRequest(session.endpoint, keyStore, 'New device');
  const creation = JSON.parse(setupFetch.mock.calls[1]![1].body as string) as { publicKey: JsonWebKey };
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  await approvePairingRequest(session, {
    id: pairing.requestId,
    instanceId: pairing.instanceId,
    deviceId: await keyStore.getDeviceId(),
    deviceName: 'New device',
    publicKey: creation.publicKey,
    expiresAt: pairing.expiresAt,
    endpoint: pairing.endpoint,
    fingerprint: pairing.fingerprint,
  }, masterKey);
  const approval = JSON.parse(setupFetch.mock.calls[2]![1].body as string) as { response: unknown };
  return { pairing, masterKey, response: approval.response };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pairing approval review', () => {
  it('derives a deterministic fingerprint locally while returning requester identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'pairing-one',
      instanceId: session.instanceId,
      deviceId: 'new-device-id',
      deviceName: 'Brett’s phone',
      publicKey: VALID_PAIRING_PUBLIC_KEY,
      fingerprint: 'SERVER-CONTROLLED-VALUE',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const reviewed = await inspectPairingCode(session, ' abcd-2345 ');
    expect(reviewed).toMatchObject({
      id: 'pairing-one',
      deviceId: 'new-device-id',
      deviceName: 'Brett’s phone',
    });
    expect(reviewed.fingerprint).toMatch(/^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(reviewed.fingerprint).not.toBe('SERVER-CONTROLLED-VALUE');
    await expect(pairingFingerprint(
      session.instanceId,
      'pairing-one',
      'new-device-id',
      VALID_PAIRING_PUBLIC_KEY,
    )).resolves.toBe('7DEY-MEY8-WM55-RZA2');
    expect(reviewed.fingerprint).toBe('7DEY-MEY8-WM55-RZA2');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/code/ABCD2345',
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Device owner-credential' }),
    });
  });

  it('shows a different locally derived fingerprint when a relay substitutes the requester key', async () => {
    const attackerPair=await crypto.subtle.generateKey(
      {name:'ECDH',namedCurve:'P-256'},
      true,
      ['deriveKey'],
    );
    const attackerPublicKey=await crypto.subtle.exportKey('jwk',attackerPair.publicKey);
    const storage=new MemoryClientStorage();
    const keyStore=new DeviceKeyStore(storage);
    const deviceId=await keyStore.getDeviceId();
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        protocol:1,
        instanceId:session.instanceId,
        initialized:true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        requestId:'pairing-substitution',
        code:'ABCD2345',
        pollSecret:'poll-secret',
        expiresAt:'2999-01-01T00:00:00.000Z',
        instanceId:session.instanceId,
        fingerprint:'FORGED-BY-RELAY',
      },201))
      .mockResolvedValueOnce(jsonResponse({
        id:'pairing-substitution',
        instanceId:session.instanceId,
        deviceId,
        deviceName:'New device',
        publicKey:attackerPublicKey,
        expiresAt:'2999-01-01T00:00:00.000Z',
        fingerprint:'FORGED-BY-RELAY',
      }));
    vi.stubGlobal('fetch',fetchMock);

    const requester=await createPairingRequest(session.endpoint,keyStore,'New device');
    const approver=await inspectPairingCode(session,requester.code);

    expect(requester.fingerprint).toMatch(/^[A-HJ-NP-Z2-9-]{19}$/);
    expect(approver.fingerprint).toMatch(/^[A-HJ-NP-Z2-9-]{19}$/);
    expect(approver.fingerprint).not.toBe(requester.fingerprint);
    expect(requester.fingerprint).not.toBe('FORGED-BY-RELAY');
    expect(approver.fingerprint).not.toBe('FORGED-BY-RELAY');
  });

  it('creates and retains the raw device credential locally while sending only its hash', async () => {
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        protocol:1,
        instanceId:session.instanceId,
        initialized:true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        requestId:'hash-only-pairing',
        code:'ABCD2345',
        pollSecret:'poll-secret',
        expiresAt:'2999-01-01T00:00:00.000Z',
        instanceId:session.instanceId,
      },201));
    vi.stubGlobal('fetch',fetchMock);

    const pairing=await createPairingRequest(
      session.endpoint,
      new DeviceKeyStore(new MemoryClientStorage()),
      'Hash-only device',
    );
    const body=JSON.parse(fetchMock.mock.calls[1]![1].body as string) as Record<string,unknown>;
    const expectedHash=Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(pairing.deviceCredential),
    )),byte=>byte.toString(16).padStart(2,'0')).join('');

    expect(pairing.deviceCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({
      expectedInstanceId:session.instanceId,
      deviceCredentialHash:expectedHash,
    });
    expect(JSON.stringify(body)).not.toContain(pairing.deviceCredential);
    expect(body).not.toHaveProperty('deviceCredential');
  });

  it('rejects a pairing create response misrouted from another relay instance', async () => {
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        protocol:1,
        instanceId:session.instanceId,
        initialized:true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        requestId:'misrouted-pairing',
        code:'ABCD2345',
        pollSecret:'poll-secret',
        expiresAt:'2999-01-01T00:00:00.000Z',
        instanceId:'vault-two',
      },201));
    vi.stubGlobal('fetch',fetchMock);

    await expect(createPairingRequest(
      session.endpoint,
      new DeviceKeyStore(new MemoryClientStorage()),
      'Misrouted device',
    )).rejects.toThrow('Relay instance changed during pairing');
  });

  it('rejects a request from another relay instance before displaying or approving it', async () => {
    const fetchMock=vi.fn().mockResolvedValue(jsonResponse({
      id:'foreign-pairing',
      instanceId:'vault-two',
      deviceId:'foreign-device',
      deviceName:'Foreign device',
      publicKey:VALID_PAIRING_PUBLIC_KEY,
      expiresAt:'2999-01-01T00:00:00.000Z',
    }));
    vi.stubGlobal('fetch',fetchMock);

    await expect(inspectPairingCode(session,'ABCD2345'))
      .rejects.toThrow('different relay instance');

    fetchMock.mockClear();
    await expect(approvePairingRequest(session,{
      id:'foreign-pairing',
      instanceId:'vault-two',
      deviceId:'foreign-device',
      deviceName:'Foreign device',
      publicKey:VALID_PAIRING_PUBLIC_KEY,
      expiresAt:'2999-01-01T00:00:00.000Z',
      endpoint:session.endpoint,
      fingerprint:'ABCD-EFGH-JKLM-NPQR',
    },crypto.getRandomValues(new Uint8Array(32))))
      .rejects.toThrow('different relay instance');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pairing cancellation', () => {
  it('rejects a key-transfer response authenticated for a different relay instance', async () => {
    const keyStore=new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore=new RelaySessionStore(new MemoryClientStorage());
    const approved=await approvedPairing(keyStore);
    vi.stubGlobal('fetch',vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId:'vault-two',
        response:approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({})));

    await expect(waitForPairing({
      ...approved.pairing,
      instanceId:'vault-two',
    },{keyStore,sessionStore})).rejects.toBeDefined();
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('persists no access when the relay instance changes after approval', async () => {
    const keyStore=new DeviceKeyStore(new MemoryClientStorage());
    const sessionStore=new RelaySessionStore(new MemoryClientStorage());
    const approved=await approvedPairing(keyStore);
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId:session.instanceId,
        response:approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol:1,
        instanceId:'vault-two',
        initialized:true,
      }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch',fetchMock);

    await expect(waitForPairing(approved.pairing,{keyStore,sessionStore}))
      .rejects.toThrow('Relay instance changed during pairing');
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
    expect(fetchMock.mock.calls[2]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/pairing-one',
    );
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({method:'DELETE'});
  });

  it('rolls back newly introduced access when cancelled during key persistence', async () => {
    const storage = new DeferredTransactionStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const keyWrite = storage.deferNextTransactionMatching(keys =>
      keys.includes(DEVICE_ID_KEY)
      && keys.includes(deviceKeyFingerprintKey(session.instanceId)),
    );
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true })));
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await keyWrite.started.promise;
    controller.abort();
    keyWrite.release.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('atomically restores shared key and session state when initialization fails', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockResolvedValueOnce(jsonResponse({})));

    await expect(waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      initialize: () => {
        throw new Error('local vault failed');
      },
    })).rejects.toThrow('local vault failed');

    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(keyStore.snapshotPairingAccess(session.instanceId))
      .resolves.toEqual({ storedKeys: null, fingerprint: null });
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('does not resurrect access cleared while initialization is in flight', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const initialization = deferred<void>();
    const initializationStarted = deferred<void>();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockResolvedValueOnce(jsonResponse({})));

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      signal: controller.signal,
      initialize: () => {
        initializationStarted.resolve(undefined);
        return initialization.promise;
      },
    });
    await initializationStarted.promise;
    await clearDeviceAccess(keyStore, sessionStore);
    controller.abort();
    initialization.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Pairing failed and prior access could not be fully restored',
    });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
    await expect(keyStore.getDeviceId()).resolves.not.toBe(
      approved.pairing.deviceId,
    );
  });

  it('does not resurrect or consume access cleared while successful initialization is in flight', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const initialization = deferred<void>();
    const initializationStarted = deferred<void>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      initialize: () => {
        initializationStarted.resolve(undefined);
        return initialization.promise;
      },
    });
    await initializationStarted.promise;
    await clearDeviceAccess(keyStore, sessionStore);
    initialization.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Pairing failed and prior access could not be fully restored',
    });
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).endsWith('/pairing-one/consume'))).toBe(false);
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
    await expect(keyStore.getDeviceId()).resolves.not.toBe(
      approved.pairing.deviceId,
    );
  });

  it('does not expose a torn rollback when its shared transaction fails', async () => {
    const storage = new FailingTransactionStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockResolvedValueOnce(jsonResponse({})));

    await expect(waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      initialize: () => {
        storage.failNextTransaction = true;
        throw new Error('local vault failed');
      },
    })).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Pairing failed and prior access could not be fully restored',
    });

    await expect(keyStore.unlockDevice(session.instanceId))
      .resolves.toEqual(approved.masterKey);
    await expect(keyStore.snapshotPairingAccess(session.instanceId))
      .resolves.toMatchObject({
        storedKeys: expect.objectContaining({
          instanceId: session.instanceId,
          deviceId: approved.pairing.deviceId,
        }),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('rolls back newly introduced access when cancelled during session persistence', async () => {
    const storage = new DeferredTransactionStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const sessionWrite = storage.deferNextTransactionMatching(
      keys => keys.includes('unkeep-relay-session')
        && keys.includes(deviceKeyFingerprintKey(session.instanceId)),
      1,
    );
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true })));
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await sessionWrite.started.promise;
    controller.abort();
    sessionWrite.release.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('finishes the non-abortable server commit once durable local access is ready', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    await keyStore.persistPairedMasterKey(approved.masterKey, session.instanceId);
    await sessionStore.save(session);
    const consume = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockImplementationOnce(() => consume.promise);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const consumeRequest = fetchMock.mock.calls[2]![1] as RequestInit;
    controller.abort();
    consume.resolve(jsonResponse({ consumed: true }));

    const result = await waiting;
    expect(consumeRequest.signal).toBeUndefined();
    await expect(keyStore.unlockDevice(session.instanceId)).resolves.toEqual(approved.masterKey);
    await expect(sessionStore.load()).resolves.toEqual(result.session);
    expect(result.session.credential).toBe(approved.pairing.deviceCredential);
  });

  it('preserves durable access and a resume marker when pairing consumption is ambiguous', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ error: 'consume_failed' }, 500)));

    const result=await waitForPairing(approved.pairing,{keyStore,sessionStore});
    expect(result.finalizationPending).toBe(true);
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(true);
    await expect(sessionStore.load()).resolves.toMatchObject({
      credential:approved.pairing.deviceCredential,
      pendingPairingRequestId:'pairing-one',
    });
  });

  it('rolls back access when cancelled during local vault initialization', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const initialization = deferred<void>();
    const initializationStarted = deferred<void>();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true })));
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      signal: controller.signal,
      initialize: () => {
        initializationStarted.resolve(undefined);
        return initialization.promise;
      },
    });
    await initializationStarted.promise;
    await expect(sessionStore.load()).resolves.toBeNull();
    controller.abort();
    initialization.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('does not activate the server device until local initialization succeeds', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const initialization = deferred<void>();
    const initializationStarted = deferred<void>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true }));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      initialize: () => {
        initializationStarted.resolve(undefined);
        return initialization.promise;
      },
    });
    await initializationStarted.promise;
    await expect(sessionStore.load()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    initialization.resolve(undefined);
    await waiting;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/pairing-one/consume',
    );
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: 'POST' });
  });

  it('rolls back access when local vault initialization fails', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockResolvedValueOnce(jsonResponse({ consumed: true })));

    await expect(waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
      initialize: () => { throw new Error('local vault failed'); },
    })).rejects.toThrow('local vault failed');
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('resumes finalization after restart when the consume response and verification are lost', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({ protocol: 1, instanceId: 'vault-one', initialized: true }))
      .mockRejectedValueOnce(new TypeError('consume response lost'))
      .mockRejectedValueOnce(new TypeError('relay temporarily unreachable')));

    const interrupted=await waitForPairing(approved.pairing,{keyStore,sessionStore});
    expect(interrupted.finalizationPending).toBe(true);
    await expect(sessionStore.load()).resolves.toMatchObject({
      pendingPairingRequestId:'pairing-one',
    });

    // A new process/session-store instance retries the same request and
    // receives the relay's idempotent consumed receipt.
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(jsonResponse({
      consumed:true,
      alreadyConsumed:true,
    })));
    const restartedStore=new RelaySessionStore(storage);
    const finalized=await resumePairingFinalization(restartedStore);

    expect(finalized).not.toHaveProperty('pendingPairingRequestId');
    await expect(restartedStore.load()).resolves.toEqual(finalized);
    await expect(keyStore.unlockDevice(session.instanceId)).resolves.toEqual(approved.masterKey);
  });

  it('does not resurrect a session cleared while finalization is in flight', async () => {
    const sessionStore=new RelaySessionStore(new MemoryClientStorage());
    await sessionStore.save({...session,pendingPairingRequestId:'pairing-one'});
    const consume=deferred<Response>();
    const fetchMock=vi.fn().mockImplementationOnce(()=>consume.promise);
    vi.stubGlobal('fetch',fetchMock);

    const resuming=resumePairingFinalization(sessionStore);
    await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalledOnce());
    await sessionStore.clear();
    consume.resolve(jsonResponse({consumed:true}));

    await expect(resuming).resolves.toBeNull();
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('does not return a replacement session as the result of another pairing finalization', async () => {
    const sessionStore=new RelaySessionStore(new MemoryClientStorage());
    await sessionStore.save({...session,pendingPairingRequestId:'pairing-one'});
    const consume=deferred<Response>();
    const fetchMock=vi.fn().mockImplementationOnce(()=>consume.promise);
    vi.stubGlobal('fetch',fetchMock);
    const replacement: RelaySession = {
      endpoint: 'https://replacement.example.test',
      instanceId: 'replacement-vault',
      deviceId: 'replacement-device',
      credential: 'replacement-credential',
    };

    const resuming=resumePairingFinalization(sessionStore);
    await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalledOnce());
    await sessionStore.save(replacement);
    consume.resolve(jsonResponse({consumed:true}));

    await expect(resuming).resolves.toBeNull();
    await expect(sessionStore.load()).resolves.toEqual(replacement);
  });

  it('does not report ready and revokes best-effort when access is cleared during consume', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const consume = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockImplementationOnce(() => consume.promise)
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await clearDeviceAccess(keyStore, sessionStore);
    consume.resolve(jsonResponse({ consumed: true }));

    await expect(waiting).rejects.toMatchObject({
      name: 'PairingLocalStateChangedError',
      message: 'Pairing local access changed during finalization',
    });
    expect(fetchMock.mock.calls[3]![0]).toBe(
      `https://relay.example.test/api/v1/devices/${approved.pairing.deviceId}`,
    );
    expect(fetchMock.mock.calls[3]![1]).toMatchObject({ method: 'DELETE' });
    expect(fetchMock.mock.calls[4]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/pairing-one',
    );
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('does not mix the paired key with a replacement session installed during consume', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const consume = deferred<Response>();
    const replacement: RelaySession = {
      endpoint: 'https://replacement.example.test',
      instanceId: 'replacement-vault',
      deviceId: 'replacement-device',
      credential: 'replacement-credential',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockImplementationOnce(() => consume.promise)
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await sessionStore.save(replacement);
    consume.resolve(jsonResponse({ consumed: true }));

    await expect(waiting).rejects.toMatchObject({
      name: 'PairingLocalStateChangedError',
      message: 'Pairing local access changed during finalization',
    });
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes('/api/v1/devices/'))).toBe(false);
    await expect(sessionStore.load()).resolves.toEqual(replacement);
  });

  it('does not report pending-ready when access is cleared during an ambiguous consume', async () => {
    const storage = new MemoryClientStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const consume = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }))
      .mockImplementationOnce(() => consume.promise)
      .mockRejectedValueOnce(new TypeError('verification unreachable'))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForPairing(approved.pairing, {
      keyStore,
      sessionStore,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await clearDeviceAccess(keyStore, sessionStore);
    consume.reject(new TypeError('consume response lost'));

    await expect(waiting).rejects.toMatchObject({
      name: 'PairingLocalStateChangedError',
      message: 'Pairing local access changed during finalization',
    });
    expect(fetchMock.mock.calls[4]![0]).toBe(
      `https://relay.example.test/api/v1/devices/${approved.pairing.deviceId}`,
    );
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it('stops after resolving device identity when cancellation wins that await', async () => {
    const storage = new DeferredReadStorage();
    const keyStore = new DeviceKeyStore(storage);
    const sessionStore = new RelaySessionStore(storage);
    const approved = await approvedPairing(keyStore);
    const deviceIdRead = storage.deferNextRead();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        instanceId: session.instanceId,
        response: approved.response,
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
        instanceId: session.instanceId,
        response: approved.response,
      }))
      .mockResolvedValueOnce(new Response('invalid status response', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const waiting = waitForPairing(approved.pairing, { keyStore, sessionStore, signal: controller.signal });
    await decryptStarted.promise;
    controller.abort();
    releaseDecrypt.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      'https://relay.example.test/api/v1/pairings/pairing-one',
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'unkeep-pairing-secret': 'poll-secret' }),
    });
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
      instanceId: session.instanceId,
      response: invalidResponse,
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
        instanceId: session.instanceId,
        response: approved.response,
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
      instanceId: session.instanceId,
      response: null,
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
      instanceId: session.instanceId,
      deviceId: 'local-device',
      deviceCredential: 'local-device-credential',
      fingerprint: 'ABCD-EFGH-JKLM-NPQR',
    }, {
      keyStore: new DeviceKeyStore(new MemoryClientStorage()),
      sessionStore: new RelaySessionStore(new MemoryClientStorage()),
      signal: controller.signal,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]![1]).toMatchObject({
        method: 'DELETE',
        headers: expect.objectContaining({ 'unkeep-pairing-secret': 'poll-secret' }),
      });
    } finally {
      await vi.runAllTimersAsync();
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
      instanceId: session.instanceId,
      deviceId: 'local-device',
      deviceCredential: 'local-device-credential',
      fingerprint: 'ABCD-EFGH-JKLM-NPQR',
    }, { keyStore, sessionStore, signal: controller.signal });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>)[0]![1]!;
    controller.abort();
    resolvePoll(new Response(JSON.stringify({
      instanceId: session.instanceId,
      response: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.signal).toBe(controller.signal);
  });

  it('does not persist vault access when an in-flight approval poll resolves after cancellation', async () => {
    let resolvePoll!: (response: Response) => void;
    const pendingPoll = new Promise<Response>(resolve => { resolvePoll = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol: 1,
        instanceId: session.instanceId,
        initialized: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        requestId: 'pairing-one',
        code: 'ABCD2345',
        pollSecret: 'poll-secret',
        expiresAt: '2030-01-01T00:00:00.000Z',
        instanceId: session.instanceId,
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
    const creation = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as { publicKey: JsonWebKey };
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    await approvePairingRequest(session, {
      id: pairing.requestId,
      instanceId: pairing.instanceId,
      deviceId: await keyStore.getDeviceId(),
      deviceName: 'New device',
      publicKey: creation.publicKey,
      expiresAt: pairing.expiresAt,
      endpoint: pairing.endpoint,
      fingerprint: pairing.fingerprint,
    }, masterKey);
    const approval = JSON.parse(fetchMock.mock.calls[2]![1].body as string) as { response: unknown };
    const controller = new AbortController();

    const waiting = waitForPairing(pairing, { keyStore, sessionStore, signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    controller.abort();
    resolvePoll(new Response(JSON.stringify({
      instanceId: session.instanceId,
      response: approval.response,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(keyStore.hasDeviceKeys()).resolves.toBe(false);
    await expect(sessionStore.load()).resolves.toBeNull();
  });
});
