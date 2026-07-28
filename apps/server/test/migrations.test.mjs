import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SERVER_SCHEMA_VERSION,
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

  assert.equal(CURRENT_SERVER_SCHEMA_VERSION, 1);
  assert.deepEqual(
    db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map(row => ({ ...row })),
    [{ version: 1, name: 'initial-relay-schema' }],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row })),
    [
      { name: 'devices' },
      { name: 'instance' },
      { name: 'mutations' },
      { name: 'pairing_requests' },
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
    { ...db.prepare('SELECT id,name,token_hash FROM devices').get() },
    { id: 'device-one', name: 'Legacy device', token_hash: 'device-hash' },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT kind,id,envelope,revision FROM records').get() },
    { kind: 'note', id: 'note-one', envelope: '{"ciphertext":"opaque"}', revision: 7 },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id,payload_hash,revision FROM mutations').get() },
    { id: 'mutation-one', payload_hash: 'payload-hash', revision: 7 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
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
    [{ version: 1, name: 'initial-relay-schema' }],
  );
});

test('refuses to open a database created by a newer server schema', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(2, 'future-schema');
  db.prepare('INSERT INTO instance(id,initialized) VALUES(?,?)').run('untouched-instance', 1);

  assert.throws(() => migrateDatabase(db), UnsupportedServerSchemaError);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM instance').get() },
    { id: 'untouched-instance', initialized: 1 },
  );
});
