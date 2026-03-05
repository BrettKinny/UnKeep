export type {
  Note,
  ChecklistItem,
  NoteColor,
  NoteMetadata,
} from './types.js';

export type {
  AdapterConfig,
  ValidationResult,
  SyncResult,
  ConfigField,
  StorageAdapter,
} from './adapter.js';

export { LocalOnlyAdapter } from './adapters/local.js';
export { GitAdapter } from './adapters/git.js';
export { S3Adapter } from './adapters/s3.js';
export { WebDAVAdapter } from './adapters/webdav.js';
export { LocalMarkdownAdapter } from './adapters/local-markdown.js';
