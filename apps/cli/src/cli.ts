import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  RecordConflictError,
  createPairingRequest,
  DeviceKeyStore,
  EncryptedSync,
  MemoryClientStorage,
  PendingMutationCredentialMismatchError,
  RelayClient,
  RelaySessionStore,
  resumePairingFinalization,
  waitForPairing,
  type CompoundCommitHandle,
  type RelaySession,
} from '@unkeep/client';
import {
  MAX_NOTE_CONTENT_LENGTH,
  normalizeNoteRecord,
  validateNoteId,
  type Note,
  type NoteAttachment,
} from '@unkeep/core';
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
import {
  readStagedClip,
  removeStagedClip,
  stageClipFile,
  stagedClipFileName,
  sweepStagedClips,
  validateStagedClipFileName,
  type StagedClip,
} from './clipStaging.js';
import { JsonFileClientStorage } from './storage.js';

const DEVICE_ID_KEY = 'unkeep-cli-device-id';
const NOTES_PREFIX = 'unkeep-cli-notes:';
const PENDING_CLIP_PREFIX = 'unkeep-cli-pending-clip:';
const CLIPBOARD_NOTE_ID = 'unkeep-clipboard';
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const MAX_STDIN_CONTENT_LENGTH = MAX_NOTE_CONTENT_LENGTH;

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
  quarantined: number;
}

interface ProvisioningBundle {
  UNKEEP_ENDPOINT: string;
  UNKEEP_CREDENTIAL: string;
  UNKEEP_VAULT_KEY: string;
  UNKEEP_SCOPE: 'read-only' | 'read-write';
}

interface PendingClipIntent {
  version: 1 | 2;
  attachment: NoteAttachment;
  staged: StagedClip;
  timestamp: number;
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
  scope: 'read-only' | 'read-write';
  createdAt: string;
  revokedAt: string | null;
}

type ListedCredential = ListedDeviceCredential | ListedServiceCredential;

const TERMINAL_UNSAFE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\ufeff]/u;
const TERMINAL_UNSAFE_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\ufeff]/gu;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecordConflict(error: unknown): error is RecordConflictError {
  if (error instanceof RecordConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<RecordConflictError>;
  return candidate.name === 'RecordConflictError'
    && candidate.status === 409
    && candidate.code === 'record_conflict'
    && Number.isSafeInteger(candidate.currentRevision)
    && candidate.currentRevision! >= 0;
}

function isPendingCredentialMismatch(
  error: unknown,
): error is PendingMutationCredentialMismatchError {
  return error instanceof PendingMutationCredentialMismatchError
    || (
      !!error
      && typeof error === 'object'
      && (error as { name?: unknown }).name === 'PendingMutationCredentialMismatchError'
    );
}

function isTerminalRelayRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return Number.isSafeInteger(candidate.status)
    && Number(candidate.status) >= 400
    && Number(candidate.status) < 500
    && typeof candidate.code === 'string'
    && candidate.code.length > 0;
}

function isForeignCompoundRebuildRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && typeof candidate.code === 'string'
    && new Set([
      'attachment_id_unavailable',
      'attachment_stage_conflict',
      'attachment_stage_missing',
      'mutation_conflict',
      'record_conflict',
    ]).has(candidate.code);
}

async function pushWithCredentialHandoff(
  vault: ConnectedVault,
  note: Note,
): Promise<number> {
  try {
    return await vault.sync.push(note);
  } catch (error) {
    if (!isPendingCredentialMismatch(error)) throw error;
    try {
      await vault.sync.resumePendingMutationAfterCredentialChange('note', note.id);
    } catch (handoffError) {
      if (!isRecordConflict(handoffError)) throw handoffError;
      return vault.sync.rebasePendingNoteAfterCredentialChange(note);
    }
    return vault.sync.push(note);
  }
}

function escapeTerminalControls(value: string): string {
  return value.replace(TERMINAL_UNSAFE_GLOBAL_PATTERN, character => {
    if (character === '\n') return String.raw`\n`;
    if (character === '\r') return String.raw`\r`;
    if (character === '\t') return String.raw`\t`;
    return `\\u{${character.codePointAt(0)!.toString(16)}}`;
  });
}

function terminalValue(output: CliOutput, value: string): string {
  return output.isTTY === true ? escapeTerminalControls(value) : value;
}

function requireValue(value: string | undefined, description: string): string {
  if (!value) throw new Error(description);
  return value;
}

async function fileConfiguration(storage: JsonFileClientStorage): Promise<FileConfiguration> {
  return await storage.entries() as FileConfiguration;
}

function nonEmptyConnectionValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function storedProfileEndpoint(file: FileConfiguration): string | undefined {
  const session = file['unkeep-relay-session'];
  const sessionEndpoint = session && typeof session === 'object'
    ? nonEmptyConnectionValue((session as Partial<RelaySession>).endpoint)
    : undefined;
  return nonEmptyConnectionValue(file.endpoint) ?? sessionEndpoint;
}

function assertEndpointOverrideIsBound(
  context: CommandContext,
  stored: FileConfiguration,
): void {
  const overrideEndpoint = nonEmptyConnectionValue(context.arguments.endpoint)
    ?? nonEmptyConnectionValue(context.environment.UNKEEP_ENDPOINT);
  if (!overrideEndpoint) return;

  const savedEndpoint = storedProfileEndpoint(stored);
  const hasSavedCredential = nonEmptyConnectionValue(stored.credential)
    ?? (
      stored['unkeep-relay-session'] && typeof stored['unkeep-relay-session'] === 'object'
        ? nonEmptyConnectionValue(
          (stored['unkeep-relay-session'] as Partial<RelaySession>).credential,
        )
        : undefined
    );
  const hasSavedVaultKey = nonEmptyConnectionValue(stored.vaultKey)
    ?? nonEmptyConnectionValue(stored.vault_key);
  if (!savedEndpoint && !hasSavedCredential && !hasSavedVaultKey) return;

  let matchesSavedEndpoint = false;
  if (savedEndpoint) {
    try {
      matchesSavedEndpoint = new RelayClient(overrideEndpoint).endpoint
        === new RelayClient(savedEndpoint).endpoint;
    } catch {
      // A valid complete override can replace a malformed saved endpoint. The
      // selected override itself is validated below when RelayClient is built.
    }
  }
  if (matchesSavedEndpoint) return;

  const overrideCredential = nonEmptyConnectionValue(context.arguments.credential)
    ?? nonEmptyConnectionValue(context.environment.UNKEEP_CREDENTIAL);
  const overrideVaultKey = nonEmptyConnectionValue(context.arguments.vaultKey)
    ?? nonEmptyConnectionValue(context.environment.UNKEEP_VAULT_KEY);
  if (overrideCredential && overrideVaultKey) return;

  throw new Error(
    'Relay endpoint differs from the stored profile; provide a complete '
    + '--credential/--vault-key or UNKEEP_CREDENTIAL/UNKEEP_VAULT_KEY bundle '
    + 'for the new endpoint',
  );
}

async function configuredRelay(context: CommandContext): Promise<{
  configuration: ResolvedConfiguration;
  relay: RelayClient;
}> {
  let stored = await fileConfiguration(context.storage);
  assertEndpointOverrideIsBound(context, stored);
  let configuration = resolveConfiguration(context.arguments, context.environment, stored);
  const sessions = new RelaySessionStore(context.storage);
  const pendingSession = await sessions.load();
  const selectedEndpoint = configuration.endpoint
    ? new RelayClient(configuration.endpoint).endpoint
    : undefined;
  if (
    pendingSession?.pendingPairingRequestId
    && selectedEndpoint === pendingSession.endpoint
    && configuration.credential === pendingSession.credential
  ) {
    try {
      await resumePairingFinalization(sessions);
    } catch {
      context.stderr.write('Pairing finalization is still pending; it will retry on the next command.\n');
    }
    stored = await fileConfiguration(context.storage);
    configuration = resolveConfiguration(context.arguments, context.environment, stored);
  }
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
  const connected = {
    session,
    masterKey,
    sync: new EncryptedSync(session, masterKey, context.storage),
  };
  await recoverCommittedClipHandles(connected, context.storage, context.stderr);
  await recoverPendingClipCompound(connected, context.storage, context.stderr);
  return connected;
}

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Note>;
  return typeof candidate.id === 'string' && typeof candidate.content === 'string';
}

function emptyNoteCache(): Record<string, Note> {
  return Object.create(null) as Record<string, Note>;
}

async function loadNotes(storage: JsonFileClientStorage, instanceId: string): Promise<Record<string, Note>> {
  const value = await storage.get<unknown>(NOTES_PREFIX + instanceId);
  const notes = emptyNoteCache();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return notes;
  for (const [id, note] of Object.entries(value)) {
    if (isNote(note) && note.id === id) notes[id] = note;
  }
  return notes;
}

function cachedNote(notes: Record<string, Note>, id: string): Note | undefined {
  return Object.hasOwn(notes, id) ? notes[id] : undefined;
}

function saveNotes(storage: JsonFileClientStorage, instanceId: string, notes: Record<string, Note>): Promise<void> {
  return storage.set(NOTES_PREFIX + instanceId, notes);
}

async function syncNotes(
  vault: ConnectedVault,
  storage: JsonFileClientStorage,
  diagnostics?: CliOutput,
  recoverClips = true,
): Promise<SyncSummary> {
  const notes = await loadNotes(storage, vault.session.instanceId);
  let cursor = await vault.sync.getCursor();
  let pulled = 0;
  let deleted = 0;

  // The relay pages changes at 1,000 rows. Pull until a request no longer advances the cursor.
  for (let page = 0; page < 100; page += 1) {
    const previousCursor = cursor;
    const result = await vault.sync.pull(cursor);
    cursor = result.cursor;
    for (const note of result.notes) notes[note.id] = note;
    for (const id of result.deletedIds) delete notes[id];
    const deletedAttachmentIds = new Set(
      result.deletedAttachments.map(({ attachmentId }) => attachmentId),
    );
    let removedAttachmentMetadata = false;
    if (deletedAttachmentIds.size) {
      for (const [id, note] of Object.entries(notes)) {
        if (!note.images?.some(attachment => deletedAttachmentIds.has(attachment.id))) continue;
        const images = note.images.filter(attachment => !deletedAttachmentIds.has(attachment.id));
        notes[id] = { ...note, images: images.length ? images : undefined };
        removedAttachmentMetadata = true;
      }
    }
    pulled += result.notes.length;
    deleted += result.deletedIds.length;
    if (result.notes.length || result.deletedIds.length || removedAttachmentMetadata) {
      await saveNotes(storage, vault.session.instanceId, notes);
    }
    // A pull is deliberately non-committing. Advance only after the local
    // note snapshot above is durable so a failed write can retry this page.
    await vault.sync.acknowledge(result.cursor,result.revisions);
    if (cursor === previousCursor) {
      if (recoverClips) {
        await recoverInterruptedClip(vault, storage, diagnostics);
      }
      const quarantined = (await vault.sync.getQuarantinedRecords()).length;
      if (quarantined && diagnostics) {
        const noun = quarantined === 1 ? 'record is' : 'records are';
        diagnostics.write(
          `Warning: ${quarantined} remote note ${noun} quarantined as invalid or undecryptable; sync continued. Repair the note from a trusted device or restore a known-good relay backup.\n`,
        );
      }
      return { cursor, pulled, deleted, quarantined };
    }
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
  if (note.trashedAt !== undefined) result.trashedAt = note.trashedAt;
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
  return cachedNote(notes, CLIPBOARD_NOTE_ID)?.images ?? [];
}

function sameAttachment(left: NoteAttachment, right: NoteAttachment): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mimeType === right.mimeType
    && left.size === right.size;
}

function pendingClipKey(instanceId: string): string {
  return PENDING_CLIP_PREFIX + encodeURIComponent(instanceId);
}

function pendingClipIntent(value: unknown): PendingClipIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored interrupted clip state is invalid');
  }
  const candidate = value as Partial<PendingClipIntent>;
  if (
    Object.keys(value).sort().join(',') !== 'attachment,staged,timestamp,version'
    || (candidate.version !== 1 && candidate.version !== 2)
    || !candidate.attachment
    || !candidate.staged
    || typeof candidate.timestamp !== 'number'
    || !Number.isFinite(candidate.timestamp)
    || Object.keys(candidate.attachment).sort().join(',') !== 'id,mimeType,name,size'
    || Object.keys(candidate.staged).sort().join(',') !== 'fileName,sha256,size'
  ) {
    throw new Error('Stored interrupted clip state is invalid');
  }

  let normalized: Note;
  try {
    normalized = normalizeNoteRecord({
      id: CLIPBOARD_NOTE_ID,
      content: '',
      createdAt: 0,
      updatedAt: 0,
      pinned: false,
      archived: false,
      images: [candidate.attachment],
    });
  } catch {
    throw new Error('Stored interrupted clip state is invalid');
  }
  const attachment = normalized.images?.[0];
  let stagedFileName: string;
  try {
    stagedFileName = validateStagedClipFileName(candidate.staged.fileName);
  } catch {
    throw new Error('Stored interrupted clip state is invalid');
  }
  if (
    !attachment
    || (candidate.version === 1
      && stagedFileName !== stagedClipFileName(attachment.id))
    || candidate.staged.size !== attachment.size
    || !/^[0-9a-f]{64}$/.test(candidate.staged.sha256)
  ) {
    throw new Error('Stored interrupted clip state is invalid');
  }
  return {
    version: candidate.version,
    attachment,
    staged: {
      fileName: stagedFileName,
      sha256: candidate.staged.sha256,
      size: candidate.staged.size,
    },
    timestamp: candidate.timestamp,
  };
}

async function sweepUnreferencedClipStaging(
  storage: JsonFileClientStorage,
): Promise<void> {
  const retained = new Set<string>();
  for (const [key, value] of Object.entries(await storage.entries())) {
    if (!key.startsWith(PENDING_CLIP_PREFIX)) continue;
    retained.add(pendingClipIntent(value).staged.fileName);
  }
  await sweepStagedClips(storage, retained);
}

function clipboardNote(
  existing: Note | undefined,
  attachment: NoteAttachment,
  timestamp: number,
): Note {
  const images = existing?.images?.some(value => value.id === attachment.id)
    ? existing.images
    : [...(existing?.images ?? []), attachment];
  return {
    ...existing,
    id: CLIPBOARD_NOTE_ID,
    title: existing?.title ?? 'Clipboard',
    content: existing?.content ?? 'Files clipped with UnKeep.',
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: Math.max(existing?.updatedAt ?? timestamp, timestamp),
    pinned: existing?.pinned ?? false,
    archived: existing?.archived ?? false,
    labels: [...new Set([...(existing?.labels ?? []), 'clipboard'])],
    images,
    deleted: false,
  };
}

function clipboardNoteWithoutAttachment(
  existing: Note | undefined,
  attachmentId: string,
  timestamp: number,
): Note {
  const base = clipboardNote(existing, {
    id: attachmentId,
    name: 'discarded',
    mimeType: 'application/octet-stream',
    size: 0,
  }, timestamp);
  const images = base.images?.filter(value => value.id !== attachmentId);
  return {
    ...base,
    images: images?.length ? images : undefined,
  };
}

async function removeCompletedClipStage(
  storage: JsonFileClientStorage,
  fileName: string,
  diagnostics?: CliOutput,
): Promise<void> {
  try {
    await removeStagedClip(storage, fileName);
  } catch {
    diagnostics?.write(
      'Warning: the completed clip staging file could not be removed; a later command will retry cleanup.\n',
    );
  }
}

function onlyClipRevision(handle: CompoundCommitHandle): CompoundCommitHandle['attachmentRevisions'][number] {
  if (handle.noteId !== CLIPBOARD_NOTE_ID || handle.attachmentRevisions.length !== 1) {
    throw new Error('Stored completed clip state is invalid');
  }
  return handle.attachmentRevisions[0]!;
}

async function recoverCommittedClipHandles(
  vault: ConnectedVault,
  storage: JsonFileClientStorage,
  diagnostics?: CliOutput,
): Promise<void> {
  const handles = await vault.sync.pendingCompoundCommits();
  for (const handle of handles) {
    if (handle.noteId !== CLIPBOARD_NOTE_ID) continue;
    const revision = onlyClipRevision(handle);
    const intentKey = pendingClipKey(vault.session.instanceId);
    const storedIntent = await storage.get<unknown>(intentKey);
    const notes = await loadNotes(storage, vault.session.instanceId);
    const existing = cachedNote(notes, CLIPBOARD_NOTE_ID);
    let attachment: NoteAttachment;
    let stagedFileName = stagedClipFileName(revision.id);

    if (storedIntent !== null) {
      const intent = pendingClipIntent(storedIntent);
      if (
        intent.attachment.id !== revision.id
        || intent.staged.sha256 !== revision.contentHash
      ) {
        throw new Error('Stored completed clip does not match its pending intent');
      }
      const cached = existing?.images?.find(candidate => candidate.id === revision.id);
      if (cached && !sameAttachment(cached, intent.attachment)) {
        throw new Error('Stored completed clip does not match the local note cache');
      }
      attachment = intent.attachment;
      stagedFileName = intent.staged.fileName;
      const note = clipboardNote(existing, attachment, intent.timestamp);
      notes[note.id] = note;
      await storage.setAndDelete(
        { [NOTES_PREFIX + vault.session.instanceId]: notes },
        [intentKey],
      );
    } else {
      const cached = existing?.images?.find(candidate => candidate.id === revision.id);
      if (!cached) {
        throw new Error('Stored completed clip is absent from the local note cache');
      }
      const remoteBytes = await vault.sync.downloadAttachment(CLIPBOARD_NOTE_ID, cached);
      const contentHash = createHash('sha256').update(remoteBytes).digest('hex');
      if (contentHash !== revision.contentHash) {
        throw new Error('Stored completed clip content does not match the relay attachment');
      }
      attachment = cached;
    }

    if (!await vault.sync.completeCompoundCommit(handle)) {
      throw new Error('Stored completed clip changed during local recovery');
    }
    await removeCompletedClipStage(storage, stagedFileName, diagnostics);
    diagnostics?.write(`Recovered interrupted clip ${attachment.id}.\n`);
  }
}

async function recoverPendingClipCompound(
  vault: ConnectedVault,
  storage: JsonFileClientStorage,
  diagnostics?: CliOutput,
): Promise<void> {
  const intentKey = pendingClipKey(vault.session.instanceId);
  const storedIntent = await storage.get<unknown>(intentKey);
  if (storedIntent === null) return;
  const intent = pendingClipIntent(storedIntent);
  let handle: CompoundCommitHandle | null;
  try {
    handle = await vault.sync.resumePendingCompoundCommit(CLIPBOARD_NOTE_ID, [{
      attachment: intent.attachment,
      loadBytes: () => readStagedClip(storage, intent.staged),
    }]);
  } catch (error) {
    if (isPendingCredentialMismatch(error)) {
      // Do not destroy another credential's exact retry state until this
      // invocation has authenticated and completed its normal pull.
      return;
    }
    if (isTerminalRelayRejection(error)) {
      // The SDK has already removed the exact terminally rejected root. Let
      // this command's normal sync pull/merge and rebuild the retained intent.
      return;
    }
    if (
      !message(error).startsWith('Interrupted clip staging file ')
      || !await vault.sync.cancelPendingCompoundCommit(CLIPBOARD_NOTE_ID)
    ) throw error;
    return;
  }
  if (!handle) return;
  const revision = onlyClipRevision(handle);
  if (
    revision.id !== intent.attachment.id
    || revision.contentHash !== intent.staged.sha256
  ) {
    throw new Error('Stored completed clip does not match its pending intent');
  }

  const notes = await loadNotes(storage, vault.session.instanceId);
  const existing = cachedNote(notes, CLIPBOARD_NOTE_ID);
  const cached = existing?.images?.find(candidate => candidate.id === revision.id);
  if (cached && !sameAttachment(cached, intent.attachment)) {
    throw new Error('Stored completed clip does not match the local note cache');
  }
  const note = clipboardNote(existing, intent.attachment, intent.timestamp);
  notes[note.id] = note;
  await storage.setAndDelete(
    { [NOTES_PREFIX + vault.session.instanceId]: notes },
    [intentKey],
  );
  if (!await vault.sync.completeCompoundCommit(handle)) {
    throw new Error('Stored completed clip changed during local recovery');
  }
  await removeCompletedClipStage(storage, intent.staged.fileName, diagnostics);
  diagnostics?.write(`Recovered interrupted clip ${intent.attachment.id}.\n`);
}

async function recoverInterruptedClip(
  vault: ConnectedVault,
  storage: JsonFileClientStorage,
  diagnostics?: CliOutput,
  announceRecovery = true,
): Promise<NoteAttachment | undefined> {
  const key = pendingClipKey(vault.session.instanceId);
  const stored = await storage.get<unknown>(key);
  if (stored === null) return undefined;
  let intent = pendingClipIntent(stored);
  let notes = await loadNotes(storage, vault.session.instanceId);
  let existing = cachedNote(notes, CLIPBOARD_NOTE_ID);
  const reidentifyIntent = async (): Promise<void> => {
    intent = {
      ...intent,
      version: 2,
      attachment: {
        ...intent.attachment,
        id: globalThis.crypto.randomUUID(),
      },
    };
    await storage.set(key, intent);
  };

  if (existing?.images?.some(value => value.id === intent.attachment.id)) {
    // A successful pull may have observed a final response that was lost
    // under a replaced credential. The public attachment is now reconciled,
    // so its foreign local replay root can be retired explicitly.
    await vault.sync.abandonPendingCompoundAfterCredentialChange(
      CLIPBOARD_NOTE_ID,
    );
    await storage.delete(key);
    await removeCompletedClipStage(storage, intent.staged.fileName, diagnostics);
    if (announceRecovery) diagnostics?.write(`Recovered interrupted clip ${intent.attachment.id}.\n`);
    return intent.attachment;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    notes = await loadNotes(storage, vault.session.instanceId);
    existing = cachedNote(notes, CLIPBOARD_NOTE_ID);
    if (existing?.images?.some(value => value.id === intent.attachment.id)) {
      await storage.delete(key);
      await removeCompletedClipStage(storage, intent.staged.fileName, diagnostics);
      if (announceRecovery) diagnostics?.write(`Recovered interrupted clip ${intent.attachment.id}.\n`);
      return intent.attachment;
    }

    const note = clipboardNote(existing, intent.attachment, intent.timestamp);
    const upload = {
      attachment: intent.attachment,
      loadBytes: () => readStagedClip(storage, intent.staged),
    } as const;
    try {
      let handle: CompoundCommitHandle | null;
      try {
        handle = await vault.sync.resumePendingCompoundCommit(note.id, [upload]);
      } catch (error) {
        if (!isPendingCredentialMismatch(error)) throw error;
        try {
          handle = await vault.sync.resumePendingCompoundCommitAfterCredentialChange(
            note.id,
            [upload],
          );
        } catch (handoffError) {
          if (!isForeignCompoundRebuildRejection(handoffError)) throw handoffError;
          if (!await vault.sync.abandonPendingCompoundAfterCredentialChange(note.id)) {
            throw handoffError;
          }
          await reidentifyIntent();
          continue;
        }
      }
      handle ??= await vault.sync.commitNoteWithAttachments(note, [upload]);
      const revision = onlyClipRevision(handle);
      if (
        revision.id !== intent.attachment.id
        || revision.contentHash !== intent.staged.sha256
      ) {
        throw new Error('Committed clip does not match its private staging snapshot');
      }
      notes[note.id] = note;
      await storage.setAndDelete(
        { [NOTES_PREFIX + vault.session.instanceId]: notes },
        [key],
      );
      if (!await vault.sync.completeCompoundCommit(handle)) {
        throw new Error('Committed clip changed during local completion');
      }
      await removeCompletedClipStage(storage, intent.staged.fileName, diagnostics);
      if (announceRecovery) diagnostics?.write(`Recovered interrupted clip ${intent.attachment.id}.\n`);
      return intent.attachment;
    } catch (error) {
      if (isRecordConflict(error) && attempt < 2) {
        await syncNotes(vault, storage, diagnostics, false);
        continue;
      }
      if (isForeignCompoundRebuildRejection(error)) {
        // A prior authenticated handoff may have crashed after retiring its
        // foreign root but before persisting the replacement identity. The
        // same reserved ID then fails under a fresh current-credential root.
        // That terminal root is already gone; make the retained private bytes
        // replayable under a new durable attachment identity.
        await vault.sync.abandonPendingCompoundAfterCredentialChange(note.id);
        await reidentifyIntent();
        continue;
      }
      if (!message(error).startsWith('Interrupted clip staging file ')) throw error;

      // If the exact encrypted payload was not durable before the private
      // plaintext disappeared, abandon only that non-finalizing bundle. Any
      // server-side stage remains unpublished and expires under the relay TTL.
      const cancelled = await vault.sync.cancelPendingCompoundCommit(note.id);
      if (!cancelled && await vault.sync.pendingCompoundCommit(note.id)) {
        throw new Error('Interrupted clip was already committed but could not be reconciled');
      }

      // No live attachment exists: publish the final Clipboard note without
      // the failed reference, and never call the legacy direct attachment PUT.
      // Conflict retries merge concurrent Clipboard fields first.
      let finalNote = clipboardNoteWithoutAttachment(
        existing,
        intent.attachment.id,
        intent.timestamp,
      );
      for (let discardAttempt = 0; discardAttempt < 3; discardAttempt += 1) {
        try {
          await pushWithCredentialHandoff(vault, finalNote);
          notes = await loadNotes(storage, vault.session.instanceId);
          notes[finalNote.id] = finalNote;
          await storage.setAndDelete(
            { [NOTES_PREFIX + vault.session.instanceId]: notes },
            [key],
          );
          await removeCompletedClipStage(storage, intent.staged.fileName, diagnostics);
          diagnostics?.write(
            `Discarded interrupted clip ${intent.attachment.id} because its private staging file was missing or changed.\n`,
          );
          return undefined;
        } catch (discardError) {
          if (!isRecordConflict(discardError) || discardAttempt === 2) {
            throw discardError;
          }
          await syncNotes(vault, storage, diagnostics, false);
          notes = await loadNotes(storage, vault.session.instanceId);
          finalNote = clipboardNoteWithoutAttachment(
            cachedNote(notes, CLIPBOARD_NOTE_ID),
            intent.attachment.id,
            intent.timestamp,
          );
        }
      }
    }
  }
  throw new Error('Interrupted clip could not be reconciled');
}

function mimeType(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLocaleLowerCase()] ?? 'application/octet-stream';
}

function pasteFileName(name: string): string {
  if (!name
    || name === '.'
    || name === '..'
    || basename(name) !== name
    || name.includes('\\')
    || TERMINAL_UNSAFE_PATTERN.test(name)) {
    throw new Error(`Clip has an unsafe filename: ${JSON.stringify(name)}`);
  }
  return name;
}

async function assertReplaceablePasteDestination(destination: string, name: string): Promise<void> {
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.nlink !== 1) {
      throw new Error(`Refusing to replace unsafe destination ${name}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writePastedFile(
  destination: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  force: boolean,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${name}.unkeep-${globalThis.crypto.randomUUID()}.tmp`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (force) {
      // Rename replaces the directory entry, not a symlink or hardlink target.
      // The preflight also refuses surprising destination types and shared
      // inodes when they are already present.
      await assertReplaceablePasteDestination(destination, name);
      await rename(temporary, destination);
    } else {
      // A hard link installs the completed file atomically and fails if any
      // entry (including a symlink) already owns the requested name.
      await link(temporary, destination);
      await unlink(temporary);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite ${name}; use --force to replace it`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(input: CliInput): Promise<string> {
  let value = '';
  const decoder = new TextDecoder();
  for await (const chunk of input) {
    value += typeof chunk === 'string'
      ? decoder.decode() + chunk
      : decoder.decode(chunk, { stream: true });
    if (value.length > MAX_STDIN_CONTENT_LENGTH) {
      throw new Error(`stdin exceeds the ${MAX_STDIN_CONTENT_LENGTH}-character note limit`);
    }
  }
  value += decoder.decode();
  if (value.length > MAX_STDIN_CONTENT_LENGTH) {
    throw new Error(`stdin exceeds the ${MAX_STDIN_CONTENT_LENGTH}-character note limit`);
  }
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
  context.stderr.write(
    `Pairing code: ${terminalValue(context.stderr, pairing.code)}\n`
    + `Pairing fingerprint: ${terminalValue(context.stderr, pairing.fingerprint)}\n`
    + 'Verify the fingerprint exactly matches the approving device.\nWaiting for approval…\n',
  );
  await context.onPairingCode?.(pairing.code);
  const previousConfiguration = await context.storage.entries();
  let result: Awaited<ReturnType<typeof waitForPairing>>;
  try {
    result = await waitForPairing(pairing, {
      keyStore,
      sessionStore: sessions,
      signal: context.signal,
      storageIsolation: 'externally-serialized',
      initialize: async ({ masterKey, session }) => {
        await context.storage.setMany({
          endpoint: session.endpoint,
          credential: session.credential,
          vaultKey: encodeVaultKey(masterKey),
          [DEVICE_ID_KEY]: session.deviceId,
          'unkeep-relay-session': session,
        });
      },
    });
  } catch (error) {
    try {
      await context.storage.replaceAll(previousConfiguration);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Pairing failed and the previous CLI configuration could not be restored',
        { cause: error },
      );
    }
    throw error;
  }
  const { session } = result;
  if (result.finalizationPending) {
    context.stderr.write('Pairing is saved locally; server finalization will retry on the next command.\n');
  }
  if (context.arguments.json) {
    writeJson(context.stdout, { endpoint: session.endpoint, deviceId: session.deviceId, paired: true });
  } else {
    context.stdout.write(
      `Paired ${terminalValue(context.stdout, session.deviceId)} with ${terminalValue(context.stdout, session.endpoint)}\n`,
    );
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
  const minted = await relay.mintServiceCredential(name, context.arguments.scope ?? 'read-only');
  const bundle: ProvisioningBundle = {
    UNKEEP_ENDPOINT: relay.endpoint,
    UNKEEP_CREDENTIAL: minted.serviceCredential,
    UNKEEP_VAULT_KEY: vaultKey,
    UNKEEP_SCOPE: minted.scope,
  };

  if (context.arguments.json) {
    writeJson(context.stdout, bundle);
    return;
  }
  for (const [key, value] of Object.entries(bundle)) {
    context.stdout.write(`${key}=${terminalValue(context.stdout, value)}\n`);
  }
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
      const scope = credential.kind === 'service' ? credential.scope : 'admin';
      context.stdout.write(
        `${terminalValue(context.stdout, credential.id)}\t${credential.kind}\t`
        + `${terminalValue(context.stdout, credential.name)}\t${terminalValue(context.stdout, createdAt)}\t`
        + `${terminalValue(context.stdout, credential.revokedAt ?? '-')}\t${scope}\n`,
      );
    }
    return;
  }

  if (subcommand === 'revoke') {
    if (!id) throw new Error('credentials revoke requires a service credential ID');
    if (extra.length) throw new Error('credentials revoke accepts only one service credential ID');
    await relay.revokeServiceCredential(id);
    if (context.arguments.json) writeJson(context.stdout, { id, revoked: true });
    else context.stdout.write(`Revoked ${terminalValue(context.stdout, id)}\n`);
    return;
  }

  throw new Error(`Unknown credentials command: ${subcommand}`);
}

async function handleSync(context: CommandContext): Promise<void> {
  if (context.arguments.positionals.length) throw new Error('sync does not accept positional arguments');
  const vault = await connectedVault(context);
  const summary = await syncNotes(vault, context.storage, context.stderr);
  if (context.arguments.json) writeJson(context.stdout, summary);
  else context.stdout.write(
    `Synced ${summary.pulled} note(s), removed ${summary.deleted}, quarantined ${summary.quarantined}; cursor ${summary.cursor}\n`,
  );
}

async function handleList(context: CommandContext): Promise<void> {
  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const requiredLabels = labels(context.arguments.labels);
  const search = (context.arguments.search ?? context.arguments.positionals.join(' ')).trim().toLocaleLowerCase();
  const notes = Object.values(await loadNotes(context.storage, vault.session.instanceId))
    .filter(note => context.arguments.trash
      ? note.trashedAt !== undefined
      : note.trashedAt === undefined)
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
    context.stdout.write(
      `${terminalValue(context.stdout, note.id)}\t${terminalValue(context.stdout, summary)}\n`,
    );
  }
}

async function handleGet(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (!id) throw new Error('get requires a note ID');
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) throw new Error('get accepts only one note ID');
  validateNoteId(id);
  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const note = cachedNote(await loadNotes(context.storage, vault.session.instanceId), id);
  if (!note) throw new Error(`Note not found: ${id}`);
  if (context.arguments.json) writeJson(context.stdout, stableNote(note));
  else context.stdout.write(`${terminalValue(context.stdout, note.content)}\n`);
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
  await syncNotes(vault, context.storage, context.stderr);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = cachedNote(notes, id);
  if (existing?.trashedAt !== undefined) {
    throw new Error(`Note is in Trash; restore it before editing: ${id}`);
  }
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
    archived: existing?.archived ?? false,
  };
  if (context.arguments.title !== undefined) note.title = context.arguments.title;
  if (context.arguments.labels.length) note.labels = requestedLabels;

  await pushWithCredentialHandoff(vault, note);
  notes[id] = note;
  await saveNotes(context.storage, vault.session.instanceId, notes);
  if (context.arguments.json) writeJson(context.stdout, stableNote(note));
  else context.stdout.write(`${terminalValue(context.stdout, id)}\n`);
}

async function handleDelete(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (!id) throw new Error('delete requires a note ID');
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) throw new Error('delete accepts only one note ID');
  validateNoteId(id);

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = cachedNote(notes, id);
  if (!existing) throw new Error(`Note not found: ${id}`);

  if (context.arguments.permanent) {
    if (existing.trashedAt === undefined) {
      throw new Error(`Permanent deletion requires the note to be in Trash: ${id}`);
    }
    await pushWithCredentialHandoff(
      vault,
      { ...existing, trashedAt: undefined, deleted: true, updatedAt: context.now() },
    );
    delete notes[id];
    await saveNotes(context.storage, vault.session.instanceId, notes);
    if (context.arguments.json) writeJson(context.stdout, { id, deleted: true, permanent: true });
    else context.stdout.write(`${terminalValue(context.stdout, id)}\n`);
    return;
  }

  if (existing.trashedAt !== undefined) throw new Error(`Note is already in Trash: ${id}`);
  const trashedAt = context.now();
  const trashed = {
    ...existing,
    archived: false,
    trashedAt,
    updatedAt: trashedAt,
  } satisfies Note;
  await pushWithCredentialHandoff(vault, trashed);
  notes[id] = trashed;
  await saveNotes(context.storage, vault.session.instanceId, notes);
  if (context.arguments.json) writeJson(context.stdout, { id, trashed: true, trashedAt });
  else context.stdout.write(`${terminalValue(context.stdout, id)}\n`);
}

async function handleRestore(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (!id) throw new Error('restore requires a note ID');
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) throw new Error('restore accepts only one note ID');
  validateNoteId(id);

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const existing = cachedNote(notes, id);
  if (!existing) throw new Error(`Note not found: ${id}`);
  if (existing.trashedAt === undefined) throw new Error(`Note is not in Trash: ${id}`);

  const restored = { ...existing, trashedAt: undefined, updatedAt: context.now() } satisfies Note;
  await pushWithCredentialHandoff(vault, restored);
  notes[id] = restored;
  await saveNotes(context.storage, vault.session.instanceId, notes);
  if (context.arguments.json) writeJson(context.stdout, stableNote(restored));
  else context.stdout.write(`${terminalValue(context.stdout, id)}\n`);
}

async function handleClip(context: CommandContext): Promise<void> {
  if (context.arguments.listClips) {
    if (context.arguments.positionals.length) throw new Error('clip --list does not accept a file');
    const vault = await connectedVault(context);
    await syncNotes(vault, context.storage, context.stderr);
    const notes = await loadNotes(context.storage, vault.session.instanceId);
    const clips = [...clipboardAttachments(notes)].reverse().map(stableAttachment);
    if (context.arguments.json) {
      writeJson(context.stdout, clips);
      return;
    }
    for (const clip of clips) {
      context.stdout.write(
        `${terminalValue(context.stdout, clip.id)}\t${terminalValue(context.stdout, clip.name)}\t${clip.size}\n`,
      );
    }
    return;
  }

  if (context.arguments.positionals.length !== 1) throw new Error('clip requires exactly one file');
  const filePath = resolve(context.cwd, context.arguments.positionals[0]);
  const name = pasteFileName(basename(filePath));
  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const attachmentId = globalThis.crypto.randomUUID();
  const staged = await stageClipFile(
    context.storage,
    filePath,
    name,
    attachmentId,
    MAX_ATTACHMENT_SIZE,
  );
  const attachment: NoteAttachment = {
    id: attachmentId,
    name,
    mimeType: mimeType(name),
    size: staged.size,
  };
  const key = pendingClipKey(vault.session.instanceId);
  try {
    await context.storage.set(key, {
      version: 1,
      attachment,
      staged,
      timestamp: context.now(),
    } satisfies PendingClipIntent);
  } catch (error) {
    await removeStagedClip(context.storage, staged.fileName);
    throw error;
  }
  await recoverInterruptedClip(vault, context.storage, context.stderr, false);

  if (context.arguments.json) writeJson(context.stdout, stableAttachment(attachment));
  else context.stdout.write(`${terminalValue(context.stdout, attachment.id)}\n`);
}

async function handlePaste(context: CommandContext): Promise<void> {
  const id = context.arguments.id ?? context.arguments.positionals[0];
  if (context.arguments.positionals.length > (context.arguments.id ? 0 : 1)) {
    throw new Error('paste accepts only one clip ID');
  }
  if (id) validateNoteId(id);

  const vault = await connectedVault(context);
  await syncNotes(vault, context.storage, context.stderr);
  const notes = await loadNotes(context.storage, vault.session.instanceId);
  const clips = clipboardAttachments(notes);
  const attachment = id ? clips.find(clip => clip.id === id) : clips.at(-1);
  if (!attachment) throw new Error(id ? `Clip not found: ${id}` : 'No clips available');

  const name = pasteFileName(attachment.name);
  const destination = join(context.cwd, name);
  const bytes = await vault.sync.downloadAttachment(CLIPBOARD_NOTE_ID, attachment);
  await writePastedFile(destination, name, bytes, context.arguments.force);

  if (context.arguments.json) {
    writeJson(context.stdout, { id: attachment.id, name, path: destination, size: bytes.byteLength });
  } else {
    context.stdout.write(`${terminalValue(context.stdout, name)}\n`);
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
    const storage = new JsonFileClientStorage(join(configDirectory, 'config.json'));
    const context: CommandContext = {
      arguments: argumentsParsed,
      storage,
      stdin: options.stdin ?? process.stdin,
      stdout,
      stderr,
      environment,
      signal: options.signal,
      now: options.now ?? Date.now,
      cwd: options.cwd ?? process.cwd(),
      onPairingCode: options.onPairingCode,
    };
    await storage.runExclusive(async () => {
      await sweepUnreferencedClipStaging(storage);
      switch (argumentsParsed.command) {
        case 'login': await handleLogin(context); break;
        case 'provision': await handleProvision(context); break;
        case 'credentials': await handleCredentials(context); break;
        case 'list': await handleList(context); break;
        case 'get': await handleGet(context); break;
        case 'put': await handlePut(context); break;
        case 'delete': await handleDelete(context); break;
        case 'restore': await handleRestore(context); break;
        case 'sync': await handleSync(context); break;
        case 'clip': await handleClip(context); break;
        case 'paste': await handlePaste(context); break;
        default: throw new Error(`Unknown command: ${String(argumentsParsed.command)}`);
      }
    });
    return 0;
  } catch (error) {
    stderr.write(`unkeep: ${terminalValue(stderr, message(error))}\n`);
    return 1;
  }
}
