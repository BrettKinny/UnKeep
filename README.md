# UnKeep

*Your notes. Your storage.*

UnKeep is a privacy-first, open-source note-taking PWA with its own small, self-hostable sync protocol. Notes and images are encrypted in the browser before upload, while every device keeps an IndexedDB working copy for local-first editing.

It's built as a static single-page app (SPA). You can host it on any static file server or use it as an installable PWA on your phone or desktop. Everything — encryption, sync, ZIP parsing, S3 request signing — happens client-side with zero runtime dependencies beyond the browser itself.

## Quick Start

```bash
git clone https://github.com/BrettKinny/UnKeep.git
cd UnKeep
pnpm install
pnpm dev          # → http://localhost:5173
```

`pnpm dev` builds the core library first, then starts the SvelteKit dev server with hot reload.

For a production build:

```bash
pnpm build        # outputs to apps/web/build/
pnpm preview      # preview the production build locally
```

Other useful commands:

```bash
pnpm check        # type-check the SvelteKit app
pnpm lint         # eslint on the web app
```

## Features

- **Instant note-taking** — open, type, close. Auto-saves with 500ms debounce.
- **Checklist notes** — toggle between text and checklist mode per note.
- **Masonry card grid** — pinned notes float to the top.
- **Note colors** — 11-color palette (just like Google Keep).
- **Archive & soft delete** — with undo snackbar so you can recover mistakes.
- **Search** — full-text client-side search across all notes.
- **Dark mode** — follows OS preference, manually toggleable.
- **Markdown preview** — per-note toggle for rendered Markdown.
- **PWA** — installable on iOS, Android, and desktop with full offline support.
- **Takeout importer** — drag-drop a Google Takeout ZIP to import all your Keep notes, checklists, colors, and timestamps.
- **Quick Send** — share a note via URL. The content is compressed and encoded in the URL fragment (`#`), so it never touches a server.
- **E2E encryption** — versioned AES-256-GCM envelopes for notes and images, using a random master key wrapped per trusted device.
- **Cross-device sync** — encrypted UnKeep relay with revision cursors, tombstones, pairing, and offline retry.

## Architecture

UnKeep is a **pnpm monorepo** with two packages:

```
UnKeep/
├── packages/core/          ← Pure TypeScript library (no framework deps)
│   └── src/
│       ├── types.ts         # Note, ChecklistItem, NoteColor
│       ├── adapter.ts       # StorageAdapter interface
│       ├── adapters/        # Adapter implementations
│       │   ├── local.ts     #   IndexedDB (default, offline-first)
│       │   ├── local-markdown.ts  #   File System Access API
│       │   ├── git.ts       #   GitHub / Gitea / Forgejo
│       │   └── s3.ts        #   AWS S3 / MinIO / R2 / B2
│       ├── markdown.ts      # Note ↔ Markdown conversion
│       └── validation.ts    # Input sanitization
│
├── apps/web/               ← SvelteKit SPA (adapter-static)
│   └── src/
│       ├── lib/
│       │   ├── noteStore.svelte.ts   # Central state (Svelte 5 runes)
│       │   ├── adapterRegistry.ts    # Adapter discovery + factory
│       │   ├── encryption.ts         # AES-256-GCM via Web Crypto
│       │   ├── quickSend.ts          # Compress + base64url encode
│       │   ├── keepImporter.ts       # Google Takeout ZIP parser
│       │   └── components/           # UI components
│       └── routes/                   # SvelteKit pages
│
├── pnpm-workspace.yaml
└── package.json
```

### How the pieces connect

1. **`@unkeep/core`** defines the data model (`Note` type) and the `StorageAdapter` interface. It has no framework dependencies — it's just TypeScript compiled with `tsc`. You need to build it before the web app can use it (`pnpm --filter @unkeep/core build`).

2. **`apps/web`** is the SvelteKit frontend. It imports `@unkeep/core` as a workspace dependency and uses it to read/write notes through whichever adapter the user has configured.

3. **`noteStore`** (`apps/web/src/lib/noteStore.svelte.ts`) is the singleton reactive store that owns all note state. It uses Svelte 5 runes (`$state`, `$derived`) for reactivity. When you create, edit, or delete a note, the store debounces the write (500ms) and delegates persistence to the active `StorageAdapter`.

4. **`EncryptedSync`** (`apps/web/src/lib/encryptedSync.ts`) encrypts records before they leave the browser and speaks the versioned UnKeep HTTP sync protocol.

### Data flow

```
User action (type, pin, delete, …)
  → noteStore.updateNote()
    → debounced save (500ms)
      → adapter.saveNote()
        → IndexedDB (always, for offline safety)
        → encrypted pending write
        → UnKeep sync server
```

All writes hit IndexedDB first. This means the app is always usable offline — remote sync happens in the background and can fail without data loss.

## Backend

The reference backend is a zero-dependency Node 22 server using SQLite. It serves the PWA and sync API from one container. See [the self-hosting guide](docs/self-hosting.md).

Legacy experimental adapters remain in `packages/core`, but they are not offered by the PoC onboarding flow.

## Legacy Storage Adapters

The core abstraction in UnKeep is the **`StorageAdapter` interface** (`packages/core/src/adapter.ts`). Every storage backend implements the same contract:

```typescript
interface StorageAdapter {
  id: string;
  displayName: string;
  description: string;
  configSchema: ConfigField[];       // drives the setup wizard UI

  init(config: AdapterConfig): Promise<void>;
  validate(config: AdapterConfig): Promise<ValidationResult>;
  listNotes(): Promise<NoteMetadata[]>;
  getNote(id: string): Promise<Note>;
  saveNote(note: Note): Promise<void>;
  deleteNote(id: string): Promise<void>;
  sync(): Promise<SyncResult>;
}
```

This means you can swap where your notes are stored without changing anything else — the UI, sync logic, and encryption layer don't care which adapter is active.

### Built-in adapters

| Adapter | What it does | Config needed |
|---------|-------------|---------------|
| **Local Only** | Stores notes in browser IndexedDB. No network, no setup. | None |
| **Local Markdown** | Saves each note as a `.md` file in a folder on your device using the File System Access API. Works in Chrome and Edge. | Pick a directory |
| **Git** | Stores notes as Markdown files in a GitHub, Gitea, or Forgejo repo. Syncs via the platform's REST API. | API URL, owner, repo, personal access token |
| **S3** | Stores notes as JSON objects in any S3-compatible bucket. Signs requests client-side using AWS Signature V4 (no SDK needed). | Endpoint, region, bucket, access key, secret key |

### Writing your own adapter

To add a new storage backend:

1. Create a new file in `packages/core/src/adapters/` that implements `StorageAdapter`.
2. Export it from `packages/core/src/index.ts`.
3. Register it in `apps/web/src/lib/adapterRegistry.ts` so the setup wizard picks it up.

The `configSchema` array on your adapter drives the setup wizard automatically — each `ConfigField` becomes a form input:

```typescript
configSchema: [
  { key: 'apiUrl', label: 'API URL', type: 'url', required: true },
  { key: 'token', label: 'Access Token', type: 'password', required: true },
]
```

## Key Design Decisions

- **Client-side encryption, opaque relay.** The UI and all encryption run in the browser. The server stores only ciphertext and per-device credential hashes.
- **Offline-first.** Every write goes to IndexedDB before hitting any remote backend. The app works without a network connection.
- **No runtime dependencies for crypto/S3/ZIP.** S3 request signing (AWS Sig V4), AES-256-GCM encryption, PBKDF2 key derivation, and Google Takeout ZIP parsing are all implemented using browser-native APIs (`Web Crypto`, `CompressionStream`, `ReadableStream`). This keeps the bundle small and avoids supply-chain risk.
- **Svelte 5 runes only.** All reactive state uses `$state`, `$derived`, and `$props`. No legacy `$:` syntax or Svelte stores.

## Deploying

### Vercel

Point Vercel at the repo. The `vercel.json` at the root handles build commands and SPA rewrites.

### Any Static Host

```bash
pnpm build
# Serve apps/web/build/ with any static file server
# Configure a fallback to index.html for SPA routing
```

Works with Netlify, Cloudflare Pages, GitHub Pages, nginx, Caddy, S3 + CloudFront, etc.

## Tech Stack

- [SvelteKit](https://svelte.dev/docs/kit) — SPA mode with `adapter-static`
- [Svelte 5](https://svelte.dev/docs/svelte) — runes-based reactivity
- [TypeScript](https://www.typescriptlang.org/) — throughout both packages
- [TailwindCSS v4](https://tailwindcss.com/) — via Vite plugin
- [pnpm](https://pnpm.io/) — workspace management

## License

MIT
