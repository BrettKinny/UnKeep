export type { ClientStorage, ClientStorageTransaction } from './storage.js';
export { MemoryClientStorage } from './storage.js';
export type {
  RelaySession,
  RelayStatus,
  DeviceCredential,
  ServiceCredential,
  ServiceCredentialScope,
  RelayChange,
  RelayClientOptions,
  RelayAttachmentStageRequest,
  RelayAttachmentStageReceipt,
  RelayCompoundAttachment,
  RelayCompoundNoteRequest,
  RelayCompoundAttachmentRevision,
  RelayCompoundNoteReceipt,
} from './relay.js';
export { RelayClient, RelayHttpError, RecordConflictError, cleanRelayEndpoint } from './relay.js';
export { RelaySessionStore } from './session.js';
export type {
  PairingKeyInstallation,
  PairingKeySnapshot,
  ProvisionedKeys,
} from './deviceKeys.js';
export {
  DeviceKeyStore,
  VaultInstanceMismatchError,
  VaultKeyMismatchError,
} from './deviceKeys.js';
export type { PairingStorageIsolation } from './deviceAccess.js';
export { clearDeviceAccess } from './deviceAccess.js';
export { encrypt, decrypt, isEncrypted } from './encryption.js';
export type { PairingSession, PairingResult, WaitForPairingOptions, PendingPairingRequest } from './pairing.js';
export {
  PairingLocalStateChangedError,
  createPairingRequest,
  inspectPairingCode,
  approvePairingRequest,
  approvePairingCode,
  pairingFingerprint,
  resumePairingFinalization,
  waitForPairing,
} from './pairing.js';
export type {
  PulledAttachment,
  PulledAttachmentTombstone,
  PulledNotes,
  PulledRevision,
  QuarantinedRecord,
  QuarantineReason,
  CompoundAttachmentUpload,
  CompoundCommitHandle,
} from './sync.js';
export {
  AttachmentDeletedError,
  EncryptedSync,
  PendingCompoundCompletionError,
  PendingMutationCredentialMismatchError,
  PendingMutationRebaseRequiresPullError,
} from './sync.js';
