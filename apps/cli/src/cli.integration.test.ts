import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { startTestServer, type TestServer } from '@unkeep/server/test';
import {
  approvePairingCode,
  DeviceKeyStore,
  EncryptedSync,
  MemoryClientStorage,
  RelayClient,
  type RelaySession,
} from '@unkeep/client';
import { encryptNote, type NoteAttachment } from '@unkeep/core';
import {
  MAX_ATTACHMENT_SIZE,
  MAX_STDIN_CONTENT_LENGTH,
  runCli,
  type CliInput,
  type CliOutput,
} from './cli.js';
import { encodeVaultKey } from './config.js';
import { stageClipFile } from './clipStaging.js';
import { JsonFileClientStorage } from './storage.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

class Capture implements CliOutput {
  value = '';

  constructor(readonly isTTY = false) {}

  write(value: string): boolean {
    this.value += value;
    return true;
  }
}

function input(value = '', isTTY = false): CliInput {
  const stream = Readable.from(value ? [value] : []) as Readable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return stream as CliInput;
}

async function firstDevice(relay: TestServer): Promise<{ session: RelaySession; masterKey: Uint8Array<ArrayBuffer> }> {
  const relayClient = new RelayClient(relay.endpoint);
  const status = await relayClient.status();
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const provisioned = await keys.provisionFirstDevice(status.instanceId);
  const claimed = await relayClient.claimSetup(
    relay.setupToken,
    status.instanceId,
    provisioned.deviceId,
    'CLI test owner',
  );
  expect(claimed.instanceId).toBe(status.instanceId);
  return {
    masterKey: provisioned.masterKey,
    session: {
      endpoint: relay.endpoint,
      instanceId: claimed.instanceId,
      deviceId: provisioned.deviceId,
      credential: claimed.deviceCredential,
    },
  };
}

async function testContext(): Promise<{
  relay: TestServer;
  directory: string;
  environment: Record<string, string>;
  session: RelaySession;
  masterKey: Uint8Array<ArrayBuffer>;
}> {
  const relay = await startTestServer();
  cleanups.push(relay.stop);
  const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const { session, masterKey } = await firstDevice(relay);
  return {
    relay,
    directory,
    session,
    masterKey,
    environment: {
      XDG_CONFIG_HOME: directory,
      UNKEEP_ENDPOINT: relay.endpoint,
      UNKEEP_CREDENTIAL: session.credential,
      UNKEEP_VAULT_KEY: encodeVaultKey(masterKey),
    },
  };
}

async function invoke(
  arguments_: string[],
  environment: Record<string, string>,
  options: {
    stdin?: CliInput;
    now?: () => number;
    cwd?: string;
    configDir?: string;
    stdoutIsTTY?: boolean;
    stderrIsTTY?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Capture(options.stdoutIsTTY);
  const stderr = new Capture(options.stderrIsTTY);
  const code = await runCli(arguments_, {
    environment,
    stdin: options.stdin ?? input(),
    stdout,
    stderr,
    now: options.now,
    cwd: options.cwd,
    configDir: options.configDir,
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

test('uses env-only auth for put, list, get, sync, filters, and stable JSON', async () => {
  const context = await testContext();
  let result = await invoke([
    'put', '--id', 'cli-note', '--content', 'encrypted hello', '--title', 'Greeting', '--label', 'work', '--json',
  ], context.environment, { now: () => 100 });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    id: 'cli-note',
    content: 'encrypted hello',
    createdAt: 100,
    updatedAt: 100,
    pinned: false,
    archived: false,
    title: 'Greeting',
    labels: ['work'],
  });

  result = await invoke(['sync', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    cursor: 1,
    pulled: 1,
    deleted: 0,
    quarantined: 0,
  });

  result = await invoke(['list', '--label', 'work', '--search', 'HELLO', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(1);
  expect(JSON.parse(result.stdout)[0].id).toBe('cli-note');

  result = await invoke(['get', 'cli-note', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).content).toBe('encrypted hello');

  result = await invoke([
    'put', 'second-note', 'hidden text', '--label', 'work,old', '--json',
  ], context.environment, { now: () => 200 });
  expect(result.code).toBe(0);
  result = await invoke(['list', '--label', 'old', '-q', 'hidden', '--json'], context.environment);
  expect(JSON.parse(result.stdout).map((note: { id: string }) => note.id)).toEqual(['second-note']);

  const second = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  const pulled = await second.pull();
  expect(pulled.notes.map(note => note.id).sort()).toEqual(['cli-note', 'second-note']);
});

test('surfaces durable poison-note quarantine on JSON and implicit sync commands', async () => {
  const context = await testContext();
  const poisonId = 'cli-poison';
  const poisonPlaintext = 'must-not-appear-in-cli-diagnostics';
  const envelope = await encryptNote({
    id: poisonId,
    content: poisonPlaintext,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
  }, globalThis.crypto.getRandomValues(new Uint8Array(32)), {
    ownerId: context.session.instanceId,
    noteId: poisonId,
  });
  await new RelayClient(context.session.endpoint, context.session.credential).putNote(poisonId, {
    mutationId: globalThis.crypto.randomUUID(),
    baseRevision: 0,
    envelope,
    deleted: false,
    deviceId: context.session.deviceId,
  });

  let result = await invoke(['sync', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ pulled: 0, deleted: 0, quarantined: 1 });
  expect(result.stderr).toContain('1 remote note record is quarantined');
  expect(result.stderr).not.toContain(poisonPlaintext);

  result = await invoke(['list', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(result.stderr).toContain('1 remote note record is quarantined');
});

test('reads put content from stdin and sends failures only to stderr', async () => {
  const context = await testContext();
  let result = await invoke(['put', 'stdin-note'], context.environment, {
    stdin: input('from a pipe\n'),
    now: () => 300,
  });
  expect(result).toEqual({ code: 0, stdout: 'stdin-note\n', stderr: '' });

  result = await invoke(['get', 'stdin-note'], context.environment);
  expect(result).toEqual({ code: 0, stdout: 'from a pipe\n\n', stderr: '' });

  result = await invoke(['get', 'missing-note', '--json'], context.environment);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Note not found: missing-note');

  result = await invoke(['not-a-command'], context.environment);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unknown command');
});

test('escapes terminal controls in interactive human output without changing JSON or piped output', async () => {
  const context = await testContext();
  const hostileTitle = 'status\u001b]52;c;Y2xpcGJvYXJk\u0007\u202Etxt.exe';
  const hostileContent = 'first line\nsecond\tcolumn\u009b31m\u2066hidden\u2069';

  let result = await invoke([
    'put',
    'hostile-terminal-note',
    '--title',
    hostileTitle,
    '--content',
    hostileContent,
    '--json',
  ], context.environment, { stdoutIsTTY: true, now: () => 350 });
  expect(JSON.parse(result.stdout)).toMatchObject({
    title: hostileTitle,
    content: hostileContent,
  });

  result = await invoke(['list'], context.environment, { stdoutIsTTY: true });
  expect(result.stdout).toBe(
    'hostile-terminal-note\t'
    + String.raw`status\u{1b}]52;c;Y2xpcGJvYXJk\u{7}\u{202e}txt.exe`
    + '\n',
  );

  result = await invoke(['get', 'hostile-terminal-note'], context.environment, { stdoutIsTTY: true });
  expect(result.stdout).toBe(String.raw`first line\nsecond\tcolumn\u{9b}31m\u{2066}hidden\u{2069}` + '\n');

  result = await invoke(['get', 'hostile-terminal-note'], context.environment);
  expect(result.stdout).toBe(`${hostileContent}\n`);

  result = await invoke(['get', 'hostile-terminal-note', '--json'], context.environment, { stdoutIsTTY: true });
  expect(JSON.parse(result.stdout).content).toBe(hostileContent);
});

test('creates notes and applies the recoverable Trash lifecycle before permanent deletion', async () => {
  const context = await testContext();
  let result = await invoke(['put', '--content', 'scratch entry', '--json'], context.environment, { now: () => 400 });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const created = JSON.parse(result.stdout) as { id: string; content: string };
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.content).toBe('scratch entry');

  result = await invoke(['put'], context.environment, { stdin: input('piped scratch\n'), now: () => 401 });
  expect(result.code).toBe(0);
  const pipedId = result.stdout.trim();
  expect(pipedId).toMatch(/^[0-9a-f-]{36}$/);

  const splitUnicode = Readable.from([
    Buffer.from([0xf0, 0x9f]),
    Buffer.from([0x8c, 0x8f]),
  ]) as Readable & { isTTY?: boolean };
  splitUnicode.isTTY = false;
  result = await invoke(
    ['put', 'split-unicode', '--json'],
    context.environment,
    { stdin: splitUnicode as CliInput, now: () => 401.5 },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).content).toBe('🌏');

  result = await invoke(
    ['put', 'oversized-stdin'],
    context.environment,
    { stdin: input('x'.repeat(MAX_STDIN_CONTENT_LENGTH + 1)), now: () => 401.75 },
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`${MAX_STDIN_CONTENT_LENGTH}-character note limit`);

  result = await invoke(['delete', created.id, '--json'], context.environment, { now: () => 402 });
  expect(result).toEqual({ code: 0, stdout: `${JSON.stringify({ id: created.id, trashed: true, trashedAt: 402 })}\n`, stderr: '' });

  result = await invoke(['get', created.id], context.environment);
  expect(result).toEqual({ code: 0, stdout: 'scratch entry\n', stderr: '' });

  result = await invoke(['put', created.id, 'must not mutate trash'], context.environment);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('restore it before editing');

  result = await invoke(['delete', created.id], context.environment);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('already in Trash');

  result = await invoke(['list', '--json'], context.environment);
  expect(JSON.parse(result.stdout).map((note: { id: string }) => note.id)).toEqual([
    'split-unicode',
    pipedId,
  ]);

  result = await invoke(['list', '--trash', '--json'], context.environment);
  expect(JSON.parse(result.stdout)).toEqual([
    expect.objectContaining({ id: created.id, trashedAt: 402 }),
  ]);

  result = await invoke(['delete', created.id, '--permanent', '--json'], context.environment, { now: () => 403 });
  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ id: created.id, deleted: true, permanent: true })}\n`,
    stderr: '',
  });

  // Another device sees only the final tombstone, not the recoverable payload.
  const second = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  const pulled = await second.pull();
  expect(pulled.notes.map(note => note.id)).toEqual([pipedId, 'split-unicode']);
  expect(pulled.deletedIds).toContain(created.id);
});

test('restores a trashed note and refuses permanent deletion of an active note', async () => {
  const context = await testContext();
  await invoke(['put', 'restore-me', 'recoverable'], context.environment, { now: () => 500 });
  await invoke(['delete', 'restore-me'], context.environment, { now: () => 501 });

  let result = await invoke(['restore', 'restore-me', '--json'], context.environment, { now: () => 502 });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    id: 'restore-me',
    content: 'recoverable',
    updatedAt: 502,
  });
  expect(JSON.parse(result.stdout)).not.toHaveProperty('trashedAt');

  result = await invoke(['delete', 'restore-me', '--permanent'], context.environment);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('requires the note to be in Trash');
});

test('round-trips the valid __proto__ note ID without corrupting the local cache', async () => {
  const context = await testContext();
  let result = await invoke(
    ['put', '__proto__', '--content', 'prototype-safe note', '--json'],
    context.environment,
    { now: () => 425 },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    id: '__proto__',
    content: 'prototype-safe note',
  });

  result = await invoke(['get', '__proto__', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    id: '__proto__',
    content: 'prototype-safe note',
  });

  // A fresh CLI cache exercises remote-pull assignment as well as local put.
  const secondDirectory = await mkdtemp(join(tmpdir(), 'unkeep-cli-prototype-cache-'));
  cleanups.push(() => rm(secondDirectory, { recursive: true, force: true }));
  const secondEnvironment = {
    ...context.environment,
    XDG_CONFIG_HOME: secondDirectory,
  };
  result = await invoke(['sync', '--json'], secondEnvironment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ pulled: 1 });

  result = await invoke(['list', '--json'], secondEnvironment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    expect.objectContaining({ id: '__proto__', content: 'prototype-safe note' }),
  ]);

  result = await invoke(['delete', '__proto__', '--json'], secondEnvironment, {
    now: () => 426,
  });
  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ id: '__proto__', trashed: true, trashedAt: 426 })}\n`,
    stderr: '',
  });

  result = await invoke(['list', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
});

test('persists pulled record revisions across invocations before editing a remote note', async () => {
  const context = await testContext();
  const remote = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  await remote.push({
    id: 'remote-edit',
    content: 'created remotely',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
  });

  let result = await invoke(['sync', '--json'], context.environment);
  expect(result.code).toBe(0);
  result = await invoke(['put', 'remote-edit', '--content', 'edited by a later CLI process'], context.environment, {
    now: () => 2,
  });
  expect(result).toEqual({ code: 0, stdout: 'remote-edit\n', stderr: '' });

  const current = await new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage()).pull();
  expect(current.notes[0].content).toBe('edited by a later CLI process');
});

test('never sends a stored bearer credential to an endpoint-only override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-endpoint-binding-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const configDirectory = join(directory, 'unkeep');
  await mkdir(configDirectory, { recursive: true });
  const storedCredential = 'stored-device-credential-must-not-leave';
  const storedVaultKey = encodeVaultKey(new Uint8Array(32).fill(1));
  await writeFile(join(configDirectory, 'config.json'), `${JSON.stringify({
    endpoint: 'https://stored-relay.example',
    credential: storedCredential,
    vaultKey: storedVaultKey,
    'unkeep-relay-session': {
      endpoint: 'https://stored-relay.example',
      instanceId: 'stored-instance',
      deviceId: 'stored-device',
      credential: storedCredential,
    },
  })}\n`);

  const capturedAuthorization: Array<string | undefined> = [];
  const capture = createServer((request, response) => {
    capturedAuthorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/status') {
      response.end(JSON.stringify({
        protocol: 2,
        instanceId: 'capture-instance',
        initialized: true,
      }));
    } else if (request.url === '/api/v1/vault') {
      response.end(JSON.stringify({ vaultId: 'capture-instance' }));
    } else if (request.url === '/api/v1/changes?since=0') {
      response.end(JSON.stringify({ changes: [], cursor: 0 }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    capture.once('error', reject);
    capture.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    capture.close(error => error ? reject(error) : resolve());
  }));
  const address = capture.address();
  if (!address || typeof address === 'string') throw new Error('Capture server did not bind TCP');
  const endpoint = `http://127.0.0.1:${address.port}`;

  let result = await invoke(
    ['list', '--endpoint', endpoint],
    { XDG_CONFIG_HOME: directory },
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Relay endpoint differs from the stored profile');
  expect(capturedAuthorization).toEqual([]);

  const explicitCredential = 'explicit-credential-for-capture';
  result = await invoke(
    [
      'list',
      '--endpoint',
      endpoint,
      '--credential',
      explicitCredential,
      '--vault-key',
      encodeVaultKey(new Uint8Array(32).fill(2)),
    ],
    { XDG_CONFIG_HOME: directory },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(capturedAuthorization.length).toBeGreaterThan(0);
  expect(capturedAuthorization).not.toContain(`Device ${storedCredential}`);
  expect(new Set(capturedAuthorization)).toEqual(new Set([`Device ${explicitCredential}`]));
});

test('applies an attachment-only tombstone on a later page before acknowledging it', async () => {
  const context = await testContext();
  const remote = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  const attachment = {
    id: 'later-page-attachment',
    name: 'later-page.txt',
    mimeType: 'text/plain',
    size: 4,
  };
  const handle = await remote.commitNoteWithAttachments({
    id: 'attachment-owner',
    content: 'attachment metadata must follow its tombstone',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    images: [attachment],
  }, [{ attachment, bytes: new TextEncoder().encode('data') }]);
  await remote.completeCompoundCommit(handle);

  let result = await invoke(['sync', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ cursor: 2, pulled: 1 });

  const realFetch = globalThis.fetch.bind(globalThis);
  const requestedCursors: number[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (requestUrl.pathname !== '/api/v1/changes') return realFetch(input, init);
    const since = Number(requestUrl.searchParams.get('since'));
    requestedCursors.push(since);
    if (since === 2) {
      return Response.json({
        changes: [{
          kind: 'attachment',
          id: 'unrelated-page-boundary',
          noteId: 'unrelated-owner',
          deleted: false,
          revision: 3,
        }],
        cursor: 3,
      });
    }
    if (since === 3) {
      return Response.json({
        changes: [{
          kind: 'attachment',
          id: attachment.id,
          noteId: 'attachment-owner',
          deleted: true,
          revision: 4,
        }],
        cursor: 4,
      });
    }
    return Response.json({ changes: [], cursor: since });
  });

  result = await invoke(['sync', '--json'], context.environment);
  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({
      cursor: 4,
      pulled: 0,
      deleted: 0,
      quarantined: 0,
    })}\n`,
    stderr: '',
  });
  expect(requestedCursors).toEqual([2, 3, 4]);

  result = await invoke(['clip', '--list', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
});

test('login pairs as a normal device and persists reusable state', async () => {
  const context = await testContext();
  const stdout = new Capture(true);
  const stderr = new Capture(true);
  const code = await runCli(['login', '--endpoint', context.relay.endpoint, '--json'], {
    environment: { XDG_CONFIG_HOME: context.directory },
    stdin: input('', true),
    stdout,
    stderr,
    onPairingCode: code => approvePairingCode(context.session, code, context.masterKey),
  });
  expect(code).toBe(0);
  expect(stderr.value).toMatch(/Pairing code: [A-Z2-9]{8}/);
  expect(stderr.value).toMatch(/Pairing fingerprint: [A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}/);
  expect(stderr.value).toContain('Verify the fingerprint exactly matches the approving device.');
  expect(JSON.parse(stdout.value)).toMatchObject({ endpoint: context.relay.endpoint.replace('/api/v1', ''), paired: true });

  const persisted = JSON.parse(await readFile(join(context.directory, 'unkeep', 'config.json'), 'utf8'));
  expect(persisted.credential).toBeTruthy();
  expect(persisted.vaultKey).toBe(encodeVaultKey(context.masterKey));
  expect(persisted['unkeep-relay-session'].deviceId).toBe(persisted['unkeep-cli-device-id']);

  const reused = await invoke(['sync', '--json'], { XDG_CONFIG_HOME: context.directory });
  expect(reused.code).toBe(0);
  expect(reused.stderr).toBe('');
});

test('login preserves atomic local access and resumes after a lost consume response', async () => {
  const context = await testContext();
  const stdout = new Capture(true);
  const stderr = new Capture(true);
  const realFetch = globalThis.fetch.bind(globalThis);
  let loseConsumeResponse = true;
  let loseActiveDeviceCheck = true;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (loseConsumeResponse && url.endsWith('/consume')) {
      loseConsumeResponse = false;
      const accepted = await realFetch(input, init);
      await accepted.arrayBuffer();
      throw new TypeError('consume response lost');
    }
    if (loseActiveDeviceCheck && url.endsWith('/devices')) {
      loseActiveDeviceCheck = false;
      throw new TypeError('verification connection lost');
    }
    return realFetch(input, init);
  });

  const code = await runCli(['login', '--endpoint', context.relay.endpoint, '--json'], {
    environment: { XDG_CONFIG_HOME: context.directory },
    stdin: input('', true),
    stdout,
    stderr,
    onPairingCode: pairingCode => approvePairingCode(
      context.session,
      pairingCode,
      context.masterKey,
    ),
  });
  expect(code).toBe(0);
  expect(stderr.value).toContain(
    'Pairing is saved locally; server finalization will retry on the next command.',
  );

  const path = join(context.directory, 'unkeep', 'config.json');
  let persisted = JSON.parse(await readFile(path, 'utf8'));
  expect(persisted.vaultKey).toBe(encodeVaultKey(context.masterKey));
  expect(persisted.credential).toBeTruthy();
  expect(persisted['unkeep-relay-session']).toMatchObject({
    credential: persisted.credential,
    pendingPairingRequestId: expect.any(String),
  });

  fetchSpy.mockRestore();
  const resumed = await invoke(['sync', '--json'], { XDG_CONFIG_HOME: context.directory });
  expect(resumed.code).toBe(0);
  expect(resumed.stderr).toBe('');
  persisted = JSON.parse(await readFile(path, 'utf8'));
  expect(persisted['unkeep-relay-session']).not.toHaveProperty('pendingPairingRequestId');
});

test('login refuses to prompt when stdio is not a TTY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-nontty-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const result = await invoke(['login', '--endpoint', 'http://localhost:3000'], { XDG_CONFIG_HOME: directory });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('interactive terminal');
});

test('provisions env-only agents, lists credentials, and revokes access on the next request', async () => {
  const context = await testContext();
  const freshConfig = await mkdtemp(join(tmpdir(), 'unkeep-cli-agent-'));
  const readOnlyConfig = await mkdtemp(join(tmpdir(), 'unkeep-cli-read-only-agent-'));
  cleanups.push(() => rm(freshConfig, { recursive: true, force: true }));
  cleanups.push(() => rm(readOnlyConfig, { recursive: true, force: true }));

  let result = await invoke(['provision', '--name', 'JSON agent', '--scope', 'read-write', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const bundle = JSON.parse(result.stdout) as Record<string, string>;
  expect(bundle).toEqual({
    UNKEEP_ENDPOINT: new URL(context.relay.endpoint).origin,
    UNKEEP_CREDENTIAL: expect.any(String),
    UNKEEP_VAULT_KEY: encodeVaultKey(context.masterKey),
    UNKEEP_SCOPE: 'read-write',
  });

  result = await invoke(['provision', '--name', 'Env agent'], context.environment);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const envLines = result.stdout.trim().split('\n');
  expect(envLines.map(line => line.slice(0, line.indexOf('=')))).toEqual([
    'UNKEEP_ENDPOINT',
    'UNKEEP_CREDENTIAL',
    'UNKEEP_VAULT_KEY',
    'UNKEEP_SCOPE',
  ]);
  expect(Object.fromEntries(envLines.map(line => line.split('=', 2)))).toMatchObject({
    UNKEEP_ENDPOINT: bundle.UNKEEP_ENDPOINT,
    UNKEEP_VAULT_KEY: bundle.UNKEEP_VAULT_KEY,
    UNKEEP_SCOPE: 'read-only',
  });
  const readOnlyBundle = Object.fromEntries(envLines.map(line => line.split('=', 2)));

  // The new process receives no owner config or pairing state, only the emitted bundle.
  result = await invoke(
    ['put', 'agent-note', '--content', 'written non-interactively', '--json'],
    bundle,
    { configDir: freshConfig, now: () => 700 },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ id: 'agent-note', content: 'written non-interactively' });

  result = await invoke(['get', 'agent-note', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: 'agent-note', content: 'written non-interactively' });

  result = await invoke(['get', 'agent-note', '--json'], readOnlyBundle, { configDir: readOnlyConfig });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ id: 'agent-note', content: 'written non-interactively' });

  result = await invoke(
    ['put', 'read-only-rejection', '--content', 'must not be written', '--json'],
    readOnlyBundle,
    { configDir: readOnlyConfig },
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('service_credential_read_only');

  result = await invoke(
    ['provision', '--name', 'Invalid agent', '--scope', 'admin', '--json'],
    context.environment,
  );
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--scope expects read-only or read-write');

  result = await invoke(['credentials', 'list'], context.environment);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('\tdevice\tCLI test owner\t');
  expect(result.stdout).toContain('\tservice\tJSON agent\t');
  expect(result.stdout).toContain('\tservice\tEnv agent\t');

  result = await invoke(['credentials', 'list', '--json'], context.environment);
  expect(result.code).toBe(0);
  const credentials = JSON.parse(result.stdout) as Array<{
    id: string;
    name: string;
    kind: 'device' | 'service';
    scope?: 'read-only' | 'read-write';
    createdAt?: string;
    revokedAt: string | null;
  }>;
  expect(credentials).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'CLI test owner', kind: 'device', revokedAt: null }),
    expect.objectContaining({ name: 'JSON agent', kind: 'service', scope: 'read-write', createdAt: expect.any(String), revokedAt: null }),
    expect.objectContaining({ name: 'Env agent', kind: 'service', scope: 'read-only', createdAt: expect.any(String), revokedAt: null }),
  ]));
  const service = credentials.find(credential => credential.name === 'JSON agent');
  expect(service).toBeDefined();

  result = await invoke(['credentials', 'revoke', service!.id, '--json'], context.environment);
  expect(result).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ id: service!.id, revoked: true })}\n`,
    stderr: '',
  });

  result = await invoke(['sync', '--json'], bundle, { configDir: freshConfig });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/invalid_(?:device|service)_credential/);

  result = await invoke(['credentials', 'list', '--json'], context.environment);
  const revoked = (JSON.parse(result.stdout) as typeof credentials)
    .find(credential => credential.id === service!.id);
  expect(revoked?.revokedAt).toEqual(expect.any(String));
});

test('replays an exact ordinary note mutation after its original device is revoked', async () => {
  const context = await testContext();
  const replacement = await new RelayClient(context.relay.endpoint).reclaimSetup(
    'test-distinct-recovery-token-00000001',
    context.session.instanceId,
    'replacement-cli-device',
    'Replacement CLI device',
  );
  const replacementClient = new RelayClient(
    context.relay.endpoint,
    replacement.deviceCredential,
  );
  const originalFetch = globalThis.fetch;
  let responseDropped = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const response = await originalFetch(input, init);
    if (
      !responseDropped
      && init?.method === 'PUT'
      && new URL(url).pathname.endsWith('/notes/credential-rotation-note')
    ) {
      responseDropped = true;
      throw new TypeError('simulated lost ordinary mutation response');
    }
    return response;
  });

  const interrupted = await invoke([
    'put',
    '--id',
    'credential-rotation-note',
    '--content',
    'exact ciphertext survives device revocation',
    '--json',
  ], context.environment, { now: () => 700 });
  expect(interrupted.code).toBe(1);
  expect(responseDropped).toBe(true);

  await replacementClient.revokeDevice(context.session.deviceId);
  const recovered = await invoke([
    'put',
    '--id',
    'credential-rotation-note',
    '--content',
    'exact ciphertext survives device revocation',
    '--json',
  ], {
    ...context.environment,
    UNKEEP_CREDENTIAL: replacement.deviceCredential,
  }, { now: () => 800 });
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    id: 'credential-rotation-note',
    content: 'exact ciphertext survives device revocation',
  });

  const reader = new EncryptedSync(
    {
      ...context.session,
      credential: replacement.deviceCredential,
    },
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes).toEqual([
    expect.objectContaining({
      id: 'credential-rotation-note',
      content: 'exact ciphertext survives device revocation',
    }),
  ]);
});

test('atomically rebases a stale ordinary retry after device replacement', async () => {
  const context = await testContext();
  const replacement = await new RelayClient(context.relay.endpoint).reclaimSetup(
    'test-distinct-recovery-token-00000001',
    context.session.instanceId,
    'replacement-rebase-device',
    'Replacement rebase device',
  );
  const replacementSession: RelaySession = {
    ...context.session,
    deviceId: 'replacement-rebase-device',
    credential: replacement.deviceCredential,
  };
  const replacementClient = new RelayClient(
    context.relay.endpoint,
    replacement.deviceCredential,
  );
  const originalFetch = globalThis.fetch;
  let requestBlocked = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (
      !requestBlocked
      && init?.method === 'PUT'
      && new URL(url).pathname.endsWith('/notes/credential-rebase-note')
    ) {
      requestBlocked = true;
      throw new TypeError('simulated failure before ordinary mutation request');
    }
    return originalFetch(input, init);
  });

  const interrupted = await invoke([
    'put',
    '--id',
    'credential-rebase-note',
    '--content',
    'local edit must be atomically rebased',
    '--json',
  ], context.environment, { now: () => 700 });
  expect(interrupted.code).toBe(1);
  expect(requestBlocked).toBe(true);

  await new EncryptedSync(
    replacementSession,
    context.masterKey,
    new MemoryClientStorage(),
  ).push({
    id: 'credential-rebase-note',
    content: 'concurrent remote edit',
    createdAt: 600,
    updatedAt: 600,
    pinned: false,
    archived: false,
  });
  await replacementClient.revokeDevice(context.session.deviceId);

  const recovered = await invoke([
    'put',
    '--id',
    'credential-rebase-note',
    '--content',
    'local edit must be atomically rebased',
    '--json',
  ], {
    ...context.environment,
    UNKEEP_CREDENTIAL: replacement.deviceCredential,
  }, { now: () => 800 });
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    id: 'credential-rebase-note',
    content: 'local edit must be atomically rebased',
  });

  const reader = new EncryptedSync(
    replacementSession,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes).toEqual([
    expect.objectContaining({
      id: 'credential-rebase-note',
      content: 'local edit must be atomically rebased',
    }),
  ]);
});

test('clips binary files and pastes the latest or a selected clip on a second client', async () => {
  const context = await testContext();
  const destination = await mkdtemp(join(tmpdir(), 'unkeep-cli-paste-'));
  cleanups.push(() => rm(destination, { recursive: true, force: true }));
  const secondEnvironment = { ...context.environment, XDG_CONFIG_HOME: destination };
  const firstBytes = Uint8Array.from([0, 255, 1, 128, 10, 13, 0, 42]);
  const latestBytes = new TextEncoder().encode('the newest clip\n');
  const firstPath = join(context.directory, 'payload.bin');
  const latestPath = join(context.directory, 'latest.txt');
  await writeFile(firstPath, firstBytes);
  await writeFile(latestPath, latestBytes);

  let result = await invoke(['clip', firstPath], context.environment, { now: () => 500 });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const firstId = result.stdout.trim();

  result = await invoke(['clip', latestPath, '--json'], context.environment, { now: () => 600 });
  expect(result.code).toBe(0);
  const latestClip = JSON.parse(result.stdout) as { id: string; name: string; mimeType: string; size: number };
  expect(latestClip).toMatchObject({ name: 'latest.txt', mimeType: 'text/plain', size: latestBytes.byteLength });

  const reader = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  const pulled = await reader.pull();
  expect(pulled.notes).toHaveLength(1);
  expect(pulled.notes[0]).toMatchObject({ title: 'Clipboard', labels: ['clipboard'] });
  expect(pulled.notes[0].images?.map(attachment => attachment.id)).toEqual([firstId, latestClip.id]);
  expect(pulled.attachments.map(value => createHash('sha256').update(value.bytes).digest('hex'))).toEqual([
    createHash('sha256').update(firstBytes).digest('hex'),
    createHash('sha256').update(latestBytes).digest('hex'),
  ]);

  result = await invoke(['paste', firstId], secondEnvironment, { cwd: destination });
  expect(result).toEqual({ code: 0, stdout: 'payload.bin\n', stderr: '' });
  expect(createHash('sha256').update(await readFile(join(destination, 'payload.bin'))).digest('hex'))
    .toBe(createHash('sha256').update(firstBytes).digest('hex'));
  expect((await stat(join(destination, 'payload.bin'))).mode & 0o777).toBe(0o600);

  result = await invoke(['paste'], secondEnvironment, { cwd: destination });
  expect(result).toEqual({ code: 0, stdout: 'latest.txt\n', stderr: '' });
  expect(await readFile(join(destination, 'latest.txt'))).toEqual(Buffer.from(latestBytes));

  result = await invoke(['clip', '--list', '--json'], secondEnvironment, { cwd: destination });
  expect(result.code).toBe(0);
  expect((JSON.parse(result.stdout) as Array<{ id: string }>).map(clip => clip.id)).toEqual([latestClip.id, firstId]);

  result = await invoke(['paste', firstId], secondEnvironment, { cwd: destination });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Refusing to overwrite payload.bin');
  await writeFile(join(destination, 'payload.bin'), 'changed');
  result = await invoke(['paste', firstId, '--force'], secondEnvironment, { cwd: destination });
  expect(result.code).toBe(0);
  expect(await readFile(join(destination, 'payload.bin'))).toEqual(Buffer.from(firstBytes));
  expect((await stat(join(destination, 'payload.bin'))).mode & 0o777).toBe(0o600);

  const symlinkTarget = join(destination, 'symlink-target');
  await writeFile(symlinkTarget, 'must remain unchanged');
  await unlink(join(destination, 'latest.txt'));
  await symlink(symlinkTarget, join(destination, 'latest.txt'));
  result = await invoke(['paste', latestClip.id, '--force'], secondEnvironment, { cwd: destination });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Refusing to replace unsafe destination latest.txt');
  expect(await readFile(symlinkTarget, 'utf8')).toBe('must remain unchanged');

  const hardlinkTarget = join(destination, 'hardlink-target');
  await writeFile(hardlinkTarget, 'shared inode must remain unchanged');
  await unlink(join(destination, 'payload.bin'));
  await link(hardlinkTarget, join(destination, 'payload.bin'));
  result = await invoke(['paste', firstId, '--force'], secondEnvironment, { cwd: destination });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Refusing to replace unsafe destination payload.bin');
  expect(await readFile(hardlinkTarget, 'utf8')).toBe('shared inode must remain unchanged');
});

test.each([
  ['attachment stage acknowledgement', '/api/v1/note-mutations/'],
  ['atomic Clipboard bundle acknowledgement', '/api/v1/notes/unkeep-clipboard/compound'],
])('recovers a clip after losing the %s response', async (_description, targetPath) => {
  const context = await testContext();
  const source = join(context.directory, 'interrupted.bin');
  const bytes = new TextEncoder().encode('survives a lost response');
  await writeFile(source, bytes);
  const originalFetch = globalThis.fetch;
  let responseDropped = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const response = await originalFetch(input, init);
    if (
      !responseDropped
      && (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'PUT'
      && new URL(url).pathname.startsWith(targetPath)
    ) {
      responseDropped = true;
      throw new TypeError('simulated lost mutation response');
    }
    return response;
  });

  const interrupted = await invoke(
    ['clip', source, '--json'],
    context.environment,
    { now: () => 700 },
  );
  expect(interrupted.code).toBe(1);
  expect(interrupted.stdout).toBe('');
  expect(responseDropped).toBe(true);

  vi.stubGlobal('fetch', originalFetch);
  const recovered = await invoke(
    ['clip', '--list', '--json'],
    context.environment,
  );
  expect(recovered.code).toBe(0);
  expect(recovered.stderr).toContain('Recovered interrupted clip');
  const listed = JSON.parse(recovered.stdout) as NoteAttachment[];
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: 'interrupted.bin',
    size: bytes.byteLength,
  });

  const reader = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes[0].images?.map(value => value.id)).toEqual([listed[0].id]);
  expect(pulled.attachments).toHaveLength(1);
  expect(pulled.attachments[0].bytes).toEqual(bytes);
  expect(
    await readdir(join(context.directory, 'unkeep', 'clip-staging')),
  ).toEqual([]);

  const nextSource = join(context.directory, 'next-after-recovery.txt');
  await writeFile(nextSource, 'a later clip must not be blocked by the replay root');
  const next = await invoke(['clip', nextSource, '--json'], context.environment);
  expect(next.code).toBe(0);
  expect(next.stderr).toBe('');
});

test('an invalid replacement credential cannot erase an exact pending clip retry', async () => {
  const context = await testContext();
  const source = join(context.directory, 'credential-bound.txt');
  await writeFile(source, 'the encrypted retry survives without this private file');
  const originalFetch = globalThis.fetch;
  let finalRequestBlocked = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (
      !finalRequestBlocked
      && init?.method === 'PUT'
      && new URL(url).pathname.endsWith('/notes/unkeep-clipboard/compound')
    ) {
      finalRequestBlocked = true;
      throw new TypeError('simulated crash before final request');
    }
    return originalFetch(input, init);
  });

  const interrupted = await invoke(['clip', source, '--json'], context.environment);
  expect(interrupted.code).toBe(1);
  expect(finalRequestBlocked).toBe(true);

  const stagingDirectory = join(context.directory, 'unkeep', 'clip-staging');
  const stagedFiles = await readdir(stagingDirectory);
  expect(stagedFiles).toHaveLength(1);
  await unlink(join(stagingDirectory, stagedFiles[0]!));

  const configPath = join(context.directory, 'unkeep', 'config.json');
  const pendingSnapshot = async () => Object.fromEntries(
    Object.entries(JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>)
      .filter(([key]) => key.startsWith('unkeep-pending-compound')),
  );
  const beforeInvalidCredential = await pendingSnapshot();
  expect(Object.keys(beforeInvalidCredential).length).toBeGreaterThan(0);

  const rejected = await invoke(['clip', '--list', '--json'], {
    ...context.environment,
    UNKEEP_CREDENTIAL: 'invalid-replacement-credential',
  });
  expect(rejected.code).toBe(1);
  expect(rejected.stdout).toBe('');
  expect(rejected.stderr).toMatch(/invalid_(?:device|service)_credential/);
  expect(await pendingSnapshot()).toEqual(beforeInvalidCredential);

  const recovered = await invoke(['clip', '--list', '--json'], context.environment);
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.stderr).toContain('Recovered interrupted clip');
  expect(JSON.parse(recovered.stdout)).toEqual([
    expect.objectContaining({ name: 'credential-bound.txt' }),
  ]);
});

test('a valid replacement credential rebuilds an interrupted clip in the same invocation', async () => {
  const context = await testContext();
  const replacement = await new RelayClient(
    context.session.endpoint,
    context.session.credential,
  ).mintServiceCredential('Rotated CLI credential', 'read-write');
  const source = join(context.directory, 'credential-rotation.txt');
  const bytes = new TextEncoder().encode('rebuild this exact private clip');
  await writeFile(source, bytes);
  const originalFetch = globalThis.fetch;
  let finalRequestBlocked = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (
      !finalRequestBlocked
      && init?.method === 'PUT'
      && new URL(url).pathname.endsWith('/notes/unkeep-clipboard/compound')
    ) {
      finalRequestBlocked = true;
      throw new TypeError('simulated crash before final request');
    }
    return originalFetch(input, init);
  });

  const interrupted = await invoke(['clip', source, '--json'], context.environment);
  expect(interrupted.code).toBe(1);
  expect(finalRequestBlocked).toBe(true);

  const originalAbandon =
    EncryptedSync.prototype.abandonPendingCompoundAfterCredentialChange;
  let prePersistenceCrash = false;
  const abandonment = vi.spyOn(
    EncryptedSync.prototype,
    'abandonPendingCompoundAfterCredentialChange',
  ).mockImplementation(async function (
    this: EncryptedSync,
    noteId: string,
  ) {
    const abandoned = await originalAbandon.call(this, noteId);
    if (abandoned && !prePersistenceCrash) {
      prePersistenceCrash = true;
      throw new Error('simulated crash before replacement intent persistence');
    }
    return abandoned;
  });
  const prePersistence = await invoke(['clip', '--list', '--json'], {
    ...context.environment,
    UNKEEP_CREDENTIAL: replacement.serviceCredential,
  });
  expect(prePersistence.code).toBe(1);
  expect(prePersistence.stderr).toContain(
    'simulated crash before replacement intent persistence',
  );
  expect(prePersistenceCrash).toBe(true);
  abandonment.mockRestore();

  const originalSet = JsonFileClientStorage.prototype.set;
  let replacementIntentCrash = false;
  const persistence = vi.spyOn(JsonFileClientStorage.prototype, 'set')
    .mockImplementation(async function (
      this: JsonFileClientStorage,
      key: string,
      value: unknown,
    ) {
      await originalSet.call(this, key, value);
      if (
        !replacementIntentCrash
        && key.startsWith('unkeep-cli-pending-clip:')
        && !!value
        && typeof value === 'object'
        && (value as { version?: unknown }).version === 2
      ) {
        replacementIntentCrash = true;
        throw new Error('simulated crash after replacement intent persistence');
      }
    });
  const crashed = await invoke(['clip', '--list', '--json'], {
    ...context.environment,
    UNKEEP_CREDENTIAL: replacement.serviceCredential,
  });
  expect(crashed.code).toBe(1);
  expect(crashed.stderr).toContain('simulated crash after replacement intent persistence');
  expect(replacementIntentCrash).toBe(true);

  persistence.mockRestore();
  const recovered = await invoke(['clip', '--list', '--json'], {
    ...context.environment,
    UNKEEP_CREDENTIAL: replacement.serviceCredential,
  });
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.stderr).toContain('Recovered interrupted clip');
  const listed = JSON.parse(recovered.stdout) as NoteAttachment[];
  expect(listed).toEqual([
    expect.objectContaining({ name: 'credential-rotation.txt', size: bytes.byteLength }),
  ]);

  const reader = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes[0].images?.map(value => value.id)).toEqual([listed[0]!.id]);
  expect(pulled.attachments[0]?.bytes).toEqual(bytes);
});

test('recovers a terminal pending clip conflict in the same invocation', async () => {
  const context = await testContext();
  const source = join(context.directory, 'terminal-conflict.txt');
  await writeFile(source, 'local bytes survive a terminal replay conflict');
  const originalFetch = globalThis.fetch;
  let finalRequestBlocked = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (
      !finalRequestBlocked
      && init?.method === 'PUT'
      && new URL(url).pathname.endsWith('/notes/unkeep-clipboard/compound')
    ) {
      finalRequestBlocked = true;
      throw new TypeError('simulated crash before final request');
    }
    return originalFetch(input, init);
  });

  const interrupted = await invoke(['clip', source, '--json'], context.environment);
  expect(interrupted.code).toBe(1);
  expect(finalRequestBlocked).toBe(true);

  const other = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  await other.push({
    id: 'unkeep-clipboard',
    title: 'Concurrent Clipboard title',
    content: 'Concurrent fields survive the retry.',
    createdAt: 100,
    updatedAt: 200,
    pinned: true,
    archived: false,
    labels: ['remote'],
  });

  const recovered = await invoke(['clip', '--list', '--json'], context.environment);
  expect(recovered.code, recovered.stderr).toBe(0);
  const listed = JSON.parse(recovered.stdout) as NoteAttachment[];
  expect(listed).toEqual([
    expect.objectContaining({ name: 'terminal-conflict.txt' }),
  ]);

  const reader = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes[0]).toMatchObject({
    title: 'Concurrent Clipboard title',
    content: 'Concurrent fields survive the retry.',
    pinned: true,
    labels: expect.arrayContaining(['remote']),
  });
  expect(pulled.notes[0].images?.map(value => value.id)).toEqual([listed[0]!.id]);
});

test('recovers a committed clip after the local cache and intent transaction fails', async () => {
  const context = await testContext();
  const source = join(context.directory, 'cache-crash.txt');
  await writeFile(source, 'relay commit must survive a local cache crash');
  const transaction = vi.spyOn(JsonFileClientStorage.prototype, 'setAndDelete')
    .mockRejectedValueOnce(new Error('simulated cache transaction crash'));

  const interrupted = await invoke(['clip', source, '--json'], context.environment);
  expect(interrupted.code).toBe(1);
  expect(interrupted.stdout).toBe('');
  expect(interrupted.stderr).toContain('simulated cache transaction crash');

  transaction.mockRestore();
  const recovered = await invoke(['clip', '--list', '--json'], context.environment);
  expect(recovered.code).toBe(0);
  expect(recovered.stderr).toContain('Recovered interrupted clip');
  expect(JSON.parse(recovered.stdout)).toHaveLength(1);
});

test('verifies relay bytes before recovering a committed handle after its intent was cleared', async () => {
  const context = await testContext();
  const source = join(context.directory, 'handle-crash.txt');
  await writeFile(source, 'handle completion must be replayable');
  const completion = vi.spyOn(EncryptedSync.prototype, 'completeCompoundCommit')
    .mockRejectedValueOnce(new Error('simulated handle completion crash'));

  const interrupted = await invoke(['clip', source, '--json'], context.environment);
  expect(interrupted.code).toBe(1);
  expect(interrupted.stdout).toBe('');
  expect(interrupted.stderr).toContain('simulated handle completion crash');

  completion.mockRestore();
  const wrongBytes = vi.spyOn(EncryptedSync.prototype, 'downloadAttachment')
    .mockResolvedValue(new Uint8Array((await stat(source)).size).fill(0xff));
  const rejected = await invoke(['clip', '--list', '--json'], context.environment);
  expect(rejected.code).toBe(1);
  expect(rejected.stdout).toBe('');
  expect(rejected.stderr).toContain('content does not match the relay attachment');

  wrongBytes.mockRestore();
  const recovered = await invoke(['clip', '--list', '--json'], context.environment);
  expect(recovered.code).toBe(0);
  expect(recovered.stderr).toContain('Recovered interrupted clip');
  expect(JSON.parse(recovered.stdout)).toHaveLength(1);
});

test('sweeps a private clip stage left behind after local completion', async () => {
  const context = await testContext();
  const source = join(context.directory, 'cleanup-crash.txt');
  const bytes = new TextEncoder().encode('completed bytes');
  await writeFile(source, bytes);

  const completed = await invoke(['clip', source, '--json'], context.environment);
  expect(completed.code).toBe(0);
  const attachment = JSON.parse(completed.stdout) as NoteAttachment;
  const stagingDirectory = join(context.directory, 'unkeep', 'clip-staging');
  const orphan = join(stagingDirectory, `clip-${attachment.id}.bin`);
  await writeFile(orphan, bytes, { mode: 0o600 });

  const listed = await invoke(['clip', '--list', '--json'], context.environment);
  expect(listed.code).toBe(0);
  expect(listed.stderr).toBe('');
  expect(await readdir(stagingDirectory)).toEqual([]);
});

test('a missing private stage is discarded without publishing a legacy live attachment', async () => {
  const context = await testContext();
  const source = join(context.directory, 'missing-stage.txt');
  await writeFile(source, 'bytes that cannot be recovered');
  const configPath = join(context.directory, 'unkeep', 'config.json');
  const storage = new JsonFileClientStorage(configPath);
  const attachment: NoteAttachment = {
    id: globalThis.crypto.randomUUID(),
    name: 'missing-stage.txt',
    mimeType: 'text/plain',
    size: (await stat(source)).size,
  };
  const staged = await stageClipFile(
    storage,
    source,
    attachment.name,
    attachment.id,
    MAX_ATTACHMENT_SIZE,
  );
  await storage.set(
    `unkeep-cli-pending-clip:${encodeURIComponent(context.session.instanceId)}`,
    { version: 1, attachment, staged, timestamp: 900 },
  );
  await unlink(join(
    context.directory,
    'unkeep',
    'clip-staging',
    staged.fileName,
  ));

  const recovered = await invoke(
    ['clip', '--list', '--json'],
    context.environment,
  );
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.stdout)).toEqual([]);
  expect(recovered.stderr).toContain('Discarded interrupted clip');

  const reader = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes[0].images).toBeUndefined();
  expect(pulled.attachments).toEqual([]);
  expect(pulled.deletedAttachments).toEqual([]);
});

test('merges a concurrent Clipboard edit after its first note push conflicts', async () => {
  const context = await testContext();
  const source = join(context.directory, 'local.txt');
  await writeFile(source, 'local bytes');
  const originalFetch = globalThis.fetch;
  const other = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const otherAttachment: NoteAttachment = {
    id: 'other-clip',
    name: 'other.txt',
    mimeType: 'text/plain',
    size: 11,
  };
  let concurrentWriteInjected = false;

  vi.stubGlobal('fetch', async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const response = await originalFetch(input, init);
    if (
      !concurrentWriteInjected
      && init?.method === 'PUT'
      && new URL(url).pathname.includes('/attachments/')
    ) {
      concurrentWriteInjected = true;
      const otherHandle = await other.commitNoteWithAttachments({
        id: 'unkeep-clipboard',
        title: 'Clipboard from another device',
        content: 'Concurrent fields must survive.',
        createdAt: 400,
        updatedAt: 800,
        pinned: true,
        archived: false,
        labels: ['remote'],
        images: [otherAttachment],
      }, [{
        attachment: otherAttachment,
        bytes: new TextEncoder().encode('other bytes'),
      }]);
      await other.completeCompoundCommit(otherHandle);
    }
    return response;
  });

  const result = await invoke(
    ['clip', source, '--json'],
    context.environment,
    { now: () => 500 },
  );
  expect(result.code, result.stderr).toBe(0);
  expect(concurrentWriteInjected).toBe(true);
  const localAttachment = JSON.parse(result.stdout) as NoteAttachment;

  vi.stubGlobal('fetch', originalFetch);
  const reader = new EncryptedSync(
    context.session,
    context.masterKey,
    new MemoryClientStorage(),
  );
  const pulled = await reader.pull();
  expect(pulled.notes[0]).toMatchObject({
    title: 'Clipboard from another device',
    content: 'Concurrent fields must survive.',
    pinned: true,
  });
  expect(pulled.notes[0].images?.map(value => value.id)).toEqual([
    otherAttachment.id,
    localAttachment.id,
  ]);
  expect(pulled.attachments).toHaveLength(2);
});

test('rejects an oversized clip before reading or uploading it', async () => {
  const context = await testContext();
  const oversizedPath = join(context.directory, 'oversized.bin');
  await writeFile(oversizedPath, '');
  await truncate(oversizedPath, MAX_ATTACHMENT_SIZE + 1);

  const result = await invoke(['clip', oversizedPath], context.environment);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('oversized.bin is too large. Attachments must be 25 MB or smaller.');

  const reader = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  await expect(reader.pull()).resolves.toMatchObject({ notes: [], attachments: [] });

  const target = join(context.directory, 'private-target.txt');
  const symbolicLink = join(context.directory, 'linked.txt');
  await writeFile(target, 'must not be followed');
  await symlink(target, symbolicLink);
  const linked = await invoke(['clip', symbolicLink], context.environment);
  expect(linked.code).toBe(1);
  expect(linked.stderr).toContain('Refusing to clip a symbolic link');
  await expect(reader.pull()).resolves.toMatchObject({ notes: [], attachments: [] });
});
