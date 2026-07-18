import { expect, test } from 'vitest';
import { startTestServer, type TestServer } from '@unkeep/server/test';
import type { Note, NoteAttachment } from '@unkeep/core';
import { approvePairingCode, createPairingRequest, DeviceKeyStore, EncryptedSync, MemoryClientStorage, RelayClient, RelaySessionStore, waitForPairing, type RelaySession } from './index.js';

async function claim(relay:TestServer,deviceId='sdk-device'):Promise<RelaySession> {
  const result=await new RelayClient(relay.endpoint).claimSetup(relay.setupToken,deviceId,'SDK test');
  return {endpoint:relay.endpoint,instanceId:result.instanceId,deviceId,credential:result.deviceCredential};
}

function note(id:string,content:string,images?:NoteAttachment[]):Note {
  return {id,content,images,createdAt:1,updatedAt:1,pinned:false,archived:false};
}

test('claims setup through the SDK relay client over policy-approved loopback HTTP',async()=>{
  const relay=await startTestServer();
  try {
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(new RelayClient(relay.endpoint).endpoint).toBe(new URL(relay.endpoint).origin);
    const session=await claim(relay);
    expect(session.credential).toBeTruthy();
    await expect(new RelayClient(session.endpoint,session.credential).vault()).resolves.toEqual({vaultId:session.instanceId});
  } finally {await relay.stop()}
});

test('round-trips an encrypted note through the SDK sync interface',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const keys=new DeviceKeyStore(new MemoryClientStorage());const {masterKey}=await keys.provisionFirstDevice();
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await writer.push(note('sdk-note','encrypted hello'));
    const pulled=await reader.pull();
    expect(pulled.notes).toEqual([note('sdk-note','encrypted hello')]);
    expect(pulled.cursor).toBeGreaterThan(0);
  } finally {await relay.stop()}
});

test('converges two SDK instances through the relay',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice();
    const first=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const second=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await first.push(note('shared-note','first version'));
    const onSecond=await second.pull();
    const edited={...onSecond.notes[0],content:'second version',updatedAt:2};
    await second.push(edited);
    const onFirst=await first.pull();
    expect(onFirst.notes).toEqual([edited]);
    expect((await second.pull()).notes).toEqual([edited]);
  } finally {await relay.stop()}
});

test('round-trips encrypted attachment bytes through the SDK',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice();
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'sdk-attachment',name:'hello.txt',mimeType:'text/plain',size:5};
    const bytes=new TextEncoder().encode('hello');
    await writer.uploadAttachment('attachment-note',attachment,bytes);
    await writer.push(note('attachment-note','with attachment',[attachment]));
    expect(await reader.downloadAttachment('attachment-note',attachment)).toEqual(bytes);
    const pulled=await reader.pull();
    expect(pulled.notes[0].images).toEqual([attachment]);
    expect(pulled.attachments).toEqual([{noteId:'attachment-note',attachment,bytes}]);
  } finally {await relay.stop()}
});

test('pairs a second SDK device and persists its identity and session',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const firstKeys=new DeviceKeyStore(new MemoryClientStorage());const {masterKey}=await firstKeys.provisionFirstDevice();
    const secondStorage=new MemoryClientStorage();const secondKeys=new DeviceKeyStore(secondStorage);const sessions=new RelaySessionStore(secondStorage);
    const pairing=await createPairingRequest(relay.endpoint,secondKeys,'Second SDK device');
    await approvePairingCode(session,pairing.code,masterKey);
    const result=await waitForPairing(pairing,{keyStore:secondKeys,sessionStore:sessions});
    expect(result.masterKey).toEqual(masterKey);
    expect(await secondKeys.unlockDevice()).toEqual(masterKey);
    expect(await sessions.load()).toEqual(result.session);
    await expect(new RelayClient(result.session.endpoint,result.session.credential).vault()).resolves.toEqual({vaultId:session.instanceId});
  } finally {await relay.stop()}
});
