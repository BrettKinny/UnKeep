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

The first planned release line is the `0.2.0-rc.1` preview. Once published,
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
pnpm smoke:packages # test the packed public npm artifacts
pnpm test:e2e       # build and exercise critical browser flows
```

The monorepo is organized as `packages/core`, `packages/client`,
`apps/cli`, `apps/web`, and `apps/server`. The web app and CLI share the same
client-side sync protocol. See [CLAUDE.md](CLAUDE.md) for architecture and
contributor commands.

## Packages

Install exact preview versions from npm when published:

```sh
npm install --global @unkeep/cli@0.2.0-rc.1
npm install @unkeep/core@0.2.0-rc.1 @unkeep/client@0.2.0-rc.1
```

The package-root APIs and documented CLI commands are the intended public
`0.x` surface. Deep imports, application/server modules, raw relay request
shapes, and legacy adapter exports are internal or experimental. Release
candidates use npm's `next` dist-tag; pin an exact version for automation.

## License

UnKeep source and project artwork are provided under the [MIT License](LICENSE).
Dependency copyright and license texts are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source-of-truth icon is
[`apps/web/static/icon.svg`](apps/web/static/icon.svg); its PNG and favicon
variants are project-maintained renderings and are not derived from Google
Keep artwork.
