# Architecture

UnKeep is a pnpm monorepo. The web app and the CLI share one client library and
speak the same encrypted sync protocol to the same relay.

```text
packages/core/      Note types, validation, Markdown, AES-GCM envelopes and recovery kits
packages/client/    RelayClient, EncryptedSync, device keys, pairing (Node and browser)
apps/web/           SvelteKit static PWA (Svelte 5 runes, Tailwind 4)
apps/cli/           The `unkeep` command
apps/server/        Node 22.13+ relay: SQLite ciphertext store and PWA host, no npm dependencies
```

`core` and `client` must be built, in that order, before the web app or CLI can
use them; `pnpm dev` and `pnpm build` do this for you.

The supported storage path is the browser's IndexedDB working copy plus
`EncryptedSync` and the SQLite relay. The Git, S3, local Markdown, and
selectable-adapter code under `packages/core/src/adapters/` is experimental and
not a supported backend.

## Write and sync flow

```text
Browser edit
  -> noteStore (apps/web/src/lib/noteStore.svelte.ts)
  -> note and attachment bytes saved in IndexedDB
  -> pending note/attachment queues
  -> EncryptedSync (@unkeep/client)
  -> AES-256-GCM envelopes
  -> relay SQLite records
```

- Edits are debounced (500 ms) and written locally before anything is sent, so
  the app works offline and retries when the relay returns.
- Every write carries the revision it was based on. If another device wrote
  first, the relay rejects the stale write and the web app keeps it as a
  separately titled conflict copy.
- Attachment IDs are immutable: replacing a file creates a new ID and
  tombstones the old one.
- A note and its new attachments are published together. The client uploads
  each encrypted attachment to a private stage, then finalizes the note with
  the exact list of stages. The relay assigns the attachment and note
  revisions in one SQLite transaction, so no device ever sees an attachment
  without its note. Retrying after a lost response returns the stored result.
- On pull, the client saves notes, tombstones, and required attachment bytes
  durably *before* acknowledging the cursor, so an interrupted apply simply
  repeats.
- A connected browser opens from its local session and key without contacting
  the relay; network access only matters for syncing.

## Relay API

`GET /api/v1/status` is unauthenticated and suitable for health checks. The
rest of `/api/v1` is an internal wire format: use `@unkeep/client` or the CLI
instead of scripting raw requests.

```ts
import { RelayClient } from '@unkeep/client';

const relay = new RelayClient(endpoint, credential);
const status = await relay.status();
const { changes, cursor } = await relay.changes(0);
```

`RelayClient` is the transport. `EncryptedSync` adds encryption and cursor
handling. Callers of `EncryptedSync.pull()` must durably apply the result
before calling `acknowledge(cursor, revisions)` with what that pull returned.
A note that fails to decrypt or validate is quarantined and returned in
`quarantined`, so the caller can report it and still acknowledge later
records.

Credentials have different roles:

- **Setup token**: creates the vault once.
- **Recovery token**: mints a replacement device after every device is lost.
- **Device credentials**: read and write the vault, approve and revoke
  devices, and mint or revoke service credentials.
- **Read-only service credentials**: read identity, changes, and encrypted
  attachments.
- **Read-write service credentials**: additionally create, change, and delete
  notes and attachments. Neither service scope can use administrative
  endpoints.

## Compatibility

The packages are built together and are not published to npm. The supported
distribution is the container image. While UnKeep is `0.x`, minor releases may
break things.

| Surface | Status |
| --- | --- |
| Documented `unkeep` commands, flags, and `--json` output | Public `0.x` CLI |
| `GET /api/v1/status` | Supported health and protocol check |
| `@unkeep/core` and `@unkeep/client` exports | Internal |
| Other `/api/v1` requests and responses | Internal; use the client or CLI |
| Deep imports, `apps/web` and `apps/server` modules, `@unkeep/core/experimental` | Internal |

## CLI internals

- `login` pairs like any other device and saves the endpoint, credential, and
  vault key to `$XDG_CONFIG_HOME/unkeep/config.json` (or
  `~/.config/unkeep/config.json`) with mode `0600`. An interrupted final step
  is retried by the next command.
- Config writes are locked across processes and replaced atomically. On Linux a
  lock left by a dead process in the same PID namespace is cleared
  automatically; a lock from another container fails after ten seconds rather
  than risk two writers. Check that nothing else is using the config before
  removing it by hand.
- Flags override `UNKEEP_*` environment variables, which override the config
  file. Changing only the endpoint is refused, so saved secrets are never sent
  to a different host.
- `clip` copies the file (up to 25 MiB) into a private staging file first and
  records its intent, so an interrupted upload resumes with the same
  attachment ID. It reports success only after both the relay and the local
  cache are updated.
- The CLI is bundled in the container image. To run it from a checkout:

  ```sh
  pnpm --filter @unkeep/core build
  pnpm --filter @unkeep/client build
  pnpm --filter @unkeep/cli build
  node apps/cli/dist/bin.js --help
  ```
