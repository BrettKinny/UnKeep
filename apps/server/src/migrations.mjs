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

const SERVER_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial-relay-schema',
    up(db) { db.exec(INITIAL_SCHEMA_SQL); },
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
