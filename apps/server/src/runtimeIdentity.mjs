import * as nodeFs from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ID = 1000;
const MAX_ID = 2147483646;

function parseId(name, raw) {
  if (raw === undefined || raw === '') return DEFAULT_ID;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_ID) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_ID}; the relay never runs as root`);
  }
  return value;
}

/**
 * Decide which identity the relay should run as.
 *
 * Returns `{ uid, gid }` when the process started as root and must hand the
 * data directory to PUID/PGID and drop privileges, or `null` to keep the
 * current non-root identity.
 */
export function resolveRuntimeIdentity(env, current) {
  const uid = parseId('PUID', env.PUID);
  const gid = parseId('PGID', env.PGID);
  if (current.uid === 0) return { uid, gid };
  const requested = (env.PUID ?? '') !== '' || (env.PGID ?? '') !== '';
  if (requested && (uid !== current.uid || gid !== current.gid)) {
    throw new Error(
      `PUID/PGID (${uid}:${gid}) differ from the running user (${current.uid}:${current.gid}). `
      + 'They only take effect when the container starts as root (--user 0:0).',
    );
  }
  return null;
}

/**
 * Give the data directory and everything under it to uid:gid, without
 * following symlinks. Returns false when the directory already belongs to
 * them, which is the steady state after the first start.
 *
 * Root here holds CAP_CHOWN but not CAP_DAC_OVERRIDE, so it can only list a
 * private directory it owns: each directory is taken over before it is read.
 */
export function adoptDataDirectory(directory, { uid, gid }, fs = nodeFs) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const top = fs.lstatSync(directory);
    if (top.uid === uid && top.gid === gid) return false;
    adopt(directory);
    return true;
  } catch (error) {
    throw new Error(
      `Could not give UNKEEP_DATA_DIR ${directory} to UID ${uid} GID ${gid} `
      + `(${error.code ?? error.message}). Starting as root requires --cap-add CHOWN.`,
      { cause: error },
    );
  }

  function adopt(path) {
    if (fs.lstatSync(path).isDirectory()) {
      fs.lchownSync(path, 0, 0);
      for (const entry of fs.readdirSync(path)) adopt(join(path, entry));
    }
    fs.lchownSync(path, uid, gid);
  }
}

/** Permanently switch from root to uid:gid, which also clears capabilities. */
export function dropPrivileges({ uid, gid }, proc = process) {
  try {
    proc.setgroups([gid]);
    proc.setgid(gid);
    proc.setuid(uid);
  } catch (error) {
    throw new Error(
      `Could not switch to UID ${uid} GID ${gid} (${error.code ?? error.message}). `
      + 'Starting as root requires --cap-add SETUID --cap-add SETGID.',
      { cause: error },
    );
  }
  if (
    proc.getuid() !== uid || proc.geteuid() !== uid
    || proc.getgid() !== gid || proc.getegid() !== gid
  ) {
    throw new Error(`Relay is still not running as UID ${uid} GID ${gid}`);
  }
}
