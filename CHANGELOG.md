# Changelog

All notable changes to UnKeep are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because UnKeep is still `0.x`, minor releases may include breaking changes.

## [Unreleased]

No changes yet.

## [0.2.1] - 2026-10-21

The first stable release, and the first published image since `0.2.0-rc.4`.
It includes everything listed under `0.2.0-rc.5` and `0.2.0`, which were
tagged but never published.

### Added

- **Unraid support** — documented Unraid settings and a Community
  Applications template. Started as root with `PUID`/`PGID`, the relay gives
  its data directory to that user and permanently drops to it before opening
  the database, so the appdata folder needs no manual `chown`. The running
  relay has no capabilities and runs on a read-only root filesystem, as in the
  Compose deployment.
- **Keep-style link previews** on note cards and in the editor, opt-in with
  `UNKEEP_LINK_PREVIEWS=1`. The relay fetches only public destinations, with
  bounds on time, size, redirects, rate, and concurrency. Previews are cached
  per browser and never synced.
- **Keyboard shortcuts** — `?` lists them, `/` focuses search, `n` starts a
  note, arrow keys move between notes, `Enter` opens one, `p` pins it, and
  `Delete` moves it to Trash with Undo. Shortcuts never permanently delete
  notes, and `Enter` keeps its normal action on a focused button or link.
- **Pin and colour controls** while composing a new note, with the toolbar
  order aligned to the editor.
- **Stable releases** — `vX.Y.Z` tags publish a non-prerelease GitHub release
  and move the `X.Y` and `latest` image tags when no higher stable release
  exists.

### Changed

- Opening UnKeep on a plain-HTTP, non-local address now shows an "UnKeep
  needs HTTPS" page instead of stalling on "Opening your vault…".
- The relay stops at startup with an `UNKEEP_DATA_DIR is not usable` message
  naming the UID and GID to `chown` to when its data directory or database is
  not writable.
- Relay storage quotas are enforced across live records and attachment
  stages together, and relay requests from clients have bounded deadlines
  while uncertain mutations still replay exactly.

### Fixed

- Concurrent local edits from stale tabs or queued snapshots are preserved as
  conflict copies instead of overwriting durable edits.
- Typing a title right after opening the composer no longer moves focus to
  the note body mid-word.
- URLs in notes open when activated.
- Runtime OpenSSL packages are pinned to the patched `3.5.9-r0`.

## [0.2.0] - 2026-10-21 (not published)

This tag stopped at release staging before any image tag or GitHub release
was created: binding the container sources ran `apk add` inside the staged
non-root image. Its changes ship in `0.2.1`, which reads the staged image's
package database as shipped.

## [0.2.0-rc.5] - 2026-08-18 (not published)

This tag failed release validation before any external write; its changes
ship in `0.2.0`.

### Added

- **Recoverable Trash** — notes move to Trash with an Undo action and can be
  restored; the note record schema advances to version 2 (forward-only
  migration, `schemaVersion: 2`).
- **Native note sharing** from the expanded editor — Open in Obsidian, copy as
  Markdown or plain text, download `.md`, alongside the unencrypted Quick Send
  link.
- **Delete action in the expanded note editor** with duplicate-mutation
  protection while persistence is pending.
- **Pin icon fix** in note cards.

### Changed

- Notes navigation redesigned around the Trash picker and selection UI (the
  full-card edit target no longer blocks the action toolbar for pointer
  users).

## [0.2.0-rc.4] - 2026-08-13

### Fixed

- Build architecture-independent application assets on the native builder
  platform, avoiding QEMU crashes during arm64 release-image publication.

## [0.2.0-rc.3] - 2026-08-13

### Changed

- Consolidated draft prerelease creation and immutable GHCR promotion into one
  protected job so both operations share the same short-lived GitHub token.

## [0.2.0-rc.2] - 2026-08-13

### Changed

- Removed npm publication entirely. Workspace packages are private and the
  supported release surface is GitHub Releases plus GHCR container images.
- Replaced the GitHub Packages REST inventory check with an authenticated,
  fail-closed registry manifest check before immutable GHCR tags are written.

## [0.2.0-rc.1] - 2026-07-30

The first public preview of the current self-hosted relay architecture. It is
intended for one person using trusted devices and agents, not multi-user
collaboration.

### Added

- A self-hosted Node.js and SQLite relay that stores encrypted notes,
  attachments, revisions, tombstones, and credential hashes.
- The framework-independent `@unkeep/client` encrypted-sync SDK.
- The `unkeep` CLI for pairing, note CRUD, synchronization, credential
  provisioning, stable JSON output, and encrypted clipboard transfer.
- Browser and terminal device pairing, service credentials for automation,
  device revocation, and operator recovery.
- Read-only-by-default and explicitly read-write service-credential scopes,
  issuer tracking, recursive device-lineage revocation, and an emergency
  revoke-all recovery path.
- Recovery-kit v2, bound to a relay instance, with an explicit legacy-kit
  migration flow.
- General file attachments, complete vault export and restore, and more robust
  Google Keep Takeout imports.
- An installable local-first PWA with an offline application shell and
  operating-system share-target support.
- Documentation for self-hosting and using UnKeep as an agent scratchpad.
- A published-image Compose example, reproducible third-party license notices,
  SBOM and provenance assets, and fail-closed dependency and container
  vulnerability gates for release candidates.

### Changed

- Replaced the earlier selectable cloud-adapter product flow with a local
  IndexedDB working copy synchronized through the encrypted UnKeep relay.
- Bundled the web app, relay, and CLI in the Docker image.
- Added optimistic record revisions, durable idempotent mutation replay,
  conflict preservation, poison-record quarantine, and vault-scoped local
  state.
- Upgraded the relay to protocol 3: new attachment ciphertext is staged
  privately and the exact sorted attachment manifest plus note is published in
  one atomic mutation. Legacy direct creation now fails with an upgrade hint.
- Made attachment staging, note/outbox writes, import leases and receipts,
  tombstone application, and sync acknowledgement durable across interruption
  and concurrent browser tabs.
- Made browser and CLI compound mutations recover exact encrypted payloads,
  content hashes, and completion handles across lost responses, conflicts,
  process restarts, and credential replacement.
- Clarified the supported `0.x` package and CLI boundaries; legacy Git, S3,
  local Markdown, and selectable-adapter exports remain experimental.
- Improved mobile layout, themes, application icons, links in note text,
  attachment handling, and recovery lifecycle behavior.

### Security

- Kept vault keys and plaintext records client-side; relay records use
  context-bound AES-256-GCM envelopes.
- Separated setup, operator-recovery, device, and service authorization roles.
- Added independently derived pairing fingerprints, hash-only idempotent
  consume receipts, restart-safe finalization, and invalidation of outstanding
  approvals when their approving device is revoked.
- Made wrapped-key, fingerprint, and identity writes atomic, and made browser
  rollback and local access removal transactional across key and session
  state, with compare-and-swap fencing so a cancelled pairing cannot overwrite
  a newer tab's state.
- Required the exact pending pairing marker to remain current through relay
  activation, so a concurrent clear or replacement cannot be reported as a
  ready session or combine one vault key with another session; a cleared
  in-flight activation also attempts bounded self-revocation.
- Propagated disconnect and forget operations across open browser tabs with a
  secret-free signal, while comparing the exact durable session so stale
  notifications cannot discard newly paired replacement access.
- Bound setup, recovery, and pairing to the relay instance observed by the
  client. Joining devices generate their credentials locally; the relay stores
  only a hash, grants no pre-consume API access, and reserves device IDs without
  replacing active or revoked devices.
- Associated newly issued service credentials with their device issuer for
  revocation and incident response.
- Serialized credential revalidation with record writes and credential
  issuance so revocation wins against already-started slow requests.
- Bound durable retry roots to the exact credential that created them. A
  replacement credential must authenticate to the same vault and explicitly
  replay the exact pending ciphertext; invalid and read-only credentials cannot
  erase another credential's retry state.
- Required optimistic base revisions, made attachment identifiers immutable,
  and atomically cascaded note tombstones to their attachments.
- Bounded private attachment stages by shared storage quotas, a ten-minute
  inactivity window, a 1,000-stage bundle limit, and a maximum one-day
  continuous retention epoch while refreshing active sequential uploads
  together.
- Committed attachment removal and its predecessor snapshot to the local note
  outbox before destructive work, retained the bytes through note and
  attachment acknowledgement, and made crash/restart replay preserve the
  required final-note-before-delete order.
- Aligned relay routes, SQLite guards, and clients on one bounded record-ID
  protocol, with a fail-closed pre-upgrade check for unusable legacy rows.
- Bounded encrypted bytes, record and attachment rows, long-lived device and
  service-credential registries, pending pairings, and replay receipts inside
  the same SQLite transactions that grow them.
- Required generated-length setup and operator-recovery tokens, compared them
  through fixed-length digests, bounded failed online guesses per network
  source and globally, and capped configured pairing lifetimes at one day.
  Existing shorter administrative-token configuration must be rotated before
  upgrading.
- Removed retired raw pairing credentials from SQLite free pages and WAL files
  during a fail-closed startup migration.
- Added strict decrypted-note normalization and safer browser and terminal
  rendering for content written by agents or other clients.
- Persisted only bounded record identity, revision, and reason metadata when a
  remote note cannot be decrypted or normalized, allowing later valid changes
  to continue without storing plaintext or raw exception text.
- Made CLI clipboard uploads use bounded reads, a private durable staging
  intent, credential-aware exact replay, conflict-aware note merging, fresh
  identities when an old credential still reserves a stage, and
  final-note-before-delete cleanup after interruption.
- Added public vulnerability-reporting guidance and an explicit threat model.

### Known limitations

- An active relay can alter the web client it serves and can interfere with
  pairing, freshness, and availability. See the
  [threat model](https://github.com/BrettKinny/UnKeep/blob/v0.2.0-rc.1/THREAT_MODEL.md).
- Every paired device and provisioned agent bundle has the vault master key.
  Revocation cannot erase previously copied data or rotate that key.
- Android Web Share Target privacy depends on an active installed service
  worker. A missing worker causes a rejected network fallback, but the
  plaintext body has already reached the reverse-proxy boundary.
- There is no multi-user model, live collaboration, history browser, trash
  browser, scheduled backup service, or in-place master-key rotation.
- Release candidates are preview software. Only the latest published candidate
  receives security fixes; upgrade instead of expecting backports.

## [0.1.1] - 2026-04-28

### Added

- An initial Vitest suite.

### Changed

- Reworked introductory documentation and corrected the clone URL.
- Fixed package export resolution for the Vercel build.
- Removed stale status documentation.

## [0.1.0] - 2026-03-08

### Added

- Initial SvelteKit notes PWA with note and checklist editing, search, labels,
  colors, pinning, archiving, dark mode, import, Quick Send, and experimental
  local and remote storage adapters.

### Security

- Initial client-side encryption and input-hardening work.

[Unreleased]: https://github.com/BrettKinny/UnKeep/compare/v0.2.0-rc.4...HEAD
[0.2.0-rc.4]: https://github.com/BrettKinny/UnKeep/compare/v0.2.0-rc.3...v0.2.0-rc.4
[0.2.0-rc.3]: https://github.com/BrettKinny/UnKeep/compare/v0.2.0-rc.2...v0.2.0-rc.3
[0.2.0-rc.2]: https://github.com/BrettKinny/UnKeep/compare/v0.2.0-rc.1...v0.2.0-rc.2
[0.2.0-rc.1]: https://github.com/BrettKinny/UnKeep/compare/v0.1.1...v0.2.0-rc.1
[0.1.1]: https://github.com/BrettKinny/UnKeep/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BrettKinny/UnKeep/releases/tag/v0.1.0
