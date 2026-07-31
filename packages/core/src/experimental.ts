/**
 * Unsupported storage and OAuth experiments retained for the web client's
 * local working copy, migration, and prototype work.
 *
 * These exports are not part of the supported encrypted-relay product API and
 * may change or disappear during the 0.x line.
 */
export type {
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
  OAuthProviderConfig,
  OAuthTokens,
  StorageAdapter,
} from './adapter.js';
export {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from './oauth.js';
export {
  LEGACY_LOCAL_DATABASE_NAME,
  LOCAL_DATABASE_VERSION,
  NOTE_CREATION_CLAIM_TTL_MS,
  LocalOnlyAdapter,
  localDatabaseName,
  validateVaultNamespace,
} from './adapters/local.js';
export type {
  ClaimNoteCreationResult,
  CreateNoteWithPendingSyncResult,
  DurableNoteStorageAdapter,
  ImportCommitState,
  NoteCreationClaim,
  PendingNoteSync,
} from './adapters/local.js';
export { LocalMarkdownAdapter } from './adapters/local-markdown.js';
export { GitAdapter } from './adapters/git.js';
export { S3Adapter } from './adapters/s3.js';
