import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeSensitiveDataScrub, migrateDatabase } from './migrations.mjs';
import { assertJsonContentType, readJsonObject } from './httpBody.mjs';
import { applySecurityHeaders } from './httpSecurity.mjs';
import { listenHostForUrl, validatedListenHost } from './networkConfig.mjs';
import {
  authorizeAdministrativeSecret,
  createFailedSecretRateLimiter,
  resolveRecoveryToken,
  timingSafeSecretEqual,
  validateAdministrativeToken,
} from './administrativeSecurity.mjs';
import {
  createPairingRateLimiter,
  MAX_PAIRING_BODY_BYTES,
  normalizePairingPublicKey,
} from './pairingSecurity.mjs';
import {
  canonicalBase64Size,
  isValidRecordId,
  normalizeRecordEnvelope,
} from './recordValidation.mjs';

function positiveIntegerSetting(name, fallback, maximum) {
  const configured = Number(process.env[name] || fallback);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= maximum
    ? configured
    : fallback;
}

function storageLimitSetting(name, fallback, maximum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const configured = Number(raw);
  if (
    !Number.isSafeInteger(configured)
    || configured <= 0
    || configured > maximum
  ) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return configured;
}

const PORT = Number(process.env.PORT || 3000);
const LISTEN_HOST = validatedListenHost(process.env.UNKEEP_HOST);
const DATA_DIR = resolve(process.env.UNKEEP_DATA_DIR || './data');
const WEB_DIR = resolve(process.env.UNKEEP_WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../web/build'));
const SETUP_TOKEN = validateAdministrativeToken(
  'UNKEEP_SETUP_TOKEN',
  process.env.UNKEEP_SETUP_TOKEN || '',
  { required: false },
);
const ALLOW_SETUP_TOKEN_RECOVERY = process.env.UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY === '1';
const CONFIGURED_RECOVERY_TOKEN = process.env.UNKEEP_RECOVERY_TOKEN || '';
const RECOVERY_TOKEN = resolveRecoveryToken({
  configuredToken: CONFIGURED_RECOVERY_TOKEN,
  setupToken: SETUP_TOKEN,
  allowSetupTokenRecovery: ALLOW_SETUP_TOKEN_RECOVERY,
});
const MAX_BODY = 35 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_ENCRYPTED_RECORD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_ATTACHMENTS = 10_000;
const DEFAULT_MAX_DEVICES = 1_000;
const DEFAULT_MAX_SERVICE_CREDENTIALS = 10_000;
const DEFAULT_MAX_MUTATION_RECEIPTS = 100_000;
const DEFAULT_MUTATION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_ATTACHMENT_STAGE_TTL_MS = 10 * 60_000;
const DEFAULT_ADMIN_RATE_WINDOW_MS = 5 * 60_000;
const DEFAULT_ADMIN_SOURCE_RATE_LIMIT = 5;
const DEFAULT_ADMIN_GLOBAL_RATE_LIMIT = 100;
const MAX_PENDING_PAIRINGS = positiveIntegerSetting('UNKEEP_MAX_PENDING_PAIRINGS', 100, 1_000);
const PAIRING_RATE_WINDOW_MS = positiveIntegerSetting('UNKEEP_PAIRING_RATE_WINDOW_MS', 60_000, 60 * 60_000);
const PAIRING_SOURCE_RATE_LIMIT = positiveIntegerSetting('UNKEEP_PAIRING_SOURCE_RATE_LIMIT', 10, 1_000);
const PAIRING_GLOBAL_RATE_LIMIT = positiveIntegerSetting('UNKEEP_PAIRING_GLOBAL_RATE_LIMIT', 60, 10_000);
const MAX_ENCRYPTED_RECORD_BYTES = storageLimitSetting(
  'UNKEEP_MAX_ENCRYPTED_RECORD_BYTES',
  DEFAULT_MAX_ENCRYPTED_RECORD_BYTES,
  1024 * 1024 * 1024 * 1024,
);
const MAX_RECORDS = storageLimitSetting(
  'UNKEEP_MAX_RECORDS',
  DEFAULT_MAX_RECORDS,
  10_000_000,
);
const MAX_ATTACHMENTS = storageLimitSetting(
  'UNKEEP_MAX_ATTACHMENTS',
  DEFAULT_MAX_ATTACHMENTS,
  1_000_000,
);
const MAX_DEVICES = storageLimitSetting(
  'UNKEEP_MAX_DEVICES',
  DEFAULT_MAX_DEVICES,
  100_000,
);
const MAX_SERVICE_CREDENTIALS = storageLimitSetting(
  'UNKEEP_MAX_SERVICE_CREDENTIALS',
  DEFAULT_MAX_SERVICE_CREDENTIALS,
  1_000_000,
);
const MAX_MUTATION_RECEIPTS = storageLimitSetting(
  'UNKEEP_MAX_MUTATION_RECEIPTS',
  DEFAULT_MAX_MUTATION_RECEIPTS,
  1_000_000,
);
const ADMIN_RATE_WINDOW_MS = storageLimitSetting(
  'UNKEEP_ADMIN_RATE_WINDOW_MS',
  DEFAULT_ADMIN_RATE_WINDOW_MS,
  24 * 60 * 60_000,
);
const ADMIN_SOURCE_RATE_LIMIT = storageLimitSetting(
  'UNKEEP_ADMIN_SOURCE_RATE_LIMIT',
  DEFAULT_ADMIN_SOURCE_RATE_LIMIT,
  1_000,
);
const ADMIN_GLOBAL_RATE_LIMIT = storageLimitSetting(
  'UNKEEP_ADMIN_GLOBAL_RATE_LIMIT',
  DEFAULT_ADMIN_GLOBAL_RATE_LIMIT,
  10_000,
);
const PAIRING_TTL_MS = storageLimitSetting(
  'UNKEEP_PAIRING_TTL_MS',
  DEFAULT_PAIRING_TTL_MS,
  24 * 60 * 60_000,
);
const MUTATION_RECEIPT_TTL_MS = storageLimitSetting(
  'UNKEEP_MUTATION_RECEIPT_TTL_MS',
  DEFAULT_MUTATION_RECEIPT_TTL_MS,
  90 * 24 * 60 * 60_000,
);
const ATTACHMENT_STAGE_TTL_MS = storageLimitSetting(
  'UNKEEP_ATTACHMENT_STAGE_TTL_MS',
  DEFAULT_ATTACHMENT_STAGE_TTL_MS,
  24 * 60 * 60_000,
);
const TRUST_PROXY = process.env.UNKEEP_TRUST_PROXY === '1';
const MAX_ATTACHMENT_SIZE = storageLimitSetting(
  'UNKEEP_MAX_ATTACHMENT_SIZE',
  DEFAULT_MAX_ATTACHMENT_SIZE,
  100 * 1024 * 1024,
);
const AES_GCM_TAG_SIZE = 16;
const MAX_ATTACHMENT_BODY = 4 * Math.ceil((MAX_ATTACHMENT_SIZE + AES_GCM_TAG_SIZE) / 3) + 64 * 1024;
const MAX_SHARE_FALLBACK_BODY = 512 * 1024;
const MAX_COMPOUND_ATTACHMENTS = 1_000;
const MAX_ATTACHMENT_STAGE_BUNDLE_LIFETIME_MS = 24 * 60 * 60_000;
const PROTOCOL_VERSION = 3;
const pairingRateLimiter = createPairingRateLimiter({
  windowMs: PAIRING_RATE_WINDOW_MS,
  sourceLimit: PAIRING_SOURCE_RATE_LIMIT,
  globalLimit: PAIRING_GLOBAL_RATE_LIMIT,
});
const setupRateLimiter = createFailedSecretRateLimiter({
  windowMs: ADMIN_RATE_WINDOW_MS,
  sourceLimit: ADMIN_SOURCE_RATE_LIMIT,
  globalLimit: ADMIN_GLOBAL_RATE_LIMIT,
});
const recoveryRateLimiter = createFailedSecretRateLimiter({
  windowMs: ADMIN_RATE_WINDOW_MS,
  sourceLimit: ADMIN_SOURCE_RATE_LIMIT,
  globalLimit: ADMIN_GLOBAL_RATE_LIMIT,
});
process.umask(0o077);
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
chmodSync(DATA_DIR, 0o700);

const DATABASE_PATH = join(DATA_DIR, 'unkeep.sqlite');
const db = new DatabaseSync(DATABASE_PATH);
chmodSync(DATABASE_PATH, 0o600);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
migrateDatabase(db);
completeSensitiveDataScrub(db);
let instance = db.prepare('SELECT * FROM instance LIMIT 1').get();
if (!instance) {
  db.prepare('INSERT INTO instance (id, initialized) VALUES (?,0)').run(randomUUID());
  instance = db.prepare('SELECT * FROM instance LIMIT 1').get();
}
if (!SETUP_TOKEN && !instance.initialized) {
  db.close();
  throw new Error(
    'UNKEEP_SETUP_TOKEN is required while the relay is uninitialized',
  );
}
const deleteStalePairings = db.prepare('DELETE FROM pairing_requests WHERE expires_at<=?');
const deleteStalePairingReceipts = db.prepare('DELETE FROM pairing_consume_receipts WHERE expires_at<=?');
const deleteExpiredMutationReceipts = db.prepare(
  'DELETE FROM mutations WHERE created_at<=?',
);
const deleteExpiredAttachmentStages = db.prepare(
  'DELETE FROM attachment_stages WHERE expires_at<=?',
);
const countMutationReceipts = db.prepare(
  'SELECT COUNT(*) AS count FROM mutations',
);
const countDevices = db.prepare(
  'SELECT COUNT(*) AS count FROM devices',
);
const countServiceCredentials = db.prepare(
  'SELECT COUNT(*) AS count FROM service_credentials',
);
const deleteOldestMutationReceipts = db.prepare(`
  DELETE FROM mutations
  WHERE id IN (
    SELECT id
    FROM mutations
    ORDER BY created_at,revision,id
    LIMIT ?
  )
`);
function cleanupPairings() {
  const now = Date.now();
  deleteStalePairings.run(now);
  deleteStalePairingReceipts.run(now);
}
function pruneMutationReceipts(reservedSlots = 0, now = Date.now()) {
  deleteExpiredMutationReceipts.run(now - MUTATION_RECEIPT_TTL_MS);
  const retainedLimit = Math.max(0, MAX_MUTATION_RECEIPTS - reservedSlots);
  const count = Number(countMutationReceipts.get().count);
  if (count > retainedLimit) {
    deleteOldestMutationReceipts.run(count - retainedLimit);
  }
}
function cleanupTransientState() {
  cleanupPairings();
  deleteExpiredAttachmentStages.run(Date.now());
  pruneMutationReceipts();
}
cleanupTransientState();
const pairingCleanupTimer = setInterval(
  cleanupTransientState,
  Math.min(60_000, PAIRING_TTL_MS),
);
pairingCleanupTimer.unref();

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function token() { return randomBytes(32).toString('base64url'); }
function attachmentStageHash(value) {
  return hash(
    `unkeep:attachment-stage:v1\n${JSON.stringify(value)}`,
  );
}
function noteBundlePayloadHash(value) {
  return hash(
    `unkeep:note-bundle:v1\n${JSON.stringify(value)}`,
  );
}
function equalSecret(a, b) {
  return timingSafeSecretEqual(a, b);
}
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'unkeep-protocol-version': String(PROTOCOL_VERSION),
  });
  res.end(JSON.stringify(body));
}
function body(req, limit = MAX_BODY) {
  return readJsonObject(req, limit);
}
function bearer(req) { return (req.headers.authorization || '').match(/^(?:Device|Service) (.+)$/)?.[1] || ''; }
function pairingSecret(req) {
  const header = req.headers['unkeep-pairing-secret'];
  return (Array.isArray(header) ? header[0] : header) || '';
}
function unauthenticatedRequestSource(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',', 1)[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  return req.socket.remoteAddress || 'unknown';
}
function credentialByHash(tokenHash) {
  const device = db.prepare('SELECT id,name FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash);
  if (device) return { ...device, kind: 'device' };
  const service = db.prepare('SELECT id,name,scope FROM service_credentials WHERE token_hash=? AND revoked_at IS NULL').get(tokenHash);
  return service ? { ...service, kind: 'service' } : null;
}
function credentialHashRegistered(tokenHash) {
  return Boolean(db.prepare(`
    SELECT 1 FROM devices WHERE token_hash=?
    UNION ALL
    SELECT 1 FROM service_credentials WHERE token_hash=?
    LIMIT 1
  `).get(tokenHash, tokenHash));
}
function requireCredential(req) {
  const credential = bearer(req);
  if (!credential) return null;
  const tokenHash = hash(credential);
  const authenticated = credentialByHash(tokenHash);
  return authenticated ? { ...authenticated, tokenHash } : null;
}
function nextRevision() { return Number(db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS value FROM records').get().value); }
function validId(value) { return isValidRecordId(value); }
function validSha256Hash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function invalidCredential(req, res) {
  return json(res, 401, {
    error: (req.headers.authorization || '').startsWith('Service ')
      ? 'invalid_service_credential'
      : 'invalid_device_credential',
  });
}

function discardRequestBody(req, maximumBytes) {
  let received = 0;
  req.on('data', chunk => {
    received += chunk.length;
    if (received > maximumBytes) req.destroy();
  });
  req.resume();
}

function validatedAllowedOrigin(value) {
  if (!value) return null;
  if (value === '*') return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('UNKEEP_ALLOWED_ORIGIN must be * or an exact HTTP(S) origin');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || value !== url.origin
  ) {
    throw new Error('UNKEEP_ALLOWED_ORIGIN must be * or an exact HTTP(S) origin');
  }
  return url.origin;
}

const ALLOWED_ORIGIN = validatedAllowedOrigin(process.env.UNKEEP_ALLOWED_ORIGIN);

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, { protocol: PROTOCOL_VERSION, instanceId: instance.id, initialized: Boolean(instance.initialized) });
  if (req.method === 'POST' && url.pathname === '/api/v1/setup/claim') {
    const requestSource = unauthenticatedRequestSource(req);
    const supplied = (req.headers.authorization || '').match(/^Setup (.+)$/)?.[1] || '';
    const setupAuthorization = authorizeAdministrativeSecret({
      rateLimiter: setupRateLimiter,
      source: requestSource,
      supplied,
      expected: SETUP_TOKEN,
    });
    if (setupAuthorization.rateLimited) {
      res.setHeader(
        'retry-after',
        String(Math.ceil(setupAuthorization.retryAfterMs / 1_000)),
      );
      return json(res, 429, { error: 'setup_rate_limited' });
    }
    if (!setupAuthorization.authorized) {
      return json(res, 401, { error: 'invalid_setup_token' });
    }
    const value = await body(req);
    if (!validId(value.deviceId)) return json(res, 400, { error: 'invalid_device' });
    if (!validId(value.expectedInstanceId)) return json(res, 400, { error: 'invalid_instance' });
    let credential;
    let currentInstance;
    db.exec('BEGIN IMMEDIATE');
    try {
      currentInstance = db.prepare('SELECT id,initialized FROM instance LIMIT 1').get();
      if (!currentInstance || value.expectedInstanceId !== currentInstance.id) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'instance_mismatch' });
      }
      if (currentInstance.initialized) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'already_initialized' });
      }
      cleanupPairings();
      if (db.prepare('SELECT 1 FROM pairing_requests WHERE device_id=?').get(value.deviceId)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'device_id_unavailable' });
      }
      if (Number(countDevices.get().count) >= MAX_DEVICES) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'device_count_limit' });
      }
      credential = token();
      db.prepare(`
        INSERT INTO devices(id,name,token_hash,approved_by_device_id)
        VALUES (?,?,?,NULL)
      `).run(
        value.deviceId,
        String(value.name || 'First device').slice(0,100),
        hash(credential),
      );
      db.prepare('UPDATE instance SET initialized=1 WHERE id=?').run(currentInstance.id);
      db.exec('COMMIT');
      instance = { ...instance, ...currentInstance, initialized: 1 };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 201, { instanceId: currentInstance.id, deviceCredential: credential });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/setup/reclaim') {
    const requestSource = unauthenticatedRequestSource(req);
    const supplied = (req.headers.authorization || '').match(/^Recovery (.+)$/)?.[1] || '';
    const recoveryAuthorization = authorizeAdministrativeSecret({
      rateLimiter: recoveryRateLimiter,
      source: requestSource,
      supplied,
      expected: RECOVERY_TOKEN,
    });
    if (recoveryAuthorization.rateLimited) {
      res.setHeader(
        'retry-after',
        String(Math.ceil(recoveryAuthorization.retryAfterMs / 1_000)),
      );
      return json(res, 429, { error: 'recovery_rate_limited' });
    }
    if (!recoveryAuthorization.authorized) {
      return json(res, 401, { error: 'invalid_recovery_token' });
    }
    const value = await body(req);
    if (!validId(value.deviceId)) return json(res, 400, { error: 'invalid_device' });
    if (!validId(value.expectedInstanceId)) return json(res, 400, { error: 'invalid_instance' });
    let credential;
    let currentInstance;
    db.exec('BEGIN IMMEDIATE');
    try {
      currentInstance = db.prepare('SELECT id,initialized FROM instance LIMIT 1').get();
      if (!currentInstance || value.expectedInstanceId !== currentInstance.id) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'instance_mismatch' });
      }
      if (!currentInstance.initialized) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'not_initialized' });
      }
      cleanupPairings();
      if (db.prepare('SELECT 1 FROM pairing_requests WHERE device_id=?').get(value.deviceId)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'device_id_unavailable' });
      }
      const existingDevice = db.prepare('SELECT 1 FROM devices WHERE id=?').get(value.deviceId);
      if (!existingDevice && Number(countDevices.get().count) >= MAX_DEVICES) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'device_count_limit' });
      }
      credential = token();
      db.prepare(`
        INSERT INTO devices(
          id,name,token_hash,revoked_at,approved_by_device_id
        ) VALUES (?,?,?,NULL,NULL)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          token_hash=excluded.token_hash,
          revoked_at=NULL,
          approved_by_device_id=NULL
      `).run(value.deviceId, String(value.name || 'Recovered device').slice(0,100), hash(credential));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 201, { instanceId: currentInstance.id, deviceCredential: credential });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/pairings') {
    // Reject browser-simple form/text requests before they can spend pairing
    // capacity. Official JSON clients preflight when they are cross-origin.
    assertJsonContentType(req);
    const observedInstance = db.prepare('SELECT id,initialized FROM instance LIMIT 1').get();
    if (!observedInstance?.initialized) return json(res, 409, { error: 'not_initialized' });
    const rate = pairingRateLimiter.attempt(unauthenticatedRequestSource(req));
    if (!rate.allowed) {
      res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1_000)));
      return json(res, 429, { error: 'pairing_rate_limited' });
    }
    const value = await body(req, MAX_PAIRING_BODY_BYTES);
    if (!validId(value.deviceId)) return json(res, 400, { error: 'invalid_pairing' });
    if (!validId(value.expectedInstanceId)) return json(res, 400, { error: 'invalid_instance' });
    if (value.expectedInstanceId !== observedInstance.id) return json(res, 409, { error: 'instance_mismatch' });
    if (!validSha256Hash(value.deviceCredentialHash)) return json(res, 400, { error: 'invalid_pairing_credential' });
    const publicKey = normalizePairingPublicKey(value.publicKey);
    if (!publicKey) return json(res, 400, { error: 'invalid_pairing_public_key' });
    let id;
    let code;
    let pollSecret;
    let expiresAt;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentInstance = db.prepare('SELECT id,initialized FROM instance LIMIT 1').get();
      if (!currentInstance || value.expectedInstanceId !== currentInstance.id) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'instance_mismatch' });
      }
      if (!currentInstance.initialized) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'not_initialized' });
      }
      cleanupPairings();
      if (
        db.prepare('SELECT 1 FROM devices WHERE id=?').get(value.deviceId)
        || db.prepare('SELECT 1 FROM pairing_requests WHERE device_id=?').get(value.deviceId)
      ) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'device_id_unavailable' });
      }
      if (credentialHashRegistered(value.deviceCredentialHash)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'pairing_credential_unavailable' });
      }
      if (Number(countDevices.get().count) >= MAX_DEVICES) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'device_count_limit' });
      }
      const pendingCount = Number(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count);
      if (pendingCount >= MAX_PENDING_PAIRINGS) {
        db.exec('ROLLBACK');
        return json(res, 429, { error: 'pairing_capacity_reached' });
      }
      id = randomUUID();
      pollSecret = token();
      do {
        code = Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join('');
      } while (db.prepare('SELECT 1 FROM pairing_requests WHERE code=?').get(code));
      expiresAt = Date.now() + PAIRING_TTL_MS;
      db.prepare(`
        INSERT INTO pairing_requests(
          id,code,instance_id,device_id,device_name,public_key,poll_hash,
          expires_at,device_token_hash
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        code,
        currentInstance.id,
        value.deviceId,
        String(value.name || 'New device').slice(0,100),
        JSON.stringify(publicKey),
        hash(pollSecret),
        expiresAt,
        value.deviceCredentialHash,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 201, {
      requestId: id,
      code,
      pollSecret,
      expiresAt: new Date(expiresAt).toISOString(),
      instanceId: observedInstance.id,
    });
  }
  cleanupPairings();
  const pairMatch = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)$/);
  if (pairMatch && req.method === 'GET') {
    const row = db.prepare(`
      SELECT instance_id AS instanceId,response,expires_at,poll_hash
      FROM pairing_requests
      WHERE id=?
    `).get(pairMatch[1]);
    if (!row || !equalSecret(row.poll_hash, hash(pairingSecret(req)))) return json(res, 404, { error: 'pairing_not_found' });
    if (row.expires_at <= Date.now()) return json(res, 410, { error: 'pairing_expired' });
    return json(res, 200, {
      instanceId: row.instanceId,
      response: row.response ? JSON.parse(row.response) : null,
    });
  }
  if (pairMatch && req.method === 'DELETE') {
    const row = db.prepare('SELECT poll_hash FROM pairing_requests WHERE id=?').get(pairMatch[1]);
    if (!row || !equalSecret(row.poll_hash, hash(pairingSecret(req)))) return json(res, 404, { error: 'pairing_not_found' });
    db.prepare('DELETE FROM pairing_requests WHERE id=?').run(pairMatch[1]);
    return json(res, 204, {});
  }
  const consume = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)\/consume$/);
  if (consume && req.method === 'POST') {
    const suppliedTokenHash = hash(bearer(req));
    db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = db.prepare(`
        SELECT device_id,device_token_hash,expires_at
        FROM pairing_consume_receipts
        WHERE request_id=?
      `).get(consume[1]);
      if (receipt) {
        const activeDevice = receipt.expires_at > Date.now()
          && equalSecret(receipt.device_token_hash, suppliedTokenHash)
          && db.prepare(`
            SELECT 1
            FROM devices
            WHERE id=? AND token_hash=? AND revoked_at IS NULL
          `).get(receipt.device_id, suppliedTokenHash);
        db.exec(activeDevice ? 'COMMIT' : 'ROLLBACK');
        return activeDevice
          ? json(res, 200, { consumed: true, alreadyConsumed: true })
          : json(res, 403, { error: 'pairing_device_required' });
      }
      const pairing = db.prepare(`
        SELECT
          instance_id,device_id,device_name,device_token_hash,expires_at,
          response,approved_by_device_id
        FROM pairing_requests
        WHERE id=?
      `).get(consume[1]);
      if (!pairing) {
        db.exec('ROLLBACK');
        return json(res, 404, { error: 'pairing_not_found' });
      }
      if (
        !pairing.response
        || !pairing.device_token_hash
        || pairing.expires_at <= Date.now()
        || !equalSecret(pairing.device_token_hash, suppliedTokenHash)
      ) {
        db.exec('ROLLBACK');
        return json(res, 403, { error: 'pairing_device_required' });
      }
      const currentInstance = db.prepare('SELECT id FROM instance LIMIT 1').get();
      if (!currentInstance || pairing.instance_id !== currentInstance.id) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'instance_mismatch' });
      }
      if (
        !pairing.approved_by_device_id
        || !db.prepare(`
          SELECT 1
          FROM devices
          WHERE id=? AND revoked_at IS NULL
        `).get(pairing.approved_by_device_id)
      ) {
        db.exec('ROLLBACK');
        return json(res, 403, { error: 'pairing_device_required' });
      }
      if (credentialHashRegistered(pairing.device_token_hash)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'pairing_credential_unavailable' });
      }
      if (db.prepare('SELECT 1 FROM devices WHERE id=?').get(pairing.device_id)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'device_id_unavailable' });
      }
      if (Number(countDevices.get().count) >= MAX_DEVICES) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'device_count_limit' });
      }
      db.prepare(`
        INSERT INTO devices(
          id,name,token_hash,revoked_at,approved_by_device_id
        ) VALUES(?,?,?,NULL,?)
      `).run(
        pairing.device_id,
        pairing.device_name,
        pairing.device_token_hash,
        pairing.approved_by_device_id,
      );
      const consumedAt = Date.now();
      db.prepare(`
        INSERT INTO pairing_consume_receipts(
          request_id,device_id,device_token_hash,consumed_at,expires_at
        ) VALUES(?,?,?,?,?)
      `).run(
        consume[1],
        pairing.device_id,
        pairing.device_token_hash,
        consumedAt,
        consumedAt + PAIRING_RECEIPT_TTL_MS,
      );
      db.prepare('DELETE FROM pairing_requests WHERE id=?').run(consume[1]);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 200, { consumed: true });
  }
  const credential = requireCredential(req);
  if (!credential) return invalidCredential(req, res);
  if (req.method === 'GET' && url.pathname === '/api/v1/vault') return json(res, 200, { vaultId: instance.id });
  const attachmentStage = url.pathname.match(
    /^\/api\/v1\/note-mutations\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)$/,
  );
  if (attachmentStage && req.method === 'PUT') {
    if (credential.kind === 'service' && credential.scope === 'read-only') {
      return json(res, 403, { error: 'service_credential_read_only' });
    }
    const bundleMutationId = attachmentStage[1];
    const attachmentId = attachmentStage[2];
    if (!validId(bundleMutationId) || !validId(attachmentId)) {
      return json(res, 400, { error: 'invalid_record_id' });
    }
    const value = await body(req, MAX_ATTACHMENT_BODY);
    if (
      !hasExactKeys(value, ['noteId', 'envelope'])
      || !validId(value.noteId)
    ) {
      return json(res, 400, { error: 'invalid_attachment_stage' });
    }
    const envelope = normalizeRecordEnvelope(
      value.envelope,
      attachmentId,
      MAX_ATTACHMENT_SIZE + AES_GCM_TAG_SIZE,
    );
    if (!envelope) {
      return json(res, 400, { error: 'invalid_record_envelope' });
    }
    const serializedEnvelope = JSON.stringify(envelope);
    const envelopeBytes = Buffer.byteLength(serializedEnvelope);
    const stageHash = attachmentStageHash({
      bundleMutationId,
      attachmentId,
      noteId: value.noteId,
      envelope,
    });
    let created = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteExpiredAttachmentStages.run(Date.now());
      const freshCredential = credentialByHash(credential.tokenHash);
      if (!freshCredential) {
        db.exec('ROLLBACK');
        return invalidCredential(req, res);
      }
      if (
        freshCredential.kind === 'service'
        && freshCredential.scope === 'read-only'
      ) {
        db.exec('ROLLBACK');
        return json(res, 403, { error: 'service_credential_read_only' });
      }
      if (db.prepare('SELECT 1 FROM mutations WHERE id=?').get(bundleMutationId)) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'mutation_conflict' });
      }
      const existing = db.prepare(`
        SELECT owner_token_hash AS ownerTokenHash,stage_hash AS stageHash
        FROM attachment_stages
        WHERE bundle_mutation_id=? AND attachment_id=?
      `).get(bundleMutationId, attachmentId);
      if (existing) {
        const matches = existing.ownerTokenHash === credential.tokenHash
          && existing.stageHash === stageHash;
        if (matches) {
          const now = Date.now();
          const bundle = db.prepare(`
            SELECT MIN(created_at) AS createdAt
            FROM attachment_stages
            WHERE bundle_mutation_id=? AND owner_token_hash=?
          `).get(bundleMutationId, credential.tokenHash);
          const expiresAt = Math.min(
            now + ATTACHMENT_STAGE_TTL_MS,
            Number(bundle.createdAt) + MAX_ATTACHMENT_STAGE_BUNDLE_LIFETIME_MS,
          );
          db.prepare(`
            UPDATE attachment_stages SET expires_at=?
            WHERE bundle_mutation_id=? AND owner_token_hash=?
          `).run(expiresAt, bundleMutationId, credential.tokenHash);
          db.exec('COMMIT');
        } else {
          db.exec('ROLLBACK');
        }
        return matches
          ? json(res, 200, { stageHash })
          : json(res, 409, { error: 'attachment_stage_conflict' });
      }
      if (
        db.prepare(`
          SELECT 1 FROM attachment_stages WHERE attachment_id=?
        `).get(attachmentId)
        || db.prepare(`
          SELECT 1 FROM records WHERE kind='attachment' AND id=?
        `).get(attachmentId)
      ) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'attachment_id_unavailable' });
      }
      const bundle = db.prepare(`
        SELECT COUNT(*) AS count,MIN(created_at) AS createdAt
        FROM attachment_stages
        WHERE bundle_mutation_id=? AND owner_token_hash=?
      `).get(bundleMutationId, credential.tokenHash);
      if (Number(bundle.count) >= MAX_COMPOUND_ATTACHMENTS) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'attachment_count_limit' });
      }
      const liveUsage = db.prepare(`
        SELECT record_count AS recordCount,
          attachment_count AS attachmentCount,
          encrypted_bytes AS encryptedBytes
        FROM record_storage_usage WHERE singleton=1
      `).get();
      const stagedUsage = db.prepare(`
        SELECT stage_count AS stageCount,encrypted_bytes AS encryptedBytes
        FROM attachment_stage_usage WHERE singleton=1
      `).get();
      if (
        Number(liveUsage.recordCount) + Number(stagedUsage.stageCount) + 1
          > MAX_RECORDS
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'record_count_limit' });
      }
      if (
        Number(liveUsage.attachmentCount) + Number(stagedUsage.stageCount) + 1
          > MAX_ATTACHMENTS
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'attachment_count_limit' });
      }
      if (
        Number(liveUsage.encryptedBytes)
          + Number(stagedUsage.encryptedBytes)
          + envelopeBytes
          > MAX_ENCRYPTED_RECORD_BYTES
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'encrypted_record_bytes_limit' });
      }
      const now = Date.now();
      const bundleCreatedAt = bundle.createdAt === null
        ? now
        : Number(bundle.createdAt);
      const expiresAt = Math.min(
        now + ATTACHMENT_STAGE_TTL_MS,
        bundleCreatedAt + MAX_ATTACHMENT_STAGE_BUNDLE_LIFETIME_MS,
      );
      db.prepare(`
        UPDATE attachment_stages SET expires_at=?
        WHERE bundle_mutation_id=? AND owner_token_hash=?
      `).run(expiresAt, bundleMutationId, credential.tokenHash);
      db.prepare(`
        INSERT INTO attachment_stages(
          bundle_mutation_id,attachment_id,note_id,owner_token_hash,
          stage_hash,envelope,envelope_bytes,created_at,expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
      `).run(
        bundleMutationId,
        attachmentId,
        value.noteId,
        credential.tokenHash,
        stageHash,
        serializedEnvelope,
        envelopeBytes,
        now,
        expiresAt,
      );
      created = true;
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, created ? 201 : 200, { stageHash });
  }
  const noteBundle = url.pathname.match(
    /^\/api\/v1\/notes\/([A-Za-z0-9_-]+)\/compound$/,
  );
  if (noteBundle && req.method === 'PUT') {
    if (credential.kind === 'service' && credential.scope === 'read-only') {
      return json(res, 403, { error: 'service_credential_read_only' });
    }
    const noteId = noteBundle[1];
    if (!validId(noteId)) return json(res, 400, { error: 'invalid_record_id' });
    const value = await body(req);
    if (
      !hasExactKeys(
        value,
        ['mutationId', 'baseRevision', 'envelope', 'deleted', 'newAttachments'],
      )
      || !validId(value.mutationId)
      || !Number.isSafeInteger(value.baseRevision)
      || value.baseRevision < 0
      || value.deleted !== false
      || !Array.isArray(value.newAttachments)
      || value.newAttachments.length < 1
      || value.newAttachments.length > MAX_COMPOUND_ATTACHMENTS
      || value.newAttachments.some(
        attachment => !hasExactKeys(attachment, ['id', 'stageHash'])
          || !validId(attachment.id)
          || !validSha256Hash(attachment.stageHash),
      )
      || value.newAttachments.some(
        (attachment, index) => index > 0
          && value.newAttachments[index - 1].id >= attachment.id,
      )
      || new Set(
        value.newAttachments.map(attachment => attachment.stageHash),
      ).size !== value.newAttachments.length
    ) {
      return json(res, 400, { error: 'invalid_note_bundle' });
    }
    const envelope = normalizeRecordEnvelope(value.envelope, noteId, MAX_BODY);
    if (!envelope) {
      return json(res, 400, { error: 'invalid_record_envelope' });
    }
    const serializedEnvelope = JSON.stringify(envelope);
    const envelopeBytes = Buffer.byteLength(serializedEnvelope);
    const payloadHash = noteBundlePayloadHash({
      mutationId: value.mutationId,
      noteId,
      baseRevision: value.baseRevision,
      deleted: false,
      envelope,
      newAttachments: value.newAttachments,
    });
    let responseBody;
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteExpiredAttachmentStages.run(Date.now());
      const freshCredential = credentialByHash(credential.tokenHash);
      if (!freshCredential) {
        db.exec('ROLLBACK');
        return invalidCredential(req, res);
      }
      if (
        freshCredential.kind === 'service'
        && freshCredential.scope === 'read-only'
      ) {
        db.exec('ROLLBACK');
        return json(res, 403, { error: 'service_credential_read_only' });
      }
      const prior = db.prepare(`
        SELECT payload_hash AS payloadHash,response,owner_token_hash AS ownerTokenHash,
          mutation_kind AS mutationKind
        FROM mutations WHERE id=?
      `).get(value.mutationId);
      if (prior) {
        const matches = prior.payloadHash === payloadHash
          && prior.ownerTokenHash === credential.tokenHash
          && prior.mutationKind === 'note-bundle'
          && typeof prior.response === 'string';
        db.exec(matches ? 'COMMIT' : 'ROLLBACK');
        return matches
          ? json(res, 200, JSON.parse(prior.response))
          : json(res, 409, { error: 'mutation_conflict' });
      }
      const current = db.prepare(`
        SELECT revision,length(CAST(envelope AS BLOB)) AS envelopeBytes
        FROM records WHERE kind='note' AND id=?
      `).get(noteId);
      const currentRevision = Number(current?.revision ?? 0);
      if (currentRevision !== value.baseRevision) {
        db.prepare(`
          DELETE FROM attachment_stages
          WHERE bundle_mutation_id=? AND owner_token_hash=?
        `).run(value.mutationId, credential.tokenHash);
        db.exec('COMMIT');
        return json(res, 409, {
          error: 'record_conflict',
          currentRevision,
        });
      }
      const stages = db.prepare(`
        SELECT attachment_id AS attachmentId,note_id AS noteId,
          stage_hash AS stageHash,envelope,envelope_bytes AS envelopeBytes
        FROM attachment_stages
        WHERE bundle_mutation_id=? AND owner_token_hash=?
        ORDER BY attachment_id
      `).all(value.mutationId, credential.tokenHash);
      if (
        stages.length !== value.newAttachments.length
        || stages.some(
          (stage, index) =>
            stage.attachmentId !== value.newAttachments[index].id
            || stage.stageHash !== value.newAttachments[index].stageHash
            || stage.noteId !== noteId,
        )
      ) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'attachment_stage_missing' });
      }
      const orderedStages = stages;
      const collision = orderedStages.find(stage => db.prepare(`
        SELECT 1 FROM records WHERE kind='attachment' AND id=?
      `).get(stage.attachmentId));
      if (collision) {
        db.prepare(`
          DELETE FROM attachment_stages
          WHERE bundle_mutation_id=? AND owner_token_hash=?
        `).run(value.mutationId, credential.tokenHash);
        db.exec('COMMIT');
        return json(res, 409, { error: 'attachment_id_unavailable' });
      }
      const liveUsage = db.prepare(`
        SELECT record_count AS recordCount,encrypted_bytes AS encryptedBytes
        FROM record_storage_usage WHERE singleton=1
      `).get();
      const stagedUsage = db.prepare(`
        SELECT stage_count AS stageCount,encrypted_bytes AS encryptedBytes
        FROM attachment_stage_usage WHERE singleton=1
      `).get();
      if (
        Number(liveUsage.recordCount) + Number(stagedUsage.stageCount)
          + (current ? 0 : 1) > MAX_RECORDS
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'record_count_limit' });
      }
      if (
        Number(liveUsage.encryptedBytes) + Number(stagedUsage.encryptedBytes)
          - Number(current?.envelopeBytes ?? 0) + envelopeBytes
          > MAX_ENCRYPTED_RECORD_BYTES
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'encrypted_record_bytes_limit' });
      }
      pruneMutationReceipts(1);
      let revision = nextRevision();
      const attachmentRevisions = [];
      const insertAttachment = db.prepare(`
        INSERT INTO records(kind,id,note_id,envelope,deleted,revision)
        VALUES('attachment',?,?,?,0,?)
      `);
      for (const stage of orderedStages) {
        insertAttachment.run(
          stage.attachmentId,
          noteId,
          stage.envelope,
          revision,
        );
        attachmentRevisions.push({ id: stage.attachmentId, revision });
        revision += 1;
      }
      db.prepare(`
        INSERT INTO records(kind,id,note_id,envelope,deleted,revision)
        VALUES('note',?,NULL,?,0,?)
        ON CONFLICT(kind,id) DO UPDATE SET
          note_id=NULL,envelope=excluded.envelope,deleted=0,
          revision=excluded.revision
      `).run(noteId, serializedEnvelope, revision);
      responseBody = { revision, attachmentRevisions };
      db.prepare(`
        INSERT INTO mutations(
          id,payload_hash,revision,created_at,response,owner_token_hash,
          mutation_kind
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        value.mutationId,
        payloadHash,
        revision,
        Date.now(),
        JSON.stringify(responseBody),
        credential.tokenHash,
        'note-bundle',
      );
      db.prepare(`
        DELETE FROM attachment_stages
        WHERE bundle_mutation_id=? AND owner_token_hash=?
      `).run(value.mutationId, credential.tokenHash);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 200, responseBody);
  }
  if (url.pathname === '/api/v1/service-credentials') {
    if (credential.kind !== 'device') return json(res, 403, { error: 'device_credential_required' });
    if (req.method === 'GET') {
      return json(res, 200, { serviceCredentials: db.prepare('SELECT id,name,scope,created_at AS createdAt,revoked_at AS revokedAt,issued_by_device_id AS issuedByDeviceId FROM service_credentials ORDER BY name,id').all() });
    }
    if (req.method === 'POST') {
      const value = await body(req); const name = typeof value.name === 'string' ? value.name.trim().slice(0,100) : '';
      if (!name) return json(res, 400, { error: 'invalid_service_credential_name' });
      const scope = value.scope === undefined ? 'read-only' : value.scope;
      if (scope !== 'read-only' && scope !== 'read-write') return json(res, 400, { error: 'invalid_service_credential_scope' });
      const id = randomUUID(); const serviceCredential = token();
      let issuedByDeviceId;
      let createdAt;
      db.exec('BEGIN IMMEDIATE');
      try {
        const freshCredential = credentialByHash(credential.tokenHash);
        if (!freshCredential) {
          db.exec('ROLLBACK');
          return invalidCredential(req, res);
        }
        if (freshCredential.kind !== 'device') {
          db.exec('ROLLBACK');
          return json(res, 403, { error: 'device_credential_required' });
        }
        if (Number(countServiceCredentials.get().count) >= MAX_SERVICE_CREDENTIALS) {
          db.exec('ROLLBACK');
          return json(res, 507, { error: 'service_credential_count_limit' });
        }
        issuedByDeviceId = freshCredential.id;
        db.prepare('INSERT INTO service_credentials(id,name,token_hash,issued_by_device_id,scope) VALUES(?,?,?,?,?)')
          .run(id, name, hash(serviceCredential), issuedByDeviceId, scope);
        createdAt = db.prepare('SELECT created_at AS createdAt FROM service_credentials WHERE id=?').get(id).createdAt;
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 201, { id, name, scope, createdAt, issuedByDeviceId, serviceCredential });
    }
  }
  const serviceRevoke = url.pathname.match(/^\/api\/v1\/service-credentials\/([0-9a-f-]+)$/);
  if (serviceRevoke && req.method === 'DELETE') {
    if (credential.kind !== 'device') return json(res, 403, { error: 'device_credential_required' });
    db.prepare("UPDATE service_credentials SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").run(serviceRevoke[1]);
    return json(res, 204, {});
  }
  if (credential.kind !== 'device' && (url.pathname.startsWith('/api/v1/devices') || url.pathname.startsWith('/api/v1/pairings/'))) return json(res, 403, { error: 'device_credential_required' });
  if (req.method === 'GET' && url.pathname === '/api/v1/devices') {
    return json(res, 200, {
      devices: db.prepare(`
        SELECT
          id,name,revoked_at AS revokedAt,
          approved_by_device_id AS approvedByDeviceId
        FROM devices
        ORDER BY name,id
      `).all(),
    });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/v1/devices') {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE devices
        SET revoked_at=datetime('now')
        WHERE revoked_at IS NULL
      `).run();
      db.prepare(`
        UPDATE service_credentials
        SET revoked_at=datetime('now')
        WHERE revoked_at IS NULL
      `).run();
      db.prepare('DELETE FROM pairing_requests').run();
      db.prepare('DELETE FROM pairing_consume_receipts').run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 204, {});
  }
  const revoke = url.pathname.match(/^\/api\/v1\/devices\/([A-Za-z0-9_-]+)$/);
  if (revoke && req.method === 'DELETE') {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM devices WHERE id=?
          UNION
          SELECT child.id
          FROM devices AS child
          JOIN descendants AS parent
            ON child.approved_by_device_id=parent.id
        )
        UPDATE devices
        SET revoked_at=datetime('now')
        WHERE id IN (SELECT id FROM descendants)
      `).run(revoke[1]);
      db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM devices WHERE id=?
          UNION
          SELECT child.id
          FROM devices AS child
          JOIN descendants AS parent
            ON child.approved_by_device_id=parent.id
        )
        UPDATE service_credentials
        SET revoked_at=datetime('now')
        WHERE issued_by_device_id IN (SELECT id FROM descendants)
          AND revoked_at IS NULL
      `).run(revoke[1]);
      db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM devices WHERE id=?
          UNION
          SELECT child.id
          FROM devices AS child
          JOIN descendants AS parent
            ON child.approved_by_device_id=parent.id
        )
        DELETE FROM pairing_requests
        WHERE approved_by_device_id IN (SELECT id FROM descendants)
          AND response IS NOT NULL
      `).run(revoke[1]);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 204, {});
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/changes') {
    const sinceValue = url.searchParams.get('since') ?? '0';
    const since = Number(sinceValue);
    if (!/^(?:0|[1-9][0-9]*)$/.test(sinceValue) || !Number.isSafeInteger(since)) {
      return json(res, 400, { error: 'invalid_cursor' });
    }
    const rows = db.prepare(`
      SELECT kind,id,note_id AS noteId,
        CASE WHEN kind='note' THEN envelope END AS envelope,
        deleted,revision
      FROM records WHERE revision>? ORDER BY revision LIMIT 1000
    `).all(since).map(({ envelope, ...row }) => ({
      ...row,
      ...(row.kind === 'note' ? { envelope: JSON.parse(envelope) } : {}),
      deleted: Boolean(row.deleted),
    }));
    const cursor = rows.reduce((n, r) => Math.max(n, Number(r.revision)), since);
    return json(res, 200, { changes: rows, cursor });
  }
  const record = url.pathname.match(/^\/api\/v1\/(notes|attachments)\/([A-Za-z0-9_-]+)$/);
  if (record && !validId(record[2])) {
    return json(res, 400, { error: 'invalid_record_id' });
  }
  if (record && req.method === 'PUT') {
    if (credential.kind === 'service' && credential.scope === 'read-only') {
      return json(res, 403, { error: 'service_credential_read_only' });
    }
    const kind = record[1] === 'notes' ? 'note' : 'attachment';
    const id = record[2];
    const value = await body(req, kind === 'attachment' ? MAX_ATTACHMENT_BODY : MAX_BODY);
    if (!validId(value.mutationId)) return json(res, 400, { error: 'invalid_mutation_id' });
    if (
      value.baseRevision !== undefined
      && (!Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0)
    ) {
      return json(res, 400, { error: 'invalid_base_revision' });
    }
    if (typeof value.deleted !== 'boolean') return json(res, 400, { error: 'invalid_record' });
    if (
      (kind === 'attachment' && !validId(value.noteId))
      || (kind === 'note' && value.noteId !== undefined)
    ) {
      return json(res, 400, { error: 'invalid_record' });
    }
    const ciphertextSize = canonicalBase64Size(value.envelope?.ciphertext);
    if (
      kind === 'attachment'
      && ciphertextSize !== null
      && ciphertextSize > MAX_ATTACHMENT_SIZE + AES_GCM_TAG_SIZE
    ) {
      return json(res, 413, { error: 'attachment_too_large' });
    }
    const envelope = normalizeRecordEnvelope(
      value.envelope,
      id,
      kind === 'attachment' ? MAX_ATTACHMENT_SIZE + AES_GCM_TAG_SIZE : MAX_BODY,
    );
    if (!envelope) return json(res, 400, { error: 'invalid_record_envelope' });
    const serializedEnvelope = JSON.stringify(envelope);
    const envelopeBytes = Buffer.byteLength(serializedEnvelope);
    const payloadHash = hash(JSON.stringify(value));
    const mutationId = value.mutationId;
    let revision;
    db.exec('BEGIN IMMEDIATE');
    try {
      // An authorization decision made before awaiting the request body can
      // become stale. Serialize with revocation and re-read under this lock.
      const freshCredential = credentialByHash(credential.tokenHash);
      if (!freshCredential) {
        db.exec('ROLLBACK');
        return invalidCredential(req, res);
      }
      if (freshCredential.kind === 'service' && freshCredential.scope === 'read-only') {
        db.exec('ROLLBACK');
        return json(res, 403, { error: 'service_credential_read_only' });
      }
      const prior = db.prepare('SELECT payload_hash,revision FROM mutations WHERE id=?').get(mutationId);
      if (prior) {
        db.exec(prior.payload_hash === payloadHash ? 'COMMIT' : 'ROLLBACK');
        return prior.payload_hash === payloadHash ? json(res, 200, { revision: prior.revision }) : json(res, 409, { error: 'mutation_conflict' });
      }
      if (value.baseRevision === undefined) {
        db.exec('ROLLBACK');
        return json(res, 428, { error: 'base_revision_required', requiredProtocol: PROTOCOL_VERSION });
      }
      const current = db.prepare(`
        SELECT
          note_id AS noteId,deleted,revision,
          length(CAST(envelope AS BLOB)) AS envelopeBytes
        FROM records
        WHERE kind=? AND id=?
      `).get(kind, id);
      const currentRevision = Number(current?.revision ?? 0);
      if (kind === 'attachment' && !current && !value.deleted) {
        db.exec('ROLLBACK');
        return json(res, 428, {
          error: 'compound_mutation_required',
          requiredProtocol: PROTOCOL_VERSION,
        });
      }
      if (kind === 'attachment' && current && Boolean(current.deleted) && value.deleted) {
        if (current.noteId !== value.noteId) {
          db.exec('ROLLBACK');
          return json(res, 409, { error: 'attachment_owner_conflict' });
        }
        pruneMutationReceipts(1);
        db.prepare(`
          INSERT INTO mutations(id,payload_hash,revision,created_at)
          VALUES(?,?,?,?)
        `).run(mutationId, payloadHash, currentRevision, Date.now());
        db.exec('COMMIT');
        return json(res, 200, { revision: currentRevision });
      }
      if (value.baseRevision !== currentRevision) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'record_conflict', currentRevision });
      }
      if (kind === 'attachment' && current) {
        if (current.noteId !== value.noteId) {
          db.exec('ROLLBACK');
          return json(res, 409, { error: 'attachment_owner_conflict' });
        }
        if (Boolean(current.deleted) || !value.deleted) {
          db.exec('ROLLBACK');
          return json(res, 409, { error: 'attachment_immutable' });
        }
      }
      if (
        kind === 'attachment'
        && !value.deleted
        && db.prepare("SELECT 1 FROM records WHERE kind='note' AND id=? AND deleted=1").get(value.noteId)
      ) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'note_deleted' });
      }
      const usage = db.prepare(`
        SELECT
          record_count AS recordCount,
          attachment_count AS attachmentCount,
          encrypted_bytes AS encryptedBytes
        FROM record_storage_usage
        WHERE singleton=1
      `).get();
      const cascade = kind === 'note' && value.deleted
        ? db.prepare(`
          SELECT
            COUNT(*) AS count,
            COALESCE(SUM(length(CAST(envelope AS BLOB))),0)
              AS encryptedBytes
          FROM records
          WHERE kind='attachment' AND note_id=? AND deleted=0
        `).get(id)
        : { count: 0, encryptedBytes: 0 };
      const recordCount = Number(usage.recordCount);
      const attachmentCount = Number(usage.attachmentCount);
      const encryptedBytes = Number(usage.encryptedBytes);
      const projectedRecordCount = recordCount + (current ? 0 : 1);
      const projectedAttachmentCount = attachmentCount
        + (kind === 'attachment' && !current ? 1 : 0);
      const projectedEncryptedBytes = encryptedBytes
        - Number(current?.envelopeBytes ?? 0)
        + envelopeBytes
        - Number(cascade.encryptedBytes)
        + Number(cascade.count) * Buffer.byteLength('null');
      if (
        projectedRecordCount > MAX_RECORDS
        && projectedRecordCount > recordCount
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'record_count_limit' });
      }
      if (
        projectedAttachmentCount > MAX_ATTACHMENTS
        && projectedAttachmentCount > attachmentCount
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'attachment_count_limit' });
      }
      if (
        projectedEncryptedBytes > MAX_ENCRYPTED_RECORD_BYTES
        && projectedEncryptedBytes > encryptedBytes
      ) {
        db.exec('ROLLBACK');
        return json(res, 507, { error: 'encrypted_record_bytes_limit' });
      }
      pruneMutationReceipts(1);
      revision = nextRevision();
      db.prepare(`
        INSERT INTO records(
          kind,id,note_id,envelope,deleted,revision
        ) VALUES(?,?,?,?,?,?)
        ON CONFLICT(kind,id) DO UPDATE SET
          note_id=excluded.note_id,
          envelope=excluded.envelope,
          deleted=excluded.deleted,
          revision=excluded.revision
      `).run(
        kind,
        id,
        value.noteId || null,
        serializedEnvelope,
        value.deleted ? 1 : 0,
        revision,
      );
      db.prepare(`
        INSERT INTO mutations(id,payload_hash,revision,created_at)
        VALUES(?,?,?,?)
      `).run(mutationId, payloadHash, revision, Date.now());
      if (kind === 'note' && value.deleted) {
        const liveAttachments = db.prepare(`
          SELECT id
          FROM records
          WHERE kind='attachment' AND note_id=? AND deleted=0
          ORDER BY id
        `).all(id);
        let attachmentRevision = revision;
        const tombstoneAttachment = db.prepare(`
          UPDATE records
          SET envelope='null',
            deleted=1,
            revision=?
          WHERE kind='attachment' AND id=? AND deleted=0
        `);
        for (const attachment of liveAttachments) {
          attachmentRevision += 1;
          tombstoneAttachment.run(
            attachmentRevision,
            attachment.id,
          );
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 200, { revision });
  }
  if (record && req.method === 'GET' && record[1] === 'attachments') {
    const row = db.prepare("SELECT note_id AS noteId,envelope,deleted,revision FROM records WHERE kind='attachment' AND id=?").get(record[2]);
    if (!row) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { ...row, envelope: JSON.parse(row.envelope), deleted: Boolean(row.deleted) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/pairings/code/')) {
    const code = url.pathname.split('/').pop().toUpperCase(); const row = db.prepare('SELECT id,instance_id AS instanceId,device_id AS deviceId,device_name AS deviceName,public_key AS publicKey,expires_at AS expiresAt,response FROM pairing_requests WHERE code=?').get(code);
    if (!row || row.expiresAt <= Date.now() || row.response) return json(res, 404, { error: 'pairing_not_found' });
    return json(res, 200, { ...row, publicKey: JSON.parse(row.publicKey), expiresAt: new Date(row.expiresAt).toISOString() });
  }
  const approve = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)\/approve$/);
  if (approve && req.method === 'POST') {
    const value = await body(req, MAX_PAIRING_BODY_BYTES);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Authentication before body parsing can go stale while the body is in
      // flight. Re-read under the write lock so revocation wins cleanly.
      const approvingDevice = db.prepare(`
        SELECT id
        FROM devices
        WHERE token_hash=? AND revoked_at IS NULL
      `).get(hash(bearer(req)));
      if (!approvingDevice) {
        db.exec('ROLLBACK');
        return json(res, 401, { error: 'invalid_device_credential' });
      }
      const row = db.prepare('SELECT expires_at,response FROM pairing_requests WHERE id=?').get(approve[1]);
      if (!row || row.expires_at <= Date.now() || row.response) {
        db.exec('ROLLBACK');
        return json(res, 409, { error: 'pairing_unavailable' });
      }
      db.prepare(`
        UPDATE pairing_requests
        SET response=?,approved_by_device_id=?
        WHERE id=? AND response IS NULL
      `).run(JSON.stringify(value.response), approvingDevice.id, approve[1]);
      db.exec('COMMIT');
    } catch(error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, 200, { approved: true });
  }
  return json(res, 404, { error: 'not_found' });
}

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' };
function staticFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let path = resolve(WEB_DIR, '.' + decodeURIComponent(url.pathname));
  if (!path.startsWith(WEB_DIR + sep) && path !== WEB_DIR) return false;
  try {
    if (statSync(path).isDirectory()) path = join(path,'index.html');
    const data = readFileSync(path);
    const cacheControl = path.endsWith(`${sep}service-worker.js`)
      ? 'no-store'
      : extname(path) === '.html'
        ? 'no-cache'
        : 'public, max-age=3600';
    res.writeHead(200, {
      'content-type': mime[extname(path)] || 'application/octet-stream',
      'cache-control': cacheControl,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  } catch {}
  try {
    const data = readFileSync(join(WEB_DIR,'index.html'));
    res.writeHead(200, {'content-type': mime['.html'], 'cache-control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  } catch {
    return false;
  }
}

export const server = createServer({
  headersTimeout: 15_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 5_000,
}, async (req,res) => {
  applySecurityHeaders(res);
  if (ALLOWED_ORIGIN) res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-headers','authorization,content-type,unkeep-pairing-secret');
  res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await api(req,res,url);
    } else if (
      url.pathname === '/share'
      && (req.method === 'POST' || url.searchParams.size > 0)
    ) {
      // Web Share Target POST bodies are plaintext until the active service
      // worker intercepts them. Never render or redirect a network fallback.
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_SHARE_FALLBACK_BODY) {
        discardRequestBody(req, MAX_SHARE_FALLBACK_BODY);
        json(res, 413, { error: 'share_payload_too_large' });
      } else {
        discardRequestBody(req, MAX_SHARE_FALLBACK_BODY);
        json(res, 409, { error: 'share_worker_required' });
      }
    } else if (!staticFile(req,res,url)) {
      json(res, req.method === 'GET' || req.method === 'HEAD' ? 404 : 405, {
        error: req.method === 'GET' || req.method === 'HEAD' ? 'not_found' : 'method_not_allowed',
      });
    }
  } catch(error) {
    const status = error instanceof URIError ? 400 : Number(error?.status || 500);
    if (status >= 500) console.error(error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, status, {
      error: status < 500
        ? String(error?.code || error?.message || 'bad_request')
        : 'internal_error',
    });
  }
});

let shutdownPromise;
let databaseClosed = false;
export function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  clearInterval(pairingCleanupTimer);
  shutdownPromise = new Promise((resolveShutdown, rejectShutdown) => {
    let finished = false;
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 25_000);
    forceTimer.unref();
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      try {
        if (!databaseClosed) {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
          databaseClosed = true;
        }
      } catch (closeError) {
        error ||= closeError;
      }
      if (error) rejectShutdown(error);
      else resolveShutdown();
    };
    if (server.listening) {
      server.close(finish);
      server.closeIdleConnections?.();
    } else {
      finish();
    }
  });
  return shutdownPromise;
}

if (process.env.NODE_ENV !== 'test') {
  const stop = () => {
    shutdown().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.listen(
    PORT,
    LISTEN_HOST,
    () => console.log(`UnKeep listening on http://${listenHostForUrl(LISTEN_HOST)}:${PORT}`),
  );
}
