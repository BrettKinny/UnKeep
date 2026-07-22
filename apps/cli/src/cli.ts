import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  createPairingRequest,
  DeviceKeyStore,
  EncryptedSync,
  MemoryClientStorage,
  RelayClient,
  RelaySessionStore,
  waitForPairing,
  type RelaySession,
} from '@unkeep/client';
import { validateNoteId, type Note, type NoteAttachment } from '@unkeep/core';
import { parseArguments, type ParsedArguments } from './arguments.js';
import {
  decodeVaultKey,
  encodeVaultKey,
  resolveConfiguration,
  unkeepConfigDirectory,
  type FileConfiguration,
  type ResolvedConfiguration,
} from './config.js';
import { HELP, VERSION } from './help.js';
import { JsonFileClientStorage } from './storage.js';

const DEVICE_ID_KEY = 'unkeep-cli-device-id';
const NOTES_PREFIX = 'unkeep-cli-notes:';
const CLIPBOARD_NOTE_ID = 'unkeep-clipboard';
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

export interface CliInput extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
}

export interface CliOutput {
  isTTY?: boolean;
  write(value: string): unknown;
}

export interface RunCliOptions {
  stdin?: CliInput;
  stdout?: CliOutput;
  stderr?: CliOutput;
  environment?: Record<string, string | undefined>;
  configDir?: string;
  signal?: AbortSignal;
  now?: () => number;
  cwd?: string;
  onPairingCode?: (code: string) => void | Promise<void>;
}

interface CommandContext {
  arguments: ParsedArguments;
  storage: JsonFileClientStorage;
  stdin: CliInput;
  stdout: CliOutput;
  stderr: CliOutput;
  environment: Record<string, string | undefined>;
  signal?: AbortSignal;
  now: () => number;
  cwd: string;
  onPairingCode?: (code: string) => void | Promise<void>;
}

interface ConnectedVault {
  session: RelaySession;
  masterKey: Uint8Array<ArrayBuffer>;
  sync: EncryptedSync;
}

interface SyncSummary {
  cursor: number;
  pulled: number;
  deleted: number;
}

interface ProvisioningBundle {
  UNKEEP_ENDPOINT: string;
  UNKEEP_CREDENTIAL: string;
  UNKEEP_VAULT_KEY: string;
}

interface ListedDeviceCredential {
  id: string;
  name: string;
  kind: 'device';
  revokedAt: string | null;
}

interface ListedServiceCredential {
  id: string;
  name: string;
  kind: 'service';
  createdAt: string;
  revokedAt: string | null;
}

type ListedCredential = ListedDeviceCredential | ListedServiceCredential;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireValue(value: string | undefined, description: string): string {
  if (!value) throw new Error(description);
  return value;
}

async function fileConfiguration(storage: JsonFileClientStorage): Promise<FileConfiguration> {
  return await storage.entries() as FileConfiguration;
}

async function configuredRelay(context: CommandContext): Promise<{
  configuration: ResolvedConfiguration;
  relay: RelayClient;
}> {
  const stored = await fileConfiguration(context.storage);
  const configuration = resolveConfiguration(context.arguments, context.environment, stored);
  const endpoint = requireValue(
    configuration.endpoint,
    'Missing relay endpoint; use --endpoint, UNKEEP_ENDPOINT, or endpoint in the config file',
  );
  const credential = requireValue(
    configuration.credential,
    'Missing device credential; use --credential, UNKEEP_CREDENTIAL, or login',
  );
  return { configuration, relay: new RelayClient(endpoint, credential) };
}

async function connectedVault(context: CommandContext): Promise<ConnectedVault> {
  const { configuration, relay } = await configuredRelay(context);
  const masterKey = decodeVaultKey(requireValue(
    configuration.vaultKey,
    'Missing vault key; use --vault-key, UNKEEP_VAULT_KEY, or login',
  ));

  const [status, vault] = await Promise.all([relay.status(), relay.vault()]);
  if (status.instanceId !== vault.vaultId) throw new Error('Relay returned inconsistent vault identity');
  let deviceId = await context.storage.get<string>(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = globalThis.crypto.randomUUID();
    await context.storage.set(DEVICE_ID_KEY, deviceId);
  }
  const session: RelaySession = {
    endpoint: relay.endpoint,
    instanceId: status.instanceId,
    deviceId,
    credential: requireValue(configuration.credential, 'Missing device credential'),
  };
  return { session, masterKey, sync: new EncryptedSync(session, masterKey, context.storage) };
}

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Note>;
  return typeof candidate.id === 'string' && typeof candidate.content === 'string';
}

async function loadNotes(storage: JsonFileClientStorage, instanceId: string): Promise<Record<string, Note>> {
  const value = await storage.get<unknown>(NOTES_PREFIX + instanceId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Note] => isNote(entry[1])));
}

function saveNotes(storage: JsonFileClientStorage, instanceId: string, notes: Record<string, Note>): Promise<void> {
  return storage.set(NOTES_PREFIX + instanceId, notes);
}

async function syncNotes(vault: ConnectedVault, storage: JsonFileClientStorage): Promise<SyncSummary> {
  const notes = await loadNotes(storage, vault.session.instanceId);
  let cursor = await vault.sync.getCursor();
  let pulled = 0;
  let deleted = 0;

  // The relay pages changes at 1,000 rows. Pull until a request no longer advances the cursor.
  for (let page = 0; page < 100; page += 1) {
    const previousCursor = cursor;
    const result = await vault.sync.pull();
    cursor = result.cursor;
    for (const note of result.notes) notes[note.id] = note;
    for (const id of result.deletedIds) delete notes[id];
    pulled += result.notes.length;
    deleted += result.deletedIds.length;
    if (result.notes.length || result.deletedIds.length) {
      await saveNotes(storage, vault.session.instanceId, notes);
    }
    if (cursor === previousCursor) return { cursor, pulled, deleted };
  }
  throw new Error('Sync did not converge after 100 pages');
}

function stableNote(note: Note): Note {
  const result: Note = {
    id: note.id,
    content: note.content,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    pinned: note.pinned,
    archived: note.archived,
  };
  if (note.title !== undefined) result.title = note.title;
  if (note.color !== undefined) result.color = note.color;
  if (note.checkboxes !== undefined) result.checkboxes = note.checkboxes;
  if (note.labels !== undefined) result.labels = note.labels;
  if (note.images !== undefined) result.images = note.images;
  if (note.deleted !== undefined) result.deleted = note.deleted;
  return result;
}

function stableAttachment(attachment: NoteAttachment): NoteAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

function clipboardAttachments(notes: Record<string, Note>): NoteAttachment[] {
  return notes[CLIPBOARD_NOTE_ID]?.images ?? [];
}

function mimeType(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLocaleLowerCase()] ?? 'application/octet-stream';
}

function pasteFileName(name: string): string {
  if (!name || name === '.' || name === '..' || basename(name) !== name || name.includes('\\')) {
    throw new Error(`Clip has an unsafe filename: ${JSON.stringify(name)}`);
  }
  return name;
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(input: CliInput): Promise<string> {
  let value = '';
  for await (const chunk of input) value += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  return value;
}

function labels(values: readonly string[]): string[] {
  return [...new Set(values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean))];
}

async function handleLogin(context: CommandContext): Promise<void> {
  if (context.stdin.isTTY !== true || context.stdout.isTTY !== true) {
    throw new Error('Login requires an interactive terminal');
  }
  const stored = await fileConfiguration(context.storage);
  const configuration = resolveConfiguration(context.arguments, context.environment, stored);
  const endpoint = requireValue(
    configuration.endpoint,
    'Missing relay endpoint; use --endpoint, UNKEEP_ENDPOINT, or endpoint in the config file',
  );
  const normalizedEndpoint = new RelayClient(endpoint).endpoint;

  const memory = new MemoryClientStorage();
  const existingDeviceId = await context.storage.get<string>(DEVICE_ID_KEY);
  if (existingDeviceId) await memory.set('unkeep-device-id', existingDeviceId);
  const keyStore = new DeviceKeyStore(memory);
  const sessions = new RelaySessionStore(context.storage);
  const pairing = await createPairingRequest(normalizedEndpoint, keyStore, context.arguments.name ?? 'UnKeep CLI');
  context.stderr.write(`Pairing code: ${pairing.code}\nWaiting for approval…\n`);
  await context.onPairingCode?.(pairing.code);
  const { masterKey, session } = await waitForPairing(pairing, {
    keyStore,
    sessionStore: sessions,
    signal: context.signal,
  });

  await context.storage.set('endpoint', session.endpoint);
  await context.storage.set('credential', session.credential);
  await context.storage.set('vaultKey', encodeVaultKey(masterKey));
  await context.storage.set(DEVICE_ID_KEY, session.deviceId);
  if (context.arguments.json) {
    writeJson(context.stdout, { endpoint: session.endpoint, deviceId: session.deviceId, paired: true });
  } else {
    context.stdout.write(`Paired ${session.deviceId} with ${session.endpoint}\n`);
  }
}

async function handleProvision(context: CommandContext): Promise<void> {
  if (context.arguments.positionals.length) throw new Error('provision does not accept positional arguments');
  const name = context.arguments.name?.trim();
  if (!name) throw new Error('provision requires --name <name>');

  const { configuration, relay } = await configuredRelay(context);
  const vaultKey = encodeVaultKey(decodeVaultKey(requireValue(
    configuration.vaultKey,
    'Missing vault key; use --vault-key, UNKEEP_VAULT_KEY, or login',
  )));
  const minted = await relay.mintServiceCredential(name);
  const bundle: ProvisioningBundle = {
    UNKEEP_ENDPOINT: relay.endpoint,
    UNKEEP_CREDENTIAL: minted.serviceCredential,
    UNKEEP_VAULT_KEY: vaultKey,
  };

  if (context.arguments.json) {
    writeJson(context.stdout, bundle);
    return;
  }
  for (const [key, value] of Object.entries(bundle)) context.stdout.write(`${key}=${value}\n`);
}

async function handleCredentials(context: CommandContext): Promise<void> {
  const [subcommand, id, ...extra] = context.arguments.positionals;
  if (!subcommand) throw new Error('credentials requires list or revoke <id>');
  const { relay } = await configuredRelay(context);

  if (subcommand === 'list') {
    if (id || extra.length) throw new Error('credentials list does not accept additional arguments');
    const [{ devices }, { serviceCredentials }] = await Promise.all([
      relay.devices(),
      relay.serviceCredentials(),
    ]);
    const credentials: ListedCredential[] = [
      ...devices.map(device => ({ ...device, kind: 'device' as const })),
      ...serviceCredentials.map(service => ({ ...service, kind: 'service' as const })),
    ];
    if (context.arguments.json) {
      writeJson(context.stdout, credentials);
      return;
    }
    for (const credential of credentials) {
      const createdAt = credential.kind === 'service' ? credential.createdAt : '-';
      context.stdout.write(`${credential.id}\t${credential.kind}\t${credential.name}\t${createdAt}\t${credential.revokedAt ?? '-'}\n`);
    }
    return;
  }

  if (subcommand === 'revoke') {
    if (!id) throw new Error('credentials revoke requires a service credential ID');
    if (extra.length) throw new Error('credentials revoke accepts only one service credential ID');
    await relay.revokeServiceCredential(id);
    if (context.arguments.json) writeJson(context.stdout, { id, revoked: true });
    else context.stdout.write(`Revoked ${id}\n`);
    return;
  }

  throw new Error(`Unknown credentials command: ${subcommand}`);
}

async function handleSync(context: CommandContext): Promise<void> {
  if (context.arguments.positionals.length) throw new Error('sync does not accept positional arguments');
  const vault = await connectedVault(context);
  const summary = await syncNotes(vault, context.storage);
  if (context.arguments.json) writeJson(context.stdout, summary);
  else context.stdout.write(`Synced ${summary.pulled} note(s), removed ${summary.deleted}; cursor ${summary.cursor}\n`);
}

async function handleList(context: CommandContext): Promise<void> {
  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const requiredLabels = labels(context.arguments.labels);
  const search = (context.arguments.search ?? context.arguments.positionals.join(' ')).trim().toLocaleLowerCase();
  const notes = Object.values(await loadNotes(context.storage, vault.session.instanceId))
    .filter(note => context.arguments.archived === undefined || note.archived === context.arguments.archived)
    .filter(note => requiredLabels.every(label => note.labels?.includes(label)))
    .filter(note => !search || [note.title, note.content, ...(note.labels ?? [])]
      .some(value => value?.toLocaleLowerCase().includes(search)))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .map(stableNote);

  if (context.arguments.json) {
    writeJson(context.stdout, notes);
    return;
  }
  for (const note of notes) {
    const summary = note.title?.trim() || note.content.split(/\r?\n/, 1)[0].trim() || '(empty)';
    context.stdout.write(`${note.id}\t${summary}\n`);
  }
}

async function handleGet(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (!id) throw new Error('get requires a note ID');
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) throw new Error('get accepts only one note ID');
  validateNoteId(id);
  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const note = (await loadNotes(context.storage, vault.session.instanceId))[id];
  if (!note) throw new Error(`Note not found: ${id}`);
  if (context.arguments.json) writeJson(context.stdout, stableNote(note));
  else context.stdout.write(`${note.content}\n`);
}

async function handlePut(context: CommandContext): Promise<void> {
  const providedId = context.arguments.id ?? context.arguments.positionals[0];
  const id = providedId ?? globalThis.crypto.randomUUID();
  validateNoteId(id);
  if (id.length > 128) throw new Error('Note ID cannot exceed 128 characters');
  const contentArguments = providedId && !context.arguments.id ? context.arguments.positionals.slice(1) : context.arguments.positionals;
  if (context.arguments.content !== undefined && contentArguments.length) {
    throw new Error('Specify note content with either --content or positional arguments, not both');
  }

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = notes[id];
  let content = context.arguments.content ?? (contentArguments.length ? contentArguments.join(' ') : undefined);
  if (content === undefined && context.stdin.isTTY !== true) content = await readStdin(context.stdin);
  if (content === undefined) {
    if (!existing) throw new Error('New notes require content as an argument, --content, or stdin');
    content = existing.content;
  }

  const timestamp = context.now();
  const requestedLabels = labels(context.arguments.labels);
  const note: Note = {
    ...existing,
    id,
    content,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    pinned: context.arguments.pinned ?? existing?.pinned ?? false,
    archived: context.arguments.archived ?? existing?.archived ?? false,
  };
  if (context.arguments.title !== undefined) note.title = context.arguments.title;
  if (context.arguments.labels.length) note.labels = requestedLabels;

  await vault.sync.push(note);
  notes[id] = note;
  await saveNotes(context.storage, vault.session.instanceId, notes);
  if (context.arguments.json) writeJson(context.stdout, stableNote(note));
  else context.stdout.write(`${id}\n`);
}

async function handleDelete(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (!id) throw new Error('delete requires a note ID');
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) throw new Error('delete accepts only one note ID');
  validateNoteId(id);

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = notes[id];
  if (!existing) throw new Error(`Note not found: ${id}`);

  await vault.sync.push({ ...existing, deleted: true, updatedAt: context.now() });
  delete notes[id];
  await saveNotes(context.storage, vault.session.instanceId, notes);
  if (context.arguments.json) writeJson(context.stdout, { id, deleted: true });
  else context.stdout.write(`${id}\n`);
}

async function handleClip(context: CommandContext): Promise<void> {
  if (context.arguments.listClips) {
    if (context.arguments.positionals.length) throw new Error('clip --list does not accept a file');
    const vault = await connectedVault(context);
    await syncNotes(vault, context.storage);
    const notes = await loadNotes(context.storage, vault.session.instanceId);
    const clips = [...clipboardAttachments(notes)].reverse().map(stableAttachment);
    if (context.arguments.json) {
      writeJson(context.stdout, clips);
      return;
    }
    for (const clip of clips) context.stdout.write(`${clip.id}\t${clip.name}\t${clip.size}\n`);
    return;
  }

  if (context.arguments.positionals.length !== 1) throw new Error('clip requires exactly one file');
  const filePath = resolve(context.cwd, context.arguments.positionals[0]);
  let file: Awaited<ReturnType<typeof stat>>;
  try {
    file = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File not found: ${filePath}`);
    throw error;
  }
  if (!file.isFile()) throw new Error(`Not a file: ${filePath}`);
  const name = basename(filePath);
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`${name} is too large. Attachments must be 25 MB or smaller.`);
  }

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = notes[CLIPBOARD_NOTE_ID];
  const attachment: NoteAttachment = {
    id: globalThis.crypto.randomUUID(),
    name,
    mimeType: mimeType(name),
    size: file.size,
  };
  const timestamp = context.now();
  const note: Note = {
    ...existing,
    id: CLIPBOARD_NOTE_ID,
    title: existing?.title ?? 'Clipboard',
    content: existing?.content ?? 'Files clipped with UnKeep.',
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    pinned: existing?.pinned ?? false,
    archived: existing?.archived ?? false,
    labels: [...new Set([...(existing?.labels ?? []), 'clipboard'])],
    images: [...(existing?.images ?? []), attachment],
    deleted: false,
  };
  const bytes = Uint8Array.from(await readFile(filePath));
  await vault.sync.uploadAttachment(note.id, attachment, bytes);
  await vault.sync.push(note);
  notes[note.id] = note;
  await saveNotes(context.storage, vault.session.instanceId, notes);

  if (context.arguments.json) writeJson(context.stdout, stableAttachment(attachment));
  else context.stdout.write(`${attachment.id}\n`);
}

async function handlePaste(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) {
    throw new Error('paste accepts only one clip ID');
  }
  if (id) validateNoteId(id);

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const clips = clipboardAttachments(notes);
  const attachment = id ? clips.find(clip => clip.id === id) : clips.at(-1);
  if (!attachment) throw new Error(id ? `Clip not found: ${id}` : 'No clips available');

  const name = pasteFileName(attachment.name);
  const destination = join(context.cwd, name);
  const bytes = await vault.sync.downloadAttachment(CLIPBOARD_NOTE_ID, attachment);
  try {
    await writeFile(destination, bytes, { flag: context.arguments.force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite ${name}; use --force to replace it`);
    }
    throw error;
  }

  if (context.arguments.json) {
    writeJson(context.stdout, { id: attachment.id, name, path: destination, size: bytes.byteLength });
  } else {
    context.stdout.write(`${name}\n`);
  }
}

export async function runCli(arguments_: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;
  try {
    const argumentsParsed = parseArguments(arguments_);
    if (!argumentsParsed.command && argumentsParsed.positionals.length && !argumentsParsed.help && !argumentsParsed.version) {
      throw new Error(`Unknown command: ${argumentsParsed.positionals[0]}`);
    }
    if (argumentsParsed.help || (!argumentsParsed.command && !argumentsParsed.version)) {
      stdout.write(HELP);
      return 0;
    }
    if (argumentsParsed.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    const configDirectory = unkeepConfigDirectory(environment, options.configDir ?? argumentsParsed.configDir);
    const context: CommandContext = {
      arguments: argumentsParsed,
      storage: new JsonFileClientStorage(join(configDirectory, 'config.json')),
      stdin: options.stdin ?? process.stdin,
      stdout,
      stderr,
      environment,
      signal: options.signal,
      now: options.now ?? Date.now,
      cwd: options.cwd ?? process.cwd(),
      onPairingCode: options.onPairingCode,
    };
    switch (argumentsParsed.command) {
      case 'login': await handleLogin(context); break;
      case 'provision': await handleProvision(context); break;
      case 'credentials': await handleCredentials(context); break;
      case 'list': await handleList(context); break;
      case 'get': await handleGet(context); break;
      case 'put': await handlePut(context); break;
      case 'delete': await handleDelete(context); break;
      case 'sync': await handleSync(context); break;
      case 'clip': await handleClip(context); break;
      case 'paste': await handlePaste(context); break;
      default: throw new Error(`Unknown command: ${String(argumentsParsed.command)}`);
    }
    return 0;
  } catch (error) {
    stderr.write(`unkeep: ${message(error)}\n`);
    return 1;
  }
}
