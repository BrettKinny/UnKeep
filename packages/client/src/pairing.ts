import { decodeBase64, encodeBase64 } from './base64.js';
import type { DeviceKeyStore } from './deviceKeys.js';
import { RelayClient, type RelaySession } from './relay.js';
import type { RelaySessionStore } from './session.js';

const POLL_INTERVAL_MS=1500;
export interface PairingSession { requestId:string;code:string;pollSecret:string;expiresAt:string;privateKey:CryptoKey;endpoint:string }
export interface WaitForPairingOptions { keyStore:DeviceKeyStore; sessionStore:RelaySessionStore; signal?:AbortSignal }
interface PairingResponse { version:1;responderPublicKey:JsonWebKey;iv:string;ciphertext:string }
const aad=(id:string)=>new TextEncoder().encode(`unkeep:pairing:v1:${id}`);
async function keys(){return globalThis.crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey'])}
async function derive(privateKey:CryptoKey,jwk:JsonWebKey){const publicKey=await globalThis.crypto.subtle.importKey('jwk',jwk,{name:'ECDH',namedCurve:'P-256'},false,[]);return globalThis.crypto.subtle.deriveKey({name:'ECDH',public:publicKey},privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}

export async function createPairingRequest(endpoint:string,keyStore:DeviceKeyStore,deviceName:string):Promise<PairingSession>{
  const pair=await keys();const publicKey=await globalThis.crypto.subtle.exportKey('jwk',pair.publicKey);
  const result=await new RelayClient(endpoint).createPairing({deviceId:await keyStore.getDeviceId(),name:deviceName,publicKey});
  return {...result,privateKey:pair.privateKey,endpoint};
}
export async function approvePairingCode(session:RelaySession,code:string,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  const relay=new RelayClient(session.endpoint,session.credential);const request=await relay.pairingByCode(code.toUpperCase().replace(/[^A-Z2-9]/g,''));
  const responder=await keys();const key=await derive(responder.privateKey,request.publicKey);const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await globalThis.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(request.id),tagLength:128},key,masterKey);
  const response:PairingResponse={version:1,responderPublicKey:await globalThis.crypto.subtle.exportKey('jwk',responder.publicKey),iv:encodeBase64(iv),ciphertext:encodeBase64(new Uint8Array(ciphertext))};
  await relay.approvePairing(request.id,response);
}
export async function waitForPairing(pairing:PairingSession,{keyStore,sessionStore,signal}:WaitForPairingOptions):Promise<{masterKey:Uint8Array<ArrayBuffer>;session:RelaySession}>{
  while(Date.now()<new Date(pairing.expiresAt).getTime()){
    if(signal?.aborted){const error=new Error('Pairing cancelled');error.name='AbortError';throw error}
    const relay=new RelayClient(pairing.endpoint);const data=await relay.pollPairing(pairing.requestId,pairing.pollSecret);
    if(data.response&&data.deviceCredential){const response=data.response as PairingResponse;const key=await derive(pairing.privateKey,response.responderPublicKey);const plaintext=await globalThis.crypto.subtle.decrypt({name:'AES-GCM',iv:decodeBase64(response.iv),additionalData:aad(pairing.requestId),tagLength:128},key,decodeBase64(response.ciphertext));const masterKey=new Uint8Array(plaintext);if(!await keyStore.unlockDevice())await keyStore.persistPairedMasterKey(masterKey);const status=await relay.status();const session={endpoint:pairing.endpoint,instanceId:status.instanceId,deviceId:await keyStore.getDeviceId(),credential:data.deviceCredential};await sessionStore.save(session);await new RelayClient(session.endpoint,session.credential).consumePairing(pairing.requestId);return {masterKey,session};}
    await new Promise(resolve=>setTimeout(resolve,POLL_INTERVAL_MS));
  }throw new Error('Pairing request expired');
}
