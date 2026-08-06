# Threat model

This document describes the security boundary of the upcoming `0.2.x` release.
It is a design contract, not a proof of security. Report mismatches privately
using [SECURITY.md](SECURITY.md).

## Scope

UnKeep is a single-user vault used from multiple trusted devices, terminals,
and agents. It is not a multi-user collaboration system. Every paired client
ultimately receives the same vault master key.

The system has four main parts:

1. The browser PWA keeps a local working copy in IndexedDB.
2. The CLI keeps a local snapshot and credentials in the user's configuration
   directory or receives them through environment variables.
3. `@unkeep/client` encrypts note and attachment records before relay upload.
4. The self-hosted relay authenticates requests, stores ciphertext and sync
   metadata in SQLite, and normally serves the PWA JavaScript.

## Assets and guarantees

| Asset or property | Intended protection |
| --- | --- |
| Note and attachment contents at the relay | AES-256-GCM ciphertext; the vault key is not sent to the relay |
| Record substitution between IDs or vaults | Authenticated encryption binds an envelope to its record and vault context |
| Relay credentials | Random bearer credentials are stored as hashes by the relay and require HTTPS outside trusted local networks |
| Local edits | Stored locally before normal remote synchronization |
| Concurrent record writes | Optimistic revisions detect stale writes; callers must preserve or surface conflicts |
| Recovery | A recovery kit restores the vault key; the separate operator token authorizes a replacement relay credential |
| Relay storage exhaustion | Atomic encrypted-byte, record-count, and credential-registry ceilings fail writes closed; incomplete attachment stages consume the same count and byte budgets and expire; bounded mutation receipts retain recent replay results |

These guarantees depend on current, authentic client code, uncompromised client
devices, sound key storage, and correct deployment.

## Trust assumptions

### Honest-but-curious relay

The supported confidentiality model assumes the relay follows the protocol but
may inspect everything it stores or receives. It can see:

- the relay instance identifier and whether setup is complete;
- record kinds and identifiers, note-to-attachment relationships, ciphertext
  lengths, revisions, tombstones, timing, and access patterns;
- temporary attachment-stage identifiers, ownership, ciphertext lengths,
  expiry times, and intended note relationships;
- device and service-credential names and lifecycle metadata;
- pairing state; and
- network metadata and anything recorded by reverse-proxy logs.

It cannot normally decrypt authenticated note and attachment envelopes without
the vault key. Encryption does not hide metadata or approximate content size.

### Active or compromised relay

An actively malicious relay is outside the current end-to-end security
guarantee. It can withhold, replay, reorder, or delete data and deny service.
AES-GCM detects modification or cross-context substitution of an envelope, but
there is no signed, append-only history that proves completeness or freshness.

More importantly, the usual deployment serves the PWA from the same host. A
compromised host can deliver altered JavaScript that reads plaintext and keys
after the user unlocks or edits the vault.

With authentic client code, pairing clients independently derive the displayed
80-bit fingerprint from the relay instance ID, pairing request ID, requester
device ID, and canonical requester P-256 public key. The encrypted key transfer
uses the same relay and request identities as AES-GCM additional authenticated
data. The relay does not supply the fingerprint. Comparing every character on
the requester and approver before approval makes relay key substitution or a
misrouted relay instance detectable; cancel on any mismatch.

That comparison does not make a compromised same-origin PWA host trustworthy.
A host that serves modified client code can forge the display or extract the
key after decryption. The fingerprint also does not prove the human identity of
either device, prevent denial of service, or attest the responder key. Users
who need protection from a compromised application host must load independently
authenticated client code and compare the transcript through a separate
channel.

The TLS terminator is trusted with credentials and request metadata. Use HTTPS
for every non-local deployment and protect proxy logs.

### Paired devices and agents

A paired device has the vault key and a device credential. Device credentials
are administrative: they can approve devices and manage service credentials.

A provisioned agent bundle contains a scoped service credential and the same
vault key. A read-only service credential can sync and download encrypted
records but cannot mutate records or use administrative endpoints. A read-write
service credential can also mutate note records and stage/finalize encrypted
attachments; neither scope can administer devices, pairings, or credentials.
Existing credentials created before scopes were introduced retain read-write
authority.

Scope limits relay operations, not decryption. Every service bundle can decrypt
the entire vault, retain plaintext, and inspect every label. The relay cannot
enforce label-specific access because labels and note contents are encrypted
from it. Treat agent output and synchronized note data as untrusted input when
rendering it in a browser or terminal.

Compromise of any device or bundle therefore compromises vault
confidentiality. Revocation prevents future authenticated relay requests; it
cannot erase copied plaintext or keys, undo prior exfiltration, or make an
already shared master key secret again.

For pairings consumed by schema-v7 relays, each device records the device that
approved it. Targeted device revocation recursively revokes that device, every
known descendant it approved directly or indirectly, service credentials
issued by that subtree, and its approved-but-unconsumed pairings. First-setup
devices, operator-recovered devices, and devices preserved from older schemas
have `NULL` lineage. The relay deliberately does not guess whether such a row
is a genuine root or a legacy paired device, so targeted revocation cannot
contain unknown pre-upgrade descendants.

During an incident where lineage is unknown or several roots may be
compromised, the authenticated emergency revoke-all operation revokes every
device and service credential and removes all transient pairing state. It also
revokes the calling device, so recovery requires the separate operator token;
decrypting the vault still requires a recovery kit or an already retained
local key. Review both device and service credentials during incident response.

There is no in-place master-key rotation or re-encryption workflow. For a
suspected key leak, preserve a safe export, create a new vault with new
credentials, and re-import only after the affected environment is contained.

### Local device and browser profile

The browser's local note and attachment working copy is plaintext in IndexedDB.
The locally stored vault key is wrapped with a non-exportable browser key, but
this is not protection from malicious code running in the same browser profile
or operating-system account. There is no independent UnKeep passcode or
hardware-backed key requirement.

All same-origin tabs share that IndexedDB state, but an already-open tab can
also hold the unwrapped key and relay session in memory. After a durable
browser-side disconnect or destructive local-access clear, UnKeep sends a
secret-free same-origin invalidation signal using `BroadcastChannel` with a
storage-event fallback. Receiving tabs compare their in-memory session with
the current durable session, stop using stale access, and never clear a
concurrently installed replacement. This is a local lifecycle backstop, not
credential revocation or secure erasure. “Disconnect sync” removes the shared
browser session while retaining the wrapped vault key; “forget local access”
also removes the shared wrapped key and device identity. A copied key,
plaintext, or credential outside the browser profile remains unaffected.

CLI configuration and agent environment variables contain the raw vault key
and bearer credential. File permissions reduce accidental disclosure but do
not defend against compromise of the same user account. Plaintext exports,
downloads, backups, swap, browser history, clipboard contents, crash reports,
and terminal logs are outside UnKeep's cryptographic boundary.
The CLI also keeps an interrupted `clip` input as a private `0600` plaintext
staging file under its config directory until the relay note reference and
local completion state are durable. Reads and staging size are bounded, the
file name is derived from a fresh route-safe attachment ID, and a stored hash
is verified before replay. If the bytes are missing or changed, the CLI first
flushes any pending final note without that attachment, then tombstones its
immutable relay ID so a live unreachable upload is not retained.

## Pairing and recovery

- Pair only while an existing trusted device and the joining device are under
  your control. Verify the endpoint and compare the full pairing fingerprint on
  both devices before approval; cancel if any character differs.
- Pairing requests are temporary, but the unauthenticated request surface is
  available after initialization and is still exposed to denial-of-service
  attempts. The relay rate- and size-limits it, caps outstanding requests, and
  refuses a configured request lifetime above one day.
- The joining client generates its 32-byte device credential locally. Its
  unauthenticated pairing request sends only the SHA-256 hash; final consume
  and later authenticated calls send the raw bearer credential over the
  configured transport. The relay hashes it for lookup and never persists or
  returns the raw value. Before final consume that credential is authorized
  only for the matching consume endpoint: it cannot read the vault or changes,
  write records, or administer access. Pairing requests reserve a device ID
  and cannot replace or revive an active or revoked device.
- Cancellation or expiry before local installation leaves no active joining
  credential. Pairing is complete only after the joining client has durably
  stored its local key and session and finalized with the relay. The client
  durably records unfinished finalization and retries after restart. The relay
  retains a temporary hash-only consumed receipt so a lost consume response
  can be retried without retaining the raw credential or encrypted key-transfer
  response.
- Relay activation and browser storage cannot commit atomically. If another tab
  clears the exact pending local session while finalization is in flight, the
  joining client fails closed and makes a bounded best-effort request to revoke
  the newly activated device. A network failure can still leave an orphan
  credential that must be revoked from another trusted device or by using the
  emergency revoke-all and recovery procedure. A concurrent replacement
  session is preserved and is never treated as the result of the old pairing.
- An approved but unconsumed request remains dependent on its approving device.
  Revoking that approver or any known ancestor invalidates those outstanding
  approvals. A successful consume copies the approver identity into the active
  device's lineage before authorizing it.
- The recovery kit is sufficient to recover the vault key and must be protected
  like the vault itself. The operator recovery token grants relay
  authorization but does not decrypt records by itself.
- Configured setup and effective recovery tokens must be 32-256 printable
  non-whitespace ASCII characters. Fresh deployments should generate separate
  256-bit random values rather than human passwords. An uninitialized relay
  also refuses to start without a setup token; an initialized relay may omit it
  to disable further setup claims. Failed setup and recovery
  secret checks have independent bounded sliding-window limits per observed
  network source and globally; successful checks do not consume capacity.
  Expired source state is removed and retained state cannot exceed the global
  failure budget. This slows online guessing but permits an unauthenticated
  distributed denial of setup or recovery until the window expires. Per-source
  identity comes from the direct peer unless explicitly configured to trust an
  overwriting reverse proxy.
- Keep the recovery kit, operator token, relay backup, and ordinary devices in
  separate failure domains. Test restoration using non-production data.

## Sharing

Outbound sharing creates a plaintext Markdown snapshot and hands it to an
operating-system share target selected by the user. If native Web Share is not
available or fails, the UI offers explicit clipboard, Markdown download,
Obsidian custom-protocol, and legacy Quick Send actions. These destinations are
outside the vault's cryptographic boundary. Clipboard managers, target apps,
download folders, backups, and operating-system telemetry may retain the
plaintext. The Obsidian handoff puts the note body on the clipboard and only a
sanitized note name in the custom-protocol URL; it refuses to open Obsidian if
the clipboard write fails. Markdown and plain-text exports list attachment
names but do not copy attachment bytes.

Quick Send creates a copy, not shared access or collaboration. Its payload is
encoded and compressed, not encrypted. Anyone or any software that obtains the
complete URL can read it, and there is no recipient identity, expiry, or
revocation. Browser history, URL synchronization, messaging services, and the
recipient's device may retain a copy.

The operating-system share target is a local import convenience. It does not
change the trust model of the source application, browser, service worker, or
destination vault. A received draft should require explicit confirmation and
must not be reported as saved before durable local persistence succeeds.

On Android/Chrome, keeping the plaintext share local depends on the installed
PWA's service worker being active when it receives the Web Share Target POST.
The worker accepts only URL-encoded forms, stops reading after 512 KiB, rejects
invalid UTF-8, and applies a 256,000-character payload limit before redirecting
the accepted fields into a fragment.
If interception is unavailable, the reverse proxy and relay receive the form
body before the relay rejects it with `share_worker_required`; UnKeep does not
store, render, or redirect that fallback, but upstream infrastructure could
observe it. The documented iOS Shortcut puts its payload in a URL fragment,
which is not included in the HTTP request.

## Integrity, availability, and deletion limits

- Multi-device sync is asynchronous optimistic concurrency, not live
  collaborative editing or a transactional distributed database.
- Creating attachments uses a bounded two-phase relay mutation. The client
  first uploads context-bound encrypted attachment envelopes under one
  route-safe mutation ID. Each stage is owned by the exact credential hash,
  immutable for that mutation and attachment ID, and absent from public change
  and download routes. The client then submits the non-deleted note envelope,
  its optimistic base revision, and an exact sorted unique stage manifest.
  Under one serialized SQLite transaction the relay reauthenticates the
  credential, validates the note revision and stages, assigns deterministic
  consecutive attachment revisions, and assigns the immediately following
  revision to the note. A stale note or attachment-ID collision publishes no
  row. Thus another device may see the entire committed revision sequence or
  none of it, but it can still receive that sequence later through ordinary
  asynchronous sync.
- A successful compound mutation stores a credential-bound, domain-separated
  receipt before removing its stages. Retrying the same canonical request after
  a lost final response returns the original attachment and note revisions;
  reusing its mutation ID with another credential or payload conflicts.
  Receipt count and retention remain finite, so this replay guarantee is
  bounded. Direct creation of a new live attachment through the legacy record
  route fails with HTTP 428 `compound_mutation_required` after checking for a
  prior legacy receipt; existing tombstones remain retryable.
- Removing an attachment commits the note-without-attachment and its prior
  attachment snapshot to the local note outbox atomically before any local
  bytes can be deleted. Sync derives the deletion intent from that durable
  snapshot, retains the bytes until the relay accepts both the note revision
  and attachment deletion, and can replay the transition after a crash.
- Decrypted notes cross one shared, bounded schema boundary: route-safe IDs,
  unique embedded IDs, finite field lengths, collection counts, aggregate
  text, and 25 MiB attachment declarations. A note that fails decryption or
  this boundary is not applied. Its record ID, revision, and a stable reason
  code are persisted in a bounded local quarantine before the page may be
  acknowledged, so one poison record cannot indefinitely block unrelated later
  changes. No plaintext or raw exception text is stored in the quarantine; a
  valid later revision clears it. Attachment download and network failures
  remain retryable and do not advance the cursor.
- Recovery kits, raw Keep selections, Takeout archives, per-note JSON, and
  complete vault restores are size- and count-bounded before expensive reads,
  decompression, base64 decoding, or record construction. These availability
  controls are not a promise that a device has enough memory for every input
  at the advertised maximum.
- A relay operator can delete the database or serve an old backup. Keep and
  test independent backups and exports.
- Trash is retention, not deletion. A note with `trashedAt` remains a live
  encrypted record, its attachment ciphertext is retained indefinitely, it
  continues to consume relay quota, and any client or agent with the vault key
  can still decrypt it. Web and CLI delete actions move notes to Trash first.
  Only an explicit permanent delete of a note already in Trash creates the
  tombstone and cascades attachment deletion.
- Tombstones and revocation are application-level state, not proof of secure
  erasure from SSDs, backups, logs, browser storage, or other devices.
- The relay limits the total serialized encrypted-envelope bytes, total record
  rows, attachment rows, device rows, service-credential rows, and mutation
  receipts. Live records and incomplete attachment stages share the byte,
  record-count, and attachment-count budgets. A write that would increase an
  exceeded record budget fails atomically; storage-reducing replacements remain
  available for recovery. Record and attachment counts include tombstones
  because deleting them without per-device acknowledgement could resurrect
  stale data. Device and service-credential counts include revoked rows so
  lineage and audit history remain available.
- Incomplete encrypted attachment stages expire after ten minutes of bundle
  inactivity by default; operators may configure a positive inactivity window
  up to one day with `UNKEEP_ATTACHMENT_STAGE_TTL_MS`. Stage creation and exact
  replay refresh every stage owned by that credential and bundle together, but
  each bundle is capped at 1,000 stages and no continuously retained stage epoch
  survives more than one day from its first stage. After full expiry, a later
  retry may restage a fresh epoch. Expiry and terminal conflict cleanup update
  stage accounting atomically. A quota failure can retain an otherwise valid
  stage until expiry so a bounded retry is possible. These limits bound
  persistent abandoned-stage growth but do not prevent an authorized client
  from occupying the configured capacity until expiry.
- Relay routes and SQLite guards enforce the same bounded record identities as
  clients. An upgrade refuses a legacy database containing an unusable record
  identity without deleting or printing the ciphertext row; operators must
  repair or restore it with the previous server before continuing.
- Mutation receipts are retained for a configured time window and capped by
  count. The oldest receipts are pruned first, preserving recent lost-response
  replay within that finite window and capacity; replay is not promised
  forever.
- Cascading a note tombstone logically replaces its attachment ciphertext with
  a small non-encrypted tombstone sentinel after the attachment change is
  recorded. This releases quota and lets SQLite reuse pages. It is not secure
  erasure: old bytes may remain in the WAL, free pages, filesystem snapshots,
  backups, or clients.
- These ceilings limit persistent relay growth; they do not prevent an
  authorized client from filling the configured budget and causing denial of
  service. Traffic analysis, endpoint compromise, browser vulnerabilities,
  malicious extensions, and denial of service are not solved by content
  encryption.

## Deployment boundary

Keep the relay on a trusted host. Direct source startup defaults its validated
`UNKEEP_HOST` to `127.0.0.1`; opt into another interface only when intentional.
The official container explicitly listens on all container interfaces so port
publishing works, while the supplied Compose files publish only to host
loopback. Terminate HTTPS with a maintained reverse proxy, restrict CORS to the
deployed origin, protect `/data`, and promptly install security updates. See
[docs/self-hosting.md](docs/self-hosting.md) for operational guidance.
