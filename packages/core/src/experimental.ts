/**
 * Internal browser working-copy implementation retained behind an explicit
 * subpath while the supported web client migrates away from the old adapter
 * seam. This is not part of the package-root API and has no compatibility
 * guarantee.
 */
export type {
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
  StorageAdapter,
} from './adapter.js';
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
