import { accessSync, chmodSync, constants, existsSync, mkdirSync } from 'node:fs';

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function processIdentity() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return null;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function permissionError(path, error) {
  const identity = processIdentity();
  const owner = identity ? `UID ${identity.uid} GID ${identity.gid}` : 'the relay process';
  const fix = identity
    ? ` Fix the host directory ownership, for example: chown -R ${identity.uid}:${identity.gid} <host data path>.`
    : '';
  return new Error(
    `UNKEEP_DATA_DIR is not usable: ${path} must be owned and writable by ${owner} (${error.code}).${fix}`,
    { cause: error },
  );
}

// Creates the private data directory and fails with an actionable message when
// a bind mount's ownership does not match the container user.
export function prepareDataDirectory(directory, databasePath) {
  let current = directory;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    if (existsSync(databasePath)) {
      current = databasePath;
      accessSync(databasePath, constants.R_OK | constants.W_OK);
    }
  } catch (error) {
    if (PERMISSION_CODES.has(error?.code)) throw permissionError(current, error);
    throw error;
  }
}
