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
export { DropboxAdapter } from './adapters/dropbox.js';
export { GoogleDriveAdapter } from './adapters/googledrive.js';
export { OneDriveAdapter } from './adapters/onedrive.js';
export { PCloudAdapter } from './adapters/pcloud.js';
