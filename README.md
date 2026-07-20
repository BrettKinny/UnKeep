# UnKeep

*Your notes. Your storage.*

UnKeep is a privacy-first, open-source notes vault that serves two purposes at once:

1. **A self-hosted Google Keep replacement** — an installable PWA with pinning, colors, checklists, search, archive, and a Takeout importer, backed by your own tiny sync server.
2. **A scratchpad for AI agents and scripts** — the same notes, reachable from any terminal through the `unkeep` CLI. Provision an agent with three environment variables and it can read, write, search, and delete notes (and clip files) non-interactively; everything it writes appears as cards in your browser. See the [agent scratchpad guide](docs/agent-scratchpad.md).

Notes and images are encrypted client-side before upload, while every device keeps a local working copy for offline-first editing.

Run it as a single Docker container on your own hardware (Unraid, a VPS, a NUC under the desk). The server stores only ciphertext and per-device credential hashes — it never sees your vault key or plaintext.

## Quick Start

### Self-host (recommended)

```bash
git clone https://github.com/BrettKinny/UnKeep.git
cd UnKeep
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose up --build -d      # → http://localhost:3000
```

Put port 3000 behind an HTTPS reverse proxy, Tailscale Serve, or Cloudflare Tunnel. Browsers block the cryptography and PWA features UnKeep needs on insecure non-local origins.

Open the HTTPS address. On the first device, enter the setup token once — it's exchanged for a revocable device credential and cannot be reused. Save the recovery kit when prompted. See the [self-hosting guide](docs/self-hosting.md) for pairing additional devices, backups, and Unraid settings.

### Terminal & agent access

After building (`pnpm build`), the `unkeep` CLI (`apps/cli/dist/bin.js`) talks to the same vault:

```bash
unkeep login                                   # pair this terminal (approve on any device)
unkeep put --title "Idea" --content "…"        # create a note (prints the generated ID)
unkeep list -q idea --json                     # sync + search, stable JSON output
unkeep get <id>                                # print a note's content
unkeep delete <id>                             # remove it everywhere
unkeep clip ./file.pdf && unkeep paste         # encrypted cross-machine file clipboard
```

For headless use — CI jobs, cron scripts, AI coding agents — mint a revocable service credential with `unkeep provision --name <agent>` and export the three environment variables it prints. The [agent scratchpad guide](docs/agent-scratchpad.md) covers provisioning, JSON output, conventions, and a drop-in `CLAUDE.md`/`AGENTS.md` snippet.

### Develop locally

```bash
pnpm install
pnpm dev          # builds core, then starts SvelteKit dev server → http://localhost:5173
```

Other useful commands:

```bash
pnpm build        # build core, client, CLI, and web (PWA output in apps/web/build/)
pnpm start        # run the relay server (apps/server)
pnpm test         # all workspace tests (core, client, cli, web, server)
pnpm check        # svelte-kit sync + svelte-check (type checking)
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
- **Terminal CLI** — `unkeep list/get/put/delete/sync` against the same encrypted vault, with `--json` output, stdin piping, and label/search filters.
- **Agent-friendly** — mint per-agent service credentials (`unkeep provision`) so AI agents and scripts get non-interactive, revocable access via three env vars.
- **File clipboard** — `unkeep clip <file>` / `unkeep paste` moves encrypted files between machines (and the browser).

## Architecture

UnKeep is a **pnpm monorepo** with five workspaces:

```
UnKeep/
├── packages/core/          ← Pure TypeScript library (no framework deps)
│   └── src/
│       ├── types.ts         # Note, ChecklistItem, NoteColor, NoteImage
│       ├── adapter.ts       # StorageAdapter interface
│       ├── adapters/        # Legacy adapter implementations
│       │   ├── local.ts     #   IndexedDB (default, offline-first)
│       │   ├── local-markdown.ts  #   File System Access API
│       │   ├── git.ts       #   GitHub / Gitea / Forgejo
│       │   └── s3.ts        #   AWS S3 / MinIO / R2 / B2
│       ├── crypto.ts        # AES-256-GCM envelopes, key wrapping, recovery kit
│       ├── markdown.ts      # Note ↔ Markdown conversion
│       ├── oauth.ts         # PKCE helpers
│       └── validation.ts    # Input sanitization
│
├── packages/client/        ← Headless client SDK (Node + browser)
│   └── src/                 # RelayClient, EncryptedSync, device keys, pairing
│
├── apps/cli/               ← `unkeep` terminal client / agent interface
│   └── src/                 # login, provision, list/get/put/delete, sync, clip/paste
│
├── apps/web/               ← SvelteKit SPA (adapter-static)
│   └── src/
│       ├── lib/
│       │   ├── noteStore.svelte.ts   # Central state (Svelte 5 runes)
│       │   ├── adapterRegistry.ts    # Legacy adapter discovery + factory
│       │   ├── encryption.ts         # Browser crypto helpers
│       │   ├── encryptedSync.ts      # Encrypts records, speaks sync protocol
│       │   ├── relayClient.ts        # HTTP client for the UnKeep relay
│       │   ├── keyStore.ts           # Master key wrapping + device trust
│       │   ├── devicePairing.ts     # Pair new devices via short code
│       │   ├── quickSend.ts          # Compress + base64url encode
│       │   ├── keepImporter.ts       # Google Takeout ZIP parser
│       │   └── components/           # UI components
│       └── routes/                   # SvelteKit pages
│
├── apps/server/            ← Zero-dependency Node 22 relay server
│   └── src/index.mjs       # SQLite-backed sync API + static PWA host
│
├── Dockerfile              # Multi-stage build: pnpm build → node:22-alpine
├── compose.yaml            # Single-container compose definition
├── pnpm-workspace.yaml
└── package.json
```

### How the pieces connect

1. **`@unkeep/core`** defines the data model (`Note` type), the `StorageAdapter` interface, and the crypto envelope layer (`crypto.ts`). It has no framework dependencies — it's just TypeScript compiled with `tsc`. You need to build it before the web app can use it (`pnpm --filter @unkeep/core build`).

2. **`@unkeep/client`** is the headless client SDK: relay HTTP client, encrypted sync, device key store, and pairing flows. It runs in Node and the browser, and is what makes non-browser clients (the CLI, future bots) first-class citizens of the vault.

3. **`apps/cli`** wraps `@unkeep/client` in the `unkeep` binary — the terminal and agent interface. It authenticates from flags, environment variables, or the config file written by `unkeep login`, and emits stable JSON with `--json`.

4. **`apps/web`** is the SvelteKit frontend. It imports `@unkeep/core` as a workspace dependency and uses it to read/write notes through the active storage path.

5. **`noteStore`** (`apps/web/src/lib/noteStore.svelte.ts`) is the singleton reactive store that owns all note state. It uses Svelte 5 runes (`$state`, `$derived`) for reactivity. When you create, edit, or delete a note, the store debounces the write (500ms) and delegates persistence to IndexedDB, then queues an encrypted sync.

6. **`EncryptedSync`** (`apps/web/src/lib/encryptedSync.ts`) + **`relayClient`** (`apps/web/src/lib/relayClient.ts`) encrypt records before they leave the browser and speak the versioned UnKeep HTTP sync protocol to the relay.

7. **`apps/server`** is a zero-dependency Node 22 server backed by SQLite (`/data/unkeep.sqlite`). It serves the built PWA and the sync API from one container. It stores only ciphertext envelopes, device credential hashes, and pairing state — never the vault key.

### Data flow

```
User action (type, pin, delete, …)
  → noteStore.updateNote()
    → debounced save (500ms)
      → adapter.saveNote()
        → IndexedDB (always, for offline safety)
        → encrypted pending write
        → UnKeep relay server
```

All writes hit IndexedDB first. This means the app is always usable offline — remote sync happens in the background and can fail without data loss.

## Legacy Storage Adapters

Before the self-hosted relay existed, UnKeep supported direct-to-backend storage adapters (Git, S3, File System Access, local-only). These remain in `packages/core` for experimentation, but the default onboarding flow now uses the encrypted relay.

The core abstraction is the **`StorageAdapter` interface** (`packages/core/src/adapter.ts`):

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

| Adapter | What it does | Config needed |
|---------|-------------|---------------|
| **Local Only** | Stores notes in browser IndexedDB. No network, no setup. | None |
| **Local Markdown** | Saves each note as a `.md` file in a folder on your device using the File System Access API. Works in Chrome and Edge. | Pick a directory |
| **Git** | Stores notes as Markdown files in a GitHub, Gitea, or Forgejo repo. Syncs via the platform's REST API. | API URL, owner, repo, personal access token |
| **S3** | Stores notes as JSON objects in any S3-compatible bucket. Signs requests client-side using AWS Signature V4 (no SDK needed). | Endpoint, region, bucket, access key, secret key |

To add a new adapter: create a file in `packages/core/src/adapters/` implementing `StorageAdapter`, export it from `packages/core/src/index.ts`, and register it in `apps/web/src/lib/adapterRegistry.ts`.

## Key Design Decisions

- **Client-side encryption, opaque relay.** The UI and all encryption run in the browser. The server stores only ciphertext and per-device credential hashes.
- **Offline-first.** Every write goes to IndexedDB before hitting any remote backend. The app works without a network connection.
- **No runtime dependencies for crypto/S3/ZIP.** S3 request signing (AWS Sig V4), AES-256-GCM encryption, PBKDF2 key derivation, and Google Takeout ZIP parsing are all implemented using browser-native APIs (`Web Crypto`, `CompressionStream`, `ReadableStream`). The relay server likewise ships zero npm dependencies — just Node's built-in `http`, `crypto`, and `node:sqlite`.
- **Svelte 5 runes only.** All reactive state uses `$state`, `$derived`, and `$props`. No legacy `$:` syntax or Svelte stores.

## Deploying

### Docker (recommended)

```bash
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
docker compose up --build -d
```

The container builds the PWA and relay in one image, serves both on port 3000, and persists data to `/data`. Works on Unraid, Docker on a VPS, or any host with Docker installed. See the [self-hosting guide](docs/self-hosting.md) for Unraid-specific settings, reverse proxy guidance, backups, and device pairing.

### Build from source

```bash
pnpm build
pnpm start        # serves apps/web/build/ + sync API on :3000
```

Requires Node 22+ (for `node:sqlite`). Set `UNKEEP_DATA_DIR` and `UNKEEP_WEB_DIR` if you need to relocate the database or built PWA.

## Tech Stack

- [SvelteKit](https://svelte.dev/docs/kit) — SPA mode with `adapter-static`
- [Svelte 5](https://svelte.dev/docs/svelte) — runes-based reactivity
- [TypeScript](https://www.typescriptlang.org/) — throughout core and web
- [TailwindCSS v4](https://tailwindcss.com/) — via Vite plugin
- [Node 22](https://nodejs.org/) — relay server with built-in `node:sqlite`
- [pnpm](https://pnpm.io/) — workspace management

## License

[MIT](LICENSE)
