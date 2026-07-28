import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AuthVaultGate.svelte', import.meta.url), 'utf8');

describe('AuthVaultGate recovery paths', () => {
  it('lets a waiting pairing be cancelled back to the connection choice', () => {
    expect(source).toContain('function cancelPairing()');
    expect(source).toContain("view='choose'");
    expect(source).toContain('Cancel pairing');
    expect(source).toContain('abort?.abort()');
  });

  it('keeps recovery-kit selection keyboard operable', () => {
    expect(source).toMatch(/Restore recovery kit[\s\S]*class="sr-only"/);
  });

  it('offers an explicit destructive key-clear path before switching vaults', () => {
    expect(source).toContain('clearDeviceAccess');
    expect(source).toContain('Forget stored vault key and switch');
    expect(source).toContain('window.confirm');
    expect(source).toContain('await onSignedOut?.()');
  });

  it('keeps stored vault access until pending note teardown succeeds', () => {
    const disconnect = source.match(/async function disconnect\(\)\{([^}]*)\}/)?.[1] ?? '';
    const forget = source.match(/async function forgetLocalAccess\(\)\{([^}]*)\}/)?.[1] ?? '';
    const disconnectSection = source.slice(
      source.indexOf('async function disconnect()'),
      source.indexOf('async function forgetLocalAccess()'),
    );

    expect(disconnect.indexOf('await onSignedOut?.()')).toBeLessThan(disconnect.indexOf('await relaySessionStore.clear()'));
    expect(forget.indexOf('await onSignedOut?.()')).toBeLessThan(forget.indexOf('await clearDeviceAccess'));
    expect(disconnectSection).toContain('catch');
  });

  it('shows the requesting device identity before pairing approval', () => {
    expect(source).toContain('inspectPairingCode');
    expect(source).toContain('pendingApproval.deviceName');
    expect(source).toContain('pendingApproval.deviceId');
    expect(source).toContain('approvePairingRequest');
    expect(source).toContain('Review device');
  });
});
