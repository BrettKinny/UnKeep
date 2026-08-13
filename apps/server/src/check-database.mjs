import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { countProtocolInvalidRecords } from './migrations.mjs';

const databasePath = resolve(
  process.argv[2] || join(process.env.UNKEEP_DATA_DIR || './data', 'unkeep.sqlite'),
);

if (!existsSync(databasePath)) {
  console.error(`Database does not exist: ${databasePath}`);
  process.exitCode = 1;
} else {
  const database = new DatabaseSync(databasePath);
  try {
    const results = database.prepare('PRAGMA integrity_check').all();
    const errors = results
      .map(row => String(row.integrity_check))
      .filter(result => result !== 'ok');
    if (errors.length) {
      console.error(`SQLite integrity check failed:\n${errors.join('\n')}`);
      process.exitCode = 1;
    } else {
      const invalidRecords = countProtocolInvalidRecords(database);
      if (invalidRecords > 0) {
        console.error(
          `Protocol validation failed: ${invalidRecords} record(s) have an `
          + 'invalid identity or metadata. Do not upgrade this database until '
          + 'it is restored or repaired with the previous server.',
        );
        process.exitCode = 1;
      } else {
        console.log(`SQLite integrity and protocol checks passed: ${databasePath}`);
      }
    }
  } finally {
    database.close();
  }
}
