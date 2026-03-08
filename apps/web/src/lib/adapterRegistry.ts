import {
  LocalOnlyAdapter,
  GitAdapter,
  S3Adapter,
  WebDAVAdapter,
  LocalMarkdownAdapter,
  DropboxAdapter,
  GoogleDriveAdapter,
  OneDriveAdapter,
  PCloudAdapter,
} from '@unkeep/core';
import type { StorageAdapter } from '@unkeep/core';

export interface AdapterEntry {
  id: string;
  create: () => StorageAdapter;
}

export const adapters: AdapterEntry[] = [
  { id: 'local', create: () => new LocalOnlyAdapter() },
  { id: 'local-markdown', create: () => new LocalMarkdownAdapter() },
  { id: 'git', create: () => new GitAdapter() },
  { id: 's3', create: () => new S3Adapter() },
  { id: 'webdav', create: () => new WebDAVAdapter() },
  { id: 'dropbox', create: () => new DropboxAdapter() },
  { id: 'googledrive', create: () => new GoogleDriveAdapter() },
  { id: 'onedrive', create: () => new OneDriveAdapter() },
  { id: 'pcloud', create: () => new PCloudAdapter() },
];

export function getAdapter(id: string): StorageAdapter {
  const entry = adapters.find(a => a.id === id);
  if (!entry) throw new Error(`Unknown adapter: ${id}`);
  return entry.create();
}
