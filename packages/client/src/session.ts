import { cleanRelayEndpoint, type RelaySession } from './relay.js';
import type { ClientStorage } from './storage.js';

export const SESSION_KEY = 'unkeep-relay-session';
const ENDPOINT_KEY = 'unkeep-relay-endpoint';
const relaySessionStoreBackings = new WeakMap<RelaySessionStore, ClientStorage>();

export function relaySessionStoreStorage(
  sessionStore: RelaySessionStore,
): ClientStorage {
  const storage = relaySessionStoreBackings.get(sessionStore);
  if (!storage) throw new Error('Relay session store is not initialized');
  return storage;
}

export class RelaySessionStore {
  constructor(private readonly storage: ClientStorage) {
    relaySessionStoreBackings.set(this, storage);
  }

  load(): Promise<RelaySession | null> {
    return this.storage.get<RelaySession>(SESSION_KEY);
  }

  save(session: RelaySession): Promise<void> {
    return this.storage.set(SESSION_KEY, session);
  }

  /**
   * Clear a pairing resume marker only if the same session is still current.
   * Supported stores perform this as one atomic update so a concurrent local
   * disconnect cannot be undone by a late consume response.
   */
  async completePairingFinalization(expected: RelaySession): Promise<RelaySession | null> {
    if (!expected.pendingPairingRequestId) return expected;
    const { pendingPairingRequestId: _, ...finalized } = expected;
    const matches = (current: RelaySession | null) => Boolean(
      current
      && current.pendingPairingRequestId === expected.pendingPairingRequestId
      && current.endpoint === expected.endpoint
      && current.instanceId === expected.instanceId
      && current.deviceId === expected.deviceId
      && current.credential === expected.credential
    );

    if (!this.storage.update) {
      throw new Error('Pairing finalization requires atomic client storage updates');
    }
    let result: RelaySession | null = null;
    await this.storage.update<RelaySession>(SESSION_KEY, current => {
      if (!matches(current)) {
        result = current;
        return current;
      }
      result = finalized;
      return finalized;
    });
    return result;
  }

  clear(): Promise<void> {
    return this.storage.delete(SESSION_KEY);
  }

  async defaultEndpoint(fallback: string): Promise<string> {
    return await this.storage.get<string>(ENDPOINT_KEY) ?? fallback;
  }

  saveEndpoint(endpoint: string): Promise<void> {
    return this.storage.set(ENDPOINT_KEY, cleanRelayEndpoint(endpoint));
  }
}
