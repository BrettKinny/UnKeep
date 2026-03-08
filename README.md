# UnKeep

*Your notes. Your storage.*

A privacy-first, open-source PWA for ephemeral note-taking. Fast, lightweight, and free from vendor lock-in. Pluggable storage backends, optional end-to-end encryption, and zero server components.

## Quick Start

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

Build for production:

```bash
pnpm build
pnpm preview    # preview the production build locally
```

## Features

- **Instant note-taking** — open, type, close. Auto-saves with 500ms debounce
- **Checklist notes** — toggle between text and checklist mode per note
- **Masonry card grid** with pinned notes at top
- **Note colors** — 11-color Keep-style palette
- **Archive & soft delete** with undo snackbar
- **Search** across all note content (client-side)
- **Dark mode** — follows OS preference, manually toggleable
- **Markdown preview** — per-note toggle
- **Copy to clipboard** — one tap
- **PWA** — installable on iOS, Android, desktop with full offline support

### Beyond Keep

- **Takeout importer** — drag-drop a Takeout ZIP and import all notes, checklists, colors, and timestamps
- **Quick Send** — generate a share link with the note content encoded in the URL fragment (never hits a server)
- **E2E encryption** — AES-256-GCM with PBKDF2 key derivation; passphrase never stored
- **Pluggable storage** — swap backends without changing anything else

## Storage Adapters

| Adapter | Covers | Config |
|---------|--------|--------|
| **Local Only** | Browser IndexedDB | None |
| **Git** | GitHub, Gitea, Forgejo | API URL, owner, repo, token |
| **S3** | AWS S3, MinIO, Cloudflare R2, Backblaze B2 | Endpoint, bucket, credentials |
| **Local Markdown** | Local filesystem (File System Access API) | Directory picker |

All writes hit IndexedDB first (offline-safe, immediate), then sync to the remote adapter.

## Project Structure

```
├── packages/core/        # Types, StorageAdapter interface, adapters
│   └── src/
│       ├── types.ts       # Note, ChecklistItem, NoteColor
│       ├── adapter.ts     # StorageAdapter interface
│       └── adapters/      # local, local-markdown, git, s3
├── apps/web/             # SvelteKit SPA
│   └── src/
│       ├── lib/           # Stores, utilities, components
│       └── routes/        # Pages (main app + Quick Send receiver)
├── package.json          # Workspace root
└── pnpm-workspace.yaml
```

## Tech Stack

- **SvelteKit** (SPA mode with `adapter-static`)
- **Svelte 5** with runes (`$state`, `$derived`, `$props`)
- **TypeScript** throughout
- **TailwindCSS v4**
- **Web Crypto API** for encryption
- **No external runtime dependencies** for S3 signing, ZIP parsing, or crypto

## Deploying

### Vercel

Point Vercel at the repo. The `vercel.json` at the root handles build commands and SPA rewrites.

### Any Static Host

```bash
pnpm build
# Serve apps/web/build/ with any static server
# Configure a fallback to index.html for SPA routing
```

Works with Netlify, Cloudflare Pages, GitHub Pages, nginx, Caddy, etc.

## License

MIT
