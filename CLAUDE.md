# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install              # install all dependencies
pnpm dev                  # build core, then start SvelteKit dev server at :5173
pnpm build                # production build (core first, then web)
pnpm preview              # preview production build
pnpm check                # svelte-kit sync + svelte-check (type checking)
pnpm lint                 # eslint on the web app
```

Core package only: `pnpm --filter @unkeep/core build` (runs `tsc`). Must be built before the web app can use it.

## Architecture

**pnpm monorepo** with two workspaces:

- `packages/core` — Pure TypeScript library. Defines the `Note` type, `StorageAdapter` interface, and adapter implementations (local/IndexedDB, local-markdown, git, s3). No framework dependencies. Built with `tsc` to `dist/`.
- `apps/web` — SvelteKit SPA (`adapter-static`, outputs to `apps/web/build/`). Consumes `@unkeep/core` as a workspace dependency.

### Key patterns

- **Svelte 5 runes** — all reactive state uses `$state`, `$derived`, `$props`. No legacy stores or `$:` syntax.
- **`noteStore`** (`apps/web/src/lib/noteStore.svelte.ts`) — singleton class-based store. Central state manager for notes. Uses debounced auto-save (500ms) and delegates persistence to the active `StorageAdapter`.
- **StorageAdapter interface** (`packages/core/src/adapter.ts`) — all storage backends implement `init`, `validate`, `listNotes`, `getNote`, `saveNote`, `deleteNote`, `sync`. Writes always go to IndexedDB first (offline-safe), then sync to the remote adapter.
- **Adapter registry** (`apps/web/src/lib/adapterRegistry.ts`) — maps adapter IDs to factory functions. The setup wizard uses this to let users pick a backend.
- **Quick Send** — encodes note content in URL fragment (never hits a server). Receiver page at `/recv`.
- **E2E encryption** — AES-256-GCM with PBKDF2, implemented via Web Crypto API in `apps/web/src/lib/encryption.ts`.
- **TailwindCSS v4** — configured through Vite plugin (`@tailwindcss/vite`), styles in `apps/web/src/app.css`.
- **No runtime dependencies** for S3 signing, ZIP parsing, or crypto — all hand-rolled using browser APIs.
