import { decodeBase64, encodeBase64 } from './base64.js';
import type { DeviceKeyStore } from './deviceKeys.js';
import {
  assertPairingStorageCapabilities,
  installPairingSession,
  restorePairingAccessState,
  snapshotPairingAccessState,
  type PairingStorageIsolation,
} from './deviceAccess.js';
import { RelayClient, type RelaySession } from './relay.js';
import type { RelaySessionStore } from './session.js';

const POLL_INTERVAL_MS=1500;
const PAIRING_FINGERPRINT_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export interface PairingSession { requestId:string;code:string;pollSecret:string;expiresAt:string;privateKey:CryptoKey;endpoint:string;instanceId:string;deviceId:string;deviceCredential:string;fingerprint:string }
export interface PairingResult { masterKey:Uint8Array<ArrayBuffer>;session:RelaySession;finalizationPending:boolean }
export interface WaitForPairingOptions {
  keyStore: DeviceKeyStore;
  sessionStore: RelaySessionStore;
  signal?: AbortSignal;
  initialize?: (result: PairingResult) => void | Promise<void>;
  /**
   * Only for callers, such as the CLI, that hold one external lock across the
   * whole pairing operation and atomically persist their durable key/session
   * bundle inside `initialize`.
   */
  storageIsolation?: PairingStorageIsolation;
}
export interface PendingPairingRequest { id:string;instanceId:string;deviceId:string;deviceName:string;publicKey:JsonWebKey;expiresAt:string;endpoint:string;fingerprint:string }
interface PairingResponse { version:2;responderPublicKey:JsonWebKey;iv:string;ciphertext:string }
export class PairingLocalStateChangedError extends Error {
  readonly name = 'PairingLocalStateChangedError';

  constructor(message = 'Pairing local access changed during finalization') {
    super(message);
  }
}
const aad=(instanceId:string,id:string)=>new TextEncoder().encode(`unkeep:pairing:v2\n${instanceId}\n${id}`);
function cancellationError():Error {
  const error=new Error('Pairing cancelled');error.name='AbortError';return error;
}
function throwIfCancelled(signal?:AbortSignal):void {
  if (!signal?.aborted) return;
  throw cancellationError();
}
function waitForNextPoll(signal?:AbortSignal):Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(cancellationError())};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve()},POLL_INTERVAL_MS);
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
  });
}
async function keys(){return globalThis.crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey'])}
async function derive(privateKey:CryptoKey,jwk:JsonWebKey){const publicKey=await globalThis.crypto.subtle.importKey('jwk',canonicalPairingPublicKey(jwk),{name:'ECDH',namedCurve:'P-256'},false,[]);return globalThis.crypto.subtle.deriveKey({name:'ECDH',public:publicKey},privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
function deviceCredential():string {
  return encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g,'-')
    .replace(/\//g,'_')
    .replace(/=+$/,'');
}
async function sha256Hex(value:string):Promise<string> {
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
  return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}

function canonicalCoordinate(value:unknown):string {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Invalid P-256 pairing public key');
  const standard=value.replace(/-/g,'+').replace(/_/g,'/')+'=';
  const decoded=decodeBase64(standard);
  const canonical=encodeBase64(decoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if(decoded.byteLength!==32||canonical!==value)throw new Error('Invalid P-256 pairing public key');
  return value;
}

function canonicalPairingPublicKey(value:JsonWebKey):Readonly<{kty:'EC';crv:'P-256';x:string;y:string}> {
  if(!value||value.kty!=='EC'||value.crv!=='P-256')throw new Error('Invalid P-256 pairing public key');
  return {kty:'EC',crv:'P-256',x:canonicalCoordinate(value.x),y:canonicalCoordinate(value.y)};
}

function fingerprintBase32(bytes:Uint8Array):string {
  let bits=0,value=0,result='';
  for(const byte of bytes){
    value=(value<<8)|byte;
    bits+=8;
    while(bits>=5){
      result+=PAIRING_FINGERPRINT_ALPHABET[(value>>>(bits-5))&31];
      bits-=5;
    }
  }
  if(bits)result+=PAIRING_FINGERPRINT_ALPHABET[(value<<(5-bits))&31];
  return result;
}

/**
 * Derive the human-comparable pairing transcript fingerprint locally. The
 * relay never supplies this value: both clients compute it from the request
 * identity and canonical requester key they independently observe.
 */
export async function pairingFingerprint(instanceId:string,requestId:string,deviceId:string,publicKey:JsonWebKey):Promise<string>{
  if(!instanceId||!requestId||!deviceId)throw new Error('Invalid pairing request identity');
  const key=canonicalPairingPublicKey(publicKey);
  await globalThis.crypto.subtle.importKey(
    'jwk',
    key,
    {name:'ECDH',namedCurve:'P-256'},
    false,
    [],
  );
  const transcript=new TextEncoder().encode([
    'unkeep:pairing-fingerprint:v2',
    instanceId,
    requestId,
    deviceId,
    key.kty,
    key.crv,
    key.x,
    key.y,
  ].join('\n'));
  const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',transcript));
  const encoded=fingerprintBase32(digest.subarray(0,10));
  return encoded.match(/.{1,4}/g)!.join('-');
}

export async function createPairingRequest(endpoint:string,keyStore:DeviceKeyStore,deviceName:string):Promise<PairingSession>{
  const relay=new RelayClient(endpoint);
  const status=await relay.status();
  if(!status.initialized)throw new Error('Relay is not initialized');
  const pair=await keys();const publicKey=await globalThis.crypto.subtle.exportKey('jwk',pair.publicKey);
  const deviceId=await keyStore.getDeviceId();
  const credential=deviceCredential();
  const deviceCredentialHash=await sha256Hex(credential);
  const result=await relay.createPairing({
    expectedInstanceId:status.instanceId,
    deviceId,
    name:deviceName,
    publicKey,
    deviceCredentialHash,
  });
  if(result.instanceId!==status.instanceId)throw new Error('Relay instance changed during pairing');
  const fingerprint=await pairingFingerprint(status.instanceId,result.requestId,deviceId,publicKey);
  return {...result,privateKey:pair.privateKey,endpoint,deviceId,deviceCredential:credential,fingerprint};
}
export async function inspectPairingCode(session:RelaySession,code:string):Promise<PendingPairingRequest>{
  const relay=new RelayClient(session.endpoint,session.credential);
  const request=await relay.pairingByCode(code.toUpperCase().replace(/[^A-Z2-9]/g,''));
  if(request.instanceId!==session.instanceId)throw new Error('Pairing request belongs to a different relay instance');
  const fingerprint=await pairingFingerprint(request.instanceId,request.id,request.deviceId,request.publicKey);
  return {...request,endpoint:relay.endpoint,fingerprint};
}
export async function approvePairingRequest(session:RelaySession,request:PendingPairingRequest,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  const relay=new RelayClient(session.endpoint,session.credential);
  if(request.instanceId!==session.instanceId)throw new Error('Pairing request belongs to a different relay instance');
  if(request.endpoint!==relay.endpoint)throw new Error('Pairing request belongs to a different relay');
  if(new Date(request.expiresAt).getTime()<=Date.now())throw new Error('Pairing request expired');
  const responder=await keys();const key=await derive(responder.privateKey,request.publicKey);const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await globalThis.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(request.instanceId,request.id),tagLength:128},key,masterKey);
  const response:PairingResponse={version:2,responderPublicKey:await globalThis.crypto.subtle.exportKey('jwk',responder.publicKey),iv:encodeBase64(iv),ciphertext:encodeBase64(new Uint8Array(ciphertext))};
  await relay.approvePairing(request.id,response);
}
export async function approvePairingCode(session:RelaySession,code:string,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  await approvePairingRequest(session,await inspectPairingCode(session,code),masterKey);
}

export async function resumePairingFinalization(sessionStore:RelaySessionStore):Promise<RelaySession|null>{
  const session=await sessionStore.load();
  if(!session?.pendingPairingRequestId)return session;
  const relay=new RelayClient(session.endpoint,session.credential);
  try {
    await relay.consumePairing(session.pendingPairingRequestId);
  } catch (consumeError) {
    // A response may have been lost after the relay committed. An active
    // device can use the administrative device-list endpoint; a provisional
    // pairing credential cannot. This also recovers after a short-lived
    // consumed receipt has been cleaned up.
    try {
      const listed=await relay.devices();
      if(!listed.devices.some(device=>device.id===session.deviceId&&!device.revokedAt))throw consumeError;
    } catch {
      throw consumeError;
    }
  }
  const finalized = await sessionStore.completePairingFinalization(session);
  return samePairingSession(finalized, session, false) ? finalized : null;
}

function samePairingSession(
  current: RelaySession | null,
  expected: RelaySession,
  pending: boolean,
): boolean {
  return Boolean(
    current
    && current.endpoint === expected.endpoint
    && current.instanceId === expected.instanceId
    && current.deviceId === expected.deviceId
    && current.credential === expected.credential
    && (
      pending
        ? current.pendingPairingRequestId === expected.pendingPairingRequestId
        : current.pendingPairingRequestId === undefined
    )
  );
}

async function bestEffortRevokeClearedPairing(
  pairedSession: RelaySession,
): Promise<void> {
  try {
    await new RelayClient(
      pairedSession.endpoint,
      pairedSession.credential,
    ).revokeDevice(
      pairedSession.deviceId,
      AbortSignal.timeout(2_000),
    );
  } catch {
    // Consume may not have committed, the response may be unreachable, or the
    // credential may already be revoked. The local clear remains authoritative.
  }
}

async function failIfPairingStateChanged(
  sessionStore: RelaySessionStore,
  pairedSession: RelaySession,
): Promise<void> {
  let current: RelaySession | null;
  try {
    current = await sessionStore.load();
  } catch {
    throw new PairingLocalStateChangedError(
      'Pairing local access could not be verified during finalization',
    );
  }
  if (samePairingSession(current, pairedSession, true)) return;
  if (current === null) await bestEffortRevokeClearedPairing(pairedSession);
  throw new PairingLocalStateChangedError();
}

export async function waitForPairing(pairing:PairingSession,{keyStore,sessionStore,signal,initialize,storageIsolation='shared'}:WaitForPairingOptions):Promise<PairingResult>{
  const relay=new RelayClient(pairing.endpoint);
  try {
    while(Date.now()<new Date(pairing.expiresAt).getTime()){
      throwIfCancelled(signal);
      const data=await relay.pollPairing(pairing.requestId,pairing.pollSecret,signal);
      throwIfCancelled(signal);
      if(data.instanceId!==pairing.instanceId)throw new Error('Relay instance changed during pairing');
      if(data.response){
        const response=data.response as PairingResponse;
        if(response.version!==2)throw new Error('Unsupported pairing response');
        const key=await derive(pairing.privateKey,response.responderPublicKey);
        throwIfCancelled(signal);
        const plaintext=await globalThis.crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(response.iv),additionalData:aad(pairing.instanceId,pairing.requestId),tagLength:128},key,decodeBase64(response.ciphertext));
        throwIfCancelled(signal);
        const masterKey=new Uint8Array(plaintext);
        const status=await relay.status(signal);
        throwIfCancelled(signal);
        if(!status.initialized||status.instanceId!==pairing.instanceId)throw new Error('Relay instance changed during pairing');
        const deviceId=await keyStore.getDeviceId();
        throwIfCancelled(signal);
        if(deviceId!==pairing.deviceId)throw new Error('Device identity changed during pairing');
        const pairedSession:RelaySession={
          endpoint:pairing.endpoint,
          instanceId:status.instanceId,
          deviceId,
          credential:pairing.deviceCredential,
          pendingPairingRequestId:pairing.requestId,
        };
        // Fail before any local key or application state is changed when the
        // caller cannot uphold the requested transaction-isolation contract.
        assertPairingStorageCapabilities(
          keyStore,
          sessionStore,
          storageIsolation,
        );
        const accessSnapshot=await snapshotPairingAccessState(
          keyStore,
          sessionStore,
          status.instanceId,
        );
        throwIfCancelled(signal);
        let installedKeys=accessSnapshot.keys;
        try {
          const installation=await keyStore.installPairedMasterKey(masterKey, status.instanceId);
          installedKeys=installation.snapshot;
          throwIfCancelled(signal);
          const result={masterKey,session:pairedSession,finalizationPending:true};
          await initialize?.(result);
          throwIfCancelled(signal);
          // The application-specific durable state (notably the CLI's raw
          // vault key) must commit before the resume marker can ever lead to
          // server activation.
          await installPairingSession(
            keyStore,
            sessionStore,
            status.instanceId,
            installedKeys,
            storageIsolation === 'externally-serialized'
              ? [accessSnapshot.session, pairedSession]
              : [accessSnapshot.session],
            pairedSession,
            storageIsolation,
          );
          throwIfCancelled(signal);
        } catch (error) {
          try {
            await restorePairingAccessState(
              keyStore,
              sessionStore,
              status.instanceId,
              accessSnapshot,
              installedKeys,
              [accessSnapshot.session,pairedSession],
              storageIsolation,
            );
          } catch (cleanupError) {
            const failures=cleanupError instanceof AggregateError
              ? cleanupError.errors
              : [cleanupError];
            throw new AggregateError(
              [error,...failures],
              'Pairing failed and prior access could not be fully restored',
              {cause:error},
            );
          }
          throw error;
        }
        // Local access and the pending request ID are now durable. Finalization
        // is deliberately not abortable and must never trigger local rollback:
        // a lost response may mean the relay already activated this device.
        try {
          const finalized=await resumePairingFinalization(sessionStore);
          if(!finalized||!samePairingSession(finalized,pairedSession,false)){
            await failIfPairingStateChanged(sessionStore,pairedSession);
            throw new PairingLocalStateChangedError();
          }
          return {masterKey,session:finalized,finalizationPending:false};
        } catch (error) {
          if(error instanceof PairingLocalStateChangedError)throw error;
          // Preserve lost-response recovery only while the exact durable
          // pending marker is still current. A concurrent clear/replacement
          // must never be surfaced as ready merely because consume was
          // ambiguous.
          await failIfPairingStateChanged(sessionStore,pairedSession);
          return {masterKey,session:pairedSession,finalizationPending:true};
        }
      }
      await waitForNextPoll(signal);
    }
    throw new Error('Pairing request expired');
  } catch (error) {
    await relay.cancelPairing(pairing.requestId,pairing.pollSecret).catch(()=>undefined);
    throw error;
  }
}
