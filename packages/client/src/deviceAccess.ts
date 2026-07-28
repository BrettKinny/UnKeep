import type { DeviceKeyStore } from './deviceKeys.js';
import type { RelaySessionStore } from './session.js';

/**
 * Destructively disconnect this local device from its current vault.
 * The remembered endpoint and application-owned note data are left intact.
 */
export async function clearDeviceAccess(keyStore:DeviceKeyStore,sessionStore:RelaySessionStore):Promise<void> {
  await sessionStore.clear();
  await keyStore.clearDevice();
}
