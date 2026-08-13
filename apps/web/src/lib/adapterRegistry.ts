import { LocalOnlyAdapter, type StorageAdapter } from '@unkeep/core/experimental';

export interface AdapterEntry {
  id: string;
  displayName: string;
  description: string;
  create: () => StorageAdapter | Promise<StorageAdapter>;
}

export const adapters: AdapterEntry[] = [
  {
    id: 'local',
    displayName: 'Local Only',
    description: 'Store notes in your browser. No sync, no account needed.',
    create: () => new LocalOnlyAdapter(),
  },
  {
    id: 'local-markdown',
    displayName: 'Local Markdown Files',
    description: 'Save notes as .md files in a folder on your device (Chrome/Edge).',
    create: async () => {
      const { LocalMarkdownAdapter } = await import('@unkeep/core/experimental');
      return new LocalMarkdownAdapter();
    },
  },
  {
    id: 'git',
    displayName: 'Git Repository',
    description: 'Store notes as markdown files in a GitHub, Gitea, or Forgejo repository.',
    create: async () => {
      const { GitAdapter } = await import('@unkeep/core/experimental');
      return new GitAdapter();
    },
  },
  {
    id: 's3',
    displayName: 'S3-Compatible Storage',
    description: 'Store notes in any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Backblaze B2).',
    create: async () => {
      const { S3Adapter } = await import('@unkeep/core/experimental');
      return new S3Adapter();
    },
  },
];

export async function getAdapter(id: string): Promise<StorageAdapter> {
  const entry = adapters.find(a => a.id === id);
  if (!entry) throw new Error(`Unknown adapter: ${id}`);
  return entry.create();
}
