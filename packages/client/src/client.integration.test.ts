import { expect, test, vi } from 'vitest';
import { startTestServer, type TestServer } from '@unkeep/server/test';
import { encryptNote, type Note, type NoteAttachment } from '@unkeep/core';
import { approvePairingCode, createPairingRequest, DeviceKeyStore, EncryptedSync, MemoryClientStorage, RecordConflictError, RelayClient, RelaySessionStore, waitForPairing, type RelaySession } from './index.js';

async function claim(relay:TestServer,deviceId='sdk-device'):Promise<RelaySession> {
  const result=await new RelayClient(relay.endpoint).claimSetup(relay.setupToken,relay.instanceId,deviceId,'SDK test');
  return {endpoint:relay.endpoint,instanceId:result.instanceId,deviceId,credential:result.deviceCredential};
}

function note(id:string,content:string,images?:NoteAttachment[]):Note {
  return {id,content,...(images?{images}:{}),createdAt:1,updatedAt:1,pinned:false,archived:false};
}

async function commitAttachments(
  sync:EncryptedSync,
  value:Note,
  uploads:readonly {attachment:NoteAttachment;bytes:Uint8Array<ArrayBuffer>}[],
):Promise<void> {
  const handle=await sync.commitNoteWithAttachments(value,uploads);
  if(!await sync.completeCompoundCommit(handle))throw new Error('Compound test bundle was not completed');
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
    expect(pulled.notes).toEqual([{...note('sdk-note','encrypted hello'),schemaVersion:2}]);
    expect(pulled.cursor).toBeGreaterThan(0);
  } finally {await relay.stop()}
});

test('atomically round-trips a note with a new encrypted attachment and durably completes its bundle',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);
    const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const storage=new MemoryClientStorage();
    const writer=new EncryptedSync(session,masterKey,storage);
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={
      id:'compound-sdk-attachment',
      name:'proof.bin',
      mimeType:'application/octet-stream',
      size:3,
    };
    const bytes=new Uint8Array([1,2,3]);
    const bundledNote=note('compound-sdk-note','encrypted bundle',[attachment]);

    const handle=await writer.commitNoteWithAttachments(
      bundledNote,
      [{attachment,bytes}],
    );
    expect(await writer.pendingCompoundCommit(bundledNote.id)).toEqual(handle);
    expect(await writer.completeCompoundCommit(handle)).toBe(true);

    const pulled=await reader.pull();
    expect(pulled.notes).toEqual([{...bundledNote,schemaVersion:2}]);
    expect(pulled.attachments).toEqual([{noteId:bundledNote.id,attachment,bytes}]);
    await expect(writer.push({...bundledNote,content:'updated',updatedAt:2}))
      .resolves.toEqual(expect.any(Number));
    await expect(writer.deleteAttachment(bundledNote.id,attachment)).resolves.toBeUndefined();
  } finally {await relay.stop()}
});

test('keeps trashed notes and attachments recoverable until a permanent tombstone is pushed',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);
    const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={
      id:'trash-attachment',
      name:'recoverable.txt',
      mimeType:'text/plain',
      size:11,
    };
    const bytes=new TextEncoder().encode('recoverable');
    const original=note('trash-note','keep until explicit deletion',[attachment]);
    await commitAttachments(writer,original,[{attachment,bytes}]);
    const trashed={...original,trashedAt:2,updatedAt:2};
    await writer.push(trashed);

    const recoverable=await reader.pull();
    expect(recoverable.deletedIds).toEqual([]);
    expect(recoverable.notes).toEqual([{...trashed,schemaVersion:2}]);
    expect(recoverable.attachments).toEqual([{noteId:original.id,attachment,bytes}]);
    await reader.acknowledge(recoverable.cursor,recoverable.revisions);

    await writer.push({...trashed,trashedAt:undefined,deleted:true,updatedAt:3});
    const deleted=await reader.pull();
    expect(deleted.notes).toEqual([]);
    expect(deleted.deletedIds).toEqual([original.id]);
    expect(deleted.deletedAttachments).toContainEqual({
      noteId:original.id,
      attachmentId:attachment.id,
    });
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
    expect(first.notes).toEqual([{...note('retryable-note','must survive a failed local apply'),schemaVersion:2}]);
    expect(await reader.getCursor()).toBe(0);

    // Simulate the caller crashing before it durably applies the first result.
    const retried=await reader.pull();
    expect(retried.notes).toEqual(first.notes);

    await reader.acknowledge(first.cursor,first.revisions);
    expect(await reader.getCursor()).toBe(first.cursor);
    expect((await reader.pull()).notes).toEqual([]);
  } finally {await relay.stop()}
});

test('durably quarantines a poison note without wedging later records and recovers on a valid revision',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);
    const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const relayClient=new RelayClient(session.endpoint,session.credential);
    const poisonId='poison-note';
    const poisonPlaintext='must-not-enter-quarantine-storage';
    const poisonEnvelope=await encryptNote(
      note(poisonId,poisonPlaintext),
      globalThis.crypto.getRandomValues(new Uint8Array(32)),
      {ownerId:session.instanceId,noteId:poisonId},
    );
    const poisoned=await relayClient.putNote(poisonId,{
      mutationId:globalThis.crypto.randomUUID(),
      baseRevision:0,
      envelope:poisonEnvelope,
      deleted:false,
      deviceId:session.deviceId,
    });
    await new EncryptedSync(session,masterKey,new MemoryClientStorage())
      .push(note('after-poison','later records still flow'));

    const storage=new MemoryClientStorage();
    const reader=new EncryptedSync(session,masterKey,storage);
    const pulled=await reader.pull();
    const expectedQuarantine={
      kind:'note' as const,
      id:poisonId,
      revision:poisoned.revision,
      reason:'note_invalid_or_undecryptable' as const,
    };
    expect(pulled.notes).toEqual([{...note('after-poison','later records still flow'),schemaVersion:2}]);
    expect(pulled.quarantined).toEqual([expectedQuarantine]);
    expect(await reader.getQuarantinedRecords()).toEqual([expectedQuarantine]);
    const stored=await storage.get<unknown>(`unkeep-sync-quarantine:${encodeURIComponent(session.instanceId)}`);
    expect(stored).toEqual({version:1,records:[expectedQuarantine]});
    expect(JSON.stringify(stored)).not.toContain(poisonPlaintext);

    // A caller may advance beyond a record once the SDK has durably recorded
    // its quarantine, allowing subsequent pages to continue after restart.
    await reader.acknowledge(pulled.cursor,pulled.revisions);
    const restarted=new EncryptedSync(session,masterKey,storage);
    expect(await restarted.getCursor()).toBe(pulled.cursor);
    expect(await restarted.getQuarantinedRecords()).toEqual([expectedQuarantine]);
    expect((await restarted.pull()).notes).toEqual([]);

    const repaired=note(poisonId,'valid replacement');
    const repairedEnvelope=await encryptNote(
      repaired,
      masterKey,
      {ownerId:session.instanceId,noteId:poisonId},
    );
    await relayClient.putNote(poisonId,{
      mutationId:globalThis.crypto.randomUUID(),
      baseRevision:poisoned.revision,
      envelope:repairedEnvelope,
      deleted:false,
      deviceId:session.deviceId,
    });
    const recovered=await restarted.pull();
    expect(recovered.notes).toEqual([{...repaired,schemaVersion:2}]);
    expect(recovered.quarantined).toEqual([]);
    expect(await restarted.getQuarantinedRecords()).toEqual([]);
    await restarted.acknowledge(recovered.cursor,recovered.revisions);
    expect(await new EncryptedSync(session,masterKey,storage).getQuarantinedRecords()).toEqual([]);
  } finally {await relay.stop()}
});

test('rejects unbounded or invalid quarantine and acknowledgement inputs',async()=>{
  const storage=new MemoryClientStorage();
  const session:RelaySession={
    endpoint:'http://127.0.0.1:1',
    instanceId:'bounded-quarantine-instance',
    deviceId:'bounded-device',
    credential:'unused',
  };
  const sync=new EncryptedSync(session,new Uint8Array(32),storage);
  await expect(sync.acknowledge(1,[{kind:'note',id:'x'.repeat(129),revision:1}]))
    .rejects.toThrow('Pulled revisions must identify valid records');
  await storage.set(`unkeep-sync-quarantine:${encodeURIComponent(session.instanceId)}`,{
    version:1,
    records:Array.from({length:1001},(_,revision)=>({
      kind:'note',
      id:`q${revision}`,
      revision:revision+1,
      reason:'note_invalid_or_undecryptable',
    })),
  });
  await expect(sync.getQuarantinedRecords()).rejects.toThrow('Stored sync quarantine is invalid');
});

test('atomically merges cursor revisions and quarantines from concurrent tabs',async()=>{
  const storage=new MemoryClientStorage();
  const session:RelaySession={
    endpoint:'http://127.0.0.1:1',
    instanceId:'concurrent-tab-instance',
    deviceId:'concurrent-tab-device',
    credential:'unused',
  };
  const first=new EncryptedSync(session,new Uint8Array(32),storage);
  const second=new EncryptedSync(session,new Uint8Array(32),storage);

  await Promise.all([
    first.acknowledge(5,[{kind:'note',id:'first-note',revision:5}]),
    second.acknowledge(6,[{kind:'attachment',id:'second-file',revision:6}]),
  ]);
  expect(await first.getCursor()).toBe(6);
  expect(await storage.get(`unkeep-sync-state:${session.instanceId}`)).toEqual({
    version:1,
    cursor:6,
    revisions:{
      'note:first-note':5,
      'attachment:second-file':6,
    },
  });

  const fetch=vi.spyOn(globalThis,'fetch');
  try {
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        changes:[{
          kind:'note',
          id:'first-poison',
          envelope:{},
          deleted:false,
          revision:7,
        }],
        cursor:7,
      }),{status:200,headers:{'content-type':'application/json'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        changes:[{
          kind:'note',
          id:'second-poison',
          envelope:{},
          deleted:false,
          revision:8,
        }],
        cursor:8,
      }),{status:200,headers:{'content-type':'application/json'}}));

    const [firstPull,secondPull]=await Promise.all([first.pull(6),second.pull(6)]);
    expect(firstPull.quarantined).toHaveLength(1);
    expect(secondPull.quarantined).toHaveLength(1);
    expect(await first.getQuarantinedRecords()).toEqual([
      {
        kind:'note',
        id:'first-poison',
        revision:7,
        reason:'note_invalid_or_undecryptable',
      },
      {
        kind:'note',
        id:'second-poison',
        revision:8,
        reason:'note_invalid_or_undecryptable',
      },
    ]);
  } finally {
    fetch.mockRestore();
  }
});

test('rejects invalid IDs and oversized pages from an untrusted relay response',async()=>{
  const session:RelaySession={
    endpoint:'http://127.0.0.1:1',
    instanceId:'untrusted-relay-instance',
    deviceId:'untrusted-relay-device',
    credential:'unused',
  };
  const sync=new EncryptedSync(session,new Uint8Array(32),new MemoryClientStorage());
  const fetch=vi.spyOn(globalThis,'fetch');
  try {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      changes:[{
        kind:'note',
        id:'x'.repeat(129),
        envelope:{},
        deleted:false,
        revision:1,
      }],
      cursor:1,
    }),{status:200,headers:{'content-type':'application/json'}}));
    await expect(sync.pull()).rejects.toThrow('Relay returned an invalid change record');
    expect(await sync.getQuarantinedRecords()).toEqual([]);

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      changes:Array.from({length:1001},(_,index)=>({
        kind:'note',
        id:`page${index}`,
        envelope:{},
        deleted:false,
        revision:index+1,
      })),
      cursor:1001,
    }),{status:200,headers:{'content-type':'application/json'}}));
    await expect(sync.pull()).rejects.toThrow('Relay returned an invalid change page');
    expect(await sync.getQuarantinedRecords()).toEqual([]);
  } finally {
    fetch.mockRestore();
  }
});

test('returns note tombstone and attachment revisions with a pull',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'revision-attachment',name:'revision.txt',mimeType:'text/plain',size:8};
    await commitAttachments(
      writer,
      note('revision-note','before deletion',[attachment]),
      [{attachment,bytes:new TextEncoder().encode('revision')}],
    );
    await writer.push({...note('revision-note','deleted'),deleted:true,updatedAt:2});

    const pulled=await reader.pull();
    expect(pulled.deletedIds).toEqual(['revision-note']);
    expect(pulled.revisions).toEqual([
      {kind:'note',id:'revision-note',revision:expect.any(Number)},
      {kind:'attachment',id:'revision-attachment',revision:expect.any(Number)},
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
    expect(replayed.notes).toEqual([{...note('legacy-note','remote version'),schemaVersion:2}]);
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
    await commitAttachments(
      writer,
      note('attachment-note','with attachment',[attachment]),
      [{attachment,bytes}],
    );
    expect(await reader.downloadAttachment('attachment-note',attachment)).toEqual(bytes);
    const pulled=await reader.pull();
    expect(pulled.notes[0].images).toEqual([attachment]);
    expect(pulled.attachments).toEqual([{noteId:'attachment-note',attachment,bytes}]);
  } finally {await relay.stop()}
});

test('recovers a post-success attachment replay only when owner, bytes, and size match',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const storage=new MemoryClientStorage();
    const attachment:NoteAttachment={id:'immutable-replay',name:'replay.bin',mimeType:'application/octet-stream',size:4};
    const bytes=new Uint8Array([1,2,3,4]);
    const first=new EncryptedSync(session,masterKey,storage);
    await commitAttachments(
      first,
      note('immutable-owner','with attachment',[attachment]),
      [{attachment,bytes}],
    );

    // AttachmentStore can stop after the SDK has committed its mutation and
    // revision but before clearing its own pending-upload marker. A restarted
    // SDK creates a fresh mutation ID for those same durable bytes.
    const restarted=new EncryptedSync(session,masterKey,storage);
    await expect(restarted.uploadAttachment('immutable-owner',attachment,bytes))
      .resolves.toBeUndefined();

    await expect(restarted.uploadAttachment(
      'immutable-owner',
      attachment,
      new Uint8Array([1,2,3,5]),
    )).rejects.toMatchObject({status:409,code:'attachment_immutable'});
    await expect(restarted.uploadAttachment(
      'immutable-owner',
      {...attachment,size:5},
      bytes,
    )).rejects.toMatchObject({status:409,code:'attachment_immutable'});
    await expect(restarted.uploadAttachment('different-owner',attachment,bytes))
      .rejects.toMatchObject({status:409,code:'attachment_owner_conflict'});

    await expect(restarted.downloadAttachment('immutable-owner',attachment))
      .resolves.toEqual(bytes);
  } finally {await relay.stop()}
});

test('does not recover a deleted immutable upload while delete replay stays idempotent',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const storage=new MemoryClientStorage();
    const attachment:NoteAttachment={id:'deleted-replay',name:'gone.bin',mimeType:'application/octet-stream',size:3};
    const bytes=new Uint8Array([7,8,9]);
    const first=new EncryptedSync(session,masterKey,storage);
    await commitAttachments(
      first,
      note('deleted-replay-owner','with attachment',[attachment]),
      [{attachment,bytes}],
    );
    await first.deleteAttachment('deleted-replay-owner',attachment);

    const restarted=new EncryptedSync(session,masterKey,storage);
    await expect(restarted.uploadAttachment('deleted-replay-owner',attachment,bytes))
      .rejects.toMatchObject({status:409,code:'attachment_immutable'});
    await expect(restarted.deleteAttachment('deleted-replay-owner',attachment))
      .resolves.toBeUndefined();
    await expect(restarted.downloadAttachment('deleted-replay-owner',attachment))
      .rejects.toMatchObject({name:'AttachmentDeletedError'});
  } finally {await relay.stop()}
});

test('retries a pull instead of accepting stale attachment bytes after a download failure',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'retry-attachment',name:'retry.txt',mimeType:'text/plain',size:3};
    await commitAttachments(
      writer,
      note('retry-owner','first',[attachment]),
      [{attachment,bytes:new TextEncoder().encode('one')}],
    );
    const initial=await reader.pull();
    await reader.acknowledge(initial.cursor,initial.revisions);

    const replacement:NoteAttachment={
      id:'retry-attachment-replacement',
      name:'retry.txt',
      mimeType:'text/plain',
      size:3,
    };
    await commitAttachments(
      writer,
      {...note('retry-owner','second',[replacement]),updatedAt:2},
      [{attachment:replacement,bytes:new TextEncoder().encode('two')}],
    );
    await writer.deleteAttachment('retry-owner',attachment);
    const originalFetch=globalThis.fetch;
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      const url=String(input);
      if(url.endsWith(`/api/v1/attachments/${replacement.id}`)) {
        return new Response(JSON.stringify({error:'temporarily_unavailable'}),{
          status:503,
          headers:{'content-type':'application/json'},
        });
      }
      return originalFetch(input,init);
    });
    await expect(reader.pull()).rejects.toMatchObject({status:503});
    expect(await reader.getCursor()).toBe(initial.cursor);
    expect(await reader.getQuarantinedRecords()).toEqual([]);
    fetch.mockRestore();

    const retried=await reader.pull();
    expect(retried.attachments).toEqual([{
      noteId:'retry-owner',
      attachment:replacement,
      bytes:new TextEncoder().encode('two'),
    }]);
    expect(retried.deletedAttachments).toContainEqual({
      noteId:'retry-owner',
      attachmentId:attachment.id,
    });
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
    const acceptedAttachment:NoteAttachment={id:'size-mismatch-attachment',name:'mismatch.txt',mimeType:'text/plain',size:3};
    await commitAttachments(
      writer,
      note('size-mismatch-owner','accepted bytes',[acceptedAttachment]),
      [{attachment:acceptedAttachment,bytes:new TextEncoder().encode('bad')}],
    );
    const attachment={...acceptedAttachment,size:4};
    await writer.push({...note('size-mismatch-owner','inconsistent',[attachment]),updatedAt:2});

    await expect(reader.pull()).rejects.toThrow('expected 4 bytes but received 3');
    expect(await reader.getCursor()).toBe(0);
    expect(await reader.getQuarantinedRecords()).toEqual([]);

    const correctedBytes=new TextEncoder().encode('good');
    const correctedAttachment:NoteAttachment={
      ...attachment,
      id:'size-mismatch-attachment-corrected',
    };
    await commitAttachments(
      writer,
      {...note('size-mismatch-owner','corrected',[correctedAttachment]),updatedAt:3},
      [{attachment:correctedAttachment,bytes:correctedBytes}],
    );
    await writer.deleteAttachment('size-mismatch-owner',attachment);
    const retried=await reader.pull();
    expect(retried.attachments).toEqual([{
      noteId:'size-mismatch-owner',
      attachment:correctedAttachment,
      bytes:correctedBytes,
    }]);
    expect(retried.deletedAttachments).toContainEqual({
      noteId:'size-mismatch-owner',
      attachmentId:attachment.id,
    });
  } finally {await relay.stop()}
});

test('pulls an encrypted attachment tombstone without downloading deleted bytes',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const reader=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'deleted-attachment',name:'gone.txt',mimeType:'text/plain',size:4};
    await commitAttachments(
      writer,
      note('attachment-owner','stale metadata',[attachment]),
      [{attachment,bytes:new TextEncoder().encode('gone')}],
    );
    await writer.deleteAttachment('attachment-owner',attachment);

    const pulled=await reader.pull();
    expect(pulled.deletedAttachments).toEqual([{noteId:'attachment-owner',attachmentId:attachment.id}]);
    expect(pulled.attachments).toEqual([]);
    expect(pulled.notes[0].images).toBeUndefined();
    await expect(new RelayClient(session.endpoint,session.credential).getAttachment(attachment.id))
      .resolves.toMatchObject({noteId:'attachment-owner',deleted:true});
  } finally {await relay.stop()}
});

test('keeps attachment IDs immutable while stale deletes remain idempotent',async()=>{
  const relay=await startTestServer();
  try {
    const session=await claim(relay);const {masterKey}=await new DeviceKeyStore(new MemoryClientStorage()).provisionFirstDevice(session.instanceId);
    const writer=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const stale=new EncryptedSync(session,masterKey,new MemoryClientStorage());
    const attachment:NoteAttachment={id:'protected-attachment',name:'protected.txt',mimeType:'text/plain',size:3};
    await commitAttachments(
      writer,
      note('attachment-owner','protected',[attachment]),
      [{attachment,bytes:new TextEncoder().encode('one')}],
    );
    const staleBase=await stale.pull();
    await stale.acknowledge(staleBase.cursor,staleBase.revisions);

    await expect(writer.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('two')))
      .rejects.toMatchObject({status:409,code:'attachment_immutable'});
    await writer.deleteAttachment('attachment-owner',attachment);
    await expect(stale.uploadAttachment('attachment-owner',attachment,new TextEncoder().encode('old')))
      .rejects.toBeInstanceOf(RecordConflictError);
    await expect(stale.deleteAttachment('attachment-owner',attachment))
      .resolves.toBeUndefined();
    await expect(stale.downloadAttachment('attachment-owner',attachment))
      .rejects.toMatchObject({name:'AttachmentDeletedError'});
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
