import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.mjs';

test('claims a server once and syncs opaque records', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token'});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/status`);assert.deepEqual((await response.json()).initialized,false);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-one',name:'Test'})});assert.equal(response.status,201);const claimed=await response.json();assert.ok(claimed.deviceCredential);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-two'})});assert.equal(response.status,409);
  const headers={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};
  const envelope={version:1,algorithm:'AES-GCM',keyId:'note-one',iv:'opaque',ciphertext:'opaque'};
  response=await fetch(`${api}/notes/note-one`,{method:'PUT',headers,body:JSON.stringify({mutationId:'mutation-one',envelope,deleted:false})});assert.equal(response.status,200);
  response=await fetch(`${api}/changes?since=0`,{headers});const changes=await response.json();assert.equal(changes.changes.length,1);assert.deepEqual(changes.changes[0].envelope,envelope);
});

test('rejects attachments over the configured size limit', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token',env:{UNKEEP_MAX_ATTACHMENT_SIZE:'8'}});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-one',name:'Test'})});const claimed=await response.json();
  const headers={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};
  const envelope={version:1,algorithm:'AES-GCM',keyId:'file-one',iv:'opaque',ciphertext:Buffer.alloc(25).toString('base64')};
  response=await fetch(`${api}/attachments/file-one`,{method:'PUT',headers,body:JSON.stringify({mutationId:'mutation-one',noteId:'note-one',envelope,deleted:false})});
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:'attachment_too_large'});
});

test('mints, uses, lists, and revokes a service credential', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token'});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token','content-type':'application/json'},body:JSON.stringify({deviceId:'device-one',name:'Test device'})});
  const claimed=await response.json();const deviceHeaders={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};

  response=await fetch(`${api}/service-credentials`,{method:'POST',headers:deviceHeaders,body:JSON.stringify({name:'Build agent'})});
  assert.equal(response.status,201);const minted=await response.json();assert.equal(minted.name,'Build agent');assert.ok(minted.id);assert.ok(minted.serviceCredential);

  response=await fetch(`${api}/service-credentials`,{headers:deviceHeaders});assert.equal(response.status,200);
  assert.deepEqual((await response.json()).serviceCredentials,[{id:minted.id,name:'Build agent',createdAt:minted.createdAt,revokedAt:null}]);

  const serviceHeaders={authorization:`Service ${minted.serviceCredential}`,'content-type':'application/json'};
  const noteEnvelope={version:1,algorithm:'AES-GCM',keyId:'note-one',iv:'opaque-note-iv',ciphertext:'opaque-note-ciphertext'};
  response=await fetch(`${api}/notes/note-one`,{method:'PUT',headers:serviceHeaders,body:JSON.stringify({mutationId:'service-note-mutation',envelope:noteEnvelope,deleted:false})});assert.equal(response.status,200);
  const attachmentEnvelope={version:1,algorithm:'AES-GCM',keyId:'file-one',iv:'opaque-file-iv',ciphertext:'opaque-file-ciphertext'};
  response=await fetch(`${api}/attachments/file-one`,{method:'PUT',headers:serviceHeaders,body:JSON.stringify({mutationId:'service-file-mutation',noteId:'note-one',envelope:attachmentEnvelope,deleted:false})});assert.equal(response.status,200);
  response=await fetch(`${api}/changes?since=0`,{headers:serviceHeaders});assert.equal(response.status,200);assert.equal((await response.json()).changes.length,2);

  response=await fetch(`${api}/service-credentials/${minted.id}`,{method:'DELETE',headers:deviceHeaders});assert.equal(response.status,204);
  response=await fetch(`${api}/changes?since=0`,{headers:serviceHeaders});assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'invalid_service_credential'});
});
