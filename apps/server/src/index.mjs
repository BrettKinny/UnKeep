import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.UNKEEP_DATA_DIR || './data');
const WEB_DIR = resolve(process.env.UNKEEP_WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../web/build'));
const SETUP_TOKEN = process.env.UNKEEP_SETUP_TOKEN || '';
const MAX_BODY = 35 * 1024 * 1024;
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'unkeep.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS instance (id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT);
  CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, note_id TEXT, envelope TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pairing_requests (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, device_name TEXT NOT NULL, public_key TEXT NOT NULL, poll_hash TEXT NOT NULL, response TEXT, device_token TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER);
`);
let instance = db.prepare('SELECT * FROM instance LIMIT 1').get();
if (!instance) {
  db.prepare('INSERT INTO instance (id, initialized) VALUES (?,0)').run(randomUUID());
  instance = db.prepare('SELECT * FROM instance LIMIT 1').get();
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function token() { return randomBytes(32).toString('base64url'); }
function equalSecret(a, b) {
  const x = Buffer.from(a || ''); const y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'unkeep-protocol-version': '1' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function bearer(req) { return (req.headers.authorization || '').match(/^Device (.+)$/)?.[1] || ''; }
function requireDevice(req) {
  const credential = bearer(req); if (!credential) return null;
  return db.prepare('SELECT id,name FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(credential)) || null;
}
function nextRevision() { return Number(db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS value FROM records').get().value); }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/v1/status') return json(res, 200, { protocol: 1, instanceId: instance.id, initialized: Boolean(instance.initialized) });
  if (req.method === 'POST' && url.pathname === '/api/v1/setup/claim') {
    if (instance.initialized) return json(res, 409, { error: 'already_initialized' });
    const supplied = (req.headers.authorization || '').match(/^Setup (.+)$/)?.[1] || '';
    if (!SETUP_TOKEN || !equalSecret(supplied, SETUP_TOKEN)) return json(res, 401, { error: 'invalid_setup_token' });
    const value = await body(req); if (!validId(value.deviceId)) return json(res, 400, { error: 'invalid_device' });
    const credential = token();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT initialized FROM instance').get().initialized) throw Object.assign(new Error('already initialized'), { status: 409 });
      db.prepare('INSERT INTO devices(id,name,token_hash) VALUES (?,?,?)').run(value.deviceId, String(value.name || 'First device').slice(0,100), hash(credential));
      db.prepare('UPDATE instance SET initialized=1').run(); db.exec('COMMIT'); instance = { ...instance, initialized: 1 };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 201, { instanceId: instance.id, deviceCredential: credential });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/pairings') {
    const value = await body(req); if (!validId(value.deviceId) || !value.publicKey) return json(res, 400, { error: 'invalid_pairing' });
    const id = randomUUID(); const pollSecret = token(); const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code; do { code = Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join(''); } while (db.prepare('SELECT 1 FROM pairing_requests WHERE code=?').get(code));
    const expiresAt = Date.now() + 10 * 60_000;
    db.prepare('INSERT INTO pairing_requests(id,code,device_id,device_name,public_key,poll_hash,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, code, value.deviceId, String(value.name || 'New device').slice(0,100), JSON.stringify(value.publicKey), hash(pollSecret), expiresAt);
    return json(res, 201, { requestId: id, code, pollSecret, expiresAt: new Date(expiresAt).toISOString() });
  }
  const pairMatch = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)$/);
  if (pairMatch && req.method === 'GET') {
    const row = db.prepare('SELECT response,device_token,expires_at,consumed_at,poll_hash FROM pairing_requests WHERE id=?').get(pairMatch[1]);
    if (!row || !equalSecret(row.poll_hash, hash(url.searchParams.get('secret') || ''))) return json(res, 404, { error: 'pairing_not_found' });
    if (row.expires_at <= Date.now()) return json(res, 410, { error: 'pairing_expired' });
    return json(res, 200, { response: row.response ? JSON.parse(row.response) : null, deviceCredential: row.device_token, consumed: Boolean(row.consumed_at) });
  }
  if (pairMatch && req.method === 'POST' && url.pathname.endsWith('/consume')) { /* matched below by explicit regex */ }

  const device = requireDevice(req);
  if (!device) return json(res, 401, { error: 'invalid_device_credential' });
  if (req.method === 'GET' && url.pathname === '/api/v1/vault') return json(res, 200, { vaultId: instance.id });
  if (req.method === 'GET' && url.pathname === '/api/v1/devices') {
    return json(res, 200, { devices: db.prepare('SELECT id,name,revoked_at AS revokedAt FROM devices ORDER BY name').all() });
  }
  const revoke = url.pathname.match(/^\/api\/v1\/devices\/([A-Za-z0-9_-]+)$/);
  if (revoke && req.method === 'DELETE') { db.prepare("UPDATE devices SET revoked_at=datetime('now') WHERE id=?").run(revoke[1]); return json(res, 204, {}); }
  if (req.method === 'GET' && url.pathname === '/api/v1/changes') {
    const since = Math.max(0, Number(url.searchParams.get('since') || 0));
    const rows = db.prepare('SELECT kind,id,note_id AS noteId,envelope,deleted,revision FROM records WHERE revision>? ORDER BY revision LIMIT 1000').all(since).map(r => ({ ...r, envelope: JSON.parse(r.envelope), deleted: Boolean(r.deleted) }));
    const cursor = rows.reduce((n, r) => Math.max(n, Number(r.revision)), since);
    return json(res, 200, { changes: rows, cursor });
  }
  const record = url.pathname.match(/^\/api\/v1\/(notes|attachments)\/([A-Za-z0-9_-]+)$/);
  if (record && req.method === 'PUT') {
    const kind = record[1] === 'notes' ? 'note' : 'attachment'; const id = record[2]; const value = await body(req);
    if (!value.envelope || (kind === 'attachment' && !validId(value.noteId))) return json(res, 400, { error: 'invalid_record' });
    const payloadHash = hash(JSON.stringify(value)); const mutationId = String(value.mutationId || randomUUID());
    const prior = db.prepare('SELECT payload_hash,revision FROM mutations WHERE id=?').get(mutationId);
    if (prior) return prior.payload_hash === payloadHash ? json(res, 200, { revision: prior.revision }) : json(res, 409, { error: 'mutation_conflict' });
    db.exec('BEGIN IMMEDIATE'); let revision;
    try { revision = nextRevision(); db.prepare('INSERT INTO records(kind,id,note_id,envelope,deleted,revision) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET note_id=excluded.note_id,envelope=excluded.envelope,deleted=excluded.deleted,revision=excluded.revision').run(kind,id,value.noteId || null,JSON.stringify(value.envelope),value.deleted ? 1 : 0,revision); db.prepare('INSERT INTO mutations(id,payload_hash,revision) VALUES(?,?,?)').run(mutationId,payloadHash,revision); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 200, { revision });
  }
  if (record && req.method === 'GET' && record[1] === 'attachments') {
    const row = db.prepare("SELECT note_id AS noteId,envelope,deleted,revision FROM records WHERE kind='attachment' AND id=?").get(record[2]);
    if (!row) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { ...row, envelope: JSON.parse(row.envelope), deleted: Boolean(row.deleted) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/v1/pairings/code/')) {
    const code = url.pathname.split('/').pop().toUpperCase(); const row = db.prepare('SELECT id,device_id AS deviceId,device_name AS deviceName,public_key AS publicKey,expires_at AS expiresAt,response FROM pairing_requests WHERE code=?').get(code);
    if (!row || row.expiresAt <= Date.now() || row.response) return json(res, 404, { error: 'pairing_not_found' });
    return json(res, 200, { ...row, publicKey: JSON.parse(row.publicKey), expiresAt: new Date(row.expiresAt).toISOString() });
  }
  const approve = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)\/approve$/);
  if (approve && req.method === 'POST') {
    const value = await body(req); const credential = token();
    const row = db.prepare('SELECT device_id,device_name,expires_at,response FROM pairing_requests WHERE id=?').get(approve[1]);
    if (!row || row.expires_at <= Date.now() || row.response) return json(res, 409, { error: 'pairing_unavailable' });
    db.exec('BEGIN IMMEDIATE');
    try { db.prepare('INSERT OR REPLACE INTO devices(id,name,token_hash,revoked_at) VALUES(?,?,?,NULL)').run(row.device_id,row.device_name,hash(credential)); db.prepare('UPDATE pairing_requests SET response=?,device_token=? WHERE id=? AND response IS NULL').run(JSON.stringify(value.response),credential,approve[1]); db.exec('COMMIT'); }
    catch(error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 200, { approved: true });
  }
  const consume = url.pathname.match(/^\/api\/v1\/pairings\/([0-9a-f-]+)\/consume$/);
  if (consume && req.method === 'POST') { db.prepare('UPDATE pairing_requests SET consumed_at=? WHERE id=?').run(Date.now(),consume[1]); return json(res, 200, { consumed: true }); }
  return json(res, 404, { error: 'not_found' });
}

const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' };
function staticFile(req, res, url) {
  let path = resolve(WEB_DIR, '.' + decodeURIComponent(url.pathname));
  if (!path.startsWith(WEB_DIR + sep) && path !== WEB_DIR) return false;
  try { if (statSync(path).isDirectory()) path = join(path,'index.html'); const data = readFileSync(path); res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream'}); res.end(data); return true; } catch {}
  try { const data=readFileSync(join(WEB_DIR,'index.html')); res.writeHead(200,{'content-type':mime['.html']}); res.end(data); return true; } catch { return false; }
}

export const server = createServer(async (req,res) => {
  res.setHeader('x-content-type-options','nosniff'); res.setHeader('referrer-policy','no-referrer');
  res.setHeader('access-control-allow-origin', process.env.UNKEEP_ALLOWED_ORIGIN || '*');
  res.setHeader('access-control-allow-headers','authorization,content-type');
  res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  try { const url=new URL(req.url || '/',`http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) await api(req,res,url); else if (!staticFile(req,res,url)) json(res,404,{error:'not_found'}); }
  catch(error) { console.error(error); json(res,error.status||500,{error:error.status ? error.message : 'internal_error'}); }
});
if (process.env.NODE_ENV !== 'test') server.listen(PORT,()=>console.log(`UnKeep listening on http://0.0.0.0:${PORT}`));
