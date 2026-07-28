import { expect, test, vi } from 'vitest';
import { startTestServer, type TestServer } from '@unkeep/server/test';
import type { Note, NoteAttachment } from '@unkeep/core';
import { approvePairingCode, createPairingRequest, DeviceKeyStore, EncryptedSync, MemoryClientStorage, RecordConflictError, RelayClient, RelaySessionStore, waitForPairing, type RelaySession } from './index.js';

async function claim(relay:TestServer,deviceId='sdk-device'):Promise<RelaySession> {
  const result=await new RelayClient(relay.endpoint).claimSetup(relay.setupToken,deviceId,'SDK test');
  return {endpoint:relay.endpoint,instanceId:result.instanceId,deviceId,credential:result.deviceCredential};
}

function note(id:string,content:string,images?:NoteAttachment[]):Note {
  return {id,content,...(images?{images}:{}),createdAt:1,updatedAt:1,pinned:false,archived:false};
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
    const session=await claim(relay);const keys=new DeviceKeyStore(new MemoryClientStorage());const {masterKey}=await keys.provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await writer.push(note('sdk-note','encrypted hello'));
    const pulled=await reader.pull();
    expect(pulled.notes).toEqual([{...note('sdk-note','encrypted hello'),schemaVersion:1}]);
    expect(pulled.cursor).toBeGreaterThan(0);
  } finally {await relay.stop()}
});

test('does not advance the durable cursor until the caller acknowledges applied changes',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const keys=new DeviceKeyStore(new MemoryClientStorage());const {masterKey}=await keys.provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await writer.push(note('retryable-note','must survive a failed local apply'));

    const first=await reader.pull();
    expect(first.notes).toEqual([{...note('retryable-note','must survive a failed local apply'),schemaVersion:1}]);
    expect(await reader.getCursor()).toBe(0);

    // Simulate the caller crashing before it durably applies the first result.
    const retried=await reader.pull();
    expect(retried.notes).toEqual(first.notes);

    await reader.acknowledge(first.cursor,first.revisions);
    expect(await reader.getCursor()).toBe(first.cursor);
    expect((await reader.pull()).notes).toEqual([]);
  } finally {await relay.stop()}
});

test('returns note tombstone and attachment revisions with a pull',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'revision-attachment',name:'revision.txt',mimeType:'text/plain',size:8};
    await writer.uploadAttachment('revision-note',attachment,new TextEncoder().encode('revision'));
    await writer.push(note('revision-note','before deletion',[attachment]));
    await writer.push({...note('revision-note','deleted'),deleted:true,updatedAt:2});

    const pulled=await reader.pull();
    expect(pulled.deletedIds).toEqual(['revision-note']);
    expect(pulled.revisions).toEqual([
      {kind:'attachment',id:'revision-attachment',revision:expect.any(Number)},
      {kind:'note',id:'revision-note',revision:expect.any(Number)},
    ]);
  } finally {await relay.stop()}
});

test('uses a pulled record revision only after the caller acknowledges durable application',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await writer.push(note('acknowledged-note','remote version'));

    const pulled=await reader.pull();
    const edited={...pulled.notes[0],content:'durably edited',updatedAt:2};
    await expect(reader.push(edited)).rejects.toBeInstanceOf(RecordConflictError);

    await reader.acknowledge(pulled.cursor,pulled.revisions);
    await expect(reader.push(edited)).resolves.toEqual(expect.any(Number));
  } finally {await relay.stop()}
});

test('rescans and backfills revisions when migrating a legacy nonzero cursor',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await writer.push(note('legacy-note','remote version'));
    const legacyStorage=new MemoryClientStorage();
    await legacyStorage.set(`unkeep-sync-cursor:${session.instanceId}`,999);

    const migrated=new EncryptedSync(session,masterKey,legacyStorage);
    expect(await migrated.getCursor()).toBe(0);
    const replayed=await migrated.pull();
    expect(replayed.notes).toEqual([{...note('legacy-note','remote version'),schemaVersion:1}]);
    await migrated.acknowledge(replayed.cursor,replayed.revisions);

    const restarted=new EncryptedSync(session,masterKey,legacyStorage);
    expect(await restarted.getCursor()).toBe(replayed.cursor);
    await expect(restarted.push({...replayed.notes[0],content:'protected edit',updatedAt:2}))
      .resolves.toEqual(expect.any(Number));
  } finally {await relay.stop()}
});

test('scopes known record revisions to the relay instance',async()=>{
  const firstRelay=await startTestServer();const secondRelay=await startTestServer();
  try {
    const firstSession=await claim(firstRelay,'first-instance-device');
    const secondSession=await claim(secondRelay,'second-instance-device');
    const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(firstSession.instanceId);
    const sharedStorage=new MemoryClientStorage();
    const firstWriter=new EncryptedSync(firstSession,masterKey,new MemoryClientStorage());
    const firstReader=new EncryptedSync(firstSession,masterKey,sharedStorage);
    await firstWriter.push(note('same-record-id','first relay'));
    const pulled=await firstReader.pull();
    await firstReader.acknowledge(pulled.cursor,pulled.revisions);

    const secondWriter=new EncryptedSync(secondSession,masterKey,sharedStorage);
    await expect(secondWriter.push(note('same-record-id','second relay')))
      .resolves.toEqual(expect.any(Number));
  } finally {await Promise.all([firstRelay.stop(),secondRelay.stop()])}
});

test('converges two SDK instances through the relay',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const first=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const second=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await first.push(note('shared-note','first version'));
    const onSecond=await second.pull();
    await second.acknowledge(onSecond.cursor,onSecond.revisions);
    const edited={...onSecond.notes[0],content:'second version',updatedAt:2};
    await second.push(edited);
    const onFirst=await first.pull();
    expect(onFirst.notes).toEqual([edited]);
    expect((await second.pull()).notes).toEqual([edited]);
  } finally {await relay.stop()}
});

test('rejects one of two offline edits raced from the same acknowledged revision',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const seed=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const first=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const second=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    await seed.push(note('offline-race','shared base'));
    const [firstBase,secondBase]=await Promise.all([first.pull(),second.pull()]);
    await Promise.all([
      first.acknowledge(firstBase.cursor,firstBase.revisions),
      second.acknowledge(secondBase.cursor,secondBase.revisions),
    ]);

    const outcomes=await Promise.allSettled([
      first.push({...firstBase.notes[0],content:'first offline edit',updatedAt:2}),
      second.push({...secondBase.notes[0],content:'second offline edit',updatedAt:3}),
    ]);
    const winner=outcomes.find((outcome):outcome is PromiseFulfilledResult<number>=>outcome.status==='fulfilled');
    const loser=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');
    expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome=>outcome.status==='rejected')).toHaveLength(1);
    expect(loser?.reason).toBeInstanceOf(RecordConflictError);
    expect(loser?.reason).toMatchObject({currentRevision:winner?.value});

    const current=await new EncryptedSync(session,masterKey,new MemoryClientStorage()).pull();
    expect(['first offline edit','second offline edit']).toContain(current.notes[0].content);
  } finally {await relay.stop()}
});

test('round-trips encrypted attachment bytes through the SDK',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
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

test('retries a pull instead of accepting stale attachment bytes after a download failure',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'retry-attachment',name:'retry.txt',mimeType:'text/plain',size:3};
    await writer.uploadAttachment('retry-owner',attachment,new TextEncoder().encode('one'));
    await writer.push(note('retry-owner','first',[attachment]));
    const initial=await reader.pull();
    await reader.acknowledge(initial.cursor,initial.revisions);

    await writer.uploadAttachment('retry-owner',attachment,new TextEncoder().encode('two'));
    await writer.push({...note('retry-owner','second',[attachment]),updatedAt:2});
    const originalFetch=globalThis.fetch;
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const url=String(input);
      if(url.endsWith(`/api/v1/attachments/${attachment.id}`)) {
        return new Response(JSON.stringify({error:'temporarily_unavailable'}),{
          status:503,
          headers:{'content-type':'application/json'},
        });
      }
      return originalFetch(input,init);
    });
    await expect(reader.pull()).rejects.toMatchObject({status:503});
    expect(await reader.getCursor()).toBe(initial.cursor);
    fetch.mockRestore();

    const retried=await reader.pull();
    expect(retried.attachments).toEqual([{
      noteId:'retry-owner',
      attachment,
      bytes:new TextEncoder().encode('two'),
    }]);
  } finally {
    vi.restoreAllMocks();
    await relay.stop();
  }
});

test('retries a pull instead of accepting attachment bytes inconsistent with note metadata',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'size-mismatch-attachment',name:'mismatch.txt',mimeType:'text/plain',size:4};
    await writer.uploadAttachment('size-mismatch-owner',attachment,new TextEncoder().encode('bad'));
    await writer.push(note('size-mismatch-owner','inconsistent',[attachment]));

    await expect(reader.pull()).rejects.toThrow('expected 4 bytes but received 3');
    expect(await reader.getCursor()).toBe(0);

    const correctedBytes=new TextEncoder().encode('good');
    await writer.uploadAttachment('size-mismatch-owner',attachment,correctedBytes);
    const retried=await reader.pull();
    expect(retried.attachments).toEqual([{
      noteId:'size-mismatch-owner',
      attachment,
      bytes:correctedBytes,
    }]);
  } finally {await relay.stop()}
});

test('pulls an encrypted attachment tombstone without downloading deleted bytes',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'deleted-attachment',name:'gone.txt',mimeType:'text/plain',size:4};
    await writer.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('gone'));
    await writer.push(note('attachment-owner','stale metadata',[attachment]));
    await writer.deleteAttachment('attachment-owner',attachment);

    const pulled=await reader.pull();
    expect(pulled.deletedAttachments).toEqual([{noteId:'attachment-owner',attachmentId:attachment.id}]);
    expect(pulled.attachments).toEqual([]);
    expect(pulled.notes[0].images).toBeUndefined();
    await expect(new RelayClient(session.endpoint,session.credential).getAttachment(attachment.id))
      .resolves.toMatchObject({noteId:'attachment-owner',deleted:true});
  } finally {await relay.stop()}
});

test('protects attachment updates with their acknowledged record revision',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const stale=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'protected-attachment',name:'protected.txt',mimeType:'text/plain',size:3};
    await writer.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('one'));
    const staleBase=await stale.pull();
    await stale.acknowledge(staleBase.cursor,staleBase.revisions);

    await writer.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('two'));
    await expect(stale.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('old')))
      .rejects.toBeInstanceOf(RecordConflictError);
    await expect(stale.deleteAttachment('attachment-owner',attachment))
      .rejects.toBeInstanceOf(RecordConflictError);
    await expect(stale.downloadAttachment('attachment-owner',attachment))
      .resolves.toEqual(new TextEncoder().encode('two'));
  } finally {await relay.stop()}
});

test('pairs a second SDK device and persists its identity and session',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const firstKeys=new DeviceKeyStore(new MemoryClientStorage());const {masterKey}=await firstKeys.provisionFirstDevice(session.instanceId);
    const secondStorage=new MemoryClientStorage();const secondKeys=new DeviceKeyStore(secondStorage);const sessions=new RelaySessionStore(secondStorage);
    const pairing=await createPairingRequest(relay.endpoint,secondKeys,'Second SDK device');
    await approvePairingCode(session,pairing.code,masterKey);
    const result=await waitForPairing(pairing,{keyStore:secondKeys,sessionStore:sessions});
    expect(result.masterKey).toEqual(masterKey);
    expect(await secondKeys.unlockDevice(result.session.instanceId)).toEqual(masterKey);
    expect(await sessions.load()).toEqual(result.session);
    await expect(new RelayClient(result.session.endpoint,result.session.credential).vault()).resolves.toEqual({vaultId:session.instanceId});
  } finally {await relay.stop()}
});
