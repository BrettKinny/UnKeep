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

  it('binds setup and recovery to the relay status instance before persisting access', () => {
    expect(source).toContain('relayInstanceId=status.instanceId');
    expect(source).toContain('provisionFirstDevice(relayInstanceId)');
    expect(source).toContain('restoreDeviceFromRecovery(serialized,relayInstanceId)');
    expect(source).toContain("if(result.instanceId!==relayInstanceId)throw new Error('Relay instance changed during setup')");
    expect(source).toContain("if(result.instanceId!==relayInstanceId)throw new Error('Relay instance changed during recovery')");
  });

  it('does not enter the ready view until local vault initialization succeeds', () => {
    const initialize = source.indexOf('await onReady(');
    const transition = source.indexOf("view='ready'", initialize);
    expect(initialize).toBeGreaterThan(-1);
    expect(transition).toBeGreaterThan(initialize);
  });

  it('requires explicit confirmation before committing a legacy recovery kit', () => {
    const validate = source.indexOf('validateLegacyRecovery(serialized,relayInstanceId)');
    const warning = source.indexOf("view='legacy-recovery-warning'", validate);
    const commit = source.indexOf('restoreLegacyDeviceFromRecovery(', warning);
    expect(validate).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(validate);
    expect(commit).toBeGreaterThan(warning);
    expect(source).toContain("function cancelLegacyRecovery(){pendingLegacyRecoveryKit='';error=null;view='choose'}");
    expect(source).toContain('The operator token proves permission to access the relay; it cannot prove that this legacy encryption key is correct.');
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
