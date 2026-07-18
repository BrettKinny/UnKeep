import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { startTestServer, type TestServer } from '@unkeep/server/test';
import {
  approvePairingCode,
  DeviceKeyStore,
  EncryptedSync,
  MemoryClientStorage,
  RelayClient,
  type RelaySession,
} from '@unkeep/client';
import { MAX_ATTACHMENT_SIZE, runCli, type CliInput, type CliOutput } from './cli.js';
import { encodeVaultKey } from './config.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
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
  const keys = new DeviceKeyStore(new MemoryClientStorage());
  const provisioned = await keys.provisionFirstDevice();
  const claimed = await new RelayClient(relay.endpoint).claimSetup(
    relay.setupToken,
    provisioned.deviceId,
    'CLI test owner',
  );
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
  options: { stdin?: CliInput; now?: () => number; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runCli(arguments_, {
    environment,
    stdin: options.stdin ?? input(),
    stdout,
    stderr,
    now: options.now,
    cwd: options.cwd,
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
  expect(JSON.parse(result.stdout)).toEqual({ cursor: 1, pulled: 1, deleted: 0 });

  result = await invoke(['list', '--label', 'work', '--search', 'HELLO', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(1);
  expect(JSON.parse(result.stdout)[0].id).toBe('cli-note');

  result = await invoke(['get', 'cli-note', '--json'], context.environment);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).content).toBe('encrypted hello');

  result = await invoke([
    'put', 'archived-note', 'hidden text', '--label', 'work,old', '--archived', '--json',
  ], context.environment, { now: () => 200 });
  expect(result.code).toBe(0);
  result = await invoke(['list', '--archived', '--label', 'old', '-q', 'hidden', '--json'], context.environment);
  expect(JSON.parse(result.stdout).map((note: { id: string }) => note.id)).toEqual(['archived-note']);

  const second = new EncryptedSync(context.session, context.masterKey, new MemoryClientStorage());
  const pulled = await second.pull();
  expect(pulled.notes.map(note => note.id).sort()).toEqual(['archived-note', 'cli-note']);
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
  expect(JSON.parse(stdout.value)).toMatchObject({ endpoint: context.relay.endpoint.replace('/api/v1', ''), paired: true });

  const persisted = JSON.parse(await readFile(join(context.directory, 'unkeep', 'config.json'), 'utf8'));
  expect(persisted.credential).toBeTruthy();
  expect(persisted.vaultKey).toBe(encodeVaultKey(context.masterKey));
  expect(persisted['unkeep-relay-session'].deviceId).toBe(persisted['unkeep-cli-device-id']);

  const reused = await invoke(['sync', '--json'], { XDG_CONFIG_HOME: context.directory });
  expect(reused.code).toBe(0);
  expect(reused.stderr).toBe('');
});

test('login refuses to prompt when stdio is not a TTY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-nontty-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const result = await invoke(['login', '--endpoint', 'http://localhost:3000'], { XDG_CONFIG_HOME: directory });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('interactive terminal');
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
});
