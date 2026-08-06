<p align="center">
  <img src="apps/web/static/icon.svg" alt="UnKeep icon" width="112" height="112">
</p>

<h1 align="center">UnKeep</h1>

<p align="center"><strong>Your notes. Your storage.</strong><br>
Your private, self-hosted notes vault — with a useful scratchpad for agents.</p>

<p align="center">
  <a href="https://github.com/BrettKinny/UnKeep">Source</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="docs/agent-scratchpad.md">Agent scratchpad</a> ·
  <a href="SECURITY.md">Security</a>
</p>

UnKeep is a single-user, open-source notes vault for trusted devices,
terminals, and agents. It feels like a focused Keep-style PWA, but your notes
live in a local-first browser working copy and sync through a relay you run.
Notes and attachments are encrypted in the client before they leave the
device; the relay stores ciphertext and the metadata needed to synchronize it.

UnKeep is independent software, not affiliated with or endorsed by Google.
Google and Google Keep are trademarks of Google LLC.

> [!IMPORTANT]
> **Hobby project, heavily AI-assisted.** UnKeep was built with substantial AI
> assistance in a domain outside the maintainer's primary expertise. It has
> been reviewed and dogfooded on a home server for the last couple of months,
> but it is not a polished commercial product or a substitute for an
> independent security audit. Expect rough edges, keep tested backups, and read
> the [threat model](THREAT_MODEL.md) before trusting it with important data.

## Why UnKeep?

- **Keep your data close.** Run one small Docker container on your own server,
  NAS, or home lab.
- **Keep working offline.** Edits land in IndexedDB first and sync when the
  relay is reachable.
- **Keep your tools connected.** Use the browser, the `unkeep` CLI, or a
  scoped service credential for an agent against the same vault.
- **Keep the useful parts.** Notes, checklists, labels, colors, pinning,
  archiving, search, attachments, imports, exports, Quick Send, and an
  installable offline-capable PWA.
- **Keep conflicts visible.** Optimistic revisions and explicit conflict
  copies prevent a stale device from silently overwriting newer work.

## Start here

### Run from source

This is the quickest way to try the current preview locally. Node.js 22.13+
and pnpm 10 are required.

```sh
git clone https://github.com/BrettKinny/UnKeep.git
cd UnKeep
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env                 # set two different random 32+ character tokens
docker compose --env-file .env up --build -d
```

Open <http://localhost:3000>. On first setup, UnKeep creates the vault key in
your browser and asks you to download a recovery kit before it initializes the
relay. Keep the recovery kit and `UNKEEP_RECOVERY_TOKEN` in separate failure
domains. Use HTTPS before exposing the service beyond localhost; browser
cryptography and PWA features require a secure context on non-local origins.

### Run the release image

For a deployment outside a development machine, use the release Compose file
and pin the container to the digest published with the release. The complete
procedure verifies the release signatures and checksums, configures HTTPS,
and covers upgrades and backups:

[Follow the verified release procedure in `docs/self-hosting.md`.](docs/self-hosting.md)

The first published release line is planned as the `0.2.0-rc.4` preview. Once published,
pin exact preview versions while the project is `0.x`; minor releases may
still contain breaking changes.

## Use it with an agent

The image includes an isolated, one-shot CLI service. Pair a terminal from an
already trusted device, then mint one credential per agent or environment:

```sh
docker compose --env-file .env run --rm --no-deps \
  unkeep-cli login --endpoint http://unkeep:3000
docker compose --env-file .env run --rm --no-deps \
  unkeep-cli provision --name "review bot"          # read-only by default
```

Provisioning prints `UNKEEP_ENDPOINT`, `UNKEEP_CREDENTIAL`,
`UNKEEP_VAULT_KEY`, and `UNKEEP_SCOPE`. A read-write bundle is opt-in:

```sh
docker compose --env-file .env run --rm --no-deps \
  unkeep-cli provision --name "release bot" --scope read-write
```

Then use the same vault from a terminal or script:

```sh
unkeep put --title "Build note" --content "Investigate the arm64 failure"
unkeep list -q arm64 --json
unkeep get <note-id>
unkeep clip ./report.pdf
unkeep paste
```

Both service scopes contain the vault key and can decrypt the entire vault;
scopes limit relay operations, not what an agent can read. Treat every bundle
like a password, store it in a secret manager, and revoke it when the agent or
environment is retired. Read the [agent scratchpad guide](docs/agent-scratchpad.md)
for non-interactive setup, labels, JSON output, and file-transfer details.

## What is included

| Surface | What it does |
| --- | --- |
| Web PWA | Local-first notes and checklists, search, labels, colors, pinning, archiving, attachments, imports, exports, Quick Send, and offline app shell |
| Encrypted sync | AES-256-GCM envelopes, durable queues, cursor acknowledgements, optimistic revisions, attachment transactions, pairing, recovery, and revocation |
| CLI | `login`, `list`, `get`, `put`, `delete`, `sync`, `clip`, `paste`, and service-credential provisioning |
| Relay | Small Node.js + SQLite service that stores ciphertext, credential hashes, revisions, and sync metadata |
| Packages | `@unkeep/core` for domain and crypto primitives; `@unkeep/client` for relay and sync; `@unkeep/cli` for the terminal workflow |

The supported product path is the browser's IndexedDB working copy plus
`EncryptedSync` and the SQLite relay. Legacy Git, S3, local Markdown, and
selectable-adapter code remains experimental and is not a supported storage
backend.

## Security, plainly stated

UnKeep protects note and attachment contents from an honest-but-curious relay:
the relay does not receive the vault master key. It does not protect against
an actively compromised host serving altered browser JavaScript, a compromised
trusted device, or an agent bundle that has been copied. Browser profiles,
CLI configuration, exports, backups, clipboard contents, and terminal logs can
contain plaintext or keys.

Before deploying:

- use separate, long random setup and operator-recovery tokens;
- save the recovery kit and back up the relay's complete `/data` volume,
  separately;
- use HTTPS for every non-local deployment and preserve the relay's security
  headers at the reverse proxy;
- compare every character of the pairing fingerprint on both devices;
- remember that Quick Send is an unencrypted bearer snapshot, and Android's
  share-target fallback can expose plaintext to the proxy before rejection.

See the [threat model](THREAT_MODEL.md) for the exact security boundary and
[SECURITY.md](SECURITY.md) for vulnerability reporting. The full pairing,
recovery, revocation, backup, proxy, and storage-limit guidance lives in the
[self-hosting guide](docs/self-hosting.md).

## Current boundaries

This is a `0.2.x` preview, not a multi-user collaboration service. It does not
yet provide reminders, handwriting, drawing, OCR, voice notes, shared editing,
note history, a merge UI, trash browsing, scheduled backups, selective restore,
or in-place master-key rotation. Quick Send creates a copy, not shared access;
links do not expire or revoke. Markdown preview intentionally supports a safe
subset rather than full CommonMark/GitHub Flavored Markdown.

Vault export and restore are complete JSON snapshots. The current browser and
CLI attachment limit is 25 MiB per file, and the documented export/import
limits are finite. See [self-hosting](docs/self-hosting.md) and the
[threat model](THREAT_MODEL.md) before relying on a preview deployment for
large or high-consequence data.

## Develop

```sh
corepack enable
pnpm install
pnpm dev
```

Useful commands:

```sh
pnpm build          # build core, client, CLI, and the static PWA
pnpm check          # type-check all packages and the web app
pnpm lint           # lint the web app
pnpm test           # workspace and release-safety tests
pnpm smoke:packages # pack and test the local package artifacts
pnpm test:e2e       # build and exercise critical browser flows
```

The monorepo is organized as `packages/core`, `packages/client`,
`apps/cli`, `apps/web`, and `apps/server`. The web app and CLI share the same
client-side sync protocol. See [CLAUDE.md](CLAUDE.md) for architecture and
contributor commands.

## Packages

<<<<<<< HEAD
The package-root APIs and documented CLI commands are the intended public
`0.x` surface. Deep imports, application/server modules, raw relay request
shapes, and legacy adapter exports are internal or experimental. Release
candidates are distributed through the GitHub source and release assets; the
container image is published to GHCR. Build the packages from a source
checkout, or use the bundled CLI in the release image.
=======
## Implemented product

- **Notes and checklists** — titles, bodies, checklist conversion and editing, labels, pinning, recoverable Trash, 11 colors, a masonry card grid, and safe clickable HTTP(S), `www.`, and email links in rendered note text.
- **Local-first editing** — note writes go to IndexedDB first, with a 500 ms editor debounce and queued retries when the relay is unavailable.
- **Search** — client-side matching across titles, bodies, checklist items, and labels.
- **Attachments** — image previews and downloadable general files up to 25 MiB each. Bytes are saved durably in IndexedDB before upload and encrypted separately from note metadata.
- **Encrypted sync** — AES-256-GCM note and attachment envelopes, atomic note-plus-new-attachment publication, revision cursors, tombstones, optimistic revision conflict protection, durable idempotent replay after a lost mutation response, device pairing, device revocation, and restricted service credentials.
- **Recovery** — authenticated recovery-kit v2 binds the vault key to its relay instance; a separate operator token restores relay authorization after every device is lost.
- **Markdown preview** — a safe rendered subset covering headings, paragraphs, emphasis, strong text, inline and fenced code, ordered and unordered lists, line breaks, and absolute HTTP(S) links.
- **Google Keep import** — Takeout ZIPs, or selected JSON and media files, import titles, text, checklists, labels, colors, timestamps, pin state, legacy archive metadata, and referenced media. Previously archived Keep notes appear with regular notes; trashed Keep notes are skipped. Note records commit in one local transaction, failed staging rolls back, and a durable journal finalizes or removes an import interrupted by tab termination on the next startup.
- **Complete vault export and restore** — the web UI downloads one JSON file containing every currently loaded note and the bytes for every attachment. Export refuses corrupt or silently partial attachment data, and the import dialog validates the complete format, preserves collisions as copies, and uses the same transactional restore path.
- **Outbound sharing** — the note share action sends a plaintext Markdown snapshot through the operating-system share sheet when the browser exposes one. Firefox/Zen and failed native shares fall back to explicit Obsidian, Markdown/plain-text copy, `.md` download, and legacy Quick Send actions. Attachment names are listed in text exports; attachment bytes remain in UnKeep unless Quick Send is selected.
- **Structured Quick Send** — a URL-fragment snapshot carries a note's title, body, checklist, labels, color, and small attachments that fit the payload budget; the receiver previews it and explicitly saves it to their vault. Existing text-only links remain readable.
- **Share sheet integration** — Android/Chrome normally POSTs into the installed PWA's active service worker, which converts the content to a local URL fragment; iOS uses the documented fragment-based Shortcut. Both paths show a preview and require confirmation before a durable vault save. If the Android worker is unavailable, the relay rejects the network fallback but the plaintext has already crossed the reverse-proxy boundary; see the threat model.
- **Installable and offline-capable PWA** — SvelteKit builds and registers a versioned service worker from `apps/web/src/service-worker.ts`. It precaches the generated application shell, falls back to that shell for offline navigation, caches same-origin assets, and never caches `/api` responses.
- **CLI and agent workflows** — pair a terminal, list/get/put notes, move notes through recoverable Trash, restore or permanently delete them, sync a local CLI snapshot, provision revocable agent credentials, and move files through an encrypted clipboard note.

## Architecture

UnKeep is a pnpm monorepo with five main workspaces:

```text
UnKeep/
├── packages/core/          Domain types, crypto, validation, and local working copy
│   └── src/
│       ├── types.ts        Note, checklist, color, and attachment types
│       ├── crypto.ts       AES-GCM envelopes, key wrapping, recovery kits
│       └── adapters/local.ts IndexedDB working copy and durable local outbox
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
`unkeep-cli` Compose service. The CLI is not published to npm. To run it from a
source checkout:

```sh
pnpm --filter @unkeep/core build
pnpm --filter @unkeep/client build
pnpm --filter @unkeep/cli build

node apps/cli/dist/bin.js --help
node apps/cli/dist/bin.js --endpoint https://notes.example.com login
```

`login` prints an eight-character pairing code and a four-group security
fingerprint. In the unlocked web client's device menu, review the request and
compare every fingerprint character with the terminal before approving. Cancel
on any mismatch. The CLI then saves the endpoint, device credential, vault key,
and any unfinished finalization marker in
`$XDG_CONFIG_HOME/unkeep/config.json` or `~/.config/unkeep/config.json` with
mode `0600`; a later command safely retries an interrupted finalization.

Examples after pairing through the container (replace `unkeep` with `node apps/cli/dist/bin.js` when running from the checkout):

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

### Compatibility boundary

The core, client, and CLI workspaces are private implementation packages. They
are built together with Node.js 22.13 or newer and are not published to npm.
The supported distribution is the self-hosted container. Because UnKeep is
still `0.x`, minor releases may contain breaking changes.

| Surface | Compatibility status |
| --- | --- |
| `@unkeep/core` and `@unkeep/client` workspace exports | Internal implementation API |
| Documented `unkeep` commands, flags, and `--json` output | Intended public `0.x` CLI |
| `GET /api/v1/status` | Supported operational health/protocol check |
| Deep package imports, `apps/web` modules, `apps/server` modules, and the server test harness | Internal; no compatibility promise |
| Raw `/api/v1` request/response shapes other than status | Internal wire implementation; use `@unkeep/client` or the CLI |
| `@unkeep/cli` package-root imports | No exports; use the `unkeep` executable |
| `@unkeep/core/experimental` working-copy exports | Internal migration surface; no compatibility promise |

## Recovery, backups, and security boundaries

- The relay cannot decrypt vault contents. It stores ciphertext envelopes, credential hashes, record revisions, relay-instance-bound temporary pairing state, and short-lived hash-only consume receipts used to make pairing finalization retryable. Joining devices generate raw pairing credentials locally; the relay never stores or returns them.
- Recovery-kit v2 contains everything needed to recover the vault key and authenticates the relay instance it belongs to. Treat it like a password; downloading a new kit from an authorized device invalidates neither older kits nor existing devices. Legacy v1 kits require an explicit association warning; retained local vault data rejects a different key using a relay-scoped non-secret fingerprint.
- The required operator recovery token must differ from the one-time setup token. It can mint a replacement device credential but cannot decrypt the vault without a recovery kit. Rotating it does not revoke existing credentials; setup-token recovery is available only through the explicit legacy compatibility flag.
- Revoking a device recursively revokes its known paired descendants, their service credentials, and pending approvals. Pre-schema-v7 devices have unknown lineage; the emergency revoke-all API contains every credential before operator recovery. Neither operation can erase keys or notes already copied to a device.
- Back up the complete `/data` volume, the recovery kit, and the operator recovery token. Keep the latter two separate. A relay backup alone is ciphertext, and a recovery kit is not a backup of current note data.
- Quick Send uses compression and base64url encoding, **not encryption**. The fragment is not sent in the HTTP request, but anyone who receives or captures the complete URL can read the snapshot.
- Native sharing, clipboard copies, Obsidian handoff, and downloaded Markdown deliberately move plaintext outside the vault. UnKeep cannot control what the chosen application, operating system, clipboard manager, or downloaded-file backup retains.

## Current limitations and remaining work

- A relay represents one vault, and the browser stores one active relay session per profile. There is no multi-user account model, multiple-vault switcher, live collaboration, or shared editing.
- This preview does not reproduce every Google Keep feature. It has no reminders,
  handwriting or drawing tools, OCR, voice-note capture, or collaborative notes.
- Concurrent relay writes use optimistic revision checks, and the web client preserves a stale local edit as a separately titled conflict copy instead of silently overwriting either side. There is still no merge UI, conflict history, note version history, or automatic Trash retention policy.
- Vault export and restore operate on a complete JSON snapshot. There is no incremental or scheduled backup format, encrypted export option, selective restore UI, or server-side backup automation. Recovery-kit restore recovers keys and authorization, not exported note data.
- Browser vault exports are capped at 10,000 notes, 10,000 attachments, 32 MiB of note text, 96 MiB of attachment bytes, and a 256 MiB serialized file. Google Keep imports accept at most 10,000 selected/archive entries and 512 MiB total expanded input, with 4 MiB per Keep note JSON; recovery-kit files are capped at 64 KiB. Larger vaults need a future streaming backup format.
- Offline opening and editing require a previously loaded/installed app and an existing local session and key. First setup, device pairing, operator recovery, and remote sync require the relay. API responses are deliberately never served from cache.
- Quick Send is a static copy rather than collaboration. Note data and up to 20 small attachments share a 100 KiB uncompressed structured-payload budget, and practical URL-length limits may be lower in some sharing tools.
- Outbound Web Share support depends on HTTPS, the browser, and the operating system. Firefox/Zen desktop normally uses UnKeep's fallback menu. Text exports list attachment names but do not include attachment bytes; Quick Send remains the self-contained small-attachment option.
- Android share-target privacy depends on an active installed service worker.
  Without it, the relay rejects the plaintext fallback POST without storing or
  rendering it, but the reverse proxy and relay host have already received the
  body. The iOS fragment-based Shortcut does not send its fragment to the
  server.
- Markdown preview intentionally implements a safe subset, not full CommonMark or GitHub Flavored Markdown.
- The web and CLI enforce a 25 MiB per-file limit. The relay defaults to the same limit; raising `UNKEEP_MAX_ATTACHMENT_SIZE` alone does not raise the client limits.
- The workspace packages are internal and are not distributed through npm.
  This release supports the self-hosted container path; the raw relay
  protocol remains internal.
- The browser working copy remains an internal IndexedDB implementation while its old adapter seam is retired; alternate storage backends are not part of the supported product plan.

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
>>>>>>> 0200690 (Integrate sharing and editor deletion with recoverable Trash)

## License

UnKeep source and project artwork are provided under the [MIT License](LICENSE).
Dependency copyright and license texts are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source-of-truth icon is
[`apps/web/static/icon.svg`](apps/web/static/icon.svg); its PNG and favicon
variants are project-maintained renderings and are not derived from Google
Keep artwork.
