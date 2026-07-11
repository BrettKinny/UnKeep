import { getDeviceId, persistPairedMasterKey, unlockDevice } from './keyStore.js';
import { RelayClient, saveRelaySession, type RelaySession } from './relayClient.js';

const POLL_INTERVAL_MS=1500;
export interface PairingSession { requestId:string;code:string;pollSecret:string;expiresAt:string;privateKey:CryptoKey;endpoint:string }
interface PairingResponse { version:1;responderPublicKey:JsonWebKey;iv:string;ciphertext:string }
const b64=(bytes:Uint8Array)=>{let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value)};
const unb64=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const aad=(id:string)=>new TextEncoder().encode(`unkeep:pairing:v1:${id}`);
async function keys(){return crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey'])}
async function derive(privateKey:CryptoKey,jwk:JsonWebKey){const publicKey=await crypto.subtle.importKey('jwk',jwk,{name:'ECDH',namedCurve:'P-256'},false,[]);return crypto.subtle.deriveKey({name:'ECDH',public:publicKey},privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}

export async function createPairingRequest(endpoint:string,deviceName=navigator.userAgent.slice(0,100)):Promise<PairingSession>{
  const pair=await keys();const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const result=await new RelayClient(endpoint).createPairing({deviceId:getDeviceId(),name:deviceName,publicKey});
  return {...result,privateKey:pair.privateKey,endpoint};
}
export async function approvePairingCode(session:RelaySession,code:string,masterKey:Uint8Array<ArrayBuffer>):Promise<void>{
  const relay=new RelayClient(session.endpoint,session.credential);const request=await relay.pairingByCode(code.toUpperCase().replace(/[^A-Z2-9]/g,''));
  const responder=await keys();const key=await derive(responder.privateKey,request.publicKey);const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(request.id),tagLength:128},key,masterKey);
  const response:PairingResponse={version:1,responderPublicKey:await crypto.subtle.exportKey('jwk',responder.publicKey),iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))};
  await relay.approvePairing(request.id,response);
}
export async function waitForPairing(pairing:PairingSession,signal?:AbortSignal):Promise<{masterKey:Uint8Array<ArrayBuffer>;session:RelaySession}>{
  while(Date.now()<new Date(pairing.expiresAt).getTime()){
    if(signal?.aborted)throw new DOMException('Pairing cancelled','AbortError');
    const relay=new RelayClient(pairing.endpoint);const data=await relay.pollPairing(pairing.requestId,pairing.pollSecret);
    if(data.response&&data.deviceCredential){const response=data.response as PairingResponse;const key=await derive(pairing.privateKey,response.responderPublicKey);const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(response.iv),additionalData:aad(pairing.requestId),tagLength:128},key,unb64(response.ciphertext));const masterKey=new Uint8Array(plaintext);if(!await unlockDevice())await persistPairedMasterKey(masterKey);const status=await relay.status();const session={endpoint:pairing.endpoint,instanceId:status.instanceId,deviceId:getDeviceId(),credential:data.deviceCredential};saveRelaySession(session);await new RelayClient(session.endpoint,session.credential).consumePairing(pairing.requestId);return {masterKey,session};}
    await new Promise(resolve=>setTimeout(resolve,POLL_INTERVAL_MS));
  }throw new Error('Pairing request expired');
}
