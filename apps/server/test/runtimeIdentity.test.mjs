import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adoptDataDirectory,
  dropPrivileges,
  resolveRuntimeIdentity,
} from '../src/runtimeIdentity.mjs';

test('keeps a non-root identity and rejects PUID/PGID it cannot honour', () => {
  assert.equal(resolveRuntimeIdentity({}, { uid: 1000, gid: 1000 }), null);
  assert.equal(resolveRuntimeIdentity({ PUID: '1000', PGID: '1000' }, { uid: 1000, gid: 1000 }), null);
  assert.throws(
    () => resolveRuntimeIdentity({ PUID: '99', PGID: '100' }, { uid: 1000, gid: 1000 }),
    /only take effect when the container starts as root/,
  );
});

test('drops root to PUID/PGID, defaulting to the image user', () => {
  assert.deepEqual(resolveRuntimeIdentity({ PUID: '99', PGID: '100' }, { uid: 0, gid: 0 }), { uid: 99, gid: 100 });
  assert.deepEqual(resolveRuntimeIdentity({}, { uid: 0, gid: 0 }), { uid: 1000, gid: 1000 });
});

test('never accepts root or malformed identities', () => {
  for (const value of ['0', '-1', '1.5', ' 99', '99a', '2147483647']) {
    assert.throws(() => resolveRuntimeIdentity({ PUID: value }, { uid: 0, gid: 0 }), /PUID must be an integer/);
    assert.throws(() => resolveRuntimeIdentity({ PGID: value }, { uid: 0, gid: 0 }), /PGID must be an integer/);
  }
});

function fakeFs(entries) {
  const calls = [];
  const fs = {
    mkdirSync: () => {},
    lstatSync: path => {
      const entry = entries[path];
      if (!entry) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
      return { uid: entry.uid, gid: entry.gid, isDirectory: () => Boolean(entry.children) };
    },
    readdirSync: path => {
      if (entries[path].uid !== 0) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return entries[path].children;
    },
    lchownSync: (path, uid, gid) => {
      calls.push(`${path} ${uid}:${gid}`);
      Object.assign(entries[path], { uid, gid });
    },
  };
  return { fs, calls };
}

test('takes each directory over before listing it, without following links', () => {
  const entries = {
    '/data': { uid: 1000, gid: 1000, children: ['unkeep.sqlite', 'nested', 'link'] },
    '/data/unkeep.sqlite': { uid: 1000, gid: 1000 },
    '/data/nested': { uid: 1000, gid: 1000, children: ['file'] },
    '/data/nested/file': { uid: 1000, gid: 1000 },
    '/data/link': { uid: 1000, gid: 1000 },
  };
  const { fs, calls } = fakeFs(entries);
  assert.equal(adoptDataDirectory('/data', { uid: 99, gid: 100 }, fs), true);
  assert.deepEqual(calls, [
    '/data 0:0',
    '/data/unkeep.sqlite 99:100',
    '/data/nested 0:0',
    '/data/nested/file 99:100',
    '/data/nested 99:100',
    '/data/link 99:100',
    '/data 99:100',
  ]);
  for (const entry of Object.values(entries)) assert.deepEqual([entry.uid, entry.gid], [99, 100]);
});

test('leaves an already adopted directory untouched', () => {
  const { fs, calls } = fakeFs({ '/data': { uid: 99, gid: 100, children: [] } });
  assert.equal(adoptDataDirectory('/data', { uid: 99, gid: 100 }, fs), false);
  assert.deepEqual(calls, []);
});

test('explains the missing capability when ownership cannot change', () => {
  const { fs } = fakeFs({ '/data': { uid: 0, gid: 0, children: [] } });
  fs.lchownSync = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); };
  assert.throws(
    () => adoptDataDirectory('/data', { uid: 99, gid: 100 }, fs),
    /UNKEEP_DATA_DIR \/data to UID 99 GID 100 \(EPERM\)\. Starting as root requires --cap-add CHOWN/,
  );
});

function fakeProcess({ failWith } = {}) {
  const state = { uid: 0, gid: 0, groups: [0] };
  return {
    state,
    setgroups: groups => { if (failWith) throw failWith; state.groups = groups; },
    setgid: gid => { state.gid = gid; },
    setuid: uid => { state.uid = uid; },
    getuid: () => state.uid,
    geteuid: () => state.uid,
    getgid: () => state.gid,
    getegid: () => state.gid,
  };
}

test('switches groups, then group, then user', () => {
  const proc = fakeProcess();
  dropPrivileges({ uid: 99, gid: 100 }, proc);
  assert.deepEqual(proc.state, { uid: 99, gid: 100, groups: [100] });
});

test('explains missing SETUID/SETGID capabilities', () => {
  const proc = fakeProcess({ failWith: Object.assign(new Error('not permitted'), { code: 'EPERM' }) });
  assert.throws(
    () => dropPrivileges({ uid: 99, gid: 100 }, proc),
    /\(EPERM\)\. Starting as root requires --cap-add SETUID --cap-add SETGID/,
  );
});
