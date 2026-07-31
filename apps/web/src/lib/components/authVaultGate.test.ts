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

  it('invalidates stale pairing completion on cancel and unmount', () => {
    const mount = source.slice(
      source.indexOf('onMount(()=>'),
      source.indexOf('async function handleExternalAccessInvalidation('),
    );
    const cancel = source.slice(
      source.indexOf('function cancelPairing()'),
      source.indexOf('async function restore('),
    );

    expect(source).toContain('pairingOperation+=1');
    expect(source).toContain('operation===pairingOperation');
    expect(source).toContain('initialize:async result=>');
    expect(mount).toContain('pairingOperation+=1');
    expect(mount).toContain('abort?.abort()');
    expect(cancel).toContain('pairingOperation+=1');
    expect(cancel).toContain('abort?.abort()');
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

  it('notifies other tabs only after the matching durable access is cleared', () => {
    const disconnect = source.slice(
      source.indexOf('async function disconnect()'),
      source.indexOf('async function forgetLocalAccess()'),
    );
    const forget = source.slice(
      source.indexOf('async function forgetLocalAccess()'),
      source.indexOf('</script>'),
    );

    expect(source).toContain('createVaultAccessInvalidationChannel');
    expect(disconnect.indexOf('await relaySessionStore.clear()'))
      .toBeLessThan(disconnect.indexOf("accessInvalidationChannel?.publish('disconnect')"));
    expect(forget.indexOf('await clearDeviceAccess(deviceKeyStore,relaySessionStore)'))
      .toBeLessThan(forget.indexOf("accessInvalidationChannel?.publish('forget')"));
  });

  it('signs out stale in-memory access without clearing a replacement', () => {
    const handler = source.slice(
      source.indexOf('async function handleExternalAccessInvalidation('),
      source.indexOf('async function ready('),
    );

    expect(handler).toContain('relaySessionStore.load()');
    expect(handler).toContain('deviceKeyStore.hasDeviceKeys()');
    expect(handler).toContain('shouldInvalidateVaultAccess');
    expect(handler).toContain('await onSignedOut?.()');
    expect(handler).not.toContain('relaySessionStore.clear()');
    expect(handler).not.toContain('clearDeviceAccess');
  });

  it('does not render ready after durable access changes during initialization', () => {
    const ready = source.slice(
      source.indexOf('async function ready('),
      source.indexOf('async function resumeStoredPairing('),
    );
    const pairing = source.slice(
      source.indexOf('async function startPairing('),
      source.indexOf('function cancelPairing('),
    );

    expect(ready).toContain('await relaySessionStore.load()');
    expect(ready).toContain('sameVaultAccessSession');
    expect(ready.indexOf('await onReady(')).toBeLessThan(
      ready.indexOf('await relaySessionStore.load()'),
    );
    expect(ready.indexOf('await relaySessionStore.load()')).toBeLessThan(
      ready.indexOf("view='ready'"),
    );
    expect(pairing).toContain('await relaySessionStore.load()');
    expect(pairing).toContain('operation!==pairingOperation');
    expect(pairing).toContain('lifecycle!==accessLifecycle');
    expect(pairing).toContain('await onSignedOut?.()');
  });

  it('shows the requesting device identity before pairing approval', () => {
    expect(source).toContain('inspectPairingCode');
    expect(source).toContain('pendingApproval.deviceName');
    expect(source).toContain('pendingApproval.deviceId');
    expect(source).toContain('approvePairingRequest');
    expect(source).toContain('Review device');
  });

  it('shows the independently derived pairing fingerprint on both devices', () => {
    expect(source).toContain('{pairing?.fingerprint}');
    expect(source).toContain('{pendingApproval.fingerprint}');
    expect(source).toContain('Verify this fingerprint exactly matches the approving device');
    expect(source).toContain('Cancel if any character differs');
    expect(source).toContain('<bdi>{pendingApproval.deviceName}</bdi>');
    expect(source).toMatch(/dir="ltr">\{pendingApproval\.fingerprint\}/);
  });

  it('resumes a durably marked pairing finalization after restart', () => {
    expect(source).toContain('resumePairingFinalization(relaySessionStore)');
    expect(source).toContain('local.session.pendingPairingRequestId');
    expect(source).toContain('Pairing is saved locally; server finalization will retry after reconnecting.');
  });

  it('warns operators to rotate preserved service credentials with unknown issuers', () => {
    expect(source).toContain('service.issuedByDeviceId===null');
    expect(source).toContain('Legacy service credentials have no device issuer; revoke and re-mint them.');
  });

  it('defaults service credentials to read-only and exposes both scopes', () => {
    expect(source).toContain("serviceScope=$state<ServiceCredentialScope>('read-only')");
    expect(source).toContain('mintServiceCredential(serviceName,serviceScope)');
    expect(source).toContain("serviceScope='read-only';notice=");
    expect(source).toContain('<option value="read-only">Read only</option>');
    expect(source).toContain('<option value="read-write">Read and write</option>');
    expect(source).toContain('{service.scope}');
    expect(source).toContain('every bundle can decrypt the whole vault');
  });
});
