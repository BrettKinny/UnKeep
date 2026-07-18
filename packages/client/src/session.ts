import { cleanRelayEndpoint, type RelaySession } from './relay.js';
import type { ClientStorage } from './storage.js';

const SESSION_KEY = 'unkeep-relay-session';
const ENDPOINT_KEY = 'unkeep-relay-endpoint';

export class RelaySessionStore {
  constructor(private readonly storage: ClientStorage) {}

  load(): Promise<RelaySession | null> {
    return this.storage.get<RelaySession>(SESSION_KEY);
  }

  save(session: RelaySession): Promise<void> {
    return this.storage.set(SESSION_KEY, session);
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
