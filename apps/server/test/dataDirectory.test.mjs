import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDataDirectory } from '../src/dataDirectory.mjs';

const runningAsRoot = process.getuid?.() === 0;

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'unkeep-data-dir-'));
  try {
    run(root);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}

test('creates a private data directory', () => withTempDir(root => {
  const directory = join(root, 'data');
  prepareDataDirectory(directory, join(directory, 'unkeep.sqlite'));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
}));

test('explains unwritable bind mounts with the process identity', { skip: runningAsRoot }, () => withTempDir(root => {
  chmodSync(root, 0o500);
  const directory = join(root, 'data');
  assert.throws(
    () => prepareDataDirectory(directory, join(directory, 'unkeep.sqlite')),
    error => {
      assert.match(error.message, /UNKEEP_DATA_DIR is not usable/);
      assert.match(error.message, new RegExp(`UID ${process.getuid()} GID ${process.getgid()}`));
      assert.match(error.message, /chown -R \d+:\d+/);
      assert.equal(error.cause.code, 'EACCES');
      return true;
    },
  );
}));

test('rejects an existing database the process cannot write', { skip: runningAsRoot }, () => withTempDir(root => {
  const databasePath = join(root, 'unkeep.sqlite');
  writeFileSync(databasePath, '');
  chmodSync(databasePath, 0o400);
  assert.throws(
    () => prepareDataDirectory(root, databasePath),
    error => error.message.includes(`${databasePath} must be owned and writable`),
  );
}));
