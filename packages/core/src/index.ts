export type {
  Note,
  ChecklistItem,
  NoteColor,
  NoteMetadata,
  NoteAttachment,
  NoteImage,
} from './types.js';

export { MAX_NOTE_ID_LENGTH, validateNoteId, isValidNoteId } from './validation.js';

export {
  CURRENT_NOTE_SCHEMA_VERSION,
  MAX_ATTACHMENT_MIME_TYPE_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_ITEM_TEXT_LENGTH,
  MAX_NOTE_ATTACHMENTS,
  MAX_NOTE_ATTACHMENT_SIZE,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_LABEL_LENGTH,
  MAX_NOTE_LABELS,
  MAX_NOTE_TEXT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  normalizeNoteRecord,
  UnsupportedNoteSchemaVersionError,
} from './noteMigrations.js';

export type {
  EncryptedEnvelope,
  EncryptedEnvelopeV1,
  RecoveryKit,
  RecoveryKitV1,
  RecoveryKitV2,
  NoteEncryptionContext,
  AttachmentEncryptionContext,
} from './crypto.js';
export {
  assertSupportedEnvelope,
  MAX_RECOVERY_KIT_SERIALIZED_LENGTH,
  generateMasterKey,
  generateDeviceWrappingKey,
  wrapMasterKeyForDevice,
  unwrapMasterKeyForDevice,
  createRecoveryKit,
  recoverMasterKey,
  recoverLegacyMasterKey,
  exportRecoveryKit,
  importRecoveryKit,
  encryptNote,
  decryptNote,
  encryptAttachment,
  decryptAttachment,
} from './crypto.js';

export { noteToMarkdown, markdownToNote } from './markdown.js';
