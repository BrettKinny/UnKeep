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
