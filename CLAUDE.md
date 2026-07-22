# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in the private GitHub repository `BrettKinny/UnKeep`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without aliases. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Commands

```bash
pnpm install              # install all dependencies
pnpm dev                  # build core + client, then start SvelteKit dev server at :5173
pnpm build                # production build (core, client, cli, then web)
pnpm start                # run the relay server (apps/server) on :3000
pnpm preview              # preview production build
pnpm check                # type checking across core, client, cli, and web
pnpm lint                 # eslint on the web app
pnpm test                 # all workspace tests (core, client, cli, web, server)
```

Single package: `pnpm --filter @unkeep/core build` (likewise `@unkeep/client`, `@unkeep/cli`). `core` and `client` must be built (in that order) before the web app or CLI can use them.

## Architecture

UnKeep is dual-purpose: a self-hosted Keep-style PWA for humans, and a scratchpad AI agents reach from the terminal via the `unkeep` CLI (see `docs/agent-scratchpad.md`). Both speak the same encrypted sync protocol to the same relay.

**pnpm monorepo** with five workspaces:

- `packages/core` — Pure TypeScript library. Defines the `Note` type, crypto envelopes (AES-256-GCM), validation, markdown conversion, the legacy `StorageAdapter` interface and adapters (local/IndexedDB, local-markdown, git, s3). No framework dependencies. Built with `tsc` to `dist/`.
- `packages/client` — Headless client SDK: `RelayClient`, `EncryptedSync`, device key store, pairing. Runs in Node and the browser.
- `apps/cli` — The `unkeep` binary: `login`, `provision` (mints agent env bundles), `credentials`, `list`, `get`, `put`, `delete`, `sync`, `clip`, `paste`. Auth from flags, `UNKEEP_*` env vars, or the config file; `--json` for stable machine output.
- `apps/web` — SvelteKit SPA (`adapter-static`, outputs to `apps/web/build/`). Consumes `@unkeep/core` and `@unkeep/client` as workspace dependencies.
- `apps/server` — Zero-dependency Node 22 relay: SQLite-backed sync API + static PWA host, stores only ciphertext.

### Key patterns

- **Svelte 5 runes** — all reactive state uses `$state`, `$derived`, `$props`. No legacy stores or `$:` syntax.
- **`noteStore`** (`apps/web/src/lib/noteStore.svelte.ts`) — singleton class-based store. Central state manager for notes. Uses debounced auto-save (500ms) and delegates persistence to the active `StorageAdapter`.
- **StorageAdapter interface** (`packages/core/src/adapter.ts`) — all storage backends implement `init`, `validate`, `listNotes`, `getNote`, `saveNote`, `deleteNote`, `sync`. Writes always go to IndexedDB first (offline-safe), then sync to the remote adapter.
- **Adapter registry** (`apps/web/src/lib/adapterRegistry.ts`) — maps adapter IDs to factory functions. The setup wizard uses this to let users pick a backend.
- **Quick Send** — encodes note content in URL fragment (never hits a server). Receiver page at `/recv`.
- **E2E encryption** — AES-256-GCM with PBKDF2, implemented via Web Crypto API in `apps/web/src/lib/encryption.ts`.
- **TailwindCSS v4** — configured through Vite plugin (`@tailwindcss/vite`), styles in `apps/web/src/app.css`.
- **No runtime dependencies** for S3 signing, ZIP parsing, or crypto — all hand-rolled using browser APIs.
