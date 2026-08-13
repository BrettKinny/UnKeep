<script lang="ts">
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import { importRecoveryKit } from '@unkeep/core';
  import { approvePairingRequest, clearDeviceAccess, createPairingRequest, inspectPairingCode, resumePairingFinalization, waitForPairing, RelayClient, type DeviceCredential, type PairingSession, type PendingPairingRequest, type RelaySession, type ServiceCredential, type ServiceCredentialScope } from '@unkeep/client';
  import { deviceKeyStore, relaySessionStore } from '$lib/clientStorage';
  import { downloadRecoveryKit, readRecoveryKitFile } from '$lib/recoveryKit';
  import { theme } from '$lib/theme.svelte';
  import { loadLocalVault } from '$lib/vaultBoot';
  import {
    createVaultAccessInvalidationChannel,
    sameVaultAccessSession,
    shouldInvalidateVaultAccess,
    type VaultAccessInvalidationChannel,
    type VaultAccessInvalidationKind,
  } from '$lib/vaultAccessInvalidation';
  const themeModes = ['system', 'light', 'dark'] as const;

  export interface VaultReady { ownerId:string;masterKey:Uint8Array<ArrayBuffer>;session:RelaySession;migrateLegacy:boolean }
  let {onReady,onSignedOut}:{onReady:(vault:VaultReady)=>void|Promise<void>;onSignedOut?:()=>void|Promise<void>}=$props();
  type View='loading'|'connect'|'setup'|'choose'|'pairing'|'recovery-confirm'|'legacy-recovery-warning'|'reclaim'|'ready';
  let view=$state<View>('loading'),endpoint=$state(''),relayInstanceId=$state(''),setupToken=$state(''),recoveryToken=$state(''),error=$state<string|null>(null),busy=$state(false),recoverySaved=$state(false),recoveryKit=$state(''),pairing=$state<PairingSession|null>(null),pairingQr=$state(''),pairingCode=$state(''),notice=$state<string|null>(null),menu=$state(false);
  let devices=$state<DeviceCredential[]>([]),serviceCredentials=$state<ServiceCredential[]>([]),serviceName=$state(''),serviceScope=$state<ServiceCredentialScope>('read-only'),mintedServiceCredential=$state(''),credentialsBusy=$state(false);
  let activeKey=$state<Uint8Array<ArrayBuffer>|null>(null),activeSession=$state<RelaySession|null>(null),abort:AbortController|null=null,pairingOperation=0;
  let hasLocalKey=$state(false);
  let pendingApproval=$state<PendingPairingRequest|null>(null);
  let pendingLegacyRecoveryKit=$state('');
  let initializingSession:RelaySession|null=null,initializingAccessOperation=0,accessLifecycle=0;
  let accessInvalidationChannel:VaultAccessInvalidationChannel|null=null,accessInvalidationQueue:Promise<void>=Promise.resolve(),mounted=false;

  onMount(()=>{
    mounted=true;
    accessInvalidationChannel=createVaultAccessInvalidationChannel(kind=>{
      accessInvalidationQueue=accessInvalidationQueue
        .then(()=>handleExternalAccessInvalidation(kind))
        .catch(e=>{if(mounted){error=e instanceof Error?e.message:String(e);busy=false}});
    });
    void (async()=>{try{endpoint=await relaySessionStore.defaultEndpoint(window.location.origin)}catch{endpoint=window.location.origin}await boot()})();
    return()=>{
      mounted=false;
      accessLifecycle+=1;
      pairingOperation+=1;
      abort?.abort();
      accessInvalidationChannel?.close();
      accessInvalidationChannel=null;
    };
  });
  async function handleExternalAccessInvalidation(kind:VaultAccessInvalidationKind){
    const observedLifecycle=accessLifecycle;
    const candidate=activeSession??initializingSession;
    const accessInFlight=candidate!==null||busy||view==='loading'||view==='pairing'||view==='recovery-confirm'||view==='reclaim';
    let durable:RelaySession|null=null,storedKeys=hasLocalKey,storageVerified=false;
    try{
      [durable,storedKeys]=await Promise.all([
        relaySessionStore.load(),
        deviceKeyStore.hasDeviceKeys(),
      ]);
      storageVerified=true;
    }catch{
      // A valid invalidation plus unreadable durable state fails closed for
      // in-memory access. The receiver still never mutates shared storage.
    }
    if(!mounted||observedLifecycle!==accessLifecycle)return;
    if(storageVerified&&!shouldInvalidateVaultAccess({candidate,durable,hasDeviceKeys:storedKeys,accessInFlight,kind}))return;
    if(!storageVerified&&!candidate&&!accessInFlight)return;
    accessLifecycle+=1;
    pairingOperation+=1;
    abort?.abort();
    abort=null;
    await onSignedOut?.();
    if(!mounted)return;
    let currentSession:RelaySession|null=null,currentKeys=storedKeys;
    try{
      [currentSession,currentKeys]=await Promise.all([
        relaySessionStore.load(),
        deviceKeyStore.hasDeviceKeys(),
      ]);
    }catch{
      // In-memory access is already disabled; leave durable state untouched.
    }
    activeKey=null;
    activeSession=null;
    initializingSession=null;
    hasLocalKey=currentKeys;
    busy=false;
    menu=false;
    notice=currentSession
      ?'Vault access changed in another tab. Reload to use the current connection.'
      :kind==='forget'&&!currentKeys
        ?'Stored vault access was cleared in another tab.'
        :'Sync was disconnected in another tab.';
    view='connect';
  }
  async function ready(session:RelaySession,key:Uint8Array<ArrayBuffer>,migrateLegacy=false){
    const operation=++accessLifecycle;
    initializingSession=session;
    initializingAccessOperation=operation;
    let cleanupAttempted=false;
    try{
      await onReady({ownerId:session.instanceId,masterKey:key,session,migrateLegacy});
      const durable=await relaySessionStore.load();
      if(operation!==accessLifecycle||!sameVaultAccessSession(durable,session)){
        if(operation===accessLifecycle)accessLifecycle+=1;
        cleanupAttempted=true;
        await onSignedOut?.();
        if(mounted){
          activeSession=null;
          activeKey=null;
          hasLocalKey=await deviceKeyStore.hasDeviceKeys();
          notice='Vault access changed before it finished opening.';
          view='connect';
        }
        return false;
      }
      activeSession=session;
      activeKey=key;
      hasLocalKey=true;
      notice=null;
      view='ready';
      return true;
    }catch(e){
      if(!cleanupAttempted)await onSignedOut?.();
      throw e;
    }finally{
      if(initializingAccessOperation===operation)initializingSession=null;
    }
  }
  async function resumeStoredPairing(){const operation=accessLifecycle;const expected=activeSession;try{const finalized=await resumePairingFinalization(relaySessionStore);if(operation===accessLifecycle&&expected&&finalized&&sameVaultAccessSession(expected,finalized)){activeSession=finalized;notice='Pairing finalization confirmed'}}catch{if(operation===accessLifecycle)notice='Pairing is saved locally; server finalization will retry after reconnecting.'}}
  async function boot(){try{const local=await loadLocalVault(relaySessionStore,deviceKeyStore);if(local){endpoint=local.session.endpoint;relayInstanceId=local.session.instanceId;if(!await ready(local.session,local.masterKey,true))return;if(local.session.pendingPairingRequestId){notice='Pairing is saved locally; confirming server finalization…';if(navigator.onLine)void resumeStoredPairing()}else if(!navigator.onLine)notice='Offline — showing the local working copy';return}hasLocalKey=await deviceKeyStore.hasDeviceKeys();view='connect'}catch(e){error=e instanceof Error?e.message:String(e);view='connect'}}
  async function connect(){busy=true;error=null;try{await relaySessionStore.saveEndpoint(endpoint);const status=await new RelayClient(endpoint).status();relayInstanceId=status.instanceId;view=status.initialized?'choose':'setup'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function claim(){if(!relayInstanceId)return;busy=true;error=null;try{const existing=await deviceKeyStore.unlockDevice(relayInstanceId);if(existing){activeKey=existing;recoveryKit=await deviceKeyStore.createRecoveryKit()}else{const provisioned=await deviceKeyStore.provisionFirstDevice(relayInstanceId);activeKey=provisioned.masterKey;recoveryKit=provisioned.recoveryKit}recoverySaved=false;view='recovery-confirm'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function finishSetup(){if(!recoverySaved||!activeKey||!relayInstanceId)return;busy=true;error=null;try{const deviceId=await deviceKeyStore.getDeviceId();const result=await new RelayClient(endpoint).claimSetup(setupToken,relayInstanceId,deviceId,navigator.userAgent.slice(0,100));if(result.instanceId!==relayInstanceId)throw new Error('Relay instance changed during setup');const session={endpoint,instanceId:result.instanceId,deviceId,credential:result.deviceCredential};await relaySessionStore.save(session);setupToken='';await ready(session,activeKey)}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function startPairing(){pairingOperation+=1;const operation=pairingOperation;const lifecycle=++accessLifecycle;abort?.abort();const controller=new AbortController();abort=controller;let initializationStarted=false;busy=true;error=null;try{const created=await createPairingRequest(endpoint,deviceKeyStore,navigator.userAgent.slice(0,100));if(operation!==pairingOperation||controller.signal.aborted||lifecycle!==accessLifecycle)return;pairing=created;view='pairing';const qr=await QRCode.toDataURL(JSON.stringify({type:'unkeep-pair',endpoint,code:created.code}));if(operation!==pairingOperation||controller.signal.aborted||lifecycle!==accessLifecycle)return;pairingQr=qr;const result=await waitForPairing(created,{keyStore:deviceKeyStore,sessionStore:relaySessionStore,signal:controller.signal,initialize:async result=>{initializationStarted=true;initializingSession=result.session;initializingAccessOperation=lifecycle;await onReady({ownerId:result.session.instanceId,masterKey:result.masterKey,session:result.session,migrateLegacy:false});if(operation!==pairingOperation||controller.signal.aborted||lifecycle!==accessLifecycle)throw new DOMException('Pairing access was invalidated','AbortError')}});const durable=await relaySessionStore.load();if(operation!==pairingOperation||controller.signal.aborted||lifecycle!==accessLifecycle||!sameVaultAccessSession(durable,result.session)){if(initializationStarted)await onSignedOut?.();return}activeSession=result.session;activeKey=result.masterKey;initializingSession=null;hasLocalKey=true;notice=result.finalizationPending?'Pairing is saved locally; server finalization will retry after reconnecting.':null;view='ready';abort=null}catch(e){if(initializationStarted)try{await onSignedOut?.()}catch(cleanupError){error=cleanupError instanceof Error?cleanupError.message:String(cleanupError)}if((e as Error).name!=='AbortError'&&!error)error=e instanceof Error?e.message:String(e)}finally{if(initializingAccessOperation===lifecycle)initializingSession=null;if(operation===pairingOperation)busy=false}}
  function cancelPairing(){accessLifecycle+=1;pairingOperation+=1;abort?.abort();abort=null;pairing=null;pairingQr='';error=null;busy=false;view='choose'}
  async function restore(file:File){if(!relayInstanceId)return;busy=true;error=null;try{const serialized=await readRecoveryKitFile(file);const kit=importRecoveryKit(serialized);if(kit.version===1){await deviceKeyStore.validateLegacyRecovery(serialized,relayInstanceId);pendingLegacyRecoveryKit=serialized;view='legacy-recovery-warning';return}activeKey=await deviceKeyStore.restoreDeviceFromRecovery(serialized,relayInstanceId);recoveryToken='';notice='Encryption key restored locally. Enter the operator recovery token to restore server access.';view='reclaim'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function confirmLegacyRecovery(){if(!pendingLegacyRecoveryKit||!relayInstanceId)return;busy=true;error=null;try{activeKey=await deviceKeyStore.restoreLegacyDeviceFromRecovery(pendingLegacyRecoveryKit,relayInstanceId);pendingLegacyRecoveryKit='';recoveryToken='';notice='Legacy recovery kit associated with this relay. Enter the operator recovery token to restore server access.';view='reclaim'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  function cancelLegacyRecovery(){pendingLegacyRecoveryKit='';error=null;view='choose'}
  async function reclaim(){if(!activeKey||!relayInstanceId)return;busy=true;error=null;try{const deviceId=await deviceKeyStore.getDeviceId();const result=await new RelayClient(endpoint).reclaimSetup(recoveryToken,relayInstanceId,deviceId,navigator.userAgent.slice(0,100));if(result.instanceId!==relayInstanceId)throw new Error('Relay instance changed during recovery');const session={endpoint,instanceId:result.instanceId,deviceId,credential:result.deviceCredential};await relaySessionStore.save(session);recoveryToken='';await ready(session,activeKey)}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function reviewPairing(){if(!activeSession||!pairingCode.trim())return;busy=true;error=null;try{pendingApproval=await inspectPairingCode(activeSession,pairingCode)}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function approveReviewed(){if(!activeSession||!activeKey||!pendingApproval)return;busy=true;error=null;try{await approvePairingRequest(activeSession,pendingApproval,activeKey);notice=`${pendingApproval.deviceName} approved`;pairingCode='';pendingApproval=null;await loadCredentials()}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  function cancelApproval(){pendingApproval=null;pairingCode=''}
  async function loadCredentials(){if(!activeSession)return;credentialsBusy=true;error=null;try{const relay=new RelayClient(activeSession.endpoint,activeSession.credential);const [deviceList,serviceList]=await Promise.all([relay.devices(),relay.serviceCredentials()]);devices=deviceList.devices;serviceCredentials=serviceList.serviceCredentials;if(serviceCredentials.some(service=>!service.revokedAt&&service.issuedByDeviceId===null)&&!notice?.includes('Legacy service credentials'))notice=`${notice?`${notice} `:''}Legacy service credentials have no device issuer; revoke and re-mint them.`}catch(e){error=e instanceof Error?e.message:String(e)}finally{credentialsBusy=false}}
  async function toggleMenu(){menu=!menu;if(!menu)pendingApproval=null;if(menu)await loadCredentials()}
  async function mintService(){if(!activeSession||!serviceName.trim())return;credentialsBusy=true;error=null;notice=null;try{const result=await new RelayClient(activeSession.endpoint,activeSession.credential).mintServiceCredential(serviceName,serviceScope);mintedServiceCredential=result.serviceCredential;serviceName='';serviceScope='read-only';notice=`Copy this ${result.scope} credential now. It will not be shown again.`;await loadCredentials()}catch(e){error=e instanceof Error?e.message:String(e)}finally{credentialsBusy=false}}
  async function revokeDevice(id:string,name:string){if(!activeSession||id===activeSession.deviceId||!window.confirm(`Revoke ${name}? That device, its known paired descendants, their service credentials, and pending approvals will lose relay access.`))return;credentialsBusy=true;error=null;try{await new RelayClient(activeSession.endpoint,activeSession.credential).revokeDevice(id);await loadCredentials()}catch(e){error=e instanceof Error?e.message:String(e)}finally{credentialsBusy=false}}
  async function revokeService(id:string){if(!activeSession)return;credentialsBusy=true;error=null;try{await new RelayClient(activeSession.endpoint,activeSession.credential).revokeServiceCredential(id);await loadCredentials()}catch(e){error=e instanceof Error?e.message:String(e)}finally{credentialsBusy=false}}
  async function disconnect(){busy=true;error=null;try{accessLifecycle+=1;pairingOperation+=1;abort?.abort();abort=null;await onSignedOut?.();await relaySessionStore.clear();accessInvalidationChannel?.publish('disconnect');activeKey=null;activeSession=null;initializingSession=null;hasLocalKey=await deviceKeyStore.hasDeviceKeys();menu=false;view='connect'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
  async function forgetLocalAccess(){if(!window.confirm('Forget this vault key and connection on this browser? Local vault data will stay isolated until you pair that vault again.'))return;busy=true;error=null;try{accessLifecycle+=1;pairingOperation+=1;abort?.abort();abort=null;await onSignedOut?.();await clearDeviceAccess(deviceKeyStore,relaySessionStore);accessInvalidationChannel?.publish('forget');activeKey=null;activeSession=null;initializingSession=null;hasLocalKey=false;menu=false;notice='Stored vault access cleared. You can now connect a different vault.';view='connect'}catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}}
</script>

{#if view==='ready'}
  <div class="fixed right-2 top-[calc(0.875rem+env(safe-area-inset-top))] z-50 sm:right-3">
    <button class="rounded-full p-2 text-on-surface-muted hover:bg-surface-dim hover:text-on-surface" aria-label="Device menu" aria-expanded={menu} onclick={()=>void toggleMenu()}>
      <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>
    </button>
    {#if menu}
      <div class="absolute right-0 mt-2 max-h-[calc(100dvh-4rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 shadow-xl">
        <p class="truncate text-sm">{activeSession?.endpoint}</p>
        <div class="mt-3 flex items-center gap-1 text-sm">
          <span class="mr-auto text-on-surface-muted">Theme</span>
          {#each themeModes as mode}
            <button class="rounded-full px-2.5 py-1 capitalize {theme.mode === mode ? 'bg-primary/15 text-primary' : 'text-on-surface-muted hover:bg-surface-dim'}" onclick={() => theme.set(mode)}>{mode}</button>
          {/each}
        </div>
        {#if pendingApproval}
          <div class="mt-3 rounded-lg border border-border bg-surface-dim p-3 text-sm">
            <p>Approve access for <strong><bdi>{pendingApproval.deviceName}</bdi></strong>?</p>
            <p class="mt-1 break-all text-xs text-on-surface-muted">Device ID: <code dir="ltr">{pendingApproval.deviceId}</code></p>
            <p class="mt-2 text-xs text-on-surface-muted">Compare this fingerprint with the requesting device. Cancel if any character differs.</p>
            <p class="mt-1 font-mono text-base tracking-wider" dir="ltr">{pendingApproval.fingerprint}</p>
            <div class="mt-3 flex gap-2">
              <button class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50" disabled={busy} onclick={()=>void approveReviewed()}>Approve device</button>
              <button class="rounded border border-border px-2 py-1" disabled={busy} onclick={cancelApproval}>Cancel</button>
            </div>
          </div>
        {:else}
          <form class="mt-3 flex gap-2" onsubmit={e=>{e.preventDefault();void reviewPairing()}}>
            <input class="min-w-0 flex-1 rounded border border-border bg-surface px-2" aria-label="Pairing code" placeholder="PAIR CODE" bind:value={pairingCode} required/>
            <button class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50" disabled={busy}>Review device</button>
          </form>
        {/if}
        <div class="mt-4 border-t border-border pt-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Devices</p>
          {#if credentialsBusy && !devices.length}
            <p class="mt-2 text-xs text-on-surface-muted">Loading…</p>
          {:else if !devices.length}
            <p class="mt-2 text-xs text-on-surface-muted">No devices</p>
          {:else}
            <ul class="mt-2 grid gap-1 text-sm">
              {#each devices as device}
                <li class="flex items-center gap-2">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate"><bdi>{device.name}</bdi></span>
                    <span class="block truncate text-xs text-on-surface-muted">
                      {device.approvedByDeviceId ? `Paired by ${devices.find(candidate=>candidate.id===device.approvedByDeviceId)?.name??device.approvedByDeviceId}` : 'Root or legacy lineage'}
                    </span>
                  </span>
                  {#if device.revokedAt}
                    <span class="text-xs text-on-surface-muted">Revoked</span>
                  {:else if device.id===activeSession?.deviceId}
                    <span class="text-xs text-on-surface-muted">Current</span>
                  {:else}
                    <button class="text-xs text-danger disabled:opacity-50" disabled={credentialsBusy} onclick={()=>void revokeDevice(device.id,device.name)}>Revoke</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <div class="mt-4 border-t border-border pt-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">Service credentials</p>
          {#if !serviceCredentials.length}
            <p class="mt-2 text-xs text-on-surface-muted">None</p>
          {:else}
            <ul class="mt-2 grid gap-1 text-sm">
              {#each serviceCredentials as service}
                <li class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate"><bdi>{service.name}</bdi></span>
                  <span class="text-xs text-on-surface-muted">{service.scope}</span>
                  {#if service.revokedAt}
                    <span class="text-xs text-on-surface-muted">Revoked</span>
                  {:else}
                    <button class="text-xs text-danger disabled:opacity-50" disabled={credentialsBusy} onclick={()=>void revokeService(service.id)}>Revoke</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <p class="mt-2 text-xs text-on-surface-muted">Read-only blocks relay writes, but every bundle can decrypt the whole vault.</p>
          <form class="mt-2 grid gap-2" onsubmit={e=>{e.preventDefault();void mintService()}}>
            <div class="flex gap-2">
              <input class="min-w-0 flex-1 rounded border border-border bg-surface px-2" aria-label="Credential name" placeholder="Credential name" bind:value={serviceName} required/>
              <button class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50" disabled={credentialsBusy}>Mint</button>
            </div>
            <label class="grid gap-1 text-xs text-on-surface-muted">
              Credential scope
              <select class="rounded border border-border bg-surface px-2 py-1 text-sm text-on-surface" bind:value={serviceScope}>
                <option value="read-only">Read only</option>
                <option value="read-write">Read and write</option>
              </select>
            </label>
          </form>
          {#if mintedServiceCredential}
            <code class="mt-2 block break-all rounded bg-surface-dim p-2 text-xs select-all">{mintedServiceCredential}</code>
          {/if}
        </div>
        {#if notice}<p class="mt-2 text-xs text-primary">{notice}</p>{/if}
        {#if error}<p class="mt-2 text-xs text-danger">{error}</p>{/if}
        <div class="mt-3 flex flex-col items-start gap-2">
          <button class="text-sm text-on-surface-muted" onclick={disconnect}>Disconnect sync</button>
          <button class="text-sm text-danger" onclick={()=>void forgetLocalAccess()}>Forget stored vault key and switch</button>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <main class="grid min-h-dvh place-items-center bg-surface-dim p-4"><section class="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-lg">
    <div class="mb-5 flex items-center gap-3"><img src="/icon.svg" alt="" class="h-12 w-12"/><div><h1 class="text-2xl font-semibold">UnKeep</h1><p class="text-sm text-on-surface-muted">Your notes. Your storage.</p></div></div>
    {#if view==='loading'}<p>Opening your vault…</p>
    {:else if view==='connect'}<div class="grid gap-3"><form class="grid gap-3" onsubmit={e=>{e.preventDefault();void connect()}}><label class="grid gap-1 text-sm">Sync server<input class="rounded-lg border border-border bg-surface px-3 py-2" type="url" bind:value={endpoint} required/></label><button class="rounded-lg bg-primary px-4 py-2 text-on-primary" disabled={busy}>Connect</button></form>{#if hasLocalKey}<button class="text-sm text-danger" disabled={busy} onclick={()=>void forgetLocalAccess()}>Forget stored vault key and switch</button>{/if}{#if notice}<p class="text-sm text-primary">{notice}</p>{/if}</div>
    {:else if view==='setup'}<form class="grid gap-3" onsubmit={e=>{e.preventDefault();void claim()}}><p class="text-sm text-on-surface-muted">This is a new UnKeep server. Enter its one-time setup token. The server will not be initialized until you save a recovery kit.</p><label class="grid gap-1 text-sm">Setup token<input class="rounded-lg border border-border bg-surface px-3 py-2" type="password" autocomplete="off" bind:value={setupToken} required/></label><button class="rounded-lg bg-primary px-4 py-2 text-on-primary" disabled={busy}>Continue</button></form>
    {:else if view==='choose'}<div class="grid gap-3"><p class="text-sm text-on-surface-muted">Connect this device to your encrypted vault.</p><button class="rounded-lg bg-primary px-4 py-2 text-on-primary" onclick={()=>void startPairing()} disabled={busy}>Pair with another device</button><label class="cursor-pointer rounded-lg border border-border px-4 py-2 text-center focus-within:outline focus-within:outline-2 focus-within:outline-primary">Restore recovery kit<input class="sr-only" type="file" accept="application/json" onchange={e=>{const f=e.currentTarget.files?.[0];if(f)void restore(f)}}/></label>{#if hasLocalKey}<button class="text-sm text-danger" disabled={busy} onclick={()=>void forgetLocalAccess()}>Forget stored vault key and switch</button>{/if}</div>
    {:else if view==='pairing'}<div class="text-center"><p>On an unlocked device, approve this code:</p><p class="my-3 font-mono text-2xl tracking-widest" dir="ltr">{pairing?.code}</p>{#if pairingQr}<img class="mx-auto h-40 w-40" src={pairingQr} alt="Pairing QR code"/>{/if}<p class="mt-3 text-sm text-on-surface-muted">Verify this fingerprint exactly matches the approving device:</p><p class="mt-1 font-mono text-lg tracking-wider" dir="ltr">{pairing?.fingerprint}</p><p class="mt-3 text-sm text-on-surface-muted">Waiting for approval…</p><button class="mt-4 rounded-lg border border-border px-4 py-2" onclick={cancelPairing}>Cancel pairing</button></div>
    {:else if view==='recovery-confirm'}<div class="grid gap-3"><h2 class="font-semibold">Save your recovery kit</h2><p class="text-sm text-on-surface-muted">The server is still uninitialized. Save this kit before creating the vault so an interrupted setup cannot strand your data.</p><button class="rounded-lg border border-border px-4 py-2" onclick={()=>{downloadRecoveryKit(recoveryKit);recoverySaved=true}}>Download recovery kit</button><label class="flex gap-2 text-sm"><input type="checkbox" bind:checked={recoverySaved}/>I saved it somewhere safe</label><button class="rounded-lg bg-primary px-4 py-2 text-on-primary disabled:opacity-50" disabled={!recoverySaved||busy} onclick={()=>void finishSetup()}>Initialize and open UnKeep</button></div>
    {:else if view==='legacy-recovery-warning'}<div class="grid gap-3"><h2 class="font-semibold">Legacy recovery kit</h2><p class="text-sm text-on-surface-muted">This v1 kit does not identify a relay. Continue only if this is the relay that created the kit. The operator token proves permission to access the relay; it cannot prove that this legacy encryption key is correct.</p><button class="rounded-lg bg-primary px-4 py-2 text-on-primary disabled:opacity-50" disabled={busy} onclick={()=>void confirmLegacyRecovery()}>Associate kit with this relay</button><button class="rounded-lg border border-border px-4 py-2" disabled={busy} onclick={cancelLegacyRecovery}>Cancel</button></div>
    {:else if view==='reclaim'}<form class="grid gap-3" onsubmit={e=>{e.preventDefault();void reclaim()}}><h2 class="font-semibold">Recover vault access</h2><p class="text-sm text-on-surface-muted">Your recovery kit restored the encryption key locally. Enter the operator recovery token to mint a new device credential; the key is never sent to the server.</p><label class="grid gap-1 text-sm">Operator recovery token<input class="rounded-lg border border-border bg-surface px-3 py-2" type="password" autocomplete="off" bind:value={recoveryToken} required/></label><button class="rounded-lg bg-primary px-4 py-2 text-on-primary disabled:opacity-50" disabled={busy}>Recover access</button></form>{/if}
    {#if error}<p class="mt-4 text-sm text-danger" role="alert">{error}</p>{/if}
  </section></main>
{/if}
