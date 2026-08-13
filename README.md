# UnKeep

*Your notes. Your storage.*

UnKeep is a privacy-first, open-source notes vault serving two purposes: a
single-user, self-hosted alternative to Google Keep and a scratchpad for AI
agents and scripts. It combines a local IndexedDB working copy with a small
encrypted sync relay: notes and attachments are encrypted on the client before
upload, and the relay stores only ciphertext, credential hashes, and sync
metadata.

UnKeep is an independent project and is not affiliated with or endorsed by
Google. Google and Google Keep are trademarks of Google LLC.

The PWA, relay, and `unkeep` CLI ship as one Docker container. A browser can also connect to a separately hosted relay, while terminals and agents can use the same vault through the CLI. See the [agent scratchpad guide](docs/agent-scratchpad.md).

## Quick start

### Self-host the release image

Download the release Compose file, then create separate setup and
operator-recovery secrets before starting the container:

```sh
set -eu
mkdir unkeep && cd unkeep
release_url=https://github.com/BrettKinny/UnKeep/releases/download/v0.2.0-rc.1
curl -fsSLO "$release_url/compose.release.yaml"
curl -fsSLO "$release_url/unkeep-0.2.0-rc.1-image-digest.txt"
curl -fsSLO "$release_url/SHA256SUMS"
grep -E \
  '^[0-9a-f]{64}  (compose\.release\.yaml|unkeep-0\.2\.0-rc\.1-image-digest\.txt)$' \
  SHA256SUMS > RELEASE_SHA256SUMS
test "$(wc -l < RELEASE_SHA256SUMS)" -eq 2
sha256sum --check --strict RELEASE_SHA256SUMS
rm RELEASE_SHA256SUMS
release_digest="$(
  sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' \
    unkeep-0.2.0-rc.1-image-digest.txt
)"
printf '%s\n' "$release_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
mv compose.release.yaml compose.yaml
install -d -m 700 data
sudo chown 1000:1000 data
install -m 600 /dev/null .env
{
  printf 'UNKEEP_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_RECOVERY_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_IMAGE=ghcr.io/brettkinny/unkeep@%s\n' "$release_digest"
} > .env
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

UnKeep is now available at `http://localhost:3000`. Put port 3000 behind HTTPS before exposing it beyond localhost; the browser APIs used for encryption and offline installation require a secure context on non-local origins.

Keep `.env` at mode `0600`; it contains administrative secrets. The source
repository ignores `.env`, but a standalone deployment directory is not
automatically protected from backup or sharing. Never commit it or store it
with both the recovery kit and server backup.

The first pull is pinned to the multi-architecture digest recorded by the same
release, rather than executing the mutable registry version tag. Keep that
`UNKEEP_IMAGE` line when recreating the service. See
[docs/self-hosting.md](docs/self-hosting.md) for provenance checks and the
complete procedure.

To audit and build the source instead, clone the repository and use its
development Compose file:

```sh
git clone --branch v0.2.0-rc.1 https://github.com/BrettKinny/UnKeep.git
cd UnKeep
install -d -m 700 data
sudo chown 1000:1000 data
install -m 600 /dev/null .env
release_sha="$(git rev-parse HEAD)"
{
  printf 'UNKEEP_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_RECOVERY_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_BUILD_VERSION=0.2.0-rc.1\n'
  printf 'UNKEEP_BUILD_REVISION=%s\n' "$release_sha"
} > .env
docker compose --env-file .env up --build -d
```

Open the site and enter `UNKEEP_SETUP_TOKEN`. The first browser creates the vault key locally and requires you to download a recovery kit **before** it initializes the relay and claims the one-time setup token. Store the recovery kit and `UNKEEP_RECOVERY_TOKEN` separately and securely. Recovering after every trusted device is lost requires both: the kit restores the encryption key, while the operator token authorizes a replacement device credential.

See [docs/self-hosting.md](docs/self-hosting.md) for additional-device pairing, recovery, revocation, backups, Unraid, Tailscale, and deployment settings.

### Terminal and agent access

The image also provides a separate one-shot CLI service. Its key-storage
volume is never mounted into the relay container:

```sh
docker compose --env-file .env run --rm --no-deps unkeep-cli --help
docker compose --env-file .env run --rm --no-deps unkeep-cli login --endpoint http://unkeep:3000
docker compose --env-file .env run --rm --no-deps unkeep-cli list
```

These commands assume the relay is already running. `--no-deps` prevents a
one-shot CLI invocation from starting or waiting for the relay service; omit it
when you deliberately want Compose to start that dependency and leave it
running. The explicit CLI target activates its `cli` profile automatically.

For durable automation, mint a revocable service credential with `unkeep provision --name <agent>` and export the `UNKEEP_ENDPOINT`, `UNKEEP_CREDENTIAL`, and `UNKEEP_VAULT_KEY` values it prints. Retain the server-confirmed `UNKEEP_SCOPE` metadata with that bundle. Provisioning defaults to read-only relay access; add `--scope read-write` only when the agent must change notes or attachments. See the [agent scratchpad guide](docs/agent-scratchpad.md) for conventions and non-interactive setup.

The `unkeep-cli-config` volume contains a plaintext note snapshot, the raw
vault key, and a bearer credential. Protect it like a browser profile. Do not run `unkeep login` through
`docker compose exec unkeep`: the relay filesystem is read-only, and the
relay service must not share client key storage.

Container file transfer is opt-in. Mount only a dedicated transfer directory,
read-only when uploading and writable when downloading:

```sh
install -d -m 700 transfer
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:ro" --workdir /transfer \
  unkeep-cli clip ./report.pdf
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:rw" --workdir /transfer \
  unkeep-cli paste
```

Do not mount a home directory or repository merely for convenience.

### Develop from source

The repository requires Node.js 22.13.0 or newer and pnpm 10.

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` builds `@unkeep/core` and `@unkeep/client`, then starts the web development server at `http://localhost:5173`. The development UI still needs a running relay endpoint. To exercise the integrated production build locally instead:

```sh
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
export UNKEEP_RECOVERY_TOKEN="$(openssl rand -base64 32)"
pnpm build
pnpm start
```

Useful root commands:

```sh
pnpm build        # build core, client, CLI, and the static PWA
pnpm start        # serve apps/web/build and /api/v1 on loopback port 3000
pnpm test         # test core, client, CLI, web, and server
pnpm check        # build libraries, then type-check the CLI and web app
pnpm lint         # lint the web app
pnpm notices:check # verify the generated production dependency notices
pnpm smoke:packages # pack and install the public packages in a clean local consumer
pnpm test:e2e     # build and exercise critical browser flows with Playwright
pnpm preview      # preview the static PWA without the relay API
```

## Implemented product

- **Notes and checklists** — titles, bodies, checklist conversion and editing, labels, pinning, archiving, 11 colors, a masonry card grid, and safe clickable HTTP(S), `www.`, and email links in rendered note text.
- **Local-first editing** — note writes go to IndexedDB first, with a 500 ms editor debounce and queued retries when the relay is unavailable.
- **Search** — client-side matching across titles, bodies, checklist items, and labels.
- **Attachments** — image previews and downloadable general files up to 25 MiB each. Bytes are saved durably in IndexedDB before upload and encrypted separately from note metadata.
- **Encrypted sync** — AES-256-GCM note and attachment envelopes, atomic note-plus-new-attachment publication, revision cursors, tombstones, optimistic revision conflict protection, durable idempotent replay after a lost mutation response, device pairing, device revocation, and restricted service credentials.
- **Recovery** — authenticated recovery-kit v2 binds the vault key to its relay instance; a separate operator token restores relay authorization after every device is lost.
- **Markdown preview** — a safe rendered subset covering headings, paragraphs, emphasis, strong text, inline and fenced code, ordered and unordered lists, line breaks, and absolute HTTP(S) links.
- **Google Keep import** — Takeout ZIPs, or selected JSON and media files, import titles, text, checklists, labels, colors, timestamps, pin/archive state, and referenced media. Trashed Keep notes are skipped; note records commit in one local transaction, failed staging rolls back, and a durable journal finalizes or removes an import interrupted by tab termination on the next startup.
- **Complete vault export and restore** — the web UI downloads one JSON file containing every currently loaded note and the bytes for every attachment. Export refuses corrupt or silently partial attachment data, and the import dialog validates the complete format, preserves collisions as copies, and uses the same transactional restore path.
- **Structured Quick Send** — a URL-fragment snapshot carries a note's title, body, checklist, labels, color, and small attachments that fit the payload budget; the receiver previews it and explicitly saves it to their vault. Existing text-only links remain readable.
- **Share sheet integration** — Android/Chrome normally POSTs into the installed PWA's active service worker, which converts the content to a local URL fragment; iOS uses the documented fragment-based Shortcut. Both paths show a preview and require confirmation before a durable vault save. If the Android worker is unavailable, the relay rejects the network fallback but the plaintext has already crossed the reverse-proxy boundary; see the threat model.
- **Installable and offline-capable PWA** — SvelteKit builds and registers a versioned service worker from `apps/web/src/service-worker.ts`. It precaches the generated application shell, falls back to that shell for offline navigation, caches same-origin assets, and never caches `/api` responses.
- **CLI and agent workflows** — pair a terminal, list/get/put/delete notes, sync a local CLI snapshot, provision revocable agent credentials, and move files through an encrypted clipboard note.

## Architecture

UnKeep is a pnpm monorepo with five main workspaces:

```text
UnKeep/
├── packages/core/          Domain types, crypto, validation, and legacy adapters
│   └── src/
│       ├── types.ts        Note, checklist, color, and attachment types
│       ├── crypto.ts       AES-GCM envelopes, key wrapping, recovery kits
│       ├── adapter.ts      Legacy StorageAdapter interface
│       └── adapters/       IndexedDB, local Markdown, Git, and S3 adapters
│
├── packages/client/        Framework-independent encrypted relay client
│   └── src/
│       ├── relay.ts        Versioned /api/v1 HTTP client
│       ├── sync.ts         Note/attachment encryption and cursor handling
│       ├── deviceKeys.ts   Device key storage and recovery
│       ├── pairing.ts      Pairing request, approval, and key transfer
│       ├── session.ts      Relay session persistence
│       └── storage.ts      Browser/CLI storage seam
│
├── apps/web/               SvelteKit static PWA
│   └── src/
│       ├── lib/noteStore.svelte.ts   Local state and sync orchestration
│       ├── lib/clientStorage.ts      IndexedDB client state
│       ├── lib/attachmentStorage.ts  Durable attachment bytes and upload queue
│       ├── lib/keepImporter.ts       Google Takeout parser
│       ├── lib/quickSend.ts          Structured fragment links
│       ├── lib/vaultExport.ts        Complete portable export format
│       └── service-worker.ts         Generated app-shell/offline policy
│
├── apps/cli/               Packable `unkeep` command
├── apps/server/            Node 22.13+ SQLite ciphertext relay and PWA host
│   └── src/index.mjs
├── Dockerfile
├── compose.yaml
└── package.json
```

`EncryptedSync` and `RelayClient` live in `packages/client`; the web app and CLI share them. The server has no application npm dependencies and uses Node's built-in HTTP, crypto, and SQLite modules.

### Write and sync flow

```text
Browser edit
  -> noteStore
  -> note metadata + attachment bytes persisted locally
  -> pending note/attachment queues
  -> @unkeep/client EncryptedSync
  -> AES-GCM envelopes
  -> relay SQLite records
```

Attachments upload before the note metadata that references them. Their IDs
are immutable: replacing bytes creates a fresh ID and tombstones the old one.
On pull, the web client persists notes, tombstones, and required attachment
bytes before acknowledging the new cursor, so an interrupted local apply can
safely retry the same relay changes.

An already connected browser loads its local session, wrapped vault key, notes, and attachments without first contacting the relay. Network reachability is a sync concern after boot, not an unlock prerequisite.

## CLI

The Docker image bundles `unkeep` for use through the isolated
`unkeep-cli` Compose service. `@unkeep/cli` is also a public release artifact.
Install the exact preview version with
`npm install --global @unkeep/cli@0.2.0-rc.1`. To run from a source checkout:

```sh
pnpm --filter @unkeep/core build
pnpm --filter @unkeep/client build
pnpm --filter @unkeep/cli build

node apps/cli/dist/bin.js --help
node apps/cli/dist/bin.js --endpoint https://notes.example.com login
```

`pnpm smoke:packages` provides the release-artifact check: it packs
`@unkeep/core`, `@unkeep/client`, and `@unkeep/cli`, installs all three
tarballs into a fresh temporary npm project without registry access, imports
the supported core and client package roots, verifies that the CLI package
declares no exports, proves every internal runtime dependency is pinned to the
same exact release version, and runs the installed `unkeep --version` binary.

`login` prints an eight-character pairing code and a four-group security
fingerprint. In the unlocked web client's device menu, review the request and
compare every fingerprint character with the terminal before approving. Cancel
on any mismatch. The CLI then saves the endpoint, device credential, vault key,
and any unfinished finalization marker in
`$XDG_CONFIG_HOME/unkeep/config.json` or `~/.config/unkeep/config.json` with
mode `0600`; a later command safely retries an interrupted finalization.

Examples after pairing with an installed package (replace `unkeep` with `node apps/cli/dist/bin.js` when running from the checkout):

```sh
unkeep list --label work
unkeep get note-id
unkeep put note-id --title "Deploy" --content "Check release"
unkeep sync
unkeep clip ./report.pdf
unkeep paste
unkeep provision --name automation-agent --scope read-write
```

`clip` copies at most 25 MiB through bounded reads into a private `0600`
staging file under the CLI config directory before changing the relay. A
durable intent lets the next connected command reuse the same attachment ID
after an interrupted upload, merge a concurrent Clipboard edit, or publish the
note-without-attachment before tombstoning bytes that can no longer be
verified. Success is printed only after the remote note reference and local
cache are durable.

`provision` mints a scoped service credential and prints an `UNKEEP_ENDPOINT`, `UNKEEP_CREDENTIAL`, `UNKEEP_VAULT_KEY`, and server-confirmed `UNKEEP_SCOPE` bundle in deterministic order. The default `read-only` scope can sync and download encrypted records but cannot mutate them or administer credentials; `--scope read-write` additionally permits note and attachment mutations. Both scopes receive the vault key and can decrypt the entire vault. Scopes cannot limit an agent to a label because labels and note contents are encrypted from the relay. Flags override the corresponding environment variables, which override the saved config. A different endpoint must be accompanied by an explicitly supplied credential and vault key, so an endpoint-only override cannot send saved secrets to another host. Add `--json` for the same stable four-field object.

## Relay API and client package

The unauthenticated protocol/status endpoint is useful for health checks:

```sh
curl "${UNKEEP_ENDPOINT%/}/api/v1/status"
```

The remaining JSON API is versioned under `/api/v1`. Setup, recovery, device, and service credentials have different authorization roles. Device credentials can manage trust and mint/revoke service credentials. Read-only service credentials can read vault identity, changes, and encrypted attachment records; read-write service credentials can additionally mutate notes and attachments. Neither service scope can use administrative endpoints.

Application code should use the package-root exports from `@unkeep/client` rather than constructing encrypted record payloads by hand:

```ts
import { RelayClient } from '@unkeep/client';

const relay = new RelayClient(endpoint, credential);
const status = await relay.status();
const { changes, cursor } = await relay.changes(0);
```

`RelayClient` exposes the transport operations; `EncryptedSync` adds
note/attachment encryption and explicit cursor acknowledgement. Callers of
`EncryptedSync.pull()` must durably apply its result before calling
`acknowledge(cursor, revisions)` with the cursor and per-record revisions
returned by that pull. The SDK durably quarantines metadata for an
undecryptable or invalid note before returning it in `quarantined`, allowing
the caller to surface the problem and acknowledge later records without
silently accepting the bad note.

Relay protocol 3 publishes a note and its new attachments as one compound
mutation. The client first uploads each context-bound encrypted attachment to
a private, credential-owned stage, then finalizes the note with the exact
sorted stage manifest and its optimistic base revision. Finalization assigns
consecutive attachment revisions followed immediately by the note revision in
one SQLite transaction, so another device cannot observe a live attachment
without its referencing note. Retrying the same compound mutation after a
lost response returns its stored receipt. Incomplete stages expire and count
toward the configured relay storage ceilings while retained. Direct creation
of a new live attachment through the legacy record route fails with HTTP 428
`compound_mutation_required`; use `EncryptedSync`, `RelayClient`, or the CLI
rather than scripting raw relay requests.

### Package and compatibility boundary

The public packages are ESM and require Node.js 20 or newer when used in Node.
Release-candidate tags publish them to npm under the `next` dist-tag through the
protected release workflow. Because the current versions are `0.x`,
semver-compatible minor releases may still contain breaking changes.

| Surface | Compatibility status |
| --- | --- |
| `@unkeep/core` package-root types, validation, migrations, Markdown, and cryptography exports | Intended public `0.x` API |
| `@unkeep/client` package-root relay, session, pairing, key, and encrypted-sync exports | Intended public `0.x` API |
| Documented `unkeep` commands, flags, and `--json` output | Intended public `0.x` CLI |
| `GET /api/v1/status` | Supported operational health/protocol check |
| Deep package imports, `apps/web` modules, `apps/server` modules, and the server test harness | Internal; no compatibility promise |
| Raw `/api/v1` request/response shapes other than status | Internal wire implementation; use `@unkeep/client` or the CLI |
| `@unkeep/cli` package-root imports | No exports; use the `unkeep` executable |
| Legacy Git, S3, local Markdown, local-only adapter, and adapter-oriented OAuth exports from `@unkeep/core` | Experimental; not part of the supported product workflow |

## Recovery, backups, and security boundaries

- The relay cannot decrypt vault contents. It stores ciphertext envelopes, credential hashes, record revisions, relay-instance-bound temporary pairing state, and short-lived hash-only consume receipts used to make pairing finalization retryable. Joining devices generate raw pairing credentials locally; the relay never stores or returns them.
- Recovery-kit v2 contains everything needed to recover the vault key and authenticates the relay instance it belongs to. Treat it like a password; downloading a new kit from an authorized device invalidates neither older kits nor existing devices. Legacy v1 kits require an explicit association warning; retained local vault data rejects a different key using a relay-scoped non-secret fingerprint.
- The required operator recovery token must differ from the one-time setup token. It can mint a replacement device credential but cannot decrypt the vault without a recovery kit. Rotating it does not revoke existing credentials; setup-token recovery is available only through the explicit legacy compatibility flag.
- Revoking a device recursively revokes its known paired descendants, their service credentials, and pending approvals. Pre-schema-v7 devices have unknown lineage; the emergency revoke-all API contains every credential before operator recovery. Neither operation can erase keys or notes already copied to a device.
- Back up the complete `/data` volume, the recovery kit, and the operator recovery token. Keep the latter two separate. A relay backup alone is ciphertext, and a recovery kit is not a backup of current note data.
- Quick Send uses compression and base64url encoding, **not encryption**. The fragment is not sent in the HTTP request, but anyone who receives or captures the complete URL can read the snapshot.

## Legacy adapter code

`packages/core/src/adapters/` still contains the earlier local-only, File System Access, Git, and S3 storage experiments. `apps/web/src/lib/components/SetupWizard.svelte` and `adapterRegistry.ts` also remain in the tree.

Those choices are **not wired into the current web route or supported onboarding flow**. The current product always uses a local IndexedDB working copy plus the encrypted UnKeep relay. The local adapter is reused internally for that working copy, but there is no live UI for selecting Git, S3, local Markdown, or a relay-free local-only mode. Their exports live under `@unkeep/core/experimental`, outside the supported package-root API, and have no compatibility promise.

## Current limitations and remaining work

- A relay represents one vault, and the browser stores one active relay session per profile. There is no multi-user account model, multiple-vault switcher, live collaboration, or shared editing.
- This preview does not reproduce every Google Keep feature. It has no reminders,
  handwriting or drawing tools, OCR, voice-note capture, or collaborative notes.
- Concurrent relay writes use optimistic revision checks, and the web client preserves a stale local edit as a separately titled conflict copy instead of silently overwriting either side. There is still no merge UI, conflict history, note version history, or trash browser; deletion only offers the immediate undo action.
- Vault export and restore operate on a complete JSON snapshot. There is no incremental or scheduled backup format, encrypted export option, selective restore UI, or server-side backup automation. Recovery-kit restore recovers keys and authorization, not exported note data.
- Browser vault exports are capped at 10,000 notes, 10,000 attachments, 32 MiB of note text, 96 MiB of attachment bytes, and a 256 MiB serialized file. Google Keep imports accept at most 10,000 selected/archive entries and 512 MiB total expanded input, with 4 MiB per Keep note JSON; recovery-kit files are capped at 64 KiB. Larger vaults need a future streaming backup format.
- Offline opening and editing require a previously loaded/installed app and an existing local session and key. First setup, device pairing, operator recovery, and remote sync require the relay. API responses are deliberately never served from cache.
- Quick Send is a static copy rather than collaboration. Note data and up to 20 small attachments share a 100 KiB uncompressed structured-payload budget, and practical URL-length limits may be lower in some sharing tools.
- Android share-target privacy depends on an active installed service worker.
  Without it, the relay rejects the plaintext fallback POST without storing or
  rendering it, but the reverse proxy and relay host have already received the
  body. The iOS fragment-based Shortcut does not send its fragment to the
  server.
- Markdown preview intentionally implements a safe subset, not full CommonMark or GitHub Flavored Markdown.
- The web and CLI enforce a 25 MiB per-file limit. The relay defaults to the same limit; raising `UNKEEP_MAX_ATTACHMENT_SIZE` alone does not raise the client limits.
- Release candidates publish `@unkeep/core`, `@unkeep/client`, and
  `@unkeep/cli` under npm's `next` dist-tag. Pin an exact prerelease version;
  the supported `0.x` boundary is the one documented above and the raw relay
  protocol remains internal.
- The legacy Git, S3, File System Access, and selectable local-only paths require product integration and current encryption/sync semantics before they can be considered supported.

## Deployment settings

The Docker image serves the PWA and relay together on port 3000 and stores its SQLite database under `/data`. The Compose file maps that directory to `./data`.

Common environment variables:

| Variable | Purpose |
| --- | --- |
| `UNKEEP_SETUP_TOKEN` | Required one-time first-device setup secret; when configured, 32-256 printable ASCII characters without whitespace |
| `UNKEEP_RECOVERY_TOKEN` | Required distinct operator recovery secret; 32-256 printable ASCII characters without whitespace |
| `UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY` | Legacy-only `1` opt-in to setup-token recovery; leave unset for fresh installs |
| `UNKEEP_ADMIN_RATE_WINDOW_MS` | Failed setup/recovery-secret rate-limit window; defaults to five minutes, maximum one day |
| `UNKEEP_ADMIN_SOURCE_RATE_LIMIT` | Failed administrative-secret attempts per network source and endpoint per window; defaults to 5, maximum 1,000 |
| `UNKEEP_ADMIN_GLOBAL_RATE_LIMIT` | Failed administrative-secret attempts per endpoint and window across all sources; defaults to 100, maximum 10,000 |
| `UNKEEP_HOST` | Validated listen IP or ASCII DNS hostname; direct source startup defaults to `127.0.0.1`, while the official container explicitly uses `0.0.0.0` internally |
| `UNKEEP_DATA_DIR` | SQLite directory; defaults to `./data` outside the image and `/data` in Docker |
| `UNKEEP_WEB_DIR` | Built PWA directory served by the relay |
| `UNKEEP_ALLOWED_ORIGIN` | Optional exact HTTP(S) CORS origin; no CORS header by default (`*` is an explicit, less restrictive option) |
| `UNKEEP_MAX_ATTACHMENT_SIZE` | Relay plaintext attachment limit in bytes; defaults to 25 MiB, hard maximum 100 MiB |
| `UNKEEP_MAX_ENCRYPTED_RECORD_BYTES` | Total serialized encrypted-envelope budget; defaults to 1 GiB, maximum 1 TiB |
| `UNKEEP_MAX_RECORDS` | Note and attachment rows including tombstones; defaults to 100,000, maximum 10,000,000 |
| `UNKEEP_MAX_ATTACHMENTS` | Attachment rows including tombstones; defaults to 10,000, maximum 1,000,000 |
| `UNKEEP_MAX_DEVICES` | Device registry rows including revoked devices; defaults to 1,000, maximum 100,000 |
| `UNKEEP_MAX_SERVICE_CREDENTIALS` | Service-credential rows including revoked credentials; defaults to 10,000, maximum 1,000,000 |
| `UNKEEP_MAX_MUTATION_RECEIPTS` | Retained recent mutation receipts; defaults to 100,000, maximum 1,000,000 |
| `UNKEEP_MUTATION_RECEIPT_TTL_MS` | Mutation replay retention; defaults to seven days, maximum 90 days |
| `UNKEEP_ATTACHMENT_STAGE_TTL_MS` | Incomplete encrypted attachment-stage inactivity window; defaults to 10 minutes, maximum one day; each continuously retained stage epoch is capped at one day |
| `UNKEEP_PAIRING_TTL_MS` | Pairing request lifetime; defaults to 10 minutes, maximum one day |
| `UNKEEP_MAX_PENDING_PAIRINGS` | Global pending-pairing cap; defaults to 100 |
| `UNKEEP_PAIRING_RATE_WINDOW_MS` | Pairing rate-limit window; defaults to 60 seconds |
| `UNKEEP_PAIRING_SOURCE_RATE_LIMIT` | Requests per source and window; defaults to 10 |
| `UNKEEP_PAIRING_GLOBAL_RATE_LIMIT` | Requests across all sources and window; defaults to 60 |
| `UNKEEP_TRUST_PROXY` | Set to `1` only behind a trusted proxy that replaces `X-Forwarded-For` |
| `PORT` | HTTP port; defaults to 3000 |

See [docs/self-hosting.md](docs/self-hosting.md) before exposing a deployment.

## Tech stack

- [SvelteKit](https://svelte.dev/docs/kit) with `adapter-static`
- [Svelte 5](https://svelte.dev/docs/svelte) runes
- [TypeScript](https://www.typescriptlang.org/) in core, client, CLI, and web
- [Tailwind CSS 4](https://tailwindcss.com/)
- Web Crypto, IndexedDB, Compression Streams, and Service Workers
- Node.js 22.13+ built-in HTTP, crypto, and unflagged SQLite for the relay
- pnpm workspaces

## License

UnKeep source and project artwork are provided under the [MIT License](LICENSE).
Dependency copyright and license texts are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and copied to
`/THIRD_PARTY_NOTICES.md` in the standalone PWA build.

The source-of-truth UnKeep icon is
[`apps/web/static/icon.svg`](apps/web/static/icon.svg); the PNG and favicon
variants are project-maintained renderings of that original in-repository
design. The icon was created for UnKeep and is not derived from Google Keep
artwork.
