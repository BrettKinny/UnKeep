import { createHash } from 'node:crypto';

const INITIAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS instance (id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS service_credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, note_id TEXT, envelope TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pairing_requests (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, device_name TEXT NOT NULL, public_key TEXT NOT NULL, poll_hash TEXT NOT NULL, response TEXT, device_token TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER);
`;

const INVALID_RECORD_METADATA = `
  typeof(kind) <> 'text'
  OR kind NOT IN ('note','attachment')
  OR typeof(id) <> 'text'
  OR length(id) NOT BETWEEN 1 AND 128
  OR length(CAST(id AS BLOB)) <> length(id)
  OR id GLOB '*[^A-Za-z0-9_-]*'
  OR (
    kind='note'
    AND note_id IS NOT NULL
  )
  OR (
    kind='attachment'
    AND (
      typeof(note_id) <> 'text'
      OR length(note_id) NOT BETWEEN 1 AND 128
      OR length(CAST(note_id AS BLOB)) <> length(note_id)
      OR note_id GLOB '*[^A-Za-z0-9_-]*'
    )
  )
  OR typeof(envelope) <> 'text'
  OR typeof(deleted) <> 'integer'
  OR deleted NOT IN (0,1)
  OR typeof(revision) <> 'integer'
  OR revision <= 0
`;

function hasTable(db, name) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type='table' AND name=?
  `).get(name));
}

function countCredentialHashAliases(db) {
  if (!hasTable(db, 'devices') || !hasTable(db, 'service_credentials')) {
    return 0;
  }
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM devices AS device
    JOIN service_credentials AS service
      ON service.token_hash=device.token_hash
  `).get().count);
}

function assertNoCredentialHashAliases(db) {
  const aliases = countCredentialHashAliases(db);
  if (aliases === 0) return;
  throw new Error(
    'Database device and service credential registries contain '
    + `${aliases} duplicate token hash`
    + `${aliases === 1 ? '' : 'es'}; restore or repair the credential `
    + 'registries with the previous server before upgrading. '
    + 'No credential was changed.',
  );
}

export function countProtocolInvalidRecords(db) {
  if (!hasTable(db, 'records')) return 0;
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM records
    WHERE ${INVALID_RECORD_METADATA}
  `).get().count);
}

const SERVER_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial-relay-schema',
    up(db) { db.exec(INITIAL_SCHEMA_SQL); },
  }),
  Object.freeze({
    version: 2,
    name: 'pending-pairing-and-service-issuer',
    up(db) {
      db.exec(`
        ALTER TABLE pairing_requests ADD COLUMN device_token_hash TEXT;
        ALTER TABLE service_credentials
          ADD COLUMN issued_by_device_id TEXT REFERENCES devices(id);
      `);

      // Protocol-v1 approval inserted an immediately active device. Move each
      // still-unconsumed approval back behind its pairing request so expiry or
      // cancellation invalidates the provisional token. Keeping the raw token
      // preserves an in-flight requester's ability to finish after an upgrade.
      const pending = db.prepare(`
        SELECT id,device_token
        FROM pairing_requests
        WHERE response IS NOT NULL
          AND consumed_at IS NULL
          AND device_token IS NOT NULL
      `).all();
      const savePendingHash = db.prepare(
        'UPDATE pairing_requests SET device_token_hash=? WHERE id=?',
      );
      for (const row of pending) {
        savePendingHash.run(
          createHash('sha256').update(row.device_token).digest('hex'),
          row.id,
        );
      }
      db.exec(`
        DELETE FROM devices
        WHERE id IN (
          SELECT device_id
          FROM pairing_requests
          WHERE response IS NOT NULL
            AND consumed_at IS NULL
            AND device_token_hash IS NOT NULL
        );
        CREATE UNIQUE INDEX pairing_requests_device_token_hash
          ON pairing_requests(device_token_hash)
          WHERE device_token_hash IS NOT NULL;
        CREATE INDEX service_credentials_issuer
          ON service_credentials(issued_by_device_id);
      `);

      // Existing service credentials remain valid for compatibility. Their
      // issuer is unknowable, so issued_by_device_id stays NULL and operators
      // are prompted by clients/docs to rotate them.
    },
  }),
  Object.freeze({
    version: 3,
    name: 'service-credential-scopes',
    up(db) {
      // Existing credentials retain their released read/write authority.
      // Newly minted credentials always store an explicit scope.
      db.exec(`
        ALTER TABLE service_credentials
          ADD COLUMN scope TEXT NOT NULL DEFAULT 'read-write'
          CHECK(scope IN ('read-only', 'read-write'));
      `);
    },
  }),
  Object.freeze({
    version: 4,
    name: 'pairing-consume-receipts-and-approvers',
    up(db) {
      db.exec(`
        ALTER TABLE pairing_requests
          ADD COLUMN approved_by_device_id TEXT REFERENCES devices(id);
        CREATE INDEX pairing_requests_approver
          ON pairing_requests(approved_by_device_id)
          WHERE approved_by_device_id IS NOT NULL;
        CREATE TABLE pairing_consume_receipts (
          request_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          device_token_hash TEXT NOT NULL,
          consumed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX pairing_consume_receipts_expiry
          ON pairing_consume_receipts(expires_at);

        INSERT OR IGNORE INTO pairing_consume_receipts(
          request_id,device_id,device_token_hash,consumed_at,expires_at
        )
        SELECT
          id,
          device_id,
          device_token_hash,
          consumed_at,
          MAX(expires_at,consumed_at + 604800000)
        FROM pairing_requests
        WHERE consumed_at IS NOT NULL
          AND device_token_hash IS NOT NULL;
        DELETE FROM pairing_requests WHERE consumed_at IS NOT NULL;
      `);
      // approved_by_device_id is intentionally NULL for approvals made by an
      // older server because their approving device cannot be reconstructed.
    },
  }),
  Object.freeze({
    version: 5,
    name: 'hash-only-instance-bound-pairing-reservations',
    up(db) {
      // Pairing requests are short-lived and cannot be safely resumed across
      // this protocol change: older rows may contain a relay-generated raw
      // device token and are not bound to a relay instance. Rebuild the table
      // without copying those ephemeral rows; users can start pairing again.
      db.exec(`
        CREATE TABLE pairing_requests_v5 (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          instance_id TEXT NOT NULL,
          device_id TEXT NOT NULL UNIQUE,
          device_name TEXT NOT NULL,
          public_key TEXT NOT NULL,
          poll_hash TEXT NOT NULL,
          response TEXT,
          expires_at INTEGER NOT NULL,
          device_token_hash TEXT NOT NULL UNIQUE,
          approved_by_device_id TEXT REFERENCES devices(id)
        );
        DROP TABLE pairing_requests;
        ALTER TABLE pairing_requests_v5 RENAME TO pairing_requests;
        CREATE INDEX pairing_requests_approver
          ON pairing_requests(approved_by_device_id)
          WHERE approved_by_device_id IS NOT NULL;
      `);
    },
  }),
  Object.freeze({
    version: 6,
    name: 'sensitive-data-vacuum',
    up(db) {
      // Dropping the legacy pairing table removes raw credentials from the
      // logical schema, but SQLite may retain the old bytes in free pages or
      // the WAL. Startup completes this task outside the migration
      // transaction, where VACUUM is permitted, before accepting requests.
      db.exec(`
        CREATE TABLE maintenance_tasks (
          name TEXT PRIMARY KEY,
          completed_at TEXT
        );
        INSERT INTO maintenance_tasks(name) VALUES('legacy-pairing-token-scrub');
      `);
    },
  }),
  Object.freeze({
    version: 7,
    name: 'paired-device-approver-lineage',
    up(db) {
      db.exec(`
        ALTER TABLE devices
          ADD COLUMN approved_by_device_id TEXT REFERENCES devices(id);
        CREATE INDEX devices_approver
          ON devices(approved_by_device_id)
          WHERE approved_by_device_id IS NOT NULL;
      `);
      // The first device, operator-recovered devices, and devices created by
      // older relays remain roots with NULL lineage. Inventing an approver for
      // those rows would make targeted incident-response revocation unsafe.
    },
  }),
  Object.freeze({
    version: 8,
    name: 'record-storage-accounting-and-mutation-retention',
    up(db) {
      db.exec(`
        CREATE TABLE record_storage_usage (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          record_count INTEGER NOT NULL CHECK(record_count >= 0),
          attachment_count INTEGER NOT NULL CHECK(attachment_count >= 0),
          encrypted_bytes INTEGER NOT NULL CHECK(encrypted_bytes >= 0)
        ) WITHOUT ROWID;
        INSERT INTO record_storage_usage(
          singleton,record_count,attachment_count,encrypted_bytes
        )
        SELECT
          1,
          COUNT(*),
          COALESCE(SUM(CASE WHEN kind='attachment' THEN 1 ELSE 0 END),0),
          COALESCE(SUM(length(CAST(envelope AS BLOB))),0)
        FROM records;
        CREATE TRIGGER records_storage_usage_insert
        AFTER INSERT ON records
        BEGIN
          UPDATE record_storage_usage
          SET record_count=record_count+1,
            attachment_count=attachment_count
              + CASE WHEN NEW.kind='attachment' THEN 1 ELSE 0 END,
            encrypted_bytes=encrypted_bytes
              + length(CAST(NEW.envelope AS BLOB))
          WHERE singleton=1;
        END;
        CREATE TRIGGER records_storage_usage_update
        AFTER UPDATE OF kind,envelope ON records
        BEGIN
          UPDATE record_storage_usage
          SET attachment_count=attachment_count
              + CASE WHEN NEW.kind='attachment' THEN 1 ELSE 0 END
              - CASE WHEN OLD.kind='attachment' THEN 1 ELSE 0 END,
            encrypted_bytes=encrypted_bytes
              + length(CAST(NEW.envelope AS BLOB))
              - length(CAST(OLD.envelope AS BLOB))
          WHERE singleton=1;
        END;
        CREATE TRIGGER records_storage_usage_delete
        AFTER DELETE ON records
        BEGIN
          UPDATE record_storage_usage
          SET record_count=record_count-1,
            attachment_count=attachment_count
              - CASE WHEN OLD.kind='attachment' THEN 1 ELSE 0 END,
            encrypted_bytes=encrypted_bytes
              - length(CAST(OLD.envelope AS BLOB))
          WHERE singleton=1;
        END;

        ALTER TABLE mutations
          ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0
          CHECK(created_at >= 0);
        CREATE INDEX mutations_created_at
          ON mutations(created_at,revision,id);
      `);
      // Treat legacy receipts as current at upgrade time. This retains their
      // lost-response replay value for one full configured retention window
      // instead of expiring every existing receipt immediately.
      db.prepare('UPDATE mutations SET created_at=? WHERE created_at=0')
        .run(Date.now());
    },
  }),
  Object.freeze({
    version: 9,
    name: 'protocol-record-identity-guards',
    up(db) {
      const invalidRecords = countProtocolInvalidRecords(db);
      if (invalidRecords > 0) {
        throw new Error(
          `Database contains ${invalidRecords} record(s) with protocol-invalid `
          + 'identity or metadata; restore or repair a backup with the previous '
          + 'server before upgrading. No record was changed.',
        );
      }
      db.exec(`
        CREATE TRIGGER records_protocol_guard_insert
        BEFORE INSERT ON records
        WHEN ${INVALID_RECORD_METADATA.replaceAll(/(?<![A-Za-z_])(kind|id|note_id|envelope|deleted|revision)(?![A-Za-z_])/g, 'NEW.$1')}
        BEGIN
          SELECT RAISE(ABORT,'invalid record protocol metadata');
        END;
        CREATE TRIGGER records_protocol_guard_update
        BEFORE UPDATE ON records
        WHEN ${INVALID_RECORD_METADATA.replaceAll(/(?<![A-Za-z_])(kind|id|note_id|envelope|deleted|revision)(?![A-Za-z_])/g, 'NEW.$1')}
        BEGIN
          SELECT RAISE(ABORT,'invalid record protocol metadata');
        END;
      `);
    },
  }),
  Object.freeze({
    version: 10,
    name: 'credential-hash-namespace-guards',
    up(db) {
      // Recheck while the migration's BEGIN IMMEDIATE lock is held, closing
      // the interval between the startup audit and trigger installation.
      assertNoCredentialHashAliases(db);
      db.exec(`
        CREATE TRIGGER devices_token_hash_namespace_insert
        BEFORE INSERT ON devices
        WHEN EXISTS (
          SELECT 1
          FROM service_credentials
          WHERE token_hash=NEW.token_hash
        )
        BEGIN
          SELECT RAISE(ABORT,'credential token hash namespace conflict');
        END;
        CREATE TRIGGER devices_token_hash_namespace_update
        BEFORE UPDATE OF token_hash ON devices
        WHEN EXISTS (
          SELECT 1
          FROM service_credentials
          WHERE token_hash=NEW.token_hash
        )
        BEGIN
          SELECT RAISE(ABORT,'credential token hash namespace conflict');
        END;
        CREATE TRIGGER service_credentials_token_hash_namespace_insert
        BEFORE INSERT ON service_credentials
        WHEN EXISTS (
          SELECT 1
          FROM devices
          WHERE token_hash=NEW.token_hash
        )
        BEGIN
          SELECT RAISE(ABORT,'credential token hash namespace conflict');
        END;
        CREATE TRIGGER service_credentials_token_hash_namespace_update
        BEFORE UPDATE OF token_hash ON service_credentials
        WHEN EXISTS (
          SELECT 1
          FROM devices
          WHERE token_hash=NEW.token_hash
        )
        BEGIN
          SELECT RAISE(ABORT,'credential token hash namespace conflict');
        END;
      `);
    },
  }),
  Object.freeze({
    version: 11,
    name: 'atomic-note-attachment-bundles',
    up(db) {
      db.exec(`
        ALTER TABLE mutations ADD COLUMN response TEXT;
        ALTER TABLE mutations ADD COLUMN owner_token_hash TEXT;
        ALTER TABLE mutations
          ADD COLUMN mutation_kind TEXT NOT NULL DEFAULT 'record'
          CHECK(mutation_kind IN ('record','note-bundle'));

        CREATE TABLE attachment_stages (
          bundle_mutation_id TEXT NOT NULL
            CHECK(
              length(bundle_mutation_id) BETWEEN 1 AND 128
              AND length(CAST(bundle_mutation_id AS BLOB))
                = length(bundle_mutation_id)
              AND bundle_mutation_id NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          attachment_id TEXT NOT NULL UNIQUE
            CHECK(
              length(attachment_id) BETWEEN 1 AND 128
              AND length(CAST(attachment_id AS BLOB))=length(attachment_id)
              AND attachment_id NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          note_id TEXT NOT NULL
            CHECK(
              length(note_id) BETWEEN 1 AND 128
              AND length(CAST(note_id AS BLOB))=length(note_id)
              AND note_id NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          owner_token_hash TEXT NOT NULL
            CHECK(
              length(owner_token_hash)=64
              AND owner_token_hash NOT GLOB '*[^0-9a-f]*'
            ),
          stage_hash TEXT NOT NULL UNIQUE
            CHECK(
              length(stage_hash)=64
              AND stage_hash NOT GLOB '*[^0-9a-f]*'
            ),
          envelope TEXT NOT NULL,
          envelope_bytes INTEGER NOT NULL CHECK(envelope_bytes > 0),
          created_at INTEGER NOT NULL CHECK(created_at >= 0),
          expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
          PRIMARY KEY(bundle_mutation_id,attachment_id)
        ) WITHOUT ROWID;
        CREATE INDEX attachment_stages_expiry
          ON attachment_stages(expires_at);
        CREATE INDEX attachment_stages_owner_bundle
          ON attachment_stages(owner_token_hash,bundle_mutation_id,stage_hash);

        CREATE TABLE attachment_stage_usage (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          stage_count INTEGER NOT NULL CHECK(stage_count >= 0),
          encrypted_bytes INTEGER NOT NULL CHECK(encrypted_bytes >= 0)
        ) WITHOUT ROWID;
        INSERT INTO attachment_stage_usage(
          singleton,stage_count,encrypted_bytes
        ) VALUES(1,0,0);
        CREATE TRIGGER attachment_stage_usage_insert
        AFTER INSERT ON attachment_stages
        BEGIN
          UPDATE attachment_stage_usage
          SET stage_count=stage_count+1,
            encrypted_bytes=encrypted_bytes+NEW.envelope_bytes
          WHERE singleton=1;
        END;
        CREATE TRIGGER attachment_stage_usage_update
        AFTER UPDATE OF envelope_bytes ON attachment_stages
        BEGIN
          UPDATE attachment_stage_usage
          SET encrypted_bytes=encrypted_bytes
            + NEW.envelope_bytes-OLD.envelope_bytes
          WHERE singleton=1;
        END;
        CREATE TRIGGER attachment_stage_usage_delete
        AFTER DELETE ON attachment_stages
        BEGIN
          UPDATE attachment_stage_usage
          SET stage_count=stage_count-1,
            encrypted_bytes=encrypted_bytes-OLD.envelope_bytes
          WHERE singleton=1;
        END;
      `);
    },
  }),
]);

export const CURRENT_SERVER_SCHEMA_VERSION = SERVER_MIGRATIONS.at(-1)?.version ?? 0;

export class UnsupportedServerSchemaError extends Error {
  constructor(version) {
    super(`Database schema version ${version} is newer than supported version ${CURRENT_SERVER_SCHEMA_VERSION}`);
    this.name = 'UnsupportedServerSchemaError';
    this.version = version;
  }
}

function hasMigrationTable(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get());
}

function appliedMigrations(db) {
  if (!hasMigrationTable(db)) return [];
  return db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
}

function rollback(db) {
  try { db.exec('ROLLBACK'); } catch { /* Preserve the migration error. */ }
}

function checkpointAndTruncate(db) {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (Number(result?.busy ?? 0) !== 0) {
    throw new Error('Unable to obtain an exclusive WAL checkpoint for sensitive-data scrubbing');
  }
}

export function migrateDatabase(db) {
  const applied = appliedMigrations(db);
  const latest = Number(applied.at(-1)?.version ?? 0);
  if (latest > CURRENT_SERVER_SCHEMA_VERSION) throw new UnsupportedServerSchemaError(latest);

  for (let index = 0; index < applied.length; index++) {
    const expected = SERVER_MIGRATIONS[index];
    const actual = applied[index];
    if (!expected || Number(actual.version) !== expected.version || actual.name !== expected.name) {
      throw new Error(`Invalid database migration history at version ${actual.version}`);
    }
  }

  assertNoCredentialHashAliases(db);

  for (const migration of SERVER_MIGRATIONS) {
    if (migration.version <= latest) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(migration.version, migration.name);
      db.exec('COMMIT');
    } catch (error) {
      rollback(db);
      throw error;
    }
  }

  return CURRENT_SERVER_SCHEMA_VERSION;
}

export function completeSensitiveDataScrub(db) {
  if (!hasMigrationTable(db)) return false;
  const task = db.prepare(`
    SELECT completed_at
    FROM maintenance_tasks
    WHERE name='legacy-pairing-token-scrub'
  `).get();
  if (!task || task.completed_at) return false;

  // Fail startup rather than serve from a database whose retired raw pairing
  // credentials may still be recoverable from free pages or a WAL file.
  checkpointAndTruncate(db);
  db.exec('VACUUM');
  checkpointAndTruncate(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE maintenance_tasks
      SET completed_at=datetime('now')
      WHERE name='legacy-pairing-token-scrub' AND completed_at IS NULL
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
  checkpointAndTruncate(db);
  return true;
}
