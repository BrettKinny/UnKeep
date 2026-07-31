import type { RelaySession } from '@unkeep/client';
import { describe, expect, it, vi } from 'vitest';
import {
  createVaultAccessInvalidationChannel,
  sameVaultAccessSession,
  shouldInvalidateVaultAccess,
  type VaultAccessInvalidationEnvironment,
} from './vaultAccessInvalidation';

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posts: unknown[] = [];

  constructor(readonly name: string) {
    const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    FakeBroadcastChannel.channels.set(name, channels);
  }

  postMessage(value: unknown): void {
    this.posts.push(value);
    for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel !== this) {
        channel.onmessage?.({ data: structuredClone(value) } as MessageEvent<unknown>);
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function environment(sourceId: string) {
  let listener: ((event: StorageEvent) => void) | null = null;
  const storageWrites: string[] = [];
  const storage = {
    setItem: (key: string, value: string) => {
      storageWrites.push(value);
      listener?.({ key, newValue: value } as StorageEvent);
    },
    removeItem: vi.fn(),
  };
  const env: VaultAccessInvalidationEnvironment = {
    sourceId,
    createBroadcastChannel: name => new FakeBroadcastChannel(name),
    storage,
    addStorageListener: next => { listener = next; },
    removeStorageListener: next => {
      if (listener === next) listener = null;
    },
    randomId: () => `${sourceId}-event`,
  };
  return {
    env,
    storageWrites,
    dispatchStorage: (value: string) => {
      listener?.({
        key: 'unkeep-vault-access-invalidation',
        newValue: value,
      } as StorageEvent);
    },
  };
}

function session(credential: string): RelaySession {
  return {
    endpoint: 'https://notes.example',
    instanceId: 'vault',
    deviceId: 'browser',
    credential,
  };
}

describe('cross-tab vault access invalidation', () => {
  it('delivers a secret-free event over BroadcastChannel', () => {
    FakeBroadcastChannel.channels.clear();
    const first = environment('tab-a');
    const second = environment('tab-b');
    const received = vi.fn();
    const sender = createVaultAccessInvalidationChannel(() => undefined, first.env);
    const receiver = createVaultAccessInvalidationChannel(received, second.env);

    sender.publish('forget');

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith('forget');
    const payload = JSON.parse(first.storageWrites[0]!) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'eventId',
      'kind',
      'sourceId',
      'type',
      'version',
    ]);
    expect(JSON.stringify(payload)).not.toContain('credential');
    expect(JSON.stringify(payload)).not.toContain('masterKey');

    sender.close();
    receiver.close();
  });

  it('ignores malformed, same-tab, duplicate, and post-close messages', () => {
    FakeBroadcastChannel.channels.clear();
    const first = environment('tab-a');
    const second = environment('tab-b');
    const received = vi.fn();
    const sender = createVaultAccessInvalidationChannel(() => undefined, first.env);
    const receiver = createVaultAccessInvalidationChannel(received, second.env);
    const senderTransport = [...FakeBroadcastChannel.channels.values()][0]!
      .values()
      .next()
      .value as FakeBroadcastChannel;

    senderTransport.postMessage({ kind: 'forget' });
    sender.publish('disconnect');
    senderTransport.postMessage(senderTransport.posts.at(-1));
    expect(received).toHaveBeenCalledOnce();

    receiver.close();
    sender.publish('forget');
    expect(received).toHaveBeenCalledOnce();
    sender.close();
  });

  it('falls back to storage events when BroadcastChannel is unavailable', () => {
    const first = environment('tab-a');
    const second = environment('tab-b');
    const received = vi.fn();
    first.env.createBroadcastChannel = null;
    second.env.createBroadcastChannel = null;
    const sender = createVaultAccessInvalidationChannel(() => undefined, first.env);
    const receiver = createVaultAccessInvalidationChannel(received, second.env);

    sender.publish('disconnect');
    second.dispatchStorage(first.storageWrites[0]!);

    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith('disconnect');
    expect(first.storageWrites).toHaveLength(1);
    sender.close();
    receiver.close();
  });

  it('matches exact access while allowing the pending finalization marker to change', () => {
    const pending = { ...session('credential-a'), pendingPairingRequestId: 'pairing' };
    expect(sameVaultAccessSession(pending, session('credential-a'))).toBe(true);
    expect(sameVaultAccessSession(pending, session('credential-b'))).toBe(false);
  });

  it('invalidates stale in-memory access but preserves an exact replacement', () => {
    const oldAccess = session('credential-a');
    const replacement = session('credential-b');

    expect(shouldInvalidateVaultAccess({
      candidate: oldAccess,
      durable: null,
      hasDeviceKeys: true,
      accessInFlight: false,
      kind: 'disconnect',
    })).toBe(true);
    expect(shouldInvalidateVaultAccess({
      candidate: oldAccess,
      durable: replacement,
      hasDeviceKeys: true,
      accessInFlight: false,
      kind: 'forget',
    })).toBe(true);
    expect(shouldInvalidateVaultAccess({
      candidate: replacement,
      durable: replacement,
      hasDeviceKeys: true,
      accessInFlight: false,
      kind: 'forget',
    })).toBe(false);
  });

  it('does not let a stale forget signal discard newly restored local keys', () => {
    expect(shouldInvalidateVaultAccess({
      candidate: null,
      durable: null,
      hasDeviceKeys: true,
      accessInFlight: true,
      kind: 'forget',
    })).toBe(false);
    expect(shouldInvalidateVaultAccess({
      candidate: null,
      durable: null,
      hasDeviceKeys: false,
      accessInFlight: true,
      kind: 'forget',
    })).toBe(true);
  });
});
