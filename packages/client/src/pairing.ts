import { decodeBase64, encodeBase64 } from './base64.js';
import type { DeviceKeyStore } from './deviceKeys.js';
import { RelayClient, type RelaySession } from './relay.js';
import type { RelaySessionStore } from './session.js';

const POLL_INTERVAL_MS=1500;
export interface PairingSession { requestId:string;code:string;pollSecret:string;expiresAt:string;privateKey:CryptoKey;endpoint:string }
export interface WaitForPairingOptions { keyStore:DeviceKeyStore; sessionStore:RelaySessionStore; signal?:AbortSignal }
export interface PendingPairingRequest { id:string;deviceId:string;deviceName:string;publicKey:JsonWebKey;expiresAt:string;endpoint:string }
interface PairingResponse { version:1;responderPublicKey:JsonWebKey;iv:string;ciphertext:string }
const aad=(id:string)=>new TextEncoder().encode(`unkeep:pairing:v1:${id}`);
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
async function derive(privateKey:CryptoKey,jwk:JsonWebKey){const publicKey=await globalThis.crypto.subtle.importKey('jwk',jwk,{name:'ECDH',namedCurve:'P-256'},false,[]);return globalThis.crypto.subtle.deriveKey({name:'ECDH',public:publicKey},privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}

export async function createPairingRequest(endpoint:string,keyStore:DeviceKeyStore,deviceName:string):Promise<PairingSession>{
  const pair=await keys();const publicKey=await globalThis.crypto.subtle.exportKey('jwk',pair.publicKey);
  const result=await new RelayClient(endpoint).createPairing({deviceId:await keyStore.getDeviceId(),name:deviceName,publicKey});
  return {...result,privateKey:pair.privateKey,endpoint};
}
export async function inspectPairingCode(session:RelaySession,code:string):Promise<PendingPairingRequest>{
  const relay=new RelayClient(session.endpoint,session.credential);
  const request=await relay.pairingByCode(code.toUpperCase().replace(/[^A-Z2-9]/g,''));
  return {...request,endpoint:relay.endpoint};
}
export async function approvePairingRequest(session:RelaySession,request:PendingPairingRequest,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  const relay=new RelayClient(session.endpoint,session.credential);
  if(request.endpoint!==relay.endpoint)throw new Error('Pairing request belongs to a different relay');
  if(new Date(request.expiresAt).getTime()<=Date.now())throw new Error('Pairing request expired');
  const responder=await keys();const key=await derive(responder.privateKey,request.publicKey);const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await globalThis.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(request.id),tagLength:128},key,masterKey);
  const response:PairingResponse={version:1,responderPublicKey:await globalThis.crypto.subtle.exportKey('jwk',responder.publicKey),iv:encodeBase64(iv),ciphertext:encodeBase64(new Uint8Array(ciphertext))};
  await relay.approvePairing(request.id,response);
}
export async function approvePairingCode(session:RelaySession,code:string,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  await approvePairingRequest(session,await inspectPairingCode(session,code),masterKey);
}
export async function waitForPairing(pairing:PairingSession,{keyStore,sessionStore,signal}:WaitForPairingOptions):Promise<{masterKey:Uint8Array<ArrayBuffer>;session:RelaySession}>{
  while(Date.now()<new Date(pairing.expiresAt).getTime()){
    throwIfCancelled(signal);
    const relay=new RelayClient(pairing.endpoint);const data=await relay.pollPairing(pairing.requestId,pairing.pollSecret,signal);
    throwIfCancelled(signal);
    if(data.response&&data.deviceCredential){
      const response=data.response as PairingResponse;
      const key=await derive(pairing.privateKey,response.responderPublicKey);
      throwIfCancelled(signal);
      const plaintext=await globalThis.crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(response.iv),additionalData:aad(pairing.requestId),tagLength:128},key,decodeBase64(response.ciphertext));
      throwIfCancelled(signal);
      const masterKey=new Uint8Array(plaintext);
      const status=await relay.status(signal);
      throwIfCancelled(signal);
      const deviceId=await keyStore.getDeviceId();
      throwIfCancelled(signal);
      const pairedSession={endpoint:pairing.endpoint,instanceId:status.instanceId,deviceId,credential:data.deviceCredential};
      await keyStore.persistPairedMasterKey(masterKey);
      await sessionStore.save(pairedSession);
      await new RelayClient(pairedSession.endpoint,pairedSession.credential).consumePairing(pairing.requestId);
      return {masterKey,session:pairedSession};
    }
    await waitForNextPoll(signal);
  }throw new Error('Pairing request expired');
}
