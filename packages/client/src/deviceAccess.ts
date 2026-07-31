import {
  DEVICE_ID_KEY,
  DEVICE_KEYS_KEY,
  deviceKeyFingerprintKey,
  deviceKeyStoreStorage,
  pairingKeySnapshotsEqual,
  type DeviceKeyStore,
  type PairingKeySnapshot,
} from './deviceKeys.js';
import {
  relaySessionStoreStorage,
  SESSION_KEY,
  type RelaySessionStore,
} from './session.js';
import type { RelaySession } from './relay.js';

export interface PairingAccessStateSnapshot {
  readonly keys: PairingKeySnapshot;
  readonly session: RelaySession | null;
}

export type PairingStorageIsolation = 'shared' | 'externally-serialized';

function sameSession(
  left: RelaySession | null,
  right: RelaySession | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.endpoint === right.endpoint
    && left.instanceId === right.instanceId
    && left.deviceId === right.deviceId
    && left.credential === right.credential
    && left.pendingPairingRequestId === right.pendingPairingRequestId;
}

function requireAtomicPairingStorage(
  keyStore: DeviceKeyStore,
  sessionStore: RelaySessionStore,
  isolation: PairingStorageIsolation,
): {
  keyStorage: ReturnType<typeof deviceKeyStoreStorage>;
  sessionStorage: ReturnType<typeof relaySessionStoreStorage>;
} {
  const keyStorage = deviceKeyStoreStorage(keyStore);
  const sessionStorage = relaySessionStoreStorage(sessionStore);
  if (!keyStorage.transact) {
    throw new Error('Pairing access requires atomic client storage transactions');
  }
  if (keyStorage !== sessionStorage && isolation !== 'externally-serialized') {
    throw new Error('Pairing access requires the same atomic client storage');
  }
  if (!sessionStorage.update) {
    throw new Error('Pairing access requires atomic client storage session updates');
  }
  return { keyStorage, sessionStorage };
}

export function assertPairingStorageCapabilities(
  keyStore: DeviceKeyStore,
  sessionStore: RelaySessionStore,
  isolation: PairingStorageIsolation = 'shared',
): void {
  requireAtomicPairingStorage(keyStore, sessionStore, isolation);
}

export async function snapshotPairingAccessState(
  keyStore: DeviceKeyStore,
  sessionStore: RelaySessionStore,
  instanceId: string,
): Promise<PairingAccessStateSnapshot> {
  const keyStorage = deviceKeyStoreStorage(keyStore);
  const sessionStorage = relaySessionStoreStorage(sessionStore);
  if (keyStorage === sessionStorage && keyStorage.transact) {
    const fingerprintKey = deviceKeyFingerprintKey(instanceId);
    let snapshot: PairingAccessStateSnapshot | undefined;
    await keyStorage.transact!(
      [DEVICE_KEYS_KEY, fingerprintKey, SESSION_KEY],
      transaction => {
        snapshot = {
          keys: {
            storedKeys: transaction.get<PairingKeySnapshot['storedKeys']>(
              DEVICE_KEYS_KEY,
            ),
            fingerprint: transaction.get<string>(fingerprintKey),
          },
          session: transaction.get<RelaySession>(SESSION_KEY),
        };
      },
    );
    return snapshot!;
  }
  const [keys, session] = await Promise.all([
    keyStore.snapshotPairingAccess(instanceId),
    sessionStore.load(),
  ]);
  return { keys, session };
}

async function restoreSessionIfExpected(
  sessionStore: RelaySessionStore,
  previous: RelaySession | null,
  allowedCurrent: readonly (RelaySession | null)[],
): Promise<void> {
  const storage = relaySessionStoreStorage(sessionStore);
  const matches = (current: RelaySession | null) =>
    allowedCurrent.some(allowed => sameSession(current, allowed));
  if (!storage.update) {
    throw new Error('Pairing session rollback requires atomic client storage updates');
  }
  await storage.update<RelaySession>(SESSION_KEY, current => {
    if (!matches(current)) {
      throw new Error('Relay session changed while pairing rollback was pending');
    }
    return previous;
  });
}

export async function installPairingSession(
  keyStore: DeviceKeyStore,
  sessionStore: RelaySessionStore,
  instanceId: string,
  expectedKeys: PairingKeySnapshot,
  allowedSessions: readonly (RelaySession | null)[],
  pairedSession: RelaySession,
  isolation: PairingStorageIsolation = 'shared',
): Promise<void> {
  const { keyStorage, sessionStorage } = requireAtomicPairingStorage(
    keyStore,
    sessionStore,
    isolation,
  );
  const fingerprintKey = deviceKeyFingerprintKey(instanceId);
  const sessionMatches = (current: RelaySession | null) =>
    allowedSessions.some(allowed => sameSession(current, allowed));

  if (keyStorage === sessionStorage) {
    await keyStorage.transact!(
      [DEVICE_KEYS_KEY, fingerprintKey, SESSION_KEY],
      transaction => {
        const currentKeys: PairingKeySnapshot = {
          storedKeys: transaction.get<PairingKeySnapshot['storedKeys']>(
            DEVICE_KEYS_KEY,
          ),
          fingerprint: transaction.get<string>(fingerprintKey),
        };
        const currentSession = transaction.get<RelaySession>(SESSION_KEY);
        if (!pairingKeySnapshotsEqual(currentKeys, expectedKeys)) {
          throw new Error('Device key state changed before pairing session installation');
        }
        if (!sessionMatches(currentSession)) {
          throw new Error('Relay session changed before pairing session installation');
        }
        transaction.set(SESSION_KEY, pairedSession);
      },
    );
    return;
  }

  // The CLI holds one process/file lock across the complete operation and its
  // initializer atomically commits the raw vault key and pending session. The
  // explicit isolation mode prevents other split-store callers from silently
  // receiving a non-atomic security guarantee.
  const currentKeys = await keyStore.snapshotPairingAccess(instanceId);
  if (!pairingKeySnapshotsEqual(currentKeys, expectedKeys)) {
    throw new Error('Device key state changed before pairing session installation');
  }
  await sessionStorage.update!<RelaySession>(SESSION_KEY, current => {
    if (!sessionMatches(current)) {
      throw new Error('Relay session changed before pairing session installation');
    }
    return pairedSession;
  });
}

export async function restorePairingAccessState(
  keyStore: DeviceKeyStore,
  sessionStore: RelaySessionStore,
  instanceId: string,
  previous: PairingAccessStateSnapshot,
  expectedKeys: PairingKeySnapshot,
  allowedSessions: readonly (RelaySession | null)[],
  isolation: PairingStorageIsolation = 'shared',
): Promise<void> {
  const { keyStorage, sessionStorage } = requireAtomicPairingStorage(
    keyStore,
    sessionStore,
    isolation,
  );
  if (keyStorage === sessionStorage) {
    const fingerprintKey = deviceKeyFingerprintKey(instanceId);
    await keyStorage.transact!(
      [DEVICE_KEYS_KEY, fingerprintKey, SESSION_KEY],
      transaction => {
        const currentKeys: PairingKeySnapshot = {
          storedKeys: transaction.get<PairingKeySnapshot['storedKeys']>(
            DEVICE_KEYS_KEY,
          ),
          fingerprint: transaction.get<string>(fingerprintKey),
        };
        const currentSession = transaction.get<RelaySession>(SESSION_KEY);
        if (!pairingKeySnapshotsEqual(currentKeys, expectedKeys)) {
          throw new Error('Device key state changed while pairing rollback was pending');
        }
        if (!allowedSessions.some(allowed => sameSession(currentSession, allowed))) {
          throw new Error('Relay session changed while pairing rollback was pending');
        }
        if (previous.keys.storedKeys) {
          transaction.set(DEVICE_KEYS_KEY, previous.keys.storedKeys);
        } else {
          transaction.delete(DEVICE_KEYS_KEY);
        }
        if (previous.keys.fingerprint) {
          transaction.set(fingerprintKey, previous.keys.fingerprint);
        } else {
          transaction.delete(fingerprintKey);
        }
        if (previous.session) transaction.set(SESSION_KEY, previous.session);
        else transaction.delete(SESSION_KEY);
      },
    );
    return;
  }

  const outcomes = await Promise.allSettled([
    keyStore.restorePairingAccess(previous.keys, instanceId, expectedKeys),
    restoreSessionIfExpected(sessionStore, previous.session, allowedSessions),
  ]);
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected')
    .map(outcome => outcome.reason);
  if (failures.length) {
    throw new AggregateError(
      failures,
      'Failed to restore prior pairing access state',
    );
  }
}

/**
 * Destructively disconnect this local device from its current vault.
 * The remembered endpoint and application-owned note data are left intact.
 */
export async function clearDeviceAccess(keyStore:DeviceKeyStore,sessionStore:RelaySessionStore):Promise<void> {
  const keyStorage = deviceKeyStoreStorage(keyStore);
  const sessionStorage = relaySessionStoreStorage(sessionStore);
  if (keyStorage !== sessionStorage) {
    throw new Error('Clearing device access requires the same atomic client storage');
  }
  if (!keyStorage.transact) {
    throw new Error('Clearing device access requires atomic client storage transactions');
  }
  await keyStorage.transact(
    [SESSION_KEY, DEVICE_KEYS_KEY, DEVICE_ID_KEY],
    transaction => {
      transaction.delete(SESSION_KEY);
      transaction.delete(DEVICE_KEYS_KEY);
      transaction.delete(DEVICE_ID_KEY);
    },
  );
}
