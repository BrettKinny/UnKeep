# UnKeep

*Your notes. Your storage.*

UnKeep is a privacy-first, open-source notes vault serving two purposes: a self-hosted Google Keep replacement and a scratchpad for AI agents and scripts. It combines a local IndexedDB working copy with a small encrypted sync relay: notes and attachments are encrypted on the client before upload, and the relay stores only ciphertext, credential hashes, and sync metadata.

The PWA, relay, and `unkeep` CLI ship as one Docker container. A browser can also connect to a separately hosted relay, while terminals and agents can use the same vault through the CLI. See the [agent scratchpad guide](docs/agent-scratchpad.md).

## Quick start

### Self-host with Docker

Create separate setup and operator-recovery secrets before starting the container:

```sh
git clone https://github.com/BrettKinny/UnKeep.git
cd UnKeep
export UNKEEP_SETUP_TOKEN="$(openssl rand -base64 32)"
export UNKEEP_RECOVERY_TOKEN="$(openssl rand -base64 32)"
docker compose up --build -d
```

UnKeep is now available at `http://localhost:3000`. Put port 3000 behind HTTPS before exposing it beyond localhost; the browser APIs used for encryption and offline installation require a secure context on non-local origins.

Open the site and enter `UNKEEP_SETUP_TOKEN`. The first browser creates the vault key locally and requires you to download a recovery kit **before** it initializes the relay and claims the one-time setup token. Store the recovery kit and `UNKEEP_RECOVERY_TOKEN` separately and securely. Recovering after every trusted device is lost requires both: the kit restores the encryption key, while the operator token authorizes a replacement device credential.

See [docs/self-hosting.md](docs/self-hosting.md) for additional-device pairing, recovery, revocation, backups, Unraid, Tailscale, and deployment settings.

### Terminal and agent access

The image bundles the CLI, so it can use the same vault without a separate checkout:

```sh
docker compose exec unkeep unkeep --help
docker compose exec -it unkeep unkeep login --endpoint http://127.0.0.1:3000
docker compose exec unkeep unkeep list
```

For durable automation, mint a revocable service credential with `unkeep provision --name <agent>` and export the `UNKEEP_ENDPOINT`, `UNKEEP_CREDENTIAL`, and `UNKEEP_VAULT_KEY` values it prints. See the [agent scratchpad guide](docs/agent-scratchpad.md) for conventions and non-interactive setup.

### Develop from source

The repository requires Node.js 22 or newer and pnpm 10.

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
pnpm start        # serve apps/web/build and /api/v1 on port 3000
pnpm test         # test core, client, CLI, web, and server
pnpm check        # build libraries, then type-check the CLI and web app
pnpm lint         # lint the web app
pnpm smoke:packages # pack and install the public packages in a clean local consumer
pnpm test:e2e     # build and exercise critical browser flows with Playwright
pnpm preview      # preview the static PWA without the relay API
```

## Implemented product

- **Notes and checklists** — titles, bodies, checklist conversion and editing, labels, pinning, archiving, 11 colors, a masonry card grid, and safe clickable HTTP(S), `www.`, and email links in rendered note text.
- **Local-first editing** — note writes go to IndexedDB first, with a 500 ms editor debounce and queued retries when the relay is unavailable.
- **Search** — client-side matching across titles, bodies, checklist items, and labels.
- **Attachments** — image previews and downloadable general files up to 25 MiB each. Bytes are saved durably in IndexedDB before upload and encrypted separately from note metadata.
- **Encrypted sync** — AES-256-GCM note and attachment envelopes, revision cursors, tombstones, optimistic revision conflict protection, durable idempotent replay after a lost mutation response, device pairing, device revocation, and restricted service credentials.
- **Recovery** — authenticated recovery-kit v2 binds the vault key to its relay instance; a separate operator token restores relay authorization after every device is lost.
- **Markdown preview** — a safe rendered subset covering headings, paragraphs, emphasis, strong text, inline and fenced code, ordered and unordered lists, line breaks, and absolute HTTP(S) links.
- **Google Keep import** — Takeout ZIPs, or selected JSON and media files, import titles, text, checklists, labels, colors, timestamps, pin/archive state, and referenced media. Trashed Keep notes are skipped; note records commit in one local transaction, failed staging rolls back, and a durable journal finalizes or removes an import interrupted by tab termination on the next startup.
- **Complete vault export and restore** — the web UI downloads one JSON file containing every currently loaded note and the bytes for every attachment. Export refuses corrupt or silently partial attachment data, and the import dialog validates the complete format, preserves collisions as copies, and uses the same transactional restore path.
- **Structured Quick Send** — a URL-fragment snapshot carries a note's title, body, checklist, labels, color, and small attachments that fit the payload budget; the receiver previews it and explicitly saves it to their vault. Existing text-only links remain readable.
- **Share sheet integration** — Android/Chrome can share text into the `/share` target, while iOS can use the documented Shortcut; shared content stays in the URL fragment until the user saves it.
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
├── apps/server/            Node 22 + SQLite ciphertext relay and PWA host
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

Attachments upload before the note metadata that references them. On pull, the web client persists notes, tombstones, and required attachment bytes before acknowledging the new cursor, so an interrupted local apply can safely retry the same relay changes.

An already connected browser loads its local session, wrapped vault key, notes, and attachments without first contacting the relay. Network reachability is a sync concern after boot, not an unlock prerequisite.

## CLI

The Docker image bundles `unkeep` for zero-install container use. `@unkeep/cli` is also a packable public artifact, but this repository does not automatically publish it and no registry release is performed by the build. Build and run it from this checkout:

```sh
pnpm --filter @unkeep/core build
pnpm --filter @unkeep/client build
pnpm --filter @unkeep/cli build

node apps/cli/dist/bin.js --help
node apps/cli/dist/bin.js --endpoint https://notes.example.com login
```

`pnpm smoke:packages` provides the release-artifact check: it packs `@unkeep/core`, `@unkeep/client`, and `@unkeep/cli`, installs all three tarballs into a fresh temporary npm project without registry access, imports their package roots, and runs the installed `unkeep --version` binary. If a registry release is made later, the normal installation command will be `npm install --global @unkeep/cli`; verify that a release exists before relying on that command.

`login` prints an eight-character pairing code. Approve it from the device menu of an unlocked web client; the CLI then saves the endpoint, device credential, and vault key in `$XDG_CONFIG_HOME/unkeep/config.json` or `~/.config/unkeep/config.json` with mode `0600`.

Examples after pairing with an installed package (replace `unkeep` with `node apps/cli/dist/bin.js` when running from the checkout):

```sh
unkeep list --label work
unkeep get note-id
unkeep put note-id --title "Deploy" --content "Check release"
unkeep sync
unkeep clip ./report.pdf
unkeep paste
unkeep provision --name automation-agent
```

`provision` mints a restricted service credential and prints an `UNKEEP_ENDPOINT`, `UNKEEP_CREDENTIAL`, and `UNKEEP_VAULT_KEY` bundle. Treat the bundle as sensitive: the service token can change ciphertext and the vault key can decrypt it. Flags override the corresponding environment variables, which override the saved config. Add `--json` for machine-readable output.

## Relay API and client package

The unauthenticated protocol/status endpoint is useful for health checks:

```sh
curl "${UNKEEP_ENDPOINT%/}/api/v1/status"
```

The remaining JSON API is versioned under `/api/v1`. Setup, recovery, device, and service credentials have different authorization roles; device credentials can manage trust and mint/revoke service credentials, while service credentials are limited to vault, note, attachment, and change operations.

Application code should use the package-root exports from `@unkeep/client` rather than constructing encrypted record payloads by hand:

```ts
import { RelayClient } from '@unkeep/client';

const relay = new RelayClient(endpoint, credential);
const status = await relay.status();
const { changes, cursor } = await relay.changes(0);
```

`RelayClient` exposes the transport operations; `EncryptedSync` adds note/attachment encryption and explicit cursor acknowledgement. Callers of `EncryptedSync.pull()` must durably apply its result before calling `acknowledge(cursor, revisions)` with the cursor and per-record revisions returned by that pull.

### Package and compatibility boundary

The public packages are ESM and require Node.js 20 or newer when used in Node. They are locally packable and installable, but registry publication remains a separate maintainer action. Because the current versions are `0.x`, semver-compatible minor releases may still contain breaking changes.

| Surface | Compatibility status |
| --- | --- |
| `@unkeep/core` package-root types, validation, migrations, Markdown, and cryptography exports | Intended public `0.x` API |
| `@unkeep/client` package-root relay, session, pairing, key, and encrypted-sync exports | Intended public `0.x` API |
| Documented `unkeep` commands, flags, and `--json` output | Intended public `0.x` CLI |
| `GET /api/v1/status` | Supported operational health/protocol check |
| Deep package imports, `apps/web` modules, `apps/server` modules, and the server test harness | Internal; no compatibility promise |
| Raw `/api/v1` request/response shapes other than status | Internal wire implementation; use `@unkeep/client` or the CLI |
| `@unkeep/cli` programmatic TypeScript exports | Available for the executable and tests, but not a separately supported embedding API |
| Legacy Git, S3, local Markdown, local-only adapter, and adapter-oriented OAuth exports from `@unkeep/core` | Experimental; not part of the supported product workflow |

## Recovery, backups, and security boundaries

- The relay cannot decrypt vault contents. It stores ciphertext envelopes, credential hashes, record revisions, and temporary pairing state.
- Recovery-kit v2 contains everything needed to recover the vault key and authenticates the relay instance it belongs to. Treat it like a password; downloading a new kit from an authorized device invalidates neither older kits nor existing devices. Legacy v1 kits require an explicit association warning; retained local vault data rejects a different key using a relay-scoped non-secret fingerprint.
- The operator recovery token can mint a replacement device credential but cannot decrypt the vault without a recovery kit. Rotating it does not revoke existing credentials.
- Revoking a device prevents future relay access. It cannot erase keys or notes already copied to that device.
- Back up the complete `/data` volume, the recovery kit, and the operator recovery token. Keep the latter two separate. A relay backup alone is ciphertext, and a recovery kit is not a backup of current note data.
- Quick Send uses compression and base64url encoding, **not encryption**. The fragment is not sent in the HTTP request, but anyone who receives or captures the complete URL can read the snapshot.

## Legacy adapter code

`packages/core/src/adapters/` still contains the earlier local-only, File System Access, Git, and S3 storage experiments. `apps/web/src/lib/components/SetupWizard.svelte` and `adapterRegistry.ts` also remain in the tree.

Those choices are **not wired into the current web route or supported onboarding flow**. The current product always uses a local IndexedDB working copy plus the encrypted UnKeep relay. The local adapter is reused internally for that working copy, but there is no live UI for selecting Git, S3, local Markdown, or a relay-free local-only mode. Their package-root re-exports preserve the existing experimental surface; they should not be treated as supported storage integrations.

## Current limitations and remaining work

- A relay represents one vault, and the browser stores one active relay session per profile. There is no multi-user account model, multiple-vault switcher, live collaboration, or shared editing.
- Concurrent relay writes use optimistic revision checks, and the web client preserves a stale local edit as a separately titled conflict copy instead of silently overwriting either side. There is still no merge UI, conflict history, note version history, or trash browser; deletion only offers the immediate undo action.
- Vault export and restore operate on a complete JSON snapshot. There is no incremental or scheduled backup format, encrypted export option, selective restore UI, or server-side backup automation. Recovery-kit restore recovers keys and authorization, not exported note data.
- Offline opening and editing require a previously loaded/installed app and an existing local session and key. First setup, device pairing, operator recovery, and remote sync require the relay. API responses are deliberately never served from cache.
- Quick Send is a static copy rather than collaboration. Note data and up to 20 small attachments share a 100 KiB uncompressed structured-payload budget, and practical URL-length limits may be lower in some sharing tools.
- Markdown preview intentionally implements a safe subset, not full CommonMark or GitHub Flavored Markdown.
- The web and CLI enforce a 25 MiB per-file limit. The relay defaults to the same limit; raising `UNKEEP_MAX_ATTACHMENT_SIZE` alone does not raise the client limits.
- `@unkeep/core`, `@unkeep/client`, and `@unkeep/cli` pack and install locally, but the repository has no registry-publishing automation or published-release guarantee. The supported `0.x` boundary is the one documented above; the raw relay protocol remains internal.
- The legacy Git, S3, File System Access, and selectable local-only paths require product integration and current encryption/sync semantics before they can be considered supported.

## Deployment settings

The Docker image serves the PWA and relay together on port 3000 and stores its SQLite database under `/data`. The Compose file maps that directory to `./data`.

Common environment variables:

| Variable | Purpose |
| --- | --- |
| `UNKEEP_SETUP_TOKEN` | Required one-time first-device setup secret |
| `UNKEEP_RECOVERY_TOKEN` | Recommended separate operator recovery secret; falls back to the setup token when omitted |
| `UNKEEP_DATA_DIR` | SQLite directory; defaults to `./data` outside the image and `/data` in Docker |
| `UNKEEP_WEB_DIR` | Built PWA directory served by the relay |
| `UNKEEP_ALLOWED_ORIGIN` | CORS origin; defaults to `*` |
| `UNKEEP_MAX_ATTACHMENT_SIZE` | Relay plaintext attachment limit in bytes; defaults to 25 MiB |
| `UNKEEP_PAIRING_TTL_MS` | Pairing request lifetime; defaults to 10 minutes |
| `PORT` | HTTP port; defaults to 3000 |

See [docs/self-hosting.md](docs/self-hosting.md) before exposing a deployment.

## Tech stack

- [SvelteKit](https://svelte.dev/docs/kit) with `adapter-static`
- [Svelte 5](https://svelte.dev/docs/svelte) runes
- [TypeScript](https://www.typescriptlang.org/) in core, client, CLI, and web
- [Tailwind CSS 4](https://tailwindcss.com/)
- Web Crypto, IndexedDB, Compression Streams, and Service Workers
- Node.js 22 built-in HTTP, crypto, and SQLite for the relay
- pnpm workspaces

## License

[MIT](LICENSE)
