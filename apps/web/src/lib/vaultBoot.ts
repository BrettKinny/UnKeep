import type { RelaySession } from '@unkeep/client';

interface SessionLoader {
  load(): Promise<RelaySession | null>;
}

interface DeviceKeyUnlocker {
  unlockDevice(): Promise<Uint8Array<ArrayBuffer> | null>;
}

export interface LocalVault {
  session: RelaySession;
  masterKey: Uint8Array<ArrayBuffer>;
}

/**
 * Load everything required to open the local working copy. Deliberately has
 * no relay client dependency: network reachability is a sync concern, not an
 * unlock prerequisite.
 */
export async function loadLocalVault(
  sessions: SessionLoader,
  keys: DeviceKeyUnlocker,
): Promise<LocalVault | null> {
  const [session, masterKey] = await Promise.all([
    sessions.load(),
    keys.unlockDevice(),
  ]);
  return session && masterKey ? { session, masterKey } : null;
}
