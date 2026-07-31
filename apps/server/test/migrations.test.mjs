import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countProtocolInvalidRecords,
  CURRENT_SERVER_SCHEMA_VERSION,
  completeSensitiveDataScrub,
  migrateDatabase,
  UnsupportedServerSchemaError,
} from '../src/migrations.mjs';

function createLegacyDatabase(db) {
  db.exec(`
    CREATE TABLE instance (id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT);
    CREATE TABLE service_credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT);
    CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, note_id TEXT, envelope TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE mutations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE pairing_requests (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, device_name TEXT NOT NULL, public_key TEXT NOT NULL, poll_hash TEXT NOT NULL, response TEXT, device_token TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER);
  `);
}

test('migrates a fresh database to the current schema with explicit metadata', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());

  migrateDatabase(db);

  assert.equal(CURRENT_SERVER_SCHEMA_VERSION, 11);
  assert.deepEqual(
    db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map(row => ({ ...row })),
    [
      { version: 1, name: 'initial-relay-schema' },
      { version: 2, name: 'pending-pairing-and-service-issuer' },
      { version: 3, name: 'service-credential-scopes' },
      { version: 4, name: 'pairing-consume-receipts-and-approvers' },
      { version: 5, name: 'hash-only-instance-bound-pairing-reservations' },
      { version: 6, name: 'sensitive-data-vacuum' },
      { version: 7, name: 'paired-device-approver-lineage' },
      { version: 8, name: 'record-storage-accounting-and-mutation-retention' },
      { version: 9, name: 'protocol-record-identity-guards' },
      { version: 10, name: 'credential-hash-namespace-guards' },
      { version: 11, name: 'atomic-note-attachment-bundles' },
    ],
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(devices)').all().map(row => ({
      name: row.name,
      notnull: row.notnull,
    })),
    [
      { name: 'id', notnull: 0 },
      { name: 'name', notnull: 1 },
      { name: 'token_hash', notnull: 1 },
      { name: 'revoked_at', notnull: 0 },
      { name: 'approved_by_device_id', notnull: 0 },
    ],
  );
  assert.deepEqual(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='index' AND tbl_name='devices' AND name='devices_approver'
    `).all().map(row => ({ ...row })),
    [{ name: 'devices_approver' }],
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(records)').all().map(row => row.name),
    ['kind', 'id', 'note_id', 'envelope', 'deleted', 'revision'],
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(mutations)').all().map(row => row.name),
    [
      'id',
      'payload_hash',
      'revision',
      'created_at',
      'response',
      'owner_token_hash',
      'mutation_kind',
    ],
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(attachment_stages)').all().map(row => row.name),
    [
      'bundle_mutation_id',
      'attachment_id',
      'note_id',
      'owner_token_hash',
      'stage_hash',
      'envelope',
      'envelope_bytes',
      'created_at',
      'expires_at',
    ],
  );
  assert.deepEqual(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type='trigger' AND tbl_name='records'
      ORDER BY name
    `).all().map(row => row.name),
    [
      'records_protocol_guard_insert',
      'records_protocol_guard_update',
      'records_storage_usage_delete',
      'records_storage_usage_insert',
      'records_storage_usage_update',
    ],
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(pairing_requests)').all().map(row => ({
      name: row.name,
      notnull: row.notnull,
    })),
    [
      { name: 'id', notnull: 0 },
      { name: 'code', notnull: 1 },
      { name: 'instance_id', notnull: 1 },
      { name: 'device_id', notnull: 1 },
      { name: 'device_name', notnull: 1 },
      { name: 'public_key', notnull: 1 },
      { name: 'poll_hash', notnull: 1 },
      { name: 'response', notnull: 0 },
      { name: 'expires_at', notnull: 1 },
      { name: 'device_token_hash', notnull: 1 },
      { name: 'approved_by_device_id', notnull: 0 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row })),
    [
      { name: 'attachment_stage_usage' },
      { name: 'attachment_stages' },
      { name: 'devices' },
      { name: 'instance' },
      { name: 'maintenance_tasks' },
      { name: 'mutations' },
      { name: 'pairing_consume_receipts' },
      { name: 'pairing_requests' },
      { name: 'record_storage_usage' },
      { name: 'records' },
      { name: 'schema_migrations' },
      { name: 'service_credentials' },
    ],
  );
});

test('adopts an unversioned legacy database without losing relay data', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createLegacyDatabase(db);
  db.prepare('INSERT INTO instance(id,initialized) VALUES(?,?)').run('legacy-instance', 1);
  db.prepare('INSERT INTO devices(id,name,token_hash) VALUES(?,?,?)').run('device-one', 'Legacy device', 'device-hash');
  db.prepare('INSERT INTO records(kind,id,note_id,envelope,deleted,revision) VALUES(?,?,?,?,?,?)')
    .run('note', 'note-one', null, '{"ciphertext":"opaque"}', 0, 7);
  db.prepare('INSERT INTO mutations(id,payload_hash,revision) VALUES(?,?,?)').run('mutation-one', 'payload-hash', 7);

  migrateDatabase(db);

  assert.deepEqual({ ...db.prepare('SELECT * FROM instance').get() }, { id: 'legacy-instance', initialized: 1 });
  assert.deepEqual(
    { ...db.prepare('SELECT id,name,token_hash,approved_by_device_id FROM devices').get() },
    {
      id: 'device-one',
      name: 'Legacy device',
      token_hash: 'device-hash',
      approved_by_device_id: null,
    },
  );
  assert.deepEqual(
    {
      ...db.prepare('SELECT kind,id,envelope,revision FROM records').get(),
    },
    {
      kind: 'note',
      id: 'note-one',
      envelope: '{"ciphertext":"opaque"}',
      revision: 7,
    },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM record_storage_usage').get() },
    {
      singleton: 1,
      record_count: 1,
      attachment_count: 0,
      encrypted_bytes: Buffer.byteLength('{"ciphertext":"opaque"}'),
    },
  );
  const migratedMutation = {
    ...db.prepare(`
      SELECT id,payload_hash,revision,created_at
      FROM mutations
    `).get(),
  };
  assert.deepEqual(
    {
      id: migratedMutation.id,
      payload_hash: migratedMutation.payload_hash,
      revision: migratedMutation.revision,
    },
    { id: 'mutation-one', payload_hash: 'payload-hash', revision: 7 },
  );
  assert.ok(migratedMutation.created_at > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 11);
});

test('refuses cross-registry credential aliases on every startup without changing access', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.exec(`
    DROP TRIGGER IF EXISTS devices_token_hash_namespace_insert;
    DROP TRIGGER IF EXISTS devices_token_hash_namespace_update;
    DROP TRIGGER IF EXISTS service_credentials_token_hash_namespace_insert;
    DROP TRIGGER IF EXISTS service_credentials_token_hash_namespace_update;
  `);
  db.prepare(`
    INSERT INTO devices(id,name,token_hash,revoked_at)
    VALUES(?,?,?,NULL)
  `).run('alias-device', 'Aliased device', 'shared-token-hash');
  db.prepare(`
    INSERT INTO service_credentials(id,name,token_hash,revoked_at,scope)
    VALUES(?,?,?,datetime('now'),'read-only')
  `).run('alias-service', 'Aliased revoked service', 'shared-token-hash');
  const migrationCount = db.prepare(`
    SELECT COUNT(*) AS count FROM schema_migrations
  `).get().count;

  assert.throws(
    () => migrateDatabase(db),
    /device and service credential registries contain 1 duplicate token hash/,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    migrationCount,
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM devices AS device
      JOIN service_credentials AS service
        ON service.token_hash=device.token_hash
    `).get().count,
    1,
  );
});

test('guards the credential token-hash namespace below the HTTP layer', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.prepare(`
    INSERT INTO devices(id,name,token_hash,revoked_at)
    VALUES(?,?,?,datetime('now'))
  `).run('namespace-device', 'Revoked namespace device', 'device-token-hash');
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_credentials(id,name,token_hash,revoked_at,scope)
      VALUES(?,?,?,NULL,'read-only')
    `).run(
      'namespace-service-conflict',
      'Conflicting service',
      'device-token-hash',
    ),
    /credential token hash namespace conflict/,
  );

  db.prepare(`
    INSERT INTO service_credentials(id,name,token_hash,revoked_at,scope)
    VALUES(?,?,?,datetime('now'),'read-only')
  `).run(
    'namespace-service',
    'Revoked namespace service',
    'service-token-hash',
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO devices(id,name,token_hash,revoked_at)
      VALUES(?,?,?,NULL)
    `).run(
      'namespace-device-conflict',
      'Conflicting device',
      'service-token-hash',
    ),
    /credential token hash namespace conflict/,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE devices SET token_hash=? WHERE id=?
    `).run('service-token-hash', 'namespace-device'),
    /credential token hash namespace conflict/,
  );
  assert.throws(
    () => db.prepare(`
      UPDATE service_credentials SET token_hash=? WHERE id=?
    `).run('device-token-hash', 'namespace-service'),
    /credential token hash namespace conflict/,
  );
});

test('refuses a legacy record ID with a hidden NUL suffix without changing or exposing it', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.exec(`
    DROP TRIGGER records_protocol_guard_insert;
    DROP TRIGGER records_protocol_guard_update;
    DROP TRIGGER devices_token_hash_namespace_insert;
    DROP TRIGGER devices_token_hash_namespace_update;
    DROP TRIGGER service_credentials_token_hash_namespace_insert;
    DROP TRIGGER service_credentials_token_hash_namespace_update;
    DROP TRIGGER attachment_stage_usage_insert;
    DROP TRIGGER attachment_stage_usage_update;
    DROP TRIGGER attachment_stage_usage_delete;
    DROP TABLE attachment_stage_usage;
    DROP TABLE attachment_stages;
    ALTER TABLE mutations DROP COLUMN response;
    ALTER TABLE mutations DROP COLUMN owner_token_hash;
    ALTER TABLE mutations DROP COLUMN mutation_kind;
    DELETE FROM schema_migrations WHERE version IN (9,10,11);
  `);
  const invalidId = 'valid-prefix\0hidden-suffix';
  db.prepare(`
    INSERT INTO records(kind,id,note_id,envelope,deleted,revision)
    VALUES('note',?,NULL,'{"ciphertext":"preserve-me"}',0,1)
  `).run(invalidId);

  assert.equal(countProtocolInvalidRecords(db), 1);
  assert.throws(
    () => migrateDatabase(db),
    /1 record\(s\) with protocol-invalid identity or metadata/,
  );
  assert.equal(
    db.prepare('SELECT envelope FROM records WHERE id=?').get(invalidId).envelope,
    '{"ciphertext":"preserve-me"}',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=9').get().count,
    0,
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'records_protocol_guard_%'
    `).get().count,
    0,
  );
});

test('guards record protocol identities and metadata below the HTTP layer', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  const insert = db.prepare(`
    INSERT INTO records(kind,id,note_id,envelope,deleted,revision)
    VALUES(?,?,?,?,?,?)
  `);

  insert.run('note', 'a'.repeat(128), null, '{}', 0, 1);
  assert.equal(countProtocolInvalidRecords(db), 0);
  for (const values of [
    ['note', 'b'.repeat(129), null, '{}', 0, 2],
    ['note', 'bad.dot', null, '{}', 0, 2],
    ['note', 'nul\0suffix', null, '{}', 0, 2],
    ['attachment', 'file-one', 'bad.owner', '{}', 0, 2],
    ['attachment', 'file-two', 'owner\0suffix', '{}', 0, 2],
    ['note', 'note-with-owner', 'owner', '{}', 0, 2],
    ['note', 'bad-deleted', null, '{}', 2, 2],
    ['note', 'bad-revision', null, '{}', 0, 0],
  ]) {
    assert.throws(
      () => insert.run(...values),
      /invalid record protocol metadata/,
    );
  }
  assert.throws(
    () => db.prepare('UPDATE records SET id=? WHERE id=?')
      .run('c'.repeat(129), 'a'.repeat(128)),
    /invalid record protocol metadata/,
  );
});

test('upgrades schema v6 lineage, storage accounting, and record guards, then remains current on reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'unkeep-v6-lineage-'));
  const path = join(directory, 'unkeep.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => {
    try { db.close(); } catch { /* Closed before reopen. */ }
    rmSync(directory, { recursive: true, force: true });
  });

  // Build the exact current schema from the real migration chain, then remove
  // only the additive v7/v8/v9 objects to represent a deployed schema-v6
  // database.
  migrateDatabase(db);
  db.exec(`
    DROP TRIGGER records_storage_usage_insert;
    DROP TRIGGER records_storage_usage_update;
    DROP TRIGGER records_storage_usage_delete;
    DROP TRIGGER records_protocol_guard_insert;
    DROP TRIGGER records_protocol_guard_update;
    DROP TABLE record_storage_usage;
    DROP INDEX mutations_created_at;
    ALTER TABLE mutations DROP COLUMN created_at;
    DROP INDEX devices_approver;
    ALTER TABLE devices DROP COLUMN approved_by_device_id;
    DROP TRIGGER devices_token_hash_namespace_insert;
    DROP TRIGGER devices_token_hash_namespace_update;
    DROP TRIGGER service_credentials_token_hash_namespace_insert;
    DROP TRIGGER service_credentials_token_hash_namespace_update;
    DROP TRIGGER attachment_stage_usage_insert;
    DROP TRIGGER attachment_stage_usage_update;
    DROP TRIGGER attachment_stage_usage_delete;
    DROP TABLE attachment_stage_usage;
    DROP TABLE attachment_stages;
    ALTER TABLE mutations DROP COLUMN response;
    ALTER TABLE mutations DROP COLUMN owner_token_hash;
    ALTER TABLE mutations DROP COLUMN mutation_kind;
    DELETE FROM schema_migrations WHERE version IN (7,8,9,10,11);
  `);
  db.prepare('INSERT INTO devices(id,name,token_hash) VALUES(?,?,?)').run(
    'v6-device',
    'Schema v6 device',
    'v6-device-token-hash',
  );
  db.prepare(`
    INSERT INTO records(kind,id,note_id,envelope,deleted,revision)
    VALUES(?,?,?,?,?,?)
  `).run(
    'note',
    'v6-note',
    null,
    '{"ciphertext":"v6-opaque"}',
    0,
    11,
  );
  db.prepare(`
    INSERT INTO mutations(id,payload_hash,revision)
    VALUES(?,?,?)
  `).run('v6-mutation', 'v6-payload-hash', 11);
  db.close();

  db = new DatabaseSync(path);
  assert.equal(migrateDatabase(db), 11);
  assert.deepEqual(
    { ...db.prepare(`
      SELECT id,name,approved_by_device_id
      FROM devices
      WHERE id='v6-device'
    `).get() },
    {
      id: 'v6-device',
      name: 'Schema v6 device',
      approved_by_device_id: null,
    },
  );
  assert.equal(
    db.prepare(`
      SELECT encrypted_bytes
      FROM record_storage_usage
      WHERE singleton=1
    `).get().encrypted_bytes,
    Buffer.byteLength('{"ciphertext":"v6-opaque"}'),
  );
  assert.ok(db.prepare(`
    SELECT created_at
    FROM mutations
    WHERE id='v6-mutation'
  `).get().created_at > 0);
  db.close();

  db = new DatabaseSync(path);
  assert.equal(migrateDatabase(db), CURRENT_SERVER_SCHEMA_VERSION);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE version=7 AND name='paired-device-approver-lineage'
    `).get().count,
    1,
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE version=9
        AND name='protocol-record-identity-guards'
    `).get().count,
    1,
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE version=8
        AND name='record-storage-accounting-and-mutation-retention'
    `).get().count,
    1,
  );
});

test('drops in-flight legacy pairings containing raw credentials and preserves legacy services as unattributed', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createLegacyDatabase(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)')
    .run(1, 'initial-relay-schema');
  db.prepare('INSERT INTO instance(id,initialized) VALUES(?,?)').run('legacy-instance', 1);
  const rawPendingToken = 'legacy-approved-device-token';
  db.prepare('INSERT INTO devices(id,name,token_hash) VALUES(?,?,?)').run(
    'pending-device',
    'Pending v1 device',
    createHash('sha256').update(rawPendingToken).digest('hex'),
  );
  db.prepare(`
    INSERT INTO pairing_requests(
      id,code,device_id,device_name,public_key,poll_hash,response,device_token,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
  `).run(
    '00000000-0000-4000-8000-000000000001',
    'ABCDEFGH',
    'pending-device',
    'Pending v1 device',
    '{"kty":"EC"}',
    'poll-hash',
    '{"ciphertext":"opaque"}',
    rawPendingToken,
    Date.now() + 60_000,
  );
  db.prepare('INSERT INTO service_credentials(id,name,token_hash) VALUES(?,?,?)')
    .run('legacy-service', 'Legacy service', 'legacy-service-hash');

  migrateDatabase(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count, 0);
  assert.equal(
    db.prepare("SELECT 1 FROM pragma_table_info('pairing_requests') WHERE name IN ('device_token','consumed_at')").get(),
    undefined,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id,revoked_at,issued_by_device_id,scope FROM service_credentials').get() },
    { id: 'legacy-service', revoked_at: null, issued_by_device_id: null, scope: 'read-write' },
  );
  assert.throws(
    () => db.prepare('INSERT INTO service_credentials(id,name,token_hash,scope) VALUES(?,?,?,?)')
      .run('invalid-scope', 'Invalid scope', 'invalid-scope-hash', 'admin'),
    /CHECK constraint failed/,
  );
});

test('physically scrubs retired raw pairing credentials from SQLite pages and WAL files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'unkeep-sensitive-scrub-'));
  const path = join(directory, 'unkeep.sqlite');
  const rawToken = 'UNKEEP-LEGACY-RAW-TOKEN-MUST-NOT-SURVIVE-4d1f6e773e';
  let db = new DatabaseSync(path);
  t.after(() => {
    try { db.close(); } catch { /* Closed before inspecting bytes. */ }
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec('PRAGMA journal_mode=WAL');
  createLegacyDatabase(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations(version,name)
      VALUES(1,'initial-relay-schema');
  `);
  db.prepare(`
    INSERT INTO pairing_requests(
      id,code,device_id,device_name,public_key,poll_hash,response,device_token,
      expires_at,consumed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    '00000000-0000-4000-8000-000000000009',
    'CDEFGHJK',
    'legacy-sensitive-device',
    'Legacy sensitive device',
    '{"kty":"EC"}',
    'poll-hash',
    '{"ciphertext":"opaque"}',
    rawToken,
    Date.now() + 60_000,
    null,
  );
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  assert.equal(readFileSync(path).includes(Buffer.from(rawToken)), true);

  migrateDatabase(db);
  assert.equal(completeSensitiveDataScrub(db), true);
  assert.equal(completeSensitiveDataScrub(db), false);
  assert.ok(db.prepare(`
    SELECT completed_at
    FROM maintenance_tasks
    WHERE name='legacy-pairing-token-scrub'
  `).get().completed_at);
  db.close();

  for (const filename of readdirSync(directory)) {
    assert.equal(
      readFileSync(join(directory, filename)).includes(Buffer.from(rawToken)),
      false,
      `${filename} retained the raw legacy pairing token`,
    );
  }
});

test('reopening a current database is idempotent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'unkeep-migration-'));
  const path = join(directory, 'unkeep.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => {
    try { db.close(); } catch { /* Already closed before reopen. */ }
    rmSync(directory, { recursive: true, force: true });
  });

  migrateDatabase(db);
  db.prepare('INSERT INTO instance(id,initialized) VALUES(?,?)').run('persistent-instance', 1);
  db.close();

  db = new DatabaseSync(path);
  assert.equal(migrateDatabase(db), CURRENT_SERVER_SCHEMA_VERSION);
  assert.equal(migrateDatabase(db), CURRENT_SERVER_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM instance').get() },
    { id: 'persistent-instance', initialized: 1 },
  );
  assert.deepEqual(
    db.prepare('SELECT version,name FROM schema_migrations').all().map(row => ({ ...row })),
    [
      { version: 1, name: 'initial-relay-schema' },
      { version: 2, name: 'pending-pairing-and-service-issuer' },
      { version: 3, name: 'service-credential-scopes' },
      { version: 4, name: 'pairing-consume-receipts-and-approvers' },
      { version: 5, name: 'hash-only-instance-bound-pairing-reservations' },
      { version: 6, name: 'sensitive-data-vacuum' },
      { version: 7, name: 'paired-device-approver-lineage' },
      { version: 8, name: 'record-storage-accounting-and-mutation-retention' },
      { version: 9, name: 'protocol-record-identity-guards' },
      { version: 10, name: 'credential-hash-namespace-guards' },
      { version: 11, name: 'atomic-note-attachment-bundles' },
    ],
  );
});

test('migrates consumed v3 pairing rows to hash-only retry receipts', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createLegacyDatabase(db);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE pairing_requests ADD COLUMN device_token_hash TEXT;
    ALTER TABLE service_credentials
      ADD COLUMN issued_by_device_id TEXT REFERENCES devices(id);
    ALTER TABLE service_credentials
      ADD COLUMN scope TEXT NOT NULL DEFAULT 'read-write'
      CHECK(scope IN ('read-only', 'read-write'));
    CREATE UNIQUE INDEX pairing_requests_device_token_hash
      ON pairing_requests(device_token_hash)
      WHERE device_token_hash IS NOT NULL;
    CREATE INDEX service_credentials_issuer
      ON service_credentials(issued_by_device_id);
    INSERT INTO schema_migrations(version,name) VALUES
      (1,'initial-relay-schema'),
      (2,'pending-pairing-and-service-issuer'),
      (3,'service-credential-scopes');
  `);
  const consumedAt = Date.now() - 1_000;
  const tokenHash = createHash('sha256').update('consumed-secret').digest('hex');
  db.prepare(`
    INSERT INTO pairing_requests(
      id,code,device_id,device_name,public_key,poll_hash,response,device_token,
      expires_at,consumed_at,device_token_hash
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    '00000000-0000-4000-8000-000000000002',
    'BCDEFGHJ',
    'consumed-device',
    'Consumed device',
    '{"kty":"EC"}',
    'poll-secret-hash',
    '{"encryptedMasterKey":"must-be-removed"}',
    'consumed-secret',
    consumedAt + 60_000,
    consumedAt,
    tokenHash,
  );

  migrateDatabase(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count, 0);
  assert.deepEqual(
    { ...db.prepare(`
      SELECT request_id,device_id,device_token_hash,consumed_at
      FROM pairing_consume_receipts
    `).get() },
    {
      request_id: '00000000-0000-4000-8000-000000000002',
      device_id: 'consumed-device',
      device_token_hash: tokenHash,
      consumed_at: consumedAt,
    },
  );
  assert.deepEqual(
    db.prepare('PRAGMA table_info(pairing_consume_receipts)').all().map(row => row.name),
    ['request_id', 'device_id', 'device_token_hash', 'consumed_at', 'expires_at'],
  );
});

test('refuses to open a database created by a newer server schema', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(12, 'future-schema');
  db.prepare('INSERT INTO instance(id,initialized) VALUES(?,?)').run('untouched-instance', 1);

  assert.throws(() => migrateDatabase(db), UnsupportedServerSchemaError);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM instance').get() },
    { id: 'untouched-instance', initialized: 1 },
  );
});
