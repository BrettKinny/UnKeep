import type { RelaySession } from '@unkeep/client';

const CHANNEL_NAME = 'unkeep-vault-access-v1';
const STORAGE_KEY = 'unkeep-vault-access-invalidation';
const MESSAGE_TYPE = 'unkeep-vault-access-invalidated';
const MAX_SEEN_EVENTS = 64;

export type VaultAccessInvalidationKind = 'disconnect' | 'forget';

interface VaultAccessInvalidationMessage {
  type: typeof MESSAGE_TYPE;
  version: 1;
  sourceId: string;
  eventId: string;
  kind: VaultAccessInvalidationKind;
}

interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

interface StorageLike {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VaultAccessInvalidationEnvironment {
  sourceId?: string;
  createBroadcastChannel?: ((name: string) => BroadcastChannelLike) | null;
  storage?: StorageLike | null;
  addStorageListener?: ((listener: (event: StorageEvent) => void) => void) | null;
  removeStorageListener?: ((listener: (event: StorageEvent) => void) => void) | null;
  randomId?: () => string;
}

export interface VaultAccessInvalidationChannel {
  publish(kind: VaultAccessInvalidationKind): void;
  close(): void;
}

export interface VaultAccessInvalidationDecision {
  candidate: RelaySession | null;
  durable: RelaySession | null;
  hasDeviceKeys: boolean;
  accessInFlight: boolean;
  kind: VaultAccessInvalidationKind;
}

function browserEnvironment(): VaultAccessInvalidationEnvironment {
  const browserWindow = typeof window === 'undefined' ? null : window;
  let storage: Storage | null = null;
  try {
    storage = browserWindow?.localStorage ?? null;
  } catch {
    // Storage can be disabled independently of BroadcastChannel.
  }
  return {
    createBroadcastChannel: typeof BroadcastChannel === 'undefined'
      ? null
      : name => new BroadcastChannel(name),
    storage,
    addStorageListener: browserWindow
      ? listener => browserWindow.addEventListener('storage', listener)
      : null,
    removeStorageListener: browserWindow
      ? listener => browserWindow.removeEventListener('storage', listener)
      : null,
  };
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function parseMessage(value: unknown): VaultAccessInvalidationMessage | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<VaultAccessInvalidationMessage>;
  if (
    candidate.type !== MESSAGE_TYPE
    || candidate.version !== 1
    || !validIdentity(candidate.sourceId)
    || !validIdentity(candidate.eventId)
    || (candidate.kind !== 'disconnect' && candidate.kind !== 'forget')
  ) {
    return null;
  }
  return candidate as VaultAccessInvalidationMessage;
}

export function sameVaultAccessSession(
  left: RelaySession | null,
  right: RelaySession | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.endpoint === right.endpoint
    && left.instanceId === right.instanceId
    && left.deviceId === right.deviceId
    && left.credential === right.credential;
}

/**
 * Decide whether a signal describes access that this tab still has in memory.
 * Current durable access always wins: this never asks the receiver to mutate
 * IndexedDB, and an exact replacement is preserved.
 */
export function shouldInvalidateVaultAccess({
  candidate,
  durable,
  hasDeviceKeys,
  accessInFlight,
  kind,
}: VaultAccessInvalidationDecision): boolean {
  if (candidate) return !sameVaultAccessSession(candidate, durable);
  if (durable) return false;
  if (kind === 'forget' && hasDeviceKeys) return false;
  return accessInFlight;
}

/**
 * Cross-tab notification only. Payloads contain an event nonce and intent,
 * never a relay credential, vault identifier, key, note, or endpoint.
 */
export function createVaultAccessInvalidationChannel(
  onInvalidate: (kind: VaultAccessInvalidationKind) => void,
  suppliedEnvironment?: VaultAccessInvalidationEnvironment,
): VaultAccessInvalidationChannel {
  const environment = suppliedEnvironment ?? browserEnvironment();
  const randomId = environment.randomId ?? (() => globalThis.crypto.randomUUID());
  const sourceId = environment.sourceId ?? randomId();
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let closed = false;

  const remember = (eventId: string) => {
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    seenOrder.push(eventId);
    if (seenOrder.length > MAX_SEEN_EVENTS) {
      seen.delete(seenOrder.shift()!);
    }
    return true;
  };

  const receive = (value: unknown) => {
    if (closed) return;
    const message = parseMessage(value);
    if (!message || message.sourceId === sourceId || !remember(message.eventId)) return;
    onInvalidate(message.kind);
  };

  let broadcast: BroadcastChannelLike | null = null;
  try {
    broadcast = environment.createBroadcastChannel?.(CHANNEL_NAME) ?? null;
    if (broadcast) {
      broadcast.onmessage = event => receive(event.data);
    }
  } catch {
    broadcast = null;
  }

  const storageListener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      // Same-origin storage is untrusted input; malformed signals are ignored.
    }
  };
  environment.addStorageListener?.(storageListener);

  return {
    publish(kind) {
      if (closed) return;
      const message: VaultAccessInvalidationMessage = {
        type: MESSAGE_TYPE,
        version: 1,
        sourceId,
        eventId: randomId(),
        kind,
      };
      try {
        broadcast?.postMessage(message);
      } catch {
        // The storage-event path remains available where possible.
      }
      try {
        environment.storage?.setItem(STORAGE_KEY, JSON.stringify(message));
        environment.storage?.removeItem(STORAGE_KEY);
      } catch {
        // BroadcastChannel remains available where possible.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      environment.removeStorageListener?.(storageListener);
      try {
        broadcast?.close();
      } catch {
        // Closing is best-effort during page teardown.
      }
      broadcast = null;
    },
  };
}
