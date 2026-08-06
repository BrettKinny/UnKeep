# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in the GitHub repository `BrettKinny/UnKeep`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without aliases. See `docs/agents/triage-labels.md`.

### Domain docs

Domain guidance can use a root `CONTEXT.md` and `docs/adr/` when those files
exist. See `docs/agents/domain.md`; do not assume they have already been
created.

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

- `packages/core` — Pure TypeScript domain library: note types, validation and migrations, Markdown conversion, and context-bound AES-256-GCM envelopes. It also retains legacy `StorageAdapter` experiments (IndexedDB, local Markdown, Git, and S3), which are not supported product backends. Built with `tsc` to `dist/`.
- `packages/client` — Headless client SDK: `RelayClient`, `EncryptedSync`, device key store, pairing. Runs in Node and the browser.
- `apps/cli` — The `unkeep` binary: `login`, `provision` (mints agent env bundles), `credentials`, `list`, `get`, `put`, recoverable `delete`, `restore`, `sync`, `clip`, `paste`. Auth from flags, `UNKEEP_*` env vars, or the config file; `--json` for stable machine output.
- `apps/web` — SvelteKit SPA (`adapter-static`, outputs to `apps/web/build/`). Consumes `@unkeep/core` and `@unkeep/client` as workspace dependencies.
- `apps/server` — Zero-dependency Node 22.13+ relay: SQLite-backed sync API plus static PWA host. It stores ciphertext, credential hashes, record metadata, and temporary pairing state.

### Key patterns

- **Svelte 5 runes** — all reactive state uses `$state`, `$derived`, `$props`. No legacy stores or `$:` syntax.
- **`noteStore`** (`apps/web/src/lib/noteStore.svelte.ts`) — singleton class-based store and sync orchestrator. It commits debounced edits to the local IndexedDB working copy, durably tracks pending work, and sends encrypted records through `EncryptedSync`.
- **Encrypted relay client** (`packages/client`) — owns relay transport, optimistic revisions, mutation replay, cursor acknowledgement, device sessions, and pairing. Web and CLI clients must durably apply a pull before acknowledging its cursor.
- **Device and recovery crypto** (`packages/core/src/crypto.ts`) — context-bound AES-256-GCM envelopes, per-device wrapping, and relay-bound recovery kits implemented with Web Crypto. The relay never receives the vault master key in the supported flow.
<<<<<<< HEAD
<<<<<<< HEAD
- **Sharing** — Quick Send carries an encoded, unencrypted snapshot in a URL fragment. Installed share-target handling converts operating-system shares into a local draft; `/recv` previews and requires confirmation before persistence.
=======
- **Sharing** — Outbound note sharing sends a plaintext Markdown snapshot through native Web Share, with explicit Obsidian, clipboard, download, and legacy Quick Send fallbacks when native sharing is unavailable. Quick Send carries an encoded, unencrypted snapshot in a URL fragment. Installed share-target handling converts operating-system shares into a local draft; `/recv` previews and requires confirmation before persistence.
>>>>>>> a8e4969 (Add native note sharing with Obsidian and Markdown fallbacks (#17))
=======
- **Sharing** — Outbound note sharing sends a plaintext Markdown snapshot through native Web Share, with explicit Obsidian, clipboard, download, and legacy Quick Send fallbacks when native sharing is unavailable. Quick Send carries an encoded, unencrypted snapshot in a URL fragment. Installed share-target handling converts operating-system shares into a local draft; `/recv` previews and requires confirmation before persistence.
>>>>>>> 0200690 (Integrate sharing and editor deletion with recoverable Trash)
- **Legacy adapters** — `packages/core/src/adapters/`, `adapterRegistry.ts`, and the old setup wizard remain experimental code. They are not wired into current onboarding and must not be described as supported storage options.
- **TailwindCSS v4** — configured through Vite plugin (`@tailwindcss/vite`), styles in `apps/web/src/app.css`.
- **Security boundary** — encryption protects contents from an honest-but-curious relay, not an actively compromised host serving modified PWA code. Read `THREAT_MODEL.md` before changing pairing, rendering, recovery, or authorization.
