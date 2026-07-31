import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './harness.mjs';

const VALID_PAIRING_PUBLIC_KEY = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: 'TVC4DDeSdLtCXIcq4O3JN23gk9PQGNby_E1GyWuqEdk',
  y: 'wqByzVBixoTLN9eZYpkKJTON632EX5KTuqyGhA_XjY4',
});

function setupBody(relay, value) {
  return JSON.stringify({ expectedInstanceId: relay.instanceId, ...value });
}

function pairingCredential(deviceId) {
  return `local-pairing-credential-${deviceId}`;
}

function testEnvelope(keyId, marker = 'opaque') {
  const markerBytes = Buffer.from(marker);
  const ciphertext = Buffer.alloc(Math.max(16, markerBytes.length));
  markerBytes.copy(ciphertext);
  return {
    version: 1,
    algorithm: 'AES-GCM',
    keyId,
    iv: Buffer.alloc(12, 1).toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function storedEnvelopeBytes(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope));
}

function partialJsonRequest(url, { method, headers }, firstChunk) {
  let request;
  let markFlushed;
  const flushed = new Promise(resolve => { markFlushed = resolve; });
  const response = new Promise((resolve, reject) => {
    request = nodeRequest(url, { method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: incoming.statusCode,
          body: text ? JSON.parse(text) : {},
        });
      });
    });
    request.once('error', reject);
    request.write(firstChunk, markFlushed);
  });
  return {
    flushed,
    finish(lastChunk) {
      request.end(lastChunk);
      return response;
    },
  };
}

function pairingBody(relay, deviceId, publicKey = VALID_PAIRING_PUBLIC_KEY) {
  const credential = pairingCredential(deviceId);
  return JSON.stringify({
    expectedInstanceId: relay.instanceId,
    deviceId,
    name: `Device ${deviceId}`,
    publicKey,
    deviceCredentialHash: createHash('sha256').update(credential).digest('hex'),
  });
}

async function initializeRelay(relay, deviceId = 'test-owner') {
  const response = await fetch(`${relay.endpoint}/setup/claim`, {
    method: 'POST',
    headers: {
      authorization: `Setup ${relay.setupToken}`,
      'content-type': 'application/json',
    },
    body: setupBody(relay, { deviceId, name: `Device ${deviceId}` }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function pairDevice(relay, approverCredential, deviceId) {
  let response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, deviceId),
  });
  assert.equal(response.status, 201);
  const pairing = await response.json();
  response = await fetch(`${relay.endpoint}/pairings/${pairing.requestId}/approve`, {
    method: 'POST',
    headers: {
      authorization: `Device ${approverCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ response: { encryptedMasterKey: `for-${deviceId}` } }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${relay.endpoint}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: {
      authorization: `Device ${pairingCredential(deviceId)}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 200);
  return {
    credential: pairingCredential(deviceId),
    pairing,
  };
}

async function mintServiceCredential(relay, deviceCredential, name) {
  const response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST',
    headers: {
      authorization: `Device ${deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name, scope: 'read-write' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function stageTestAttachment(
  relay,
  credential,
  {
    bundleMutationId,
    noteId,
    attachmentId,
    marker = attachmentId,
    envelope = testEnvelope(attachmentId, marker),
    credentialKind = 'Device',
  },
) {
  const response = await fetch(
    `${relay.endpoint}/note-mutations/${bundleMutationId}/attachments/${attachmentId}`,
    {
      method: 'PUT',
      headers: {
        authorization: `${credentialKind} ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        noteId,
        envelope,
      }),
    },
  );
  return {
    response,
    body: await response.json(),
  };
}

async function finalizeTestBundle(
  relay,
  credential,
  {
    bundleMutationId,
    noteId,
    baseRevision,
    newAttachments,
    marker = noteId,
    envelope = testEnvelope(noteId, marker),
    credentialKind = 'Device',
  },
) {
  const response = await fetch(`${relay.endpoint}/notes/${noteId}/compound`, {
    method: 'PUT',
    headers: {
      authorization: `${credentialKind} ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      mutationId: bundleMutationId,
      baseRevision,
      deleted: false,
      envelope,
      newAttachments: [...newAttachments].sort(
        (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    }),
  });
  return {
    response,
    body: await response.json(),
  };
}

test('requires a distinct recovery token unless legacy setup-token recovery is explicitly enabled', async t => {
  await assert.rejects(
    startTestServer({
      setupToken: 'short',
    }),
    /UNKEEP_SETUP_TOKEN must be 32-256 printable ASCII characters/,
  );
  await assert.rejects(
    startTestServer({
      setupToken: '',
    }),
    /UNKEEP_SETUP_TOKEN is required while the relay is uninitialized/,
  );
  await assert.rejects(
    startTestServer({
      env: {
        UNKEEP_RECOVERY_TOKEN: 'also-short',
      },
    }),
    /UNKEEP_RECOVERY_TOKEN must be 32-256 printable ASCII characters/,
  );
  await assert.rejects(
    startTestServer({
      setupToken: 'setup-only-token-0000000000000001',
      env: {
        UNKEEP_RECOVERY_TOKEN: '',
        UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY: '',
      },
    }),
    /UNKEEP_RECOVERY_TOKEN is required/,
  );
  await assert.rejects(
    startTestServer({
      setupToken: 'shared-setup-and-recovery-token-0001',
      env: {
        UNKEEP_RECOVERY_TOKEN: 'shared-setup-and-recovery-token-0001',
        UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY: '',
      },
    }),
    /UNKEEP_RECOVERY_TOKEN must differ from UNKEEP_SETUP_TOKEN/,
  );

  const legacy = await startTestServer({
    setupToken: 'legacy-shared-token-00000000000001',
    env: {
      UNKEEP_RECOVERY_TOKEN: '',
      UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY: '1',
    },
  });
  t.after(legacy.stop);
  const claimed = await initializeRelay(legacy, 'legacy-fallback-owner');
  const response = await fetch(`${legacy.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery legacy-shared-token-00000000000001',
      'content-type': 'application/json',
    },
    body: setupBody(legacy, {
      deviceId: 'legacy-fallback-recovery',
      name: 'Legacy fallback recovery',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).instanceId, claimed.instanceId);
});

test('rejects invalid persistent-storage limits instead of silently widening them', async () => {
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_ADMIN_SOURCE_RATE_LIMIT: '0' },
    }),
    /UNKEEP_ADMIN_SOURCE_RATE_LIMIT must be an integer between 1 and 1000/,
  );
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_PAIRING_TTL_MS: String(24 * 60 * 60_000 + 1) },
    }),
    /UNKEEP_PAIRING_TTL_MS must be an integer between 1 and 86400000/,
  );
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_MAX_RECORDS: '0' },
    }),
    /UNKEEP_MAX_RECORDS must be an integer between 1 and 10000000/,
  );
  await assert.rejects(
    startTestServer({
      env: {
        UNKEEP_MAX_ENCRYPTED_RECORD_BYTES: String(
          1024 * 1024 * 1024 * 1024 + 1,
        ),
      },
    }),
    /UNKEEP_MAX_ENCRYPTED_RECORD_BYTES must be an integer between 1 and 1099511627776/,
  );
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_MAX_ATTACHMENT_SIZE: String(100 * 1024 * 1024 + 1) },
    }),
    /UNKEEP_MAX_ATTACHMENT_SIZE must be an integer between 1 and 104857600/,
  );
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_MAX_DEVICES: '100001' },
    }),
    /UNKEEP_MAX_DEVICES must be an integer between 1 and 100000/,
  );
  await assert.rejects(
    startTestServer({
      env: { UNKEEP_MAX_SERVICE_CREDENTIALS: '1000001' },
    }),
    /UNKEEP_MAX_SERVICE_CREDENTIALS must be an integer between 1 and 1000000/,
  );
});

test('setup claim and recovery atomically reject a changed relay instance without mutating access', async t => {
  const relay=await startTestServer({
    setupToken:'test-setup-token-0000000000000001',
    env:{UNKEEP_RECOVERY_TOKEN:'operator-recovery-token-0000000001'},
  });
  t.after(relay.stop);
  const api=relay.endpoint;
  const mismatchedInstance='00000000-0000-4000-8000-000000000000';

  let response=await fetch(`${api}/setup/claim`,{
    method:'POST',
    headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},
    body:JSON.stringify({
      expectedInstanceId:mismatchedInstance,
      deviceId:'first-device',
      name:'First device',
    }),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'instance_mismatch'});
  assert.deepEqual(await (await fetch(`${api}/status`)).json(),{
    protocol:3,
    instanceId:relay.instanceId,
    initialized:false,
  });
  {
    const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM devices').get().count,0);
    } finally {
      database.close();
    }
  }

  response=await fetch(`${api}/setup/claim`,{
    method:'POST',
    headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},
    body:setupBody(relay,{deviceId:'first-device',name:'First device'}),
  });
  assert.equal(response.status,201);
  const claimed=await response.json();

  response=await fetch(`${api}/setup/reclaim`,{
    method:'POST',
    headers:{authorization:'Recovery operator-recovery-token-0000000001','content-type':'application/json'},
    body:JSON.stringify({
      expectedInstanceId:mismatchedInstance,
      deviceId:'recovered-device',
      name:'Recovered device',
    }),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'instance_mismatch'});

  const ownerHeaders={authorization:`Device ${claimed.deviceCredential}`};
  response=await fetch(`${api}/vault`,{headers:ownerHeaders});
  assert.equal(response.status,200);
  response=await fetch(`${api}/devices`,{headers:ownerHeaders});
  assert.deepEqual((await response.json()).devices,[{
    id:'first-device',
    name:'First device',
    revokedAt:null,
    approvedByDeviceId:null,
  }]);

  response=await fetch(`${api}/setup/reclaim`,{
    method:'POST',
    headers:{authorization:'Recovery operator-recovery-token-0000000001','content-type':'application/json'},
    body:setupBody(relay,{deviceId:'recovered-device',name:'Recovered device'}),
  });
  assert.equal(response.status,201);
  assert.ok((await response.json()).deviceCredential);
});

test('pairing creation rejects an uninitialized relay before reserving capacity', async t => {
  const relay=await startTestServer({
    env:{
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT:'1',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT:'1',
    },
  });
  t.after(relay.stop);

  const response=await fetch(`${relay.endpoint}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'pre-setup-device'),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'not_initialized'});

  const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count,0);
  } finally {
    database.close();
  }

  await initializeRelay(relay,'post-setup-owner');
  const postSetup=await fetch(`${relay.endpoint}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'post-setup-device'),
  });
  assert.equal(postSetup.status,201);
});

test('claims a server once and syncs opaque records', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token-0000000000000001'});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/status`);assert.deepEqual((await response.json()).initialized,false);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},body:setupBody(relay,{deviceId:'device-one',name:'Test'})});assert.equal(response.status,201);const claimed=await response.json();assert.ok(claimed.deviceCredential);
  response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},body:setupBody(relay,{deviceId:'device-two'})});assert.equal(response.status,409);
  const headers={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};
  const envelope=testEnvelope('note-one');
  response=await fetch(`${api}/notes/note-one`,{method:'PUT',headers,body:JSON.stringify({mutationId:'mutation-one',baseRevision:0,envelope,deleted:false})});assert.equal(response.status,200);
  response=await fetch(`${api}/changes?since=0`,{headers});const changes=await response.json();assert.equal(changes.changes.length,1);assert.deepEqual(changes.changes[0].envelope,envelope);
});

test('rejects record route IDs beyond the client protocol limit before persistence', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const claimed = await initializeRelay(relay, 'record-id-owner');
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };
  const maximumId = 'a'.repeat(128);
  const oversizedId = 'b'.repeat(129);

  let response = await fetch(`${relay.endpoint}/notes/${maximumId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'maximum-record-id',
      baseRevision: 0,
      envelope: testEnvelope(maximumId),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);

  for (const kind of ['notes', 'attachments']) {
    response = await fetch(`${relay.endpoint}/${kind}/${oversizedId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        mutationId: `oversized-${kind}-id`,
        baseRevision: 0,
        ...(kind === 'attachments' ? { noteId: 'owner-note' } : {}),
        envelope: testEnvelope(oversizedId),
        deleted: false,
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_record_id' });
  }

  response = await fetch(`${relay.endpoint}/attachments/${oversizedId}`, {
    headers,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_record_id' });

  response = await fetch(`${relay.endpoint}/changes?since=0`, { headers });
  const changes = await response.json();
  assert.deepEqual(changes.changes.map(change => change.id), [maximumId]);
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM records WHERE length(id)>128').get().count,
      0,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM mutations
        WHERE id IN ('oversized-notes-id','oversized-attachments-id')
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('rejects attachments over the configured size limit', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token-0000000000000001',env:{UNKEEP_MAX_ATTACHMENT_SIZE:'8'}});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},body:setupBody(relay,{deviceId:'device-one',name:'Test'})});const claimed=await response.json();
  const headers={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};
  const envelope={...testEnvelope('file-one'),ciphertext:Buffer.alloc(25).toString('base64')};
  response=await fetch(`${api}/attachments/file-one`,{method:'PUT',headers,body:JSON.stringify({mutationId:'mutation-one',baseRevision:0,noteId:'note-one',envelope,deleted:false})});
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:'attachment_too_large'});
});

test('keeps attachment change rows bounded by omitting their encrypted bytes', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;
  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'attachment-feed-device', name: 'Attachment feed test' }),
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
    iv: Buffer.alloc(12, 1).toString('base64'),
    ciphertext: Buffer.alloc(512 * 1024, 7).toString('base64'),
  };

  const staged = await stageTestAttachment(relay, claimed.deviceCredential, {
    bundleMutationId: 'large-file-mutation',
    noteId: 'attachment-owner',
    attachmentId: 'large-file',
    envelope,
  });
  assert.equal(staged.response.status, 201);
  const finalized = await finalizeTestBundle(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'large-file-mutation',
      noteId: 'attachment-owner',
      baseRevision: 0,
      newAttachments: [
        { id: 'large-file', stageHash: staged.body.stageHash },
      ],
    },
  );
  assert.equal(finalized.response.status, 200);
  const revision = finalized.body.attachmentRevisions[0].revision;

  response = await fetch(`${api}/changes?since=0`, { headers });
  const feed = await response.json();
  assert.equal(feed.changes.length, 2);
  assert.equal('envelope' in feed.changes[0], false);
  assert.deepEqual(feed.changes[0], {
    kind: 'attachment',
    id: 'large-file',
    noteId: 'attachment-owner',
    deleted: false,
    revision,
  });
  assert.equal(feed.cursor, finalized.body.revision);
  assert.ok(JSON.stringify(feed).length < 1024);
});

test('enforces the encrypted-record byte budget by atomic replacement delta while allowing deletes', async t => {
  const initialEnvelope = testEnvelope('quota-note', 'x'.repeat(64));
  const byteLimit = storedEnvelopeBytes(initialEnvelope);
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_ENCRYPTED_RECORD_BYTES: String(byteLimit),
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'byte-quota-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  let response = await fetch(`${relay.endpoint}/notes/quota-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'quota-note-create',
      baseRevision: 0,
      envelope: initialEnvelope,
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();

  response = await fetch(`${relay.endpoint}/notes/quota-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'quota-note-too-large',
      baseRevision: created.revision,
      envelope: testEnvelope('quota-note', 'x'.repeat(128)),
      deleted: false,
    }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), {
    error: 'encrypted_record_bytes_limit',
  });

  response = await fetch(`${relay.endpoint}/notes/quota-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'quota-note-smaller',
      baseRevision: created.revision,
      envelope: testEnvelope('quota-note', 'small'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const smaller = await response.json();

  response = await fetch(`${relay.endpoint}/notes/second-quota-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'quota-second-create',
      baseRevision: 0,
      envelope: testEnvelope('second-quota-note'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), {
    error: 'encrypted_record_bytes_limit',
  });

  response = await fetch(`${relay.endpoint}/notes/quota-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'quota-note-delete',
      baseRevision: smaller.revision,
      envelope: testEnvelope('quota-note'),
      deleted: true,
    }),
  });
  assert.equal(response.status, 200);

  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    const usage = database.prepare(`
      SELECT record_count AS count,encrypted_bytes AS encryptedBytes
      FROM record_storage_usage
      WHERE singleton=1
    `).get();
    assert.equal(usage.count, 1);
    assert.ok(usage.encryptedBytes <= byteLimit);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM mutations
        WHERE id='quota-note-too-large'
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('allows storage-reducing repair while an existing vault is over its byte budget', async t => {
  const smallerEnvelope = testEnvelope('over-budget-note');
  const smallerBytes = storedEnvelopeBytes(smallerEnvelope);
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_ENCRYPTED_RECORD_BYTES: String(smallerBytes - 1),
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'over-budget-owner');
  const oversizedEnvelope = testEnvelope(
    'over-budget-note',
    'x'.repeat(512),
  );
  const serializedOversizedEnvelope = JSON.stringify(oversizedEnvelope);
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.prepare(`
      INSERT INTO records(
        kind,id,note_id,envelope,deleted,revision
      ) VALUES('note',?,?,?,0,1)
    `).run(
      'over-budget-note',
      null,
      serializedOversizedEnvelope,
    );
  } finally {
    database.close();
  }
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  let response = await fetch(`${relay.endpoint}/notes/over-budget-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'over-budget-reduction',
      baseRevision: 1,
      envelope: smallerEnvelope,
      deleted: true,
    }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${relay.endpoint}/notes/over-budget-growth`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'over-budget-growth',
      baseRevision: 0,
      envelope: testEnvelope('over-budget-growth'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), {
    error: 'encrypted_record_bytes_limit',
  });
});

test('atomically enforces total-record and attachment-count budgets under concurrent writes', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_RECORDS: '3',
      UNKEEP_MAX_ATTACHMENTS: '1',
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'count-quota-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  let response = await fetch(`${relay.endpoint}/notes/count-owner`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'count-owner-create',
      baseRevision: 0,
      envelope: testEnvelope('count-owner'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const firstStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    {
      bundleMutationId: 'count-attachment-create',
      noteId: 'count-owner',
      attachmentId: 'count-attachment',
    },
  );
  assert.equal(firstStage.response.status, 201);
  const firstBundle = await finalizeTestBundle(
    relay,
    owner.deviceCredential,
    {
      bundleMutationId: 'count-attachment-create',
      noteId: 'count-owner',
      baseRevision: 1,
      newAttachments: [{
        id: 'count-attachment',
        stageHash: firstStage.body.stageHash,
      }],
    },
  );
  assert.equal(firstBundle.response.status, 200);
  const secondStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    {
      bundleMutationId: 'count-attachment-two-create',
      noteId: 'count-owner',
      attachmentId: 'count-attachment-two',
    },
  );
  assert.equal(secondStage.response.status, 507);
  assert.deepEqual(secondStage.body, {
    error: 'attachment_count_limit',
  });
  response = await fetch(`${relay.endpoint}/notes/count-second-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'count-second-note-create',
      baseRevision: 0,
      envelope: testEnvelope('count-second-note'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${relay.endpoint}/notes/count-third-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'count-third-note-create',
      baseRevision: 0,
      envelope: testEnvelope('count-third-note'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), { error: 'record_count_limit' });

  const concurrentRelay = await startTestServer({
    env: { UNKEEP_MAX_RECORDS: '1' },
  });
  t.after(concurrentRelay.stop);
  const concurrentOwner = await initializeRelay(
    concurrentRelay,
    'concurrent-quota-owner',
  );
  const concurrentHeaders = {
    authorization: `Device ${concurrentOwner.deviceCredential}`,
    'content-type': 'application/json',
  };
  const concurrentResponses = await Promise.all(
    ['concurrent-a', 'concurrent-b'].map(id => fetch(
      `${concurrentRelay.endpoint}/notes/${id}`,
      {
        method: 'PUT',
        headers: concurrentHeaders,
        body: JSON.stringify({
          mutationId: `${id}-mutation`,
          baseRevision: 0,
          envelope: testEnvelope(id),
          deleted: false,
        }),
      },
    )),
  );
  assert.deepEqual(
    concurrentResponses.map(result => result.status).sort(),
    [200, 507],
  );
  const rejected = concurrentResponses.find(result => result.status === 507);
  assert.deepEqual(await rejected.json(), { error: 'record_count_limit' });
});

test('bounds mutation receipts while preserving recent lost-response replay', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_MUTATION_RECEIPTS: '2',
      UNKEEP_MUTATION_RECEIPT_TTL_MS: '60000',
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'mutation-retention-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  const firstMutation = {
    mutationId: 'retained-mutation-one',
    baseRevision: 0,
    envelope: testEnvelope('retained-note', 'first'),
    deleted: false,
  };

  let response = await fetch(`${relay.endpoint}/notes/retained-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(firstMutation),
  });
  assert.equal(response.status, 200);
  const firstResult = await response.json();
  const secondMutation = {
    mutationId: 'retained-mutation-two',
    baseRevision: firstResult.revision,
    envelope: testEnvelope('retained-note', 'second'),
    deleted: false,
  };
  response = await fetch(`${relay.endpoint}/notes/retained-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(secondMutation),
  });
  assert.equal(response.status, 200);
  const secondResult = await response.json();

  response = await fetch(`${relay.endpoint}/notes/retained-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(firstMutation),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), firstResult);

  response = await fetch(`${relay.endpoint}/notes/retention-trigger`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'retained-mutation-three',
      baseRevision: 0,
      envelope: testEnvelope('retention-trigger'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${relay.endpoint}/notes/retained-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(secondMutation),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), secondResult);

  {
    const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
    try {
      assert.deepEqual(
        database.prepare(`
          SELECT id
          FROM mutations
          ORDER BY revision,id
        `).all().map(row => row.id),
        ['retained-mutation-two', 'retained-mutation-three'],
      );
      database.prepare(`
        UPDATE mutations
        SET created_at=0
        WHERE id='retained-mutation-two'
      `).run();
    } finally {
      database.close();
    }
  }

  response = await fetch(`${relay.endpoint}/notes/retention-trigger`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'retained-mutation-four',
      baseRevision: 3,
      envelope: testEnvelope('retention-trigger', 'updated'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${relay.endpoint}/notes/retained-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(secondMutation),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'record_conflict',
    currentRevision: secondResult.revision,
  });
  const verification = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      verification.prepare('SELECT COUNT(*) AS count FROM mutations').get().count,
      2,
    );
  } finally {
    verification.close();
  }
});

test('mints, uses, lists, and revokes a service credential', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token-0000000000000001'});t.after(relay.stop);const api=relay.endpoint;
  let response=await fetch(`${api}/setup/claim`,{method:'POST',headers:{authorization:'Setup test-setup-token-0000000000000001','content-type':'application/json'},body:setupBody(relay,{deviceId:'device-one',name:'Test device'})});
  const claimed=await response.json();const deviceHeaders={authorization:`Device ${claimed.deviceCredential}`,'content-type':'application/json'};

  response=await fetch(`${api}/service-credentials`,{method:'POST',headers:deviceHeaders,body:JSON.stringify({name:'Build agent',scope:'read-write'})});
  assert.equal(response.status,201);const minted=await response.json();assert.equal(minted.name,'Build agent');assert.equal(minted.scope,'read-write');assert.equal(minted.issuedByDeviceId,'device-one');assert.ok(minted.id);assert.ok(minted.serviceCredential);

  response=await fetch(`${api}/service-credentials`,{headers:deviceHeaders});assert.equal(response.status,200);
  assert.deepEqual((await response.json()).serviceCredentials,[{id:minted.id,name:'Build agent',scope:'read-write',createdAt:minted.createdAt,revokedAt:null,issuedByDeviceId:'device-one'}]);

  const serviceHeaders={authorization:`Service ${minted.serviceCredential}`,'content-type':'application/json'};
  const noteEnvelope=testEnvelope('note-one','opaque-note-ciphertext');
  const attachmentEnvelope=testEnvelope('file-one','opaque-file-ciphertext');
  const serviceStage=await stageTestAttachment(relay,minted.serviceCredential,{
    bundleMutationId:'service-file-mutation',
    noteId:'note-one',
    attachmentId:'file-one',
    envelope:attachmentEnvelope,
    credentialKind:'Service',
  });
  assert.equal(serviceStage.response.status,201);
  const serviceBundle=await finalizeTestBundle(relay,minted.serviceCredential,{
    bundleMutationId:'service-file-mutation',
    noteId:'note-one',
    baseRevision:0,
    envelope:noteEnvelope,
    newAttachments:[{id:'file-one',stageHash:serviceStage.body.stageHash}],
    credentialKind:'Service',
  });
  assert.equal(serviceBundle.response.status,200);
  response=await fetch(`${api}/changes?since=0`,{headers:serviceHeaders});assert.equal(response.status,200);assert.equal((await response.json()).changes.length,2);

  response=await fetch(`${api}/service-credentials/${minted.id}`,{method:'DELETE',headers:deviceHeaders});assert.equal(response.status,204);
  response=await fetch(`${api}/changes?since=0`,{headers:serviceHeaders});assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'invalid_service_credential'});
});

test('atomically bounds long-lived device and service-credential registries', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: {
      UNKEEP_MAX_DEVICES: '2',
      UNKEEP_MAX_SERVICE_CREDENTIALS: '1',
      UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001',
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'registry-owner');
  const ownerHeaders = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  const serviceResponses = await Promise.all(
    ['Concurrent agent A', 'Concurrent agent B'].map(name => fetch(
      `${relay.endpoint}/service-credentials`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ name, scope: 'read-only' }),
      },
    )),
  );
  assert.deepEqual(
    serviceResponses.map(response => response.status).sort(),
    [201, 507],
  );
  const acceptedServiceResponse = serviceResponses.find(response => response.status === 201);
  const rejectedServiceResponse = serviceResponses.find(response => response.status === 507);
  assert.ok(acceptedServiceResponse);
  assert.ok(rejectedServiceResponse);
  const acceptedService = await acceptedServiceResponse.json();
  assert.deepEqual(await rejectedServiceResponse.json(), {
    error: 'service_credential_count_limit',
  });

  let response = await fetch(
    `${relay.endpoint}/service-credentials/${acceptedService.id}`,
    { method: 'DELETE', headers: ownerHeaders },
  );
  assert.equal(response.status, 204);
  response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Replacement agent', scope: 'read-only' }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), {
    error: 'service_credential_count_limit',
  });
  response = await fetch(`${relay.endpoint}/service-credentials`, {
    headers: ownerHeaders,
  });
  const retainedServices = (await response.json()).serviceCredentials;
  assert.equal(retainedServices.length, 1);
  assert.equal(typeof retainedServices[0].revokedAt, 'string');

  const pairings = [];
  for (const deviceId of ['registry-device-a', 'registry-device-b']) {
    response = await fetch(`${relay.endpoint}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pairingBody(relay, deviceId),
    });
    assert.equal(response.status, 201);
    const pairing = await response.json();
    pairings.push({ ...pairing, deviceId });
    response = await fetch(
      `${relay.endpoint}/pairings/${pairing.requestId}/approve`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({ response: { encryptedMasterKey: `for-${deviceId}` } }),
      },
    );
    assert.equal(response.status, 200);
  }

  const consumeResponses = await Promise.all(pairings.map(pairing => fetch(
    `${relay.endpoint}/pairings/${pairing.requestId}/consume`,
    {
      method: 'POST',
      headers: {
        authorization: `Device ${pairingCredential(pairing.deviceId)}`,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  )));
  assert.deepEqual(
    consumeResponses.map(result => result.status).sort(),
    [200, 507],
  );
  const rejectedConsume = consumeResponses.find(result => result.status === 507);
  assert.ok(rejectedConsume);
  assert.deepEqual(await rejectedConsume.json(), { error: 'device_count_limit' });
  const acceptedDevice = pairings[consumeResponses.findIndex(result => result.status === 200)];
  assert.ok(acceptedDevice);

  response = await fetch(
    `${relay.endpoint}/devices/${acceptedDevice.deviceId}`,
    { method: 'DELETE', headers: ownerHeaders },
  );
  assert.equal(response.status, 204);
  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'registry-device-after-revoke'),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), { error: 'device_count_limit' });

  response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, {
      deviceId: 'registry-owner',
      name: 'Recovered registry owner',
    }),
  });
  assert.equal(response.status, 201);
  response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, {
      deviceId: 'new-recovery-root',
      name: 'New recovery root',
    }),
  });
  assert.equal(response.status, 507);
  assert.deepEqual(await response.json(), { error: 'device_count_limit' });

  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM devices').get().count,
      2,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM service_credentials').get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test('read-only service credentials can decrypt sync downloads but cannot mutate records or administer access', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;
  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'scope-owner', name: 'Scope owner' }),
  });
  const claimed = await response.json();
  const deviceHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };
  const noteEnvelope = testEnvelope('existing-note', 'opaque-note-ciphertext');
  const attachmentEnvelope = testEnvelope('existing-file', 'opaque-file-ciphertext');
  const seedStage = await stageTestAttachment(relay, claimed.deviceCredential, {
    bundleMutationId: 'seed-file',
    noteId: 'existing-note',
    attachmentId: 'existing-file',
    envelope: attachmentEnvelope,
  });
  assert.equal(seedStage.response.status, 201);
  const seedBundle = await finalizeTestBundle(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'seed-file',
      noteId: 'existing-note',
      baseRevision: 0,
      envelope: noteEnvelope,
      newAttachments: [{
        id: 'existing-file',
        stageHash: seedStage.body.stageHash,
      }],
    },
  );
  assert.equal(seedBundle.response.status, 200);

  response = await fetch(`${api}/service-credentials`, {
    method: 'POST',
    headers: deviceHeaders,
    body: JSON.stringify({ name: 'Audit agent' }),
  });
  assert.equal(response.status, 201);
  const readOnly = await response.json();
  assert.equal(readOnly.scope, 'read-only');
  const serviceHeaders = {
    authorization: `Service ${readOnly.serviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/status`, { headers: serviceHeaders });
  assert.equal(response.status, 200);
  response = await fetch(`${api}/vault`, { headers: serviceHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { vaultId: claimed.instanceId });
  response = await fetch(`${api}/changes?since=0`, { headers: serviceHeaders });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changes.length, 2);
  response = await fetch(`${api}/attachments/existing-file`, { headers: serviceHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).envelope, attachmentEnvelope);

  for (const [path, value] of [
    ['/notes/rejected-note', { mutationId: 'rejected-note', envelope: noteEnvelope, deleted: false }],
    ['/notes/rejected-note-delete', {
      mutationId: 'rejected-note-delete',
      envelope: noteEnvelope,
      deleted: true,
    }],
    ['/attachments/rejected-file', {
      mutationId: 'rejected-file',
      noteId: 'existing-note',
      envelope: attachmentEnvelope,
      deleted: false,
    }],
    ['/attachments/rejected-file-delete', {
      mutationId: 'rejected-file-delete',
      noteId: 'existing-note',
      envelope: attachmentEnvelope,
      deleted: true,
    }],
  ]) {
    response = await fetch(`${api}${path}`, {
      method: 'PUT',
      headers: serviceHeaders,
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'service_credential_read_only' });
  }

  const adminRequests = [
    fetch(`${api}/service-credentials`, { headers: serviceHeaders }),
    fetch(`${api}/service-credentials`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ name: 'Forbidden child', scope: 'read-only' }),
    }),
    fetch(`${api}/service-credentials/${readOnly.id}`, {
      method: 'DELETE',
      headers: serviceHeaders,
    }),
    fetch(`${api}/devices`, { headers: serviceHeaders }),
    fetch(`${api}/devices`, { method: 'DELETE', headers: serviceHeaders }),
    fetch(`${api}/devices/scope-owner`, { method: 'DELETE', headers: serviceHeaders }),
    fetch(`${api}/pairings/code/ABCDEFGH`, { headers: serviceHeaders }),
    fetch(`${api}/pairings/00000000-0000-4000-8000-000000000000/approve`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ response: {} }),
    }),
  ];
  for (const adminResponse of await Promise.all(adminRequests)) {
    assert.equal(adminResponse.status, 403);
    assert.deepEqual(await adminResponse.json(), { error: 'device_credential_required' });
  }

  for (const scope of ['admin', null, '', true]) {
    response = await fetch(`${api}/service-credentials`, {
      method: 'POST',
      headers: deviceHeaders,
      body: JSON.stringify({ name: 'Invalid scope', scope }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_service_credential_scope' });
  }

  response = await fetch(`${api}/notes/device-still-writes`, {
    method: 'PUT',
    headers: deviceHeaders,
    body: JSON.stringify({
      mutationId: 'device-still-writes',
      baseRevision: 0,
      envelope: testEnvelope('device-still-writes'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
});

test('revoking a device also revokes service credentials minted by that device', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'credential-parent', name: 'Credential parent' }),
  });
  const claimed = await response.json();
  const deviceHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/service-credentials`, {
    method: 'POST',
    headers: deviceHeaders,
    body: JSON.stringify({ name: 'Descendant agent' }),
  });
  assert.equal(response.status, 201);
  const minted = await response.json();

  response = await fetch(`${api}/devices/credential-parent`, {
    method: 'DELETE',
    headers: deviceHeaders,
  });
  assert.equal(response.status, 204);

  response = await fetch(`${api}/vault`, {
    headers: { authorization: `Service ${minted.serviceCredential}` },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_service_credential' });
});

test('targeted device revocation contains a paired lineage without revoking independent roots', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  t.after(relay.stop);

  const firstRoot = await initializeRelay(relay, 'lineage-root');
  let response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, {
      deviceId: 'independent-root',
      name: 'Independent root',
    }),
  });
  assert.equal(response.status, 201);
  const independentRoot = await response.json();

  const parent = await pairDevice(
    relay,
    firstRoot.deviceCredential,
    'branch-parent',
  );
  const child = await pairDevice(relay, parent.credential, 'branch-child');
  const grandchild = await pairDevice(
    relay,
    child.credential,
    'branch-grandchild',
  );
  const unrelatedChild = await pairDevice(
    relay,
    independentRoot.deviceCredential,
    'unrelated-child',
  );
  const parentService = await mintServiceCredential(
    relay,
    parent.credential,
    'Parent agent',
  );
  const grandchildService = await mintServiceCredential(
    relay,
    grandchild.credential,
    'Grandchild agent',
  );
  const unrelatedService = await mintServiceCredential(
    relay,
    unrelatedChild.credential,
    'Unrelated agent',
  );

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'pending-descendant'),
  });
  assert.equal(response.status, 201);
  const pendingDescendant = await response.json();
  response = await fetch(
    `${relay.endpoint}/pairings/${pendingDescendant.requestId}/approve`,
    {
      method: 'POST',
      headers: {
        authorization: `Device ${grandchild.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        response: { encryptedMasterKey: 'must-be-invalidated-recursively' },
      }),
    },
  );
  assert.equal(response.status, 200);

  response = await fetch(`${relay.endpoint}/devices/branch-parent`, {
    method: 'DELETE',
    headers: {
      authorization: `Device ${independentRoot.deviceCredential}`,
    },
  });
  assert.equal(response.status, 204);

  for (const credential of [
    parent.credential,
    child.credential,
    grandchild.credential,
  ]) {
    response = await fetch(`${relay.endpoint}/vault`, {
      headers: { authorization: `Device ${credential}` },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: 'invalid_device_credential',
    });
  }
  for (const credential of [
    firstRoot.deviceCredential,
    independentRoot.deviceCredential,
    unrelatedChild.credential,
  ]) {
    response = await fetch(`${relay.endpoint}/vault`, {
      headers: { authorization: `Device ${credential}` },
    });
    assert.equal(response.status, 200);
  }
  for (const service of [parentService, grandchildService]) {
    response = await fetch(`${relay.endpoint}/vault`, {
      headers: { authorization: `Service ${service.serviceCredential}` },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: 'invalid_service_credential',
    });
  }
  response = await fetch(`${relay.endpoint}/vault`, {
    headers: {
      authorization: `Service ${unrelatedService.serviceCredential}`,
    },
  });
  assert.equal(response.status, 200);

  response = await fetch(
    `${relay.endpoint}/pairings/${pendingDescendant.requestId}`,
    {
      headers: {
        'unkeep-pairing-secret': pendingDescendant.pollSecret,
      },
    },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });

  response = await fetch(`${relay.endpoint}/devices`, {
    headers: {
      authorization: `Device ${independentRoot.deviceCredential}`,
    },
  });
  assert.equal(response.status, 200);
  const devices = new Map(
    (await response.json()).devices.map(device => [device.id, device]),
  );
  assert.deepEqual(devices.get('lineage-root'), {
    id: 'lineage-root',
    name: 'Device lineage-root',
    revokedAt: null,
    approvedByDeviceId: null,
  });
  assert.deepEqual(devices.get('independent-root'), {
    id: 'independent-root',
    name: 'Independent root',
    revokedAt: null,
    approvedByDeviceId: null,
  });
  assert.deepEqual(devices.get('unrelated-child'), {
    id: 'unrelated-child',
    name: 'Device unrelated-child',
    revokedAt: null,
    approvedByDeviceId: 'independent-root',
  });
  assert.equal(devices.get('branch-parent').approvedByDeviceId, 'lineage-root');
  assert.equal(devices.get('branch-child').approvedByDeviceId, 'branch-parent');
  assert.equal(
    devices.get('branch-grandchild').approvedByDeviceId,
    'branch-child',
  );
  assert.equal(typeof devices.get('branch-parent').revokedAt, 'string');
  assert.equal(typeof devices.get('branch-child').revokedAt, 'string');
  assert.equal(typeof devices.get('branch-grandchild').revokedAt, 'string');
});

test('emergency revocation invalidates all access and pairing state while preserving recovery', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  t.after(relay.stop);

  const firstRoot = await initializeRelay(relay, 'emergency-root');
  let response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, {
      deviceId: 'emergency-recovery-root',
      name: 'Emergency recovery root',
    }),
  });
  assert.equal(response.status, 201);
  const recoveryRoot = await response.json();
  const child = await pairDevice(
    relay,
    firstRoot.deviceCredential,
    'emergency-child',
  );
  const childService = await mintServiceCredential(
    relay,
    child.credential,
    'Emergency child agent',
  );
  const rootService = await mintServiceCredential(
    relay,
    recoveryRoot.deviceCredential,
    'Emergency root agent',
  );

  const legacyServiceCredential = 'legacy-unattributed-service-credential';
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.prepare(`
      INSERT INTO service_credentials(
        id,name,token_hash,scope,issued_by_device_id
      ) VALUES(?,?,?,?,NULL)
    `).run(
      'legacy-unattributed-service',
      'Legacy unattributed service',
      createHash('sha256').update(legacyServiceCredential).digest('hex'),
      'read-write',
    );
  } finally {
    database.close();
  }

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'emergency-approved-pending'),
  });
  assert.equal(response.status, 201);
  const approvedPending = await response.json();
  response = await fetch(
    `${relay.endpoint}/pairings/${approvedPending.requestId}/approve`,
    {
      method: 'POST',
      headers: {
        authorization: `Device ${child.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        response: { encryptedMasterKey: 'emergency-pending' },
      }),
    },
  );
  assert.equal(response.status, 200);
  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'emergency-unapproved-pending'),
  });
  assert.equal(response.status, 201);
  const unapprovedPending = await response.json();

  response = await fetch(`${relay.endpoint}/devices`, {
    method: 'DELETE',
    headers: {
      authorization: `Service ${childService.serviceCredential}`,
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'device_credential_required',
  });

  response = await fetch(`${relay.endpoint}/devices`, {
    method: 'DELETE',
    headers: {
      authorization: `Device ${recoveryRoot.deviceCredential}`,
    },
  });
  assert.equal(response.status, 204);

  for (const credential of [
    firstRoot.deviceCredential,
    recoveryRoot.deviceCredential,
    child.credential,
  ]) {
    response = await fetch(`${relay.endpoint}/vault`, {
      headers: { authorization: `Device ${credential}` },
    });
    assert.equal(response.status, 401);
  }
  for (const credential of [
    childService.serviceCredential,
    rootService.serviceCredential,
    legacyServiceCredential,
  ]) {
    response = await fetch(`${relay.endpoint}/vault`, {
      headers: { authorization: `Service ${credential}` },
    });
    assert.equal(response.status, 401);
  }
  for (const pairing of [approvedPending, unapprovedPending]) {
    response = await fetch(`${relay.endpoint}/pairings/${pairing.requestId}`, {
      headers: { 'unkeep-pairing-secret': pairing.pollSecret },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'pairing_not_found' });
  }

  {
    const verification = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
    try {
      assert.equal(
        verification.prepare(`
          SELECT COUNT(*) AS count
          FROM devices
          WHERE revoked_at IS NULL
        `).get().count,
        0,
      );
      assert.equal(
        verification.prepare(`
          SELECT COUNT(*) AS count
          FROM service_credentials
          WHERE revoked_at IS NULL
        `).get().count,
        0,
      );
      assert.equal(
        verification.prepare(
          'SELECT COUNT(*) AS count FROM pairing_requests',
        ).get().count,
        0,
      );
      assert.equal(
        verification.prepare(
          'SELECT COUNT(*) AS count FROM pairing_consume_receipts',
        ).get().count,
        0,
      );
    } finally {
      verification.close();
    }
  }

  response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, {
      deviceId: 'emergency-child',
      name: 'Recovered clean root',
    }),
  });
  assert.equal(response.status, 201);
  const recovered = await response.json();
  response = await fetch(`${relay.endpoint}/devices`, {
    headers: {
      authorization: `Device ${recovered.deviceCredential}`,
    },
  });
  assert.equal(response.status, 200);
  const recoveredDevices = new Map(
    (await response.json()).devices.map(device => [device.id, device]),
  );
  assert.deepEqual(recoveredDevices.get('emergency-child'), {
    id: 'emergency-child',
    name: 'Recovered clean root',
    revokedAt: null,
    approvedByDeviceId: null,
  });
  assert.equal(
    typeof recoveredDevices.get('emergency-root').revokedAt,
    'string',
  );
  assert.equal(
    typeof recoveredDevices.get('emergency-recovery-root').revokedAt,
    'string',
  );
});

test('revocation wins against an authenticated slow service-credential mint', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  t.after(relay.stop);
  const attacker = await initializeRelay(relay, 'slow-mint-device');
  let response = await fetch(`${relay.endpoint}/setup/reclaim`, {
    method: 'POST',
    headers: {
      authorization: 'Recovery operator-recovery-token-0000000001',
      'content-type': 'application/json',
    },
    body: setupBody(relay, { deviceId: 'revoking-device', name: 'Revoker' }),
  });
  assert.equal(response.status, 201);
  const revoker = await response.json();

  const slowMint = partialJsonRequest(
    `${relay.endpoint}/service-credentials`,
    {
      method: 'POST',
      headers: {
        authorization: `Device ${attacker.deviceCredential}`,
        'content-type': 'application/json',
      },
    },
    '{"name":"late',
  );
  await slowMint.flushed;
  await new Promise(resolve => setImmediate(resolve));

  response = await fetch(`${relay.endpoint}/devices/slow-mint-device`, {
    method: 'DELETE',
    headers: { authorization: `Device ${revoker.deviceCredential}` },
  });
  assert.equal(response.status, 204);

  assert.deepEqual(await slowMint.finish(' credential","scope":"read-write"}'), {
    status: 401,
    body: { error: 'invalid_device_credential' },
  });
  response = await fetch(`${relay.endpoint}/service-credentials`, {
    headers: { authorization: `Device ${revoker.deviceCredential}` },
  });
  assert.deepEqual((await response.json()).serviceCredentials, []);
});

test('service revocation wins against an authenticated slow record mutation', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'slow-write-owner');
  const ownerHeaders = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  let response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Slow writer', scope: 'read-write' }),
  });
  assert.equal(response.status, 201);
  const service = await response.json();
  const serialized = JSON.stringify({
    mutationId: 'slow-service-write',
    baseRevision: 0,
    envelope: testEnvelope('slow-note'),
    deleted: false,
  });
  const split = Math.floor(serialized.length / 2);
  const slowWrite = partialJsonRequest(
    `${relay.endpoint}/notes/slow-note`,
    {
      method: 'PUT',
      headers: {
        authorization: `Service ${service.serviceCredential}`,
        'content-type': 'application/json',
      },
    },
    serialized.slice(0, split),
  );
  await slowWrite.flushed;
  await new Promise(resolve => setImmediate(resolve));

  response = await fetch(`${relay.endpoint}/service-credentials/${service.id}`, {
    method: 'DELETE',
    headers: ownerHeaders,
  });
  assert.equal(response.status, 204);
  assert.deepEqual(await slowWrite.finish(serialized.slice(split)), {
    status: 401,
    body: { error: 'invalid_service_credential' },
  });
  response = await fetch(`${relay.endpoint}/changes?since=0`, { headers: ownerHeaders });
  assert.deepEqual(await response.json(), { changes: [], cursor: 0 });
});

test('operator recovery mints a new device credential after every device is lost', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_RECOVERY_TOKEN: 'operator-recovery-token-0000000001' },
  });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'device-one', name: 'Lost device' }),
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
    headers: { authorization: 'Recovery test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'unauthorized-device', name: 'Unauthorized' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_recovery_token' });

  response = await fetch(`${api}/setup/reclaim`, {
    method: 'POST',
    headers: { authorization: 'Recovery operator-recovery-token-0000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'recovered-device', name: 'Recovered device' }),
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

test('rate limits failed setup and recovery secrets per trusted network source', async t => {
  const setupRelay = await startTestServer({
    setupToken: 'rate-limit-setup-token-0000000001',
    env: {
      UNKEEP_RECOVERY_TOKEN: 'rate-limit-recovery-token-0000001',
      UNKEEP_TRUST_PROXY: '1',
      UNKEEP_ADMIN_RATE_WINDOW_MS: '60000',
      UNKEEP_ADMIN_SOURCE_RATE_LIMIT: '2',
      UNKEEP_ADMIN_GLOBAL_RATE_LIMIT: '10',
    },
  });
  t.after(setupRelay.stop);

  const setupRequest = (source, token) => fetch(`${setupRelay.endpoint}/setup/claim`, {
    method: 'POST',
    headers: {
      authorization: `Setup ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': source,
    },
    body: setupBody(setupRelay, {
      deviceId: `setup-device-${source.replaceAll('.', '-')}`,
      name: 'Setup rate test',
    }),
  });

  let response = await setupRequest('192.0.2.1', 'wrong-one');
  assert.equal(response.status, 401);
  response = await setupRequest('192.0.2.1', 'wrong-two');
  assert.equal(response.status, 401);
  response = await setupRequest('192.0.2.1', setupRelay.setupToken);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'setup_rate_limited' });
  assert.match(response.headers.get('retry-after') || '', /^[1-9][0-9]*$/);

  response = await setupRequest('192.0.2.2', setupRelay.setupToken);
  assert.equal(response.status, 201);

  const recoveryRelay = await startTestServer({
    setupToken: 'recovery-rate-setup-token-0000001',
    env: {
      UNKEEP_RECOVERY_TOKEN: 'recovery-rate-secret-token-000001',
      UNKEEP_TRUST_PROXY: '1',
      UNKEEP_ADMIN_RATE_WINDOW_MS: '60000',
      UNKEEP_ADMIN_SOURCE_RATE_LIMIT: '2',
      UNKEEP_ADMIN_GLOBAL_RATE_LIMIT: '10',
    },
  });
  t.after(recoveryRelay.stop);
  await initializeRelay(recoveryRelay, 'recovery-rate-owner');

  const recoveryRequest = (source, token, deviceId) => fetch(
    `${recoveryRelay.endpoint}/setup/reclaim`,
    {
      method: 'POST',
      headers: {
        authorization: `Recovery ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': source,
      },
      body: setupBody(recoveryRelay, { deviceId, name: 'Recovery rate test' }),
    },
  );

  response = await recoveryRequest('198.51.100.1', 'wrong-one', 'wrong-one');
  assert.equal(response.status, 401);
  response = await recoveryRequest('198.51.100.1', 'wrong-two', 'wrong-two');
  assert.equal(response.status, 401);
  response = await recoveryRequest(
    '198.51.100.1',
    'recovery-rate-secret-token-000001',
    'blocked-correct-recovery',
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'recovery_rate_limited' });
  assert.match(response.headers.get('retry-after') || '', /^[1-9][0-9]*$/);

  response = await recoveryRequest(
    '198.51.100.2',
    'recovery-rate-secret-token-000001',
    'allowed-recovery',
  );
  assert.equal(response.status, 201);
});

test('existing deployments can explicitly retain setup-token recovery compatibility', async t => {
  const relay = await startTestServer({
    setupToken: 'retained-setup-token-000000000001',
    env: {
      UNKEEP_RECOVERY_TOKEN: '',
      UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY: '1',
    },
  });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup retained-setup-token-000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'original-device', name: 'Original' }),
  });
  assert.equal(response.status, 201);

  response = await fetch(`${api}/setup/reclaim`, {
    method: 'POST',
    headers: { authorization: 'Recovery retained-setup-token-000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'replacement-device', name: 'Replacement' }),
  });
  assert.equal(response.status, 201);
  assert.ok((await response.json()).deviceCredential);
});

test('bounds pairing request bodies and validates exact public P-256 JWKs', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT: '100',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT: '100',
    },
  });
  t.after(relay.stop);
  const api = relay.endpoint;
  const owner = await initializeRelay(relay, 'body-limit-owner');

  let response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'oversized-device',
      publicKey: VALID_PAIRING_PUBLIC_KEY,
      padding: 'x'.repeat(4096),
    }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request too large' });

  const invalidKeys = [
    null,
    { ...VALID_PAIRING_PUBLIC_KEY, kty: 'RSA' },
    { ...VALID_PAIRING_PUBLIC_KEY, crv: 'P-384' },
    { ...VALID_PAIRING_PUBLIC_KEY, x: 'short' },
    { ...VALID_PAIRING_PUBLIC_KEY, y: `${VALID_PAIRING_PUBLIC_KEY.y}=` },
    { ...VALID_PAIRING_PUBLIC_KEY, d: VALID_PAIRING_PUBLIC_KEY.x },
    { ...VALID_PAIRING_PUBLIC_KEY, alg: 'ES256' },
    { ...VALID_PAIRING_PUBLIC_KEY, key_ops: ['deriveKey'] },
    { ...VALID_PAIRING_PUBLIC_KEY, ext: false },
    { ...VALID_PAIRING_PUBLIC_KEY, x: 'A'.repeat(43), y: 'A'.repeat(43) },
  ];
  for (const [index, publicKey] of invalidKeys.entries()) {
    response = await fetch(`${api}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pairingBody(relay, `invalid-key-${index}`, publicKey),
    });
    assert.equal(response.status, 400, `invalid key ${index}`);
    assert.deepEqual(await response.json(), { error: 'invalid_pairing_public_key' });
  }

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'valid-key-device', {
      ...VALID_PAIRING_PUBLIC_KEY,
      ext: true,
      key_ops: [],
    }),
  });
  assert.equal(response.status, 201);
  const validPairing = await response.json();

  response = await fetch(`${api}/pairings/${validPairing.requestId}/approve`, {
    method: 'POST',
    headers: {
      authorization: `Device ${owner.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ response: { padding: 'x'.repeat(4096) } }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request too large' });
});

test('bounds outstanding pairing rows and frees capacity on cancellation', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_PENDING_PAIRINGS: '2',
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT: '100',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT: '100',
    },
  });
  t.after(relay.stop);
  const api = relay.endpoint;
  await initializeRelay(relay, 'capacity-owner');
  const created = [];

  for (const deviceId of ['capacity-one', 'capacity-two']) {
    const response = await fetch(`${api}/pairings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pairingBody(relay, deviceId),
    });
    assert.equal(response.status, 201);
    created.push(await response.json());
  }

  let response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'capacity-rejected'),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'pairing_capacity_reached' });

  response = await fetch(`${api}/pairings/${created[0].requestId}`, {
    method: 'DELETE',
    headers: { 'unkeep-pairing-secret': created[0].pollSecret },
  });
  assert.equal(response.status, 204);

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'capacity-replacement'),
  });
  assert.equal(response.status, 201);
});

test('malformed unauthenticated pairing bodies consume the creation rate limit', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT: '1',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT: '1',
    },
  });
  t.after(relay.stop);
  await initializeRelay(relay, 'pairing-rate-owner');

  let response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"malformed"',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_json' });

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'rate-limited-after-invalid'),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'pairing_rate_limited' });
});

test('browser-simple non-JSON pairing requests cannot spend pairing capacity', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT: '1',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT: '1',
    },
  });
  t.after(relay.stop);
  await initializeRelay(relay, 'pairing-media-type-owner');

  let response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: pairingBody(relay, 'browser-simple-rejected'),
  });
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: 'unsupported_media_type' });

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'json-capacity-owner'),
  });
  assert.equal(response.status, 201);

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'json-rate-limited'),
  });
  assert.equal(response.status, 429);
});

test('rate limits pairing creation per trusted source and globally', async t => {
  const relay = await startTestServer({
    env: {
      UNKEEP_TRUST_PROXY: '1',
      UNKEEP_MAX_PENDING_PAIRINGS: '100',
      UNKEEP_PAIRING_RATE_WINDOW_MS: '60000',
      UNKEEP_PAIRING_SOURCE_RATE_LIMIT: '2',
      UNKEEP_PAIRING_GLOBAL_RATE_LIMIT: '3',
    },
  });
  t.after(relay.stop);
  const api = relay.endpoint;
  await initializeRelay(relay, 'rate-owner');
  const create = (deviceId, source) => fetch(`${api}/pairings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': source,
    },
    body: pairingBody(relay, deviceId),
  });

  assert.equal((await create('source-one-a', '198.51.100.1')).status, 201);
  assert.equal((await create('source-one-b', '198.51.100.1')).status, 201);
  let response = await create('source-one-c', '198.51.100.1');
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'pairing_rate_limited' });
  assert.equal(response.headers.get('retry-after'), '60');

  assert.equal((await create('source-two-a', '198.51.100.2')).status, 201);
  response = await create('source-three-a', '198.51.100.3');
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'pairing_rate_limited' });
  assert.equal(response.headers.get('retry-after'), '60');
});

test('rejects a pairing credential that aliases a scoped service credential', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'service-alias-owner');

  let response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST',
    headers: {
      authorization: `Device ${owner.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Read-only pairing attacker',
      scope: 'read-only',
    }),
  });
  assert.equal(response.status, 201);
  const service = await response.json();

  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedInstanceId: relay.instanceId,
      deviceId: 'service-alias-device',
      name: 'Service alias device',
      publicKey: VALID_PAIRING_PUBLIC_KEY,
      deviceCredentialHash: createHash('sha256')
        .update(service.serviceCredential)
        .digest('hex'),
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'pairing_credential_unavailable',
  });

  response = await fetch(`${relay.endpoint}/devices`, {
    headers: {
      authorization: `Service ${service.serviceCredential}`,
    },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'device_credential_required',
  });

  response = await fetch(
    `${relay.endpoint}/service-credentials/${service.id}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Device ${owner.deviceCredential}`,
      },
    },
  );
  assert.equal(response.status, 204);
  response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedInstanceId: relay.instanceId,
      deviceId: 'revoked-service-alias-device',
      name: 'Revoked service alias device',
      publicKey: VALID_PAIRING_PUBLIC_KEY,
      deviceCredentialHash: createHash('sha256')
        .update(service.serviceCredential)
        .digest('hex'),
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'pairing_credential_unavailable',
  });
});

test('consume rechecks a newly aliased scoped credential before device activation', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'consume-alias-owner');
  const aliasedCredential = 'consume-alias-read-only-service-token';
  const aliasedHash = createHash('sha256')
    .update(aliasedCredential)
    .digest('hex');

  let response = await fetch(`${relay.endpoint}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedInstanceId: relay.instanceId,
      deviceId: 'consume-alias-device',
      name: 'Consume alias device',
      publicKey: VALID_PAIRING_PUBLIC_KEY,
      deviceCredentialHash: aliasedHash,
    }),
  });
  assert.equal(response.status, 201);
  const pairing = await response.json();

  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    // Simulate a credential registry change after request creation. The
    // consume transaction must recheck instead of trusting the earlier audit.
    database.prepare(`
      INSERT INTO service_credentials(
        id,name,token_hash,scope,issued_by_device_id,revoked_at
      ) VALUES(?,?,?,?,?,datetime('now'))
    `).run(
      'consume-alias-service',
      'Consume alias service',
      aliasedHash,
      'read-only',
      'consume-alias-owner',
    );
  } finally {
    database.close();
  }

  response = await fetch(
    `${relay.endpoint}/pairings/${pairing.requestId}/approve`,
    {
      method: 'POST',
      headers: {
        authorization: `Device ${owner.deviceCredential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        response: { encryptedMasterKey: 'consume-alias' },
      }),
    },
  );
  assert.equal(response.status, 200);

  response = await fetch(
    `${relay.endpoint}/pairings/${pairing.requestId}/consume`,
    {
      method: 'POST',
      headers: {
        authorization: `Service ${aliasedCredential}`,
        'content-type': 'application/json',
      },
      body: '{}',
    },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'pairing_credential_unavailable',
  });

  response = await fetch(`${relay.endpoint}/devices`, {
    headers: {
      authorization: `Service ${aliasedCredential}`,
    },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'invalid_service_credential',
  });
});

test('atomically publishes staged attachments before their note in deterministic order', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'bundle-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  const bundleMutationId = 'bundle-atomic-winner';
  const noteId = 'bundle-note';
  const stages = [];

  for (const attachmentId of ['bundle-file-z', 'bundle-file-a']) {
    const response = await fetch(
      `${relay.endpoint}/note-mutations/${bundleMutationId}/attachments/${attachmentId}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          noteId,
          envelope: testEnvelope(attachmentId, attachmentId),
        }),
      },
    );
    assert.equal(response.status, 201);
    stages.push(await response.json());
  }

  let response = await fetch(`${relay.endpoint}/notes/${noteId}/compound`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: bundleMutationId,
      baseRevision: 0,
      deleted: false,
      envelope: testEnvelope(noteId, 'atomic-note'),
      newAttachments: [
        { id: 'bundle-file-a', stageHash: stages[1].stageHash },
        { id: 'bundle-file-z', stageHash: stages[0].stageHash },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const finalized = await response.json();
  assert.deepEqual(finalized, {
    revision: 3,
    attachmentRevisions: [
      { id: 'bundle-file-a', revision: 1 },
      { id: 'bundle-file-z', revision: 2 },
    ],
  });

  response = await fetch(`${relay.endpoint}/changes?since=0`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).changes.map(change => ({
      kind: change.kind,
      id: change.id,
      revision: change.revision,
    })),
    [
      { kind: 'attachment', id: 'bundle-file-a', revision: 1 },
      { kind: 'attachment', id: 'bundle-file-z', revision: 2 },
      { kind: 'note', id: noteId, revision: 3 },
    ],
  );
});

test('stale note base revision publishes no attachment and clears terminal stages', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'stale-bundle-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  let response = await fetch(`${relay.endpoint}/notes/stale-bundle-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'seed-stale-bundle-note',
      baseRevision: 0,
      deleted: false,
      envelope: testEnvelope('stale-bundle-note', 'seed'),
    }),
  });
  assert.equal(response.status, 200);

  const staged = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'stale-bundle',
    noteId: 'stale-bundle-note',
    attachmentId: 'stale-bundle-file',
  });
  assert.equal(staged.response.status, 201);
  const finalized = await finalizeTestBundle(relay, owner.deviceCredential, {
    bundleMutationId: 'stale-bundle',
    noteId: 'stale-bundle-note',
    baseRevision: 0,
    newAttachments: [
      { id: 'stale-bundle-file', stageHash: staged.body.stageHash },
    ],
  });
  assert.equal(finalized.response.status, 409);
  assert.deepEqual(finalized.body, {
    error: 'record_conflict',
    currentRevision: 1,
  });

  response = await fetch(`${relay.endpoint}/changes?since=0`, { headers });
  assert.deepEqual(
    (await response.json()).changes.map(change => change.id),
    ['stale-bundle-note'],
  );
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM attachment_stages
        WHERE bundle_mutation_id='stale-bundle'
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('staging and finalization are idempotent but changed payloads conflict', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'idempotent-bundle-owner');
  const request = {
    bundleMutationId: 'idempotent-bundle',
    noteId: 'idempotent-bundle-note',
    attachmentId: 'idempotent-bundle-file',
  };
  const firstStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    request,
  );
  assert.equal(firstStage.response.status, 201);
  const repeatedStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    request,
  );
  assert.equal(repeatedStage.response.status, 200);
  assert.deepEqual(repeatedStage.body, firstStage.body);
  const changedStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    { ...request, marker: 'changed-stage' },
  );
  assert.equal(changedStage.response.status, 409);
  assert.deepEqual(changedStage.body, { error: 'attachment_stage_conflict' });

  const firstFinal = await finalizeTestBundle(relay, owner.deviceCredential, {
    ...request,
    baseRevision: 0,
    newAttachments: [
      { id: request.attachmentId, stageHash: firstStage.body.stageHash },
    ],
  });
  assert.equal(firstFinal.response.status, 200);
  const repeatedFinal = await finalizeTestBundle(relay, owner.deviceCredential, {
    ...request,
    baseRevision: 0,
    newAttachments: [
      { id: request.attachmentId, stageHash: firstStage.body.stageHash },
    ],
  });
  assert.equal(repeatedFinal.response.status, 200);
  assert.deepEqual(repeatedFinal.body, firstFinal.body);
  const changedFinal = await finalizeTestBundle(relay, owner.deviceCredential, {
    ...request,
    baseRevision: 0,
    newAttachments: [
      { id: request.attachmentId, stageHash: firstStage.body.stageHash },
    ],
    marker: 'changed-final',
  });
  assert.equal(changedFinal.response.status, 409);
  assert.deepEqual(changedFinal.body, { error: 'mutation_conflict' });

  const duplicateStageHash = await finalizeTestBundle(
    relay,
    owner.deviceCredential,
    {
      ...request,
      bundleMutationId: 'duplicate-stage-hash-bundle',
      baseRevision: firstFinal.body.revision,
      newAttachments: [
        { id: 'duplicate-stage-a', stageHash: firstStage.body.stageHash },
        { id: 'duplicate-stage-b', stageHash: firstStage.body.stageHash },
      ],
    },
  );
  assert.equal(duplicateStageHash.response.status, 400);
  assert.deepEqual(duplicateStageHash.body, { error: 'invalid_note_bundle' });
});

test('bundle quota failure rolls back public rows while retaining bounded stages', async t => {
  const attachmentId = 'quota-bundle-file';
  const stagedBytes = storedEnvelopeBytes(testEnvelope(attachmentId));
  const relay = await startTestServer({
    env: {
      UNKEEP_MAX_ENCRYPTED_RECORD_BYTES: String(stagedBytes + 1),
    },
  });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'quota-bundle-owner');
  const staged = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'quota-bundle',
    noteId: 'quota-bundle-note',
    attachmentId,
  });
  assert.equal(staged.response.status, 201);
  const finalized = await finalizeTestBundle(relay, owner.deviceCredential, {
    bundleMutationId: 'quota-bundle',
    noteId: 'quota-bundle-note',
    baseRevision: 0,
    newAttachments: [
      { id: attachmentId, stageHash: staged.body.stageHash },
    ],
  });
  assert.equal(finalized.response.status, 507);
  assert.deepEqual(finalized.body, {
    error: 'encrypted_record_bytes_limit',
  });

  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM records').get().count,
      0,
    );
    assert.deepEqual({
      ...database.prepare('SELECT * FROM attachment_stage_usage').get(),
    }, {
      singleton: 1,
      stage_count: 1,
      encrypted_bytes: stagedBytes,
    });
  } finally {
    database.close();
  }
});

test('attachment stages cannot reuse live or tombstoned IDs and terminal races clean stages', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'collision-bundle-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  const tombstoneId = 'bundle-existing-tombstone';
  let response = await fetch(`${relay.endpoint}/attachments/${tombstoneId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'bundle-tombstone-mutation',
      baseRevision: 0,
      noteId: 'bundle-collision-note',
      deleted: true,
      envelope: testEnvelope(tombstoneId),
    }),
  });
  assert.equal(response.status, 200);
  const unavailable = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'bundle-tombstone-reuse',
    noteId: 'bundle-collision-note',
    attachmentId: tombstoneId,
  });
  assert.equal(unavailable.response.status, 409);
  assert.deepEqual(unavailable.body, { error: 'attachment_id_unavailable' });

  const raced = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'bundle-collision-race',
    noteId: 'bundle-collision-note',
    attachmentId: 'bundle-raced-file',
  });
  assert.equal(raced.response.status, 201);
  response = await fetch(`${relay.endpoint}/attachments/bundle-raced-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'bundle-race-tombstone',
      baseRevision: 0,
      noteId: 'bundle-collision-note',
      deleted: true,
      envelope: testEnvelope('bundle-raced-file'),
    }),
  });
  assert.equal(response.status, 200);
  const racedFinal = await finalizeTestBundle(relay, owner.deviceCredential, {
    bundleMutationId: 'bundle-collision-race',
    noteId: 'bundle-collision-note',
    baseRevision: 0,
    newAttachments: [
      { id: 'bundle-raced-file', stageHash: raced.body.stageHash },
    ],
  });
  assert.equal(racedFinal.response.status, 409);
  assert.deepEqual(racedFinal.body, { error: 'attachment_id_unavailable' });

  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM attachment_stages
        WHERE bundle_mutation_id='bundle-collision-race'
      `).get().count,
      0,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM records WHERE kind='note'
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('compound endpoints reauthenticate and deny read-only service credentials', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'auth-bundle-owner');
  let response = await fetch(`${relay.endpoint}/service-credentials`, {
    method: 'POST',
    headers: {
      authorization: `Device ${owner.deviceCredential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Bundle reader', scope: 'read-only' }),
  });
  const reader = await response.json();
  const deniedStage = await stageTestAttachment(
    relay,
    reader.serviceCredential,
    {
      bundleMutationId: 'reader-bundle',
      noteId: 'reader-bundle-note',
      attachmentId: 'reader-bundle-file',
    },
  );
  assert.equal(deniedStage.response.status, 403);
  assert.deepEqual(deniedStage.body, { error: 'service_credential_read_only' });

  const staged = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'revoked-owner-bundle',
    noteId: 'revoked-owner-note',
    attachmentId: 'revoked-owner-file',
  });
  assert.equal(staged.response.status, 201);
  response = await fetch(
    `${relay.endpoint}/devices/auth-bundle-owner`,
    {
      method: 'DELETE',
      headers: { authorization: `Device ${owner.deviceCredential}` },
    },
  );
  assert.equal(response.status, 204);
  const deniedFinal = await finalizeTestBundle(relay, owner.deviceCredential, {
    bundleMutationId: 'revoked-owner-bundle',
    noteId: 'revoked-owner-note',
    baseRevision: 0,
    newAttachments: [
      { id: 'revoked-owner-file', stageHash: staged.body.stageHash },
    ],
  });
  assert.equal(deniedFinal.response.status, 401);
  assert.deepEqual(deniedFinal.body, { error: 'invalid_device_credential' });
});

test('expired attachment stages are cleaned with exact accounting', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'cleanup-bundle-owner');
  const expired = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'expired-bundle',
    noteId: 'cleanup-bundle-note',
    attachmentId: 'expired-bundle-file',
  });
  assert.equal(expired.response.status, 201);
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.prepare(`
      UPDATE attachment_stages SET created_at=0,expires_at=1
      WHERE bundle_mutation_id='expired-bundle'
    `).run();
  } finally {
    database.close();
  }
  const retained = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'retained-bundle',
    noteId: 'cleanup-bundle-note',
    attachmentId: 'retained-bundle-file',
  });
  assert.equal(retained.response.status, 201);

  const verification = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.deepEqual(
      verification.prepare(`
        SELECT bundle_mutation_id AS bundleMutationId
        FROM attachment_stages ORDER BY bundle_mutation_id
      `).all().map(row => ({ ...row })),
      [{ bundleMutationId: 'retained-bundle' }],
    );
    assert.deepEqual({
      ...verification.prepare('SELECT * FROM attachment_stage_usage').get(),
    }, {
      singleton: 1,
      stage_count: 1,
      encrypted_bytes: storedEnvelopeBytes(
        testEnvelope('retained-bundle-file', 'retained-bundle-file'),
      ),
    });
  } finally {
    verification.close();
  }
});

test('active attachment bundles refresh together without exceeding their absolute lifetime', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'refresh-bundle-owner');
  const first = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'refresh-bundle',
    noteId: 'refresh-bundle-note',
    attachmentId: 'refresh-bundle-first',
  });
  assert.equal(first.response.status, 201);

  const absoluteLifetime = 24 * 60 * 60_000;
  const almostExpiredCreatedAt = Date.now() - absoluteLifetime + 5 * 60_000;
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.prepare(`
      UPDATE attachment_stages
      SET created_at=?,expires_at=?
      WHERE bundle_mutation_id='refresh-bundle'
    `).run(almostExpiredCreatedAt, Date.now() + 1_000);
  } finally {
    database.close();
  }

  const beforeActivity = Date.now();
  const second = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'refresh-bundle',
    noteId: 'refresh-bundle-note',
    attachmentId: 'refresh-bundle-second',
  });
  assert.equal(second.response.status, 201);

  const verification = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    const rows = verification.prepare(`
      SELECT attachment_id AS attachmentId,expires_at AS expiresAt
      FROM attachment_stages
      WHERE bundle_mutation_id='refresh-bundle'
      ORDER BY attachment_id
    `).all().map(row => ({ ...row }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].expiresAt, rows[1].expiresAt);
    assert.ok(rows[0].expiresAt > beforeActivity + 4 * 60_000);
    assert.ok(
      rows[0].expiresAt <= almostExpiredCreatedAt + absoluteLifetime,
      'bundle activity must not extend the first stage beyond 24 hours',
    );
  } finally {
    verification.close();
  }
});

test('bounds stages retained under one attachment bundle mutation', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'stage-cap-owner');
  const ownerTokenHash = createHash('sha256')
    .update(owner.deviceCredential)
    .digest('hex');
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    const insert = database.prepare(`
      INSERT INTO attachment_stages(
        bundle_mutation_id,attachment_id,note_id,owner_token_hash,
        stage_hash,envelope,envelope_bytes,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    const now = Date.now();
    for (let index = 0; index < 1_000; index += 1) {
      const attachmentId = `stage-cap-${String(index).padStart(4, '0')}`;
      insert.run(
        'stage-cap-bundle',
        attachmentId,
        'stage-cap-note',
        ownerTokenHash,
        createHash('sha256').update(attachmentId).digest('hex'),
        '{}',
        2,
        now,
        now + 60_000,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }

  const overflow = await stageTestAttachment(relay, owner.deviceCredential, {
    bundleMutationId: 'stage-cap-bundle',
    noteId: 'stage-cap-note',
    attachmentId: 'stage-cap-overflow',
  });
  assert.equal(overflow.response.status, 507);
  assert.deepEqual(overflow.body, { error: 'attachment_count_limit' });
});

test('direct live attachment creation requires a compound mutation after receipt replay', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'direct-create-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };
  const liveValue = {
    mutationId: 'direct-live-create',
    baseRevision: 0,
    noteId: 'direct-create-note',
    deleted: false,
    envelope: testEnvelope('direct-live-file'),
  };
  let response = await fetch(
    `${relay.endpoint}/attachments/direct-live-file`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(liveValue),
    },
  );
  assert.equal(response.status, 428);
  assert.deepEqual(await response.json(), {
    error: 'compound_mutation_required',
    requiredProtocol: 3,
  });

  const replayValue = {
    ...liveValue,
    mutationId: 'legacy-live-receipt',
  };
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    database.prepare(`
      INSERT INTO mutations(id,payload_hash,revision,created_at)
      VALUES(?,?,?,?)
    `).run(
      replayValue.mutationId,
      createHash('sha256').update(JSON.stringify(replayValue)).digest('hex'),
      42,
      Date.now(),
    );
  } finally {
    database.close();
  }
  response = await fetch(`${relay.endpoint}/attachments/direct-live-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(replayValue),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 42 });

  response = await fetch(`${relay.endpoint}/attachments/direct-tombstone-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'direct-tombstone-create',
      baseRevision: 0,
      noteId: 'direct-create-note',
      deleted: true,
      envelope: testEnvelope('direct-tombstone-file'),
    }),
  });
  assert.equal(response.status, 200);
});

test('consume is safely retryable after a lost response without retaining the encrypted response', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'device-one', name: 'Approver' }),
  });
  const claimed = await response.json();
  const approverHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'device-two'),
  });
  assert.equal(response.status, 201);
  const pairing = await response.json();
  {
    const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
    try {
      const columns=database.prepare('PRAGMA table_info(pairing_requests)').all()
        .map(column=>column.name);
      assert.equal(columns.includes('device_token'),false);
      assert.equal(columns.includes('consumed_at'),false);
      const persisted={...database.prepare(`
        SELECT instance_id,device_id,device_token_hash
        FROM pairing_requests
        WHERE id=?
      `).get(pairing.requestId)};
      assert.deepEqual(persisted,{
        instance_id:relay.instanceId,
        device_id:'device-two',
        device_token_hash:createHash('sha256')
          .update(pairingCredential('device-two'))
          .digest('hex'),
      });
      assert.equal(Object.values(persisted).includes(pairingCredential('device-two')),false);
    } finally {
      database.close();
    }
  }

  response = await fetch(`${api}/pairings/${pairing.requestId}/approve`, {
    method: 'POST',
    headers: approverHeaders,
    body: JSON.stringify({ response: { encryptedMasterKey: 'opaque' } }),
  });
  assert.equal(response.status, 200);

  const pollUrl = `${api}/pairings/${pairing.requestId}`;
  response = await fetch(`${pollUrl}?secret=${encodeURIComponent(pairing.pollSecret)}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });

  response = await fetch(pollUrl, {
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 200);
  const approved = await response.json();
  assert.deepEqual(approved, {
    instanceId: relay.instanceId,
    response: { encryptedMasterKey: 'opaque' },
  });
  assert.equal('deviceCredential' in approved, false);

  const pendingCredential = pairingCredential('device-two');
  const pendingHeaders = {
    authorization: `Device ${pendingCredential}`,
    'content-type': 'application/json',
  };
  response = await fetch(`${api}/vault`, { headers: pendingHeaders });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
  response = await fetch(`${api}/changes?since=0`, { headers: pendingHeaders });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
  response = await fetch(`${api}/notes/pre-consume-write`, {
    method: 'PUT',
    headers: pendingHeaders,
    body: JSON.stringify({ envelope: { ciphertext: 'must-not-write' } }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
  response = await fetch(`${api}/service-credentials`, {
    method: 'POST',
    headers: pendingHeaders,
    body: JSON.stringify({ name: 'must-not-mint' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
  response = await fetch(`${api}/devices`, { headers: pendingHeaders });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
  response = await fetch(`${api}/devices`, { headers: approverHeaders });
  assert.deepEqual((await response.json()).devices, [{
    id: 'device-one',
    name: 'Approver',
    revokedAt: null,
    approvedByDeviceId: null,
  }]);

  response = await fetch(`${api}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: approverHeaders,
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'pairing_device_required' });

  response = await fetch(`${api}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: pendingHeaders,
    body: '{}',
  });
  assert.equal(response.status, 200);
  // Treat the first response as lost. Retrying with the exact credential uses
  // a hash-only consumed receipt and must not mint or replace another device.
  response = await fetch(`${api}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: pendingHeaders,
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { consumed: true, alreadyConsumed: true });

  response = await fetch(`${api}/pairings/${pairing.requestId}/consume`, {
    method: 'POST',
    headers: {
      authorization: 'Device wrong-credential',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'pairing_device_required' });

  response = await fetch(`${api}/devices`, { headers: approverHeaders });
  assert.deepEqual((await response.json()).devices, [
    {
      id: 'device-one',
      name: 'Approver',
      revokedAt: null,
      approvedByDeviceId: null,
    },
    {
      id: 'device-two',
      name: 'Device device-two',
      revokedAt: null,
      approvedByDeviceId: 'device-one',
    },
  ]);

  response = await fetch(pollUrl, {
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });
});

test('pairing device IDs cannot target active, revoked, or already-pending devices', async t => {
  const relay=await startTestServer({
    setupToken:'test-setup-token-0000000000000001',
    env:{UNKEEP_RECOVERY_TOKEN:'pairing-id-recovery-token-00000001'},
  });
  t.after(relay.stop);
  const api=relay.endpoint;
  const owner=await initializeRelay(relay,'owner-device');
  const ownerHeaders={
    authorization:`Device ${owner.deviceCredential}`,
    'content-type':'application/json',
  };

  const wrongInstanceBody=JSON.parse(pairingBody(relay,'misrouted-device'));
  wrongInstanceBody.expectedInstanceId='00000000-0000-4000-8000-000000000000';
  let response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(wrongInstanceBody),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'instance_mismatch'});
  {
    const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count,0);
    } finally {
      database.close();
    }
  }

  response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'owner-device'),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});

  response=await fetch(`${api}/setup/reclaim`,{
    method:'POST',
    headers:{
      authorization:'Recovery pairing-id-recovery-token-00000001',
      'content-type':'application/json',
    },
    body:setupBody(relay,{deviceId:'revoked-device',name:'Revoked device'}),
  });
  assert.equal(response.status,201);
  response=await fetch(`${api}/devices/revoked-device`,{
    method:'DELETE',
    headers:ownerHeaders,
  });
  assert.equal(response.status,204);

  response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'revoked-device'),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});

  response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'pending-device'),
  });
  assert.equal(response.status,201);
  const pending=await response.json();

  response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'pending-device'),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});

  response=await fetch(`${api}/setup/reclaim`,{
    method:'POST',
    headers:{
      authorization:'Recovery pairing-id-recovery-token-00000001',
      'content-type':'application/json',
    },
    body:setupBody(relay,{deviceId:'pending-device',name:'Must not replace reservation'}),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});

  response=await fetch(`${api}/pairings/${pending.requestId}`,{
    headers:{'unkeep-pairing-secret':pending.pollSecret},
  });
  assert.equal(response.status,200);
  assert.equal((await response.json()).instanceId,relay.instanceId);
});

test('first-device setup cannot claim an ID reserved by an outstanding pairing', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token-0000000000000001'});
  t.after(relay.stop);
  const credentialHash=createHash('sha256').update('reserved-local-credential').digest('hex');
  const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
  try {
    database.prepare(`
      INSERT INTO pairing_requests(
        id,code,instance_id,device_id,device_name,public_key,poll_hash,
        expires_at,device_token_hash
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      '00000000-0000-4000-8000-000000000099',
      'ABCDEFGH',
      relay.instanceId,
      'reserved-first-device',
      'Reserved first device',
      JSON.stringify(VALID_PAIRING_PUBLIC_KEY),
      createHash('sha256').update('poll-secret').digest('hex'),
      Date.now()+60_000,
      credentialHash,
    );
  } finally {
    database.close();
  }

  const response=await fetch(`${relay.endpoint}/setup/claim`,{
    method:'POST',
    headers:{
      authorization:'Setup test-setup-token-0000000000000001',
      'content-type':'application/json',
    },
    body:setupBody(relay,{deviceId:'reserved-first-device',name:'Must not collide'}),
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});
  assert.equal((await (await fetch(`${relay.endpoint}/status`)).json()).initialized,false);

  const verification=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
  try {
    assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM devices').get().count,0);
    assert.equal(verification.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count,1);
  } finally {
    verification.close();
  }
});

test('consume never replaces a device that collides with a reserved target after approval', async t => {
  const relay=await startTestServer({setupToken:'test-setup-token-0000000000000001'});
  t.after(relay.stop);
  const api=relay.endpoint;
  const owner=await initializeRelay(relay,'collision-owner');
  const ownerHeaders={
    authorization:`Device ${owner.deviceCredential}`,
    'content-type':'application/json',
  };

  let response=await fetch(`${api}/pairings`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:pairingBody(relay,'collision-target'),
  });
  assert.equal(response.status,201);
  const pairing=await response.json();
  response=await fetch(`${api}/pairings/${pairing.requestId}/approve`,{
    method:'POST',
    headers:ownerHeaders,
    body:JSON.stringify({response:{encryptedMasterKey:'opaque'}}),
  });
  assert.equal(response.status,200);

  const existingCredential='existing-device-credential';
  const existingTokenHash=createHash('sha256').update(existingCredential).digest('hex');
  const database=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
  try {
    database.prepare(`
      INSERT INTO devices(id,name,token_hash,revoked_at)
      VALUES(?,?,?,NULL)
    `).run('collision-target','Existing target',existingTokenHash);
  } finally {
    database.close();
  }

  response=await fetch(`${api}/pairings/${pairing.requestId}/consume`,{
    method:'POST',
    headers:{
      authorization:`Device ${pairingCredential('collision-target')}`,
      'content-type':'application/json',
    },
    body:'{}',
  });
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'device_id_unavailable'});

  response=await fetch(`${api}/vault`,{
    headers:{authorization:`Device ${existingCredential}`},
  });
  assert.equal(response.status,200);
  const verification=new DatabaseSync(join(relay.dataDir,'unkeep.sqlite'));
  try {
    assert.deepEqual({
      ...verification.prepare(`
        SELECT name,token_hash,revoked_at
        FROM devices
        WHERE id='collision-target'
      `).get(),
    },{
      name:'Existing target',
      token_hash:existingTokenHash,
      revoked_at:null,
    });
    assert.equal(
      verification.prepare('SELECT COUNT(*) AS count FROM pairing_requests WHERE id=?')
        .get(pairing.requestId).count,
      1,
    );
  } finally {
    verification.close();
  }
});

test('revoking an approver invalidates its unconsumed approved pairings', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'owner-device', name: 'Owner' }),
  });
  const owner = await response.json();
  const ownerHeaders = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'approver-device'),
  });
  const approverPairing = await response.json();
  response = await fetch(`${api}/pairings/${approverPairing.requestId}/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ response: { encryptedMasterKey: 'for-approver' } }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${api}/pairings/${approverPairing.requestId}`, {
    headers: { 'unkeep-pairing-secret': approverPairing.pollSecret },
  });
  const approvedApprover = await response.json();
  assert.equal('deviceCredential' in approvedApprover, false);
  const approverHeaders = {
    authorization: `Device ${pairingCredential('approver-device')}`,
    'content-type': 'application/json',
  };
  response = await fetch(`${api}/pairings/${approverPairing.requestId}/consume`, {
    method: 'POST',
    headers: approverHeaders,
    body: '{}',
  });
  assert.equal(response.status, 200);

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'waiting-device'),
  });
  const waitingPairing = await response.json();
  response = await fetch(`${api}/pairings/${waitingPairing.requestId}/approve`, {
    method: 'POST',
    headers: approverHeaders,
    body: JSON.stringify({ response: { encryptedMasterKey: 'must-be-invalidated' } }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${api}/pairings/${waitingPairing.requestId}`, {
    headers: { 'unkeep-pairing-secret': waitingPairing.pollSecret },
  });
  const waitingApproval = await response.json();
  assert.equal('deviceCredential' in waitingApproval, false);

  response = await fetch(`${api}/devices/approver-device`, {
    method: 'DELETE',
    headers: ownerHeaders,
  });
  assert.equal(response.status, 204);

  response = await fetch(`${api}/pairings/${waitingPairing.requestId}`, {
    headers: { 'unkeep-pairing-secret': waitingPairing.pollSecret },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });
  response = await fetch(`${api}/vault`, {
    headers: { authorization: `Device ${pairingCredential('waiting-device')}` },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });
});

test('cancelling an approved pairing destroys its pending credential', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'pairing-owner', name: 'Pairing owner' }),
  });
  const claimed = await response.json();
  const ownerHeaders = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'cancelled-device'),
  });
  const pairing = await response.json();
  response = await fetch(`${api}/pairings/${pairing.requestId}/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ response: { encryptedMasterKey: 'opaque' } }),
  });
  assert.equal(response.status, 200);

  const pollUrl = `${api}/pairings/${pairing.requestId}`;
  response = await fetch(pollUrl, {
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 200);
  const approved = await response.json();
  assert.equal('deviceCredential' in approved, false);

  response = await fetch(`${api}/pairings/${pairing.requestId}`, {
    method: 'DELETE',
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 204);

  response = await fetch(`${api}/vault`, {
    headers: { authorization: `Device ${pairingCredential('cancelled-device')}` },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });

  response = await fetch(`${api}/devices`, { headers: ownerHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).devices, [{
    id: 'pairing-owner',
    name: 'Pairing owner',
    revokedAt: null,
    approvedByDeviceId: null,
  }]);
});

test('expired pairing requests are removed before they can be polled again', async t => {
  const relay = await startTestServer({
    setupToken: 'test-setup-token-0000000000000001',
    env: { UNKEEP_PAIRING_TTL_MS: '500' },
  });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'approver-device', name: 'Approver' }),
  });
  const claimed = await response.json();

  response = await fetch(`${api}/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: pairingBody(relay, 'expiring-device'),
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

  const pollUrl = `${api}/pairings/${pairing.requestId}`;
  response = await fetch(pollUrl, {
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 200);
  const approved = await response.json();
  assert.equal('deviceCredential' in approved, false);

  await new Promise(resolve => setTimeout(resolve, 600));
  response = await fetch(`${api}/status`);
  assert.equal(response.status, 200);

  response = await fetch(pollUrl, {
    headers: { 'unkeep-pairing-secret': pairing.pollSecret },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'pairing_not_found' });

  response = await fetch(`${api}/vault`, {
    headers: { authorization: `Device ${pairingCredential('expiring-device')}` },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_device_credential' });

  response = await fetch(`${api}/devices`, {
    headers: { authorization: `Device ${claimed.deviceCredential}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).devices, [{
    id: 'approver-device',
    name: 'Approver',
    revokedAt: null,
    approvedByDeviceId: null,
  }]);
});

test('rejects stale note and attachment base revisions without overwriting the current records', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'conflict-device', name: 'Conflict test' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/notes/conflicted-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      envelope: testEnvelope('conflicted-note', 'note-winner'),
      mutationId: 'notes-conflicted-note-winner',
      baseRevision: 0,
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const noteWinner = await response.json();
  response = await fetch(`${api}/notes/conflicted-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      envelope: testEnvelope('conflicted-note', 'stale-loser'),
      mutationId: 'notes-conflicted-note-loser',
      baseRevision: 0,
      deleted: false,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'record_conflict',
    currentRevision: noteWinner.revision,
  });

  const attachmentStage = await stageTestAttachment(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'attachments-conflicted-attachment-winner',
      noteId: 'conflicted-note',
      attachmentId: 'conflicted-attachment',
      marker: 'attachment-winner',
    },
  );
  assert.equal(attachmentStage.response.status, 201);
  const attachmentBundle = await finalizeTestBundle(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'attachments-conflicted-attachment-winner',
      noteId: 'conflicted-note',
      baseRevision: noteWinner.revision,
      marker: 'note-winner',
      newAttachments: [{
        id: 'conflicted-attachment',
        stageHash: attachmentStage.body.stageHash,
      }],
    },
  );
  assert.equal(attachmentBundle.response.status, 200);
  const attachmentWinner = attachmentBundle.body.attachmentRevisions[0];
  response = await fetch(`${api}/attachments/conflicted-attachment`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      noteId: 'conflicted-note',
      envelope: testEnvelope('conflicted-attachment', 'stale-loser'),
      mutationId: 'attachments-conflicted-attachment-loser',
      baseRevision: 0,
      deleted: false,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'record_conflict',
    currentRevision: attachmentWinner.revision,
  });

  response = await fetch(`${api}/changes?since=0`, { headers });
  const { changes } = await response.json();
  assert.equal(
    changes.find(change => change.kind === 'note').envelope.ciphertext,
    testEnvelope('conflicted-note', 'note-winner').ciphertext,
  );
  assert.equal('envelope' in changes.find(change => change.kind === 'attachment'), false);
  response = await fetch(`${api}/attachments/conflicted-attachment`, { headers });
  assert.equal(
    (await response.json()).envelope.ciphertext,
    testEnvelope('conflicted-attachment', 'attachment-winner').ciphertext,
  );
});

test('fails released protocol-v1 writers closed when they omit baseRevision', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;

  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'legacy-device', name: 'Released client' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };

  response = await fetch(`${api}/status`);
  assert.equal((await response.json()).protocol, 3);

  response = await fetch(`${api}/notes/legacy-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      envelope: testEnvelope('legacy-note', 'first-note'),
      mutationId: 'notes-legacy-note-first',
      baseRevision: 0,
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  const noteCreate = await response.json();
  const legacyStage = await stageTestAttachment(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'attachments-legacy-attachment-first',
      noteId: 'legacy-note',
      attachmentId: 'legacy-attachment',
      marker: 'first-attachment',
    },
  );
  assert.equal(legacyStage.response.status, 201);
  const legacyBundle = await finalizeTestBundle(
    relay,
    claimed.deviceCredential,
    {
      bundleMutationId: 'attachments-legacy-attachment-first',
      noteId: 'legacy-note',
      baseRevision: noteCreate.revision,
      marker: 'first-note',
      newAttachments: [{
        id: 'legacy-attachment',
        stageHash: legacyStage.body.stageHash,
      }],
    },
  );
  assert.equal(legacyBundle.response.status, 200);

  for (const record of [
    { path: 'notes/legacy-note', body: { envelope: testEnvelope('legacy-note', 'first-note') } },
    { path: 'attachments/legacy-attachment', body: { noteId: 'legacy-note', envelope: testEnvelope('legacy-attachment', 'first-attachment') } },
  ]) {
    const mutationPrefix = record.path.replace('/', '-');
    response = await fetch(`${api}/${record.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...record.body,
        envelope: testEnvelope(record.path.split('/')[1], `updated-${record.path}`),
        mutationId: `${mutationPrefix}-updated`,
        deleted: false,
      }),
    });
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), {
      error: 'base_revision_required',
      requiredProtocol: 3,
    });
  }

  response = await fetch(`${api}/changes?since=0`, { headers });
  const { changes } = await response.json();
  assert.equal(
    changes.find(change => change.kind === 'note').envelope.ciphertext,
    testEnvelope('legacy-note', 'first-note').ciphertext,
  );
  response = await fetch(`${api}/attachments/legacy-attachment`, { headers });
  assert.equal(
    (await response.json()).envelope.ciphertext,
    testEnvelope('legacy-attachment', 'first-attachment').ciphertext,
  );
});

test('returns the original result when an accepted mutation is retried after a newer write', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const api = relay.endpoint;
  let response = await fetch(`${api}/setup/claim`, {
    method: 'POST',
    headers: { authorization: 'Setup test-setup-token-0000000000000001', 'content-type': 'application/json' },
    body: setupBody(relay, { deviceId: 'retry-device', name: 'Retry test' }),
  });
  const claimed = await response.json();
  const headers = {
    authorization: `Device ${claimed.deviceCredential}`,
    'content-type': 'application/json',
  };
  const originalMutation = {
    mutationId: 'accepted-mutation',
    baseRevision: 0,
    envelope: testEnvelope('retried-note', 'first-version'),
    deleted: false,
  };

  response = await fetch(`${api}/notes/retried-note`, { method: 'PUT', headers, body: JSON.stringify(originalMutation) });
  const original = await response.json();
  assert.equal(response.status, 200);

  response = await fetch(`${api}/notes/retried-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'newer-mutation',
      baseRevision: original.revision,
      envelope: testEnvelope('retried-note', 'newer-version'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 200);
  assert.notEqual((await response.json()).revision, original.revision);

  response = await fetch(`${api}/notes/retried-note`, { method: 'PUT', headers, body: JSON.stringify(originalMutation) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), original);

  response = await fetch(`${api}/changes?since=0`, { headers });
  assert.equal(
    (await response.json()).changes[0].envelope.ciphertext,
    testEnvelope('retried-note', 'newer-version').ciphertext,
  );
});

test('keeps attachment IDs immutable and atomically tombstones attachments with their note', async t => {
  const relay = await startTestServer({ setupToken: 'test-setup-token-0000000000000001' });
  t.after(relay.stop);
  const owner = await initializeRelay(relay, 'attachment-invariant-owner');
  const headers = {
    authorization: `Device ${owner.deviceCredential}`,
    'content-type': 'application/json',
  };

  const initialStage = await stageTestAttachment(
    relay,
    owner.deviceCredential,
    {
      bundleMutationId: 'immutable-file-create',
      noteId: 'attachment-note',
      attachmentId: 'immutable-file',
      marker: 'x'.repeat(512),
    },
  );
  assert.equal(initialStage.response.status, 201);
  const initialBundle = await finalizeTestBundle(
    relay,
    owner.deviceCredential,
    {
      bundleMutationId: 'immutable-file-create',
      noteId: 'attachment-note',
      baseRevision: 0,
      marker: 'live note',
      newAttachments: [{
        id: 'immutable-file',
        stageHash: initialStage.body.stageHash,
      }],
    },
  );
  assert.equal(initialBundle.response.status, 200);
  const noteCreate = { revision: initialBundle.body.revision };
  const attachmentCreate = initialBundle.body.attachmentRevisions[0];

  let response = await fetch(`${relay.endpoint}/attachments/immutable-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'immutable-file-overwrite',
      baseRevision: attachmentCreate.revision,
      noteId: 'attachment-note',
      envelope: testEnvelope('immutable-file', 'replacement bytes'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'attachment_immutable' });

  response = await fetch(`${relay.endpoint}/notes/attachment-note`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'attachment-note-delete',
      baseRevision: noteCreate.revision,
      envelope: testEnvelope('attachment-note', 'deleted note'),
      deleted: true,
    }),
  });
  assert.equal(response.status, 200);
  const noteDelete = await response.json();

  response = await fetch(`${relay.endpoint}/changes?since=${attachmentCreate.revision}`, { headers });
  const deletionFeed = await response.json();
  assert.deepEqual(
    deletionFeed.changes.map(({ kind, id, deleted, revision }) => ({ kind, id, deleted, revision })),
    [
      { kind: 'note', id: 'attachment-note', deleted: true, revision: noteDelete.revision },
      {
        kind: 'attachment',
        id: 'immutable-file',
        deleted: true,
        revision: noteDelete.revision + 1,
      },
    ],
  );

  response = await fetch(`${relay.endpoint}/attachments/immutable-file`, { headers });
  const cascadedAttachment = await response.json();
  assert.equal(cascadedAttachment.deleted, true);
  assert.equal(cascadedAttachment.revision, noteDelete.revision + 1);
  assert.equal(cascadedAttachment.envelope, null);
  {
    const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
    try {
      assert.deepEqual({
        ...database.prepare(`
          SELECT
            envelope,
            length(CAST(envelope AS BLOB)) AS envelope_bytes
          FROM records
          WHERE kind='attachment' AND id='immutable-file'
        `).get(),
      }, {
        envelope: 'null',
        envelope_bytes: Buffer.byteLength('null'),
      });
    } finally {
      database.close();
    }
  }

  // A queued client-side tombstone remains safely retryable after the relay's
  // atomic cascade, even though its prior base revision is now stale.
  response = await fetch(`${relay.endpoint}/attachments/immutable-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'immutable-file-explicit-delete',
      baseRevision: attachmentCreate.revision,
      noteId: 'attachment-note',
      envelope: testEnvelope('immutable-file', 'explicit tombstone'),
      deleted: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: cascadedAttachment.revision });

  response = await fetch(`${relay.endpoint}/attachments/immutable-file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'immutable-file-recreate',
      baseRevision: cascadedAttachment.revision,
      noteId: 'attachment-note',
      envelope: testEnvelope('immutable-file', 'resurrected bytes'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'attachment_immutable' });

  response = await fetch(`${relay.endpoint}/attachments/new-orphan`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      mutationId: 'new-orphan-create',
      baseRevision: 0,
      noteId: 'attachment-note',
      envelope: testEnvelope('new-orphan'),
      deleted: false,
    }),
  });
  assert.equal(response.status, 428);
  assert.deepEqual(await response.json(), {
    error: 'compound_mutation_required',
    requiredProtocol: 3,
  });
});

test('applies browser security headers and rejects plaintext share-target network fallbacks', async t => {
  const relay = await startTestServer();
  t.after(relay.stop);
  const origin = new URL(relay.endpoint).origin;

  let response = await fetch(`${relay.endpoint}/status`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  response = await fetch(`${origin}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=private&text=plaintext-note',
  });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'share_worker_required' });

  response = await fetch(`${origin}/share?title=private&text=plaintext-note`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'share_worker_required' });
});

test('graceful shutdown checkpoints a private, reopenable relay database', async t => {
  const relay = await startTestServer({ preserveDataDir: true });
  t.after(async () => {
    await relay.stop();
    await relay.cleanup();
  });
  await initializeRelay(relay, 'shutdown-owner');
  assert.equal(statSync(relay.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(relay.dataDir, 'unkeep.sqlite')).mode & 0o777, 0o600);

  await relay.stop();
  const database = new DatabaseSync(join(relay.dataDir, 'unkeep.sqlite'));
  try {
    assert.deepEqual({ ...database.prepare('PRAGMA integrity_check').get() }, {
      integrity_check: 'ok',
    });
    assert.ok(database.prepare(`
      SELECT completed_at
      FROM maintenance_tasks
      WHERE name='legacy-pairing-token-scrub'
    `).get().completed_at);
  } finally {
    database.close();
  }
});
