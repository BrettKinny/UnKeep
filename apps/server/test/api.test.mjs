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

test('keeps attachment change rows bounded by omitting their encrypted bytes', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;
  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'attachment-feed-device', name: 'Attachment feed test' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };
  const envelope = {
    version: 1,
    algorithm: 'AES-GCM',
    keyId: 'large-file',
    iv: 'opaque',
    ciphertext: Buffer.alloc(512 * 1024, 7).toString('base64'),
  };

  response = await fetch(`${api}/attachments/large-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'large-file-mutation',
      noteId: 'attachment-owner',
      envelope,
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const { revision } = await response.json();

  response = await fetch(`${api}/changes?since=0`, { headers });
  const feed = await response.json();
  assert.equal(feed.changes.length, 1);
  assert.equal('envelope' in feed.changes[0], false);
  assert.deepEqual(feed, {
    changes: [{
      kind: 'attachment',
      id: 'large-file',
      noteId: 'attachment-owner',
      deleted: false,
      revision,
    }],
    cursor: revision,
  });
  assert.ok(JSON.stringify(feed).length < 1024);
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

test('operator recovery mints a new device credential after every device is lost', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token' },
  });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-one', name: 'Lost device' }),
  });
  const claimed = await response.json();
  const originalHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/devices/device-one`, { method: 'DELETE', headers: originalHeaders });
  assert.equal(response.status, 204);
  response = await fetch(`${api}/vault`, { headers: originalHeaders });
  assert.equal(response.status, 401);

  response = await fetch(`${api}/setup/reclaim`, {
    method: 'POST',
    headers: { authorization: 'Recovery test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'unauthorized-device', name: 'Unauthorized' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_recovery_token' });

  response = await fetch(`${api}/setup/reclaim`, {
    method: 'POST',
    headers: { authorization: 'Recovery operator-recovery-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'recovered-device', name: 'Recovered device' }),
  });
  assert.equal(response.status, 201);
  const recovered = await response.json();
  assert.deepEqual(Object.keys(recovered).sort(), ['deviceCredential', 'instanceId']);
  assert.equal(recovered.instanceId, claimed.instanceId);
  assert.ok(recovered.deviceCredential);

  response = await fetch(`${api}/vault`, {
    headers: { authorization: `Device ${recovered.deviceCredential}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { vaultId: claimed.instanceId });
});

test('existing deployments use the setup token for recovery when no distinct token is configured', async t => {
  const relay = await startTestServer({ setupToken: 'retained-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup retained-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'original-device', name: 'Original' }),
  });
  assert.equal(response.status, 201);

  response = await fetch(`${api}/setup/reclaim`, {
    method: 'POST',
    headers: { authorization: 'Recovery retained-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'replacement-device', name: 'Replacement' }),
  });
  assert.equal(response.status, 201);
  assert.ok((await response.json()).deviceCredential);
});

test('consuming a pairing request removes its response and raw device credential', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-one', name: 'Approver' }),
  });
  const claimed = await response.json();
  const approverHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-two', name: 'New device', publicKey: { kty: 'EC' } }),
  });
  assert.equal(response.status, 201);
  const pairing = await response.json();

  response = await fetch(`${api}/pairings/${pairing.requestId}/approve`, {
    method: 'POST',
    headers: approverHeaders,
    body: JSON.stringify({ response: { encryptedMasterKey: 'opaque' } }),
  });
  assert.equal(response.status, 200);

  const pollUrl = `${api}/pairings/${pairing.requestId}?secret=${encodeURIComponent(pairing.pollSecret)}`;
  response = await fetch(pollUrl);
  assert.equal(response.status, 200);
  const approved = await response.json();
  assert.deepEqual(approved.response, { encryptedMasterKey: 'opaque' });
  assert.ok(approved.deviceCredential);

  response = await fetch(`${api}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: {
      authorization: `Device ${approved.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 200);

  response = await fetch(pollUrl);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });
});

test('expired pairing requests are removed before they can be polled again', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token',
    env: { UNKEEP_PAIRING_TTL_MS: '500' },
  });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'approver-device', name: 'Approver' }),
  });
  const claimed = await response.json();

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'expiring-device', name: 'Expiring', publicKey: { kty: 'EC' } }),
  });
  assert.equal(response.status, 201);
  const pairing = await response.json();

  response = await fetch(`${api}/pairings/${pairing.requestId}/approve`, {
    method: 'POST',
    headers: {
      authorization: `Device ${claimed.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ response: { encryptedMasterKey: 'expires-with-request' } }),
  });
  assert.equal(response.status, 200);

  await new Promise(resolve => setTimeout(resolve, 600));
  response = await fetch(`${api}/status`);
  assert.equal(response.status, 200);

  response = await fetch(`${api}/pairings/${pairing.requestId}?secret=${encodeURIComponent(pairing.pollSecret)}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });
});

test('rejects stale note and attachment base revisions without overwriting the current records', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'conflict-device', name: 'Conflict test' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  for (const record of [
    { path: 'notes/conflicted-note', body: { envelope: { ciphertext: 'note-winner' } } },
    { path: 'attachments/conflicted-attachment', body: { noteId: 'conflicted-note', envelope: { ciphertext: 'attachment-winner' } } },
  ]) {
    response = await fetch(`${api}/${record.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...record.body, mutationId: `${record.path}-winner`, baseRevision: 0 }),
    });
    assert.equal(response.status, 200);
    const winner = await response.json();

    response = await fetch(`${api}/${record.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...record.body, envelope: { ciphertext: 'stale-loser' }, mutationId: `${record.path}-loser`, baseRevision: 0 }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'record_conflict', currentRevision: winner.revision });
  }

  response = await fetch(`${api}/changes?since=0`, { headers });
  const { changes } = await response.json();
  assert.equal(changes.find(change => change.kind === 'note').envelope.ciphertext, 'note-winner');
  assert.equal('envelope' in changes.find(change => change.kind === 'attachment'), false);
  response = await fetch(`${api}/attachments/conflicted-attachment`, { headers });
  assert.equal((await response.json()).envelope.ciphertext, 'attachment-winner');
});

test('accepts updates from released protocol-v1 clients that omit baseRevision', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'legacy-device', name: 'Released client' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/status`);
  assert.equal((await response.json()).protocol, 1);

  for (const record of [
    { path: 'notes/legacy-note', body: { envelope: { ciphertext: 'first-note' } } },
    { path: 'attachments/legacy-attachment', body: { noteId: 'legacy-note', envelope: { ciphertext: 'first-attachment' } } },
  ]) {
    response = await fetch(`${api}/${record.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...record.body, mutationId: `${record.path}-first` }),
    });
    assert.equal(response.status, 200);
    const first = await response.json();

    response = await fetch(`${api}/${record.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...record.body,
        envelope: { ciphertext: `updated-${record.path}` },
        mutationId: `${record.path}-updated`,
      }),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).revision > first.revision);
  }

  response = await fetch(`${api}/changes?since=0`, { headers });
  const { changes } = await response.json();
  assert.equal(changes.find(change => change.kind === 'note').envelope.ciphertext, 'updated-notes/legacy-note');
  response = await fetch(`${api}/attachments/legacy-attachment`, { headers });
  assert.equal((await response.json()).envelope.ciphertext, 'updated-attachments/legacy-attachment');
});

test('returns the original result when an accepted mutation is retried after a newer write', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token' });
  t.after(relay.stop);
  const api = relay.endpoint;
  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token', 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'retry-device', name: 'Retry test' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };
  const originalMutation = {
    mutationId: 'accepted-mutation',
    baseRevision: 0,
    envelope: { ciphertext: 'first-version' },
  };

  response = await fetch(`${api}/notes/retried-note`, { method: 'PUT', headers, body: JSON.stringify(originalMutation) });
  const original = await response.json();
  assert.equal(response.status, 200);

  response = await fetch(`${api}/notes/retried-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ mutationId: 'newer-mutation', baseRevision: original.revision, envelope: { ciphertext: 'newer-version' } }),
  });
  assert.equal(response.status, 200);
  assert.notEqual((await response.json()).revision, original.revision);

  response = await fetch(`${api}/notes/retried-note`, { method: 'PUT', headers, body: JSON.stringify(originalMutation) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), original);

  response = await fetch(`${api}/changes?since=0`, { headers });
  assert.equal((await response.json()).changes[0].envelope.ciphertext, 'newer-version');
});
