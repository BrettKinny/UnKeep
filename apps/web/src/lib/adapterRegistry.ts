import { LocalOnlyAdapter, GitAdapter, S3Adapter, WebDAVAdapter, LocalMarkdownAdapter } from '@unkeep/core';
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
];

export function getAdapter(id: string): StorageAdapter {
  const entry = adapters.find(a => a.id === id);
  if (!entry) throw new Error(`Unknown adapter: ${id}`);
  return entry.create();
}
