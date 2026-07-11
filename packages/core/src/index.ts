export type {
  Note,
  ChecklistItem,
  NoteColor,
  NoteMetadata,
  NoteImage,
} from './types.js';

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

export { validateNoteId, isValidNoteId } from './validation.js';

export type {
  EncryptedEnvelope,
  EncryptedEnvelopeV1,
  RecoveryKitV1,
  NoteEncryptionContext,
  AttachmentEncryptionContext,
} from './crypto.js';
export {
  assertSupportedEnvelope,
  generateMasterKey,
  generateDeviceWrappingKey,
  wrapMasterKeyForDevice,
  unwrapMasterKeyForDevice,
  createRecoveryKit,
  recoverMasterKey,
  exportRecoveryKit,
  importRecoveryKit,
  encryptNote,
  decryptNote,
  encryptAttachment,
  decryptAttachment,
} from './crypto.js';

export { noteToMarkdown, markdownToNote } from './markdown.js';

export { LocalOnlyAdapter } from './adapters/local.js';
export { LocalMarkdownAdapter } from './adapters/local-markdown.js';
export { GitAdapter } from './adapters/git.js';
export { S3Adapter } from './adapters/s3.js';
