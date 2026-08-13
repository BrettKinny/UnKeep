# Self-hosting UnKeep

UnKeep ships as one container containing the PWA and its encrypted sync server.
Normal note and attachment sync sends only opaque AES-GCM envelopes to
`/data/unkeep.sqlite`; the server never receives the vault key. The Android
share-target failure mode described below can deliver a plaintext form body to
the proxy and relay before rejection, but UnKeep does not persist or render it.

## Start it

Download the Compose file attached to the release, create separate long,
random setup and operator-recovery tokens, then start the release by its
verified image digest:

```sh
set -eu
mkdir unkeep && cd unkeep
release_url=https://github.com/BrettKinny/UnKeep/releases/download/v0.2.0-rc.4
curl -fsSLO "$release_url/compose.release.yaml"
curl -fsSLO "$release_url/unkeep-0.2.0-rc.4-image-digest.txt"
curl -fsSLO "$release_url/SHA256SUMS"
grep -E \
  '^[0-9a-f]{64}  (compose\.release\.yaml|unkeep-0\.2\.0-rc\.1-image-digest\.txt)$' \
  SHA256SUMS > RELEASE_SHA256SUMS
test "$(wc -l < RELEASE_SHA256SUMS)" -eq 2
sha256sum --check --strict RELEASE_SHA256SUMS
rm RELEASE_SHA256SUMS
release_digest="$(
  sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' \
    unkeep-0.2.0-rc.4-image-digest.txt
)"
printf '%s\n' "$release_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'
mv compose.release.yaml compose.yaml
install -d -m 700 data
# The published container runs as the non-root node user (UID/GID 1000).
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

`UNKEEP_SETUP_TOKEN` can initialize a new server only once.
`UNKEEP_RECOVERY_TOKEN` can later mint a replacement device credential if
every authorized device is lost. Both are required by the supplied Compose
files and must be different. The relay also fails startup if the recovery token
is missing or equals the setup token. Any configured setup token and the
effective recovery token must each be 32-256 printable ASCII characters
without whitespace. The commands above generate 256-bit random values in that
range; do not substitute memorable passwords. An already initialized relay can
start with setup disabled by omitting `UNKEEP_SETUP_TOKEN` outside Compose, but
an uninitialized relay fails startup without it.

Before upgrading an existing deployment, replace any shorter, whitespace, or
non-ASCII operator token with a newly generated value in `.env`. An initialized
relay may likewise omit an obsolete setup token outside Compose, or replace it
with a generated value when the deployment tooling still requires one. These
tokens are configuration, not database rows, so this change does not rewrite
vault data or revoke existing device credentials.

An older deployment that intentionally depended on setup-token recovery can
temporarily set `UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1`. With Compose, set
`UNKEEP_RECOVERY_TOKEN` to the retained setup-token value as well, because
Compose validates that both variables are present before it creates the
container. This compatibility mode weakens separation between initial setup
and later recovery; replacing it with a distinct random recovery token is the
recommended migration. The retained setup token must also satisfy the current
administrative-token length and character boundary.

Every Compose command in this guide uses the explicit, mode-`0600` `.env`
file because Compose must interpolate both required tokens even for a one-shot
CLI or maintenance command. The source repository ignores `.env`;
a standalone deployment directory does not. Never commit or casually back up
this file, and do not keep it with both the recovery kit and server backup.

The first pull is pinned to the release's recorded multi-architecture digest;
the mutable registry version tag is never executed. Operators with GitHub CLI
can additionally run the following after downloading the assets and before the
`mv` and `docker compose` commands to verify the release is immutable and the
local files match its attestations:

```sh
gh release verify v0.2.0-rc.4 --repo BrettKinny/UnKeep
gh release verify-asset v0.2.0-rc.4 \
  compose.release.yaml --repo BrettKinny/UnKeep
gh release verify-asset v0.2.0-rc.4 \
  unkeep-0.2.0-rc.4-image-digest.txt --repo BrettKinny/UnKeep
gh release verify-asset v0.2.0-rc.4 SHA256SUMS --repo BrettKinny/UnKeep
```

Keep the digest pin in the mode-`0600` `.env` when recreating the service. To
audit and build source instead, clone the exact tag and use the repository's
separate development Compose file:

```sh
git clone --branch v0.2.0-rc.4 https://github.com/BrettKinny/UnKeep.git
cd UnKeep
install -d -m 700 data
sudo chown 1000:1000 data
install -m 600 /dev/null .env
release_sha="$(git rev-parse HEAD)"
{
  printf 'UNKEEP_SETUP_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_RECOVERY_TOKEN=%s\n' "$(openssl rand -base64 32)"
  printf 'UNKEEP_BUILD_VERSION=0.2.0-rc.4\n'
  printf 'UNKEEP_BUILD_REVISION=%s\n' "$release_sha"
} > .env
docker compose --env-file .env up --build -d
```

The official image explicitly binds the relay to `0.0.0.0` inside its isolated
network namespace so its published port works. Compose publishes port 3000 only
to host `127.0.0.1` by default. Put that loopback
listener behind an HTTPS reverse proxy, Tailscale Serve, or Cloudflare Tunnel.
Browsers block the cryptography and PWA features UnKeep needs on insecure
non-local origins. To expose the plaintext port directly on a trusted LAN,
change the mapping deliberately and understand that bearer credentials will
cross that network without transport encryption.

Relay responses include a restrictive Content Security Policy, frame denial,
MIME-sniffing protection, a no-referrer policy, and a Permissions Policy that
disables unneeded browser capabilities. Preserve these headers at the proxy.
The plaintext relay deliberately omits `Strict-Transport-Security`: configure
HSTS at the TLS-terminating proxy only after verifying that the public hostname
is HTTPS-only. Do not add `includeSubDomains` or `preload` without assessing
every affected hostname and the long-lived rollback consequences.

If Tailscale is installed on the Docker host, expose UnKeep through that existing node instead of running a second ephemeral Tailscale container:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

This publishes UnKeep at the host's Tailnet-only HTTPS name. Check the active route with `tailscale serve status` and remove it with `tailscale serve --https=443 off`. If port 443 already serves another application, choose a free HTTPS port with `--https=<port>`.

Open the HTTPS address. On the first device, enter the setup token. UnKeep creates the encryption key locally and requires you to save its recovery kit before it initializes the server and exchanges the setup token for a revocable device credential.

To add another device, open the server URL there, choose **Pair with another
device**, then enter its eight-character code in the device menu on an already
unlocked device. Both devices independently derive a four-group fingerprint
from the relay instance, requester key, and request identity. Compare every
character and cancel if they differ; do not approve based on the short code
alone. The joining device creates its device credential locally; the relay
stores only its hash and does not authorize it for any other API until final
consume. An interrupted final consume is durably marked on the joining device
and safely retried after restart.

The device menu lists trusted devices. You can revoke any device other than the
one currently in use. Revocation recursively revokes the selected device and
every device it is known to have approved directly or indirectly. It also
revokes service credentials minted anywhere in that subtree and invalidates
its approved-but-unconsumed pairing requests. It cannot erase notes or keys
already stored on a device or in an agent environment. New service credentials
default to read-only relay access; select read-write only when an agent must
mutate notes or attachments. Either scope includes the vault key and therefore
permits full-vault decryption.

Schema v7 adds device approver lineage without rewriting existing rows. The
first setup device, every operator-recovered device, and every device retained
from an older schema therefore has `approvedByDeviceId: null` in
`RelayClient.devices()`. `null` means **root or unknown legacy lineage**; the
relay cannot safely infer which. A targeted revocation does not revoke other
`null` roots or guess at descendants paired before this upgrade.

Service credentials created before the issuer-tracking schema upgrade are preserved with an **unknown legacy issuer**. They cannot be revoked automatically with their original device. Credentials created before scope tracking retain read-write authority. The device menu identifies legacy issuers and scopes; revoke and re-mint them from a currently trusted device after upgrading.

For an incident involving an unknown legacy lineage, multiple roots, or an
untrusted device list, first confirm that the recovery kit and operator
recovery token are available. Then an active **device** credential can perform
an emergency revoke-all:

```sh
curl --fail-with-body -X DELETE \
  -H "Authorization: Device $UNKEEP_DEVICE_CREDENTIAL" \
  "${UNKEEP_ENDPOINT%/}/api/v1/devices"
```

This atomically revokes every device (including the caller), every service
credential (including unknown legacy issuers), and clears pending and consumed
pairing state. A service credential cannot call it. Use **Restore recovery
kit** plus `UNKEEP_RECOVERY_TOKEN` to establish a new root device afterward.
This contains future relay access; it does not erase copied plaintext or rotate
the vault master key.

The schema-v5 pairing upgrade deliberately removes all outstanding,
short-lived pairing requests so the relay can eliminate legacy raw device
tokens and bind new requests to one relay instance. Schema v6 then checkpoints
and truncates the WAL and runs `VACUUM` before the relay accepts requests, so
the retired raw token bytes are also removed from free database pages. Allow
temporary free disk space approximately equal to the database size during the
first upgraded startup. Startup fails closed if the scrub cannot complete.
Existing devices and service credentials are preserved. After upgrading,
restart any pairing that was waiting for approval or final consume.

Schema v8 accounts for the serialized encrypted envelopes already in `records`
and timestamps existing mutation receipts. The relay enforces these persistent
storage ceilings inside the same SQLite write transaction as each operation
that would grow the corresponding registry:

- `UNKEEP_MAX_ENCRYPTED_RECORD_BYTES`: 1 GiB by default, hard maximum 1 TiB.
- `UNKEEP_MAX_RECORDS`: 100,000 rows by default, hard maximum 10,000,000.
- `UNKEEP_MAX_ATTACHMENTS`: 10,000 attachment rows by default, hard maximum
  1,000,000.
- `UNKEEP_MAX_DEVICES`: 1,000 device rows by default, hard maximum 100,000.
- `UNKEEP_MAX_SERVICE_CREDENTIALS`: 10,000 service-credential rows by default,
  hard maximum 1,000,000.
- `UNKEEP_MAX_MUTATION_RECEIPTS`: 100,000 receipts by default, hard maximum
  1,000,000.
- `UNKEEP_MUTATION_RECEIPT_TTL_MS`: seven days by default, hard maximum 90
  days.

An explicitly configured storage value outside its documented positive-integer
range fails relay startup rather than silently widening the operator's limit.
Record and attachment counts include tombstones. Replacing or deleting an
existing record is charged by its net envelope-byte change, so a vault already
at or above a newly lowered byte limit can still accept a write that does not
increase usage. New growth fails with HTTP 507 and a stable
`encrypted_record_bytes_limit`, `record_count_limit`, or
`attachment_count_limit` error. Raise a ceiling only after confirming the
host has enough space for SQLite, its WAL, and backups.

Schema v11 adds the protocol-3 private attachment-stage ledger and includes it
in the existing record, attachment, and encrypted-byte accounting. Protocol 3
stages new encrypted attachment envelopes before publishing their note. Stages
are private to the exact device or service credential that created them and do
not appear in the change feed or attachment download route. Both live records
and incomplete stages count toward the configured ceilings, so abandoning an
upload cannot bypass storage limits.

A stage is removed by successful finalization, by a terminal stale-note or
attachment-ID conflict, or after `UNKEEP_ATTACHMENT_STAGE_TTL_MS`: ten minutes
of bundle inactivity by default, with a hard maximum of one day. Adding or
exactly replaying a stage refreshes all stages owned by that credential and
bundle together, so a sequential upload does not expire its earliest
attachment while making progress. A bundle is capped at 1,000 stages, and no
continuously retained stage epoch survives more than one day from its first
stage. After every stage expires, a later retry may restage a fresh epoch.
Other failures leave stages available for a bounded retry until expiry.
Lowering the inactivity window reduces abandoned ciphertext retention but also
shortens the pause a slow or interrupted upload can survive without restaging.

Device and service-credential counts include revoked rows so lineage and
credential audit history remain available. Reclaiming an existing device ID
does not grow the registry and remains available at the device ceiling.
Creating another device or service credential fails with HTTP 507 and
`device_count_limit` or `service_credential_count_limit`. Revocation and
listing remain available at capacity.

Mutation receipts make a recent accepted write safe to retry after its response
is lost. Expired receipts and then the oldest excess receipts are pruned; this
keeps the table bounded but means replay is not permanent. Size the count and
retention window for the longest realistic client outage.

Schema v9 makes the relay's record identity boundary match every released
client: note IDs, attachment IDs, and attachment owner IDs are 1–128 ASCII
letters, numbers, underscores, or hyphens. HTTP writes reject an oversized ID
before reading or persisting its envelope, and SQLite triggers enforce the same
invariant below the route layer. Before an upgrade, run
`server/check-database.mjs` against the stopped backup. If a legacy database
already contains a protocol-invalid row, the check and the first upgraded
startup fail without changing or printing that row. Restore the stopped backup
with the previous image, export or otherwise repair it there, and repeat the
check; do not delete ciphertext unless you knowingly accept losing that
record.

When a note deletion cascades to its attachments, the relay retains each
attachment tombstone and revision but replaces the large attachment envelope
with a small logical sentinel. This releases envelope quota and allows SQLite
to reuse pages. It does **not** securely erase ciphertext from free pages, the
WAL, storage snapshots, backups, or other devices.

The scrub cannot alter old database copies, snapshots, or backups. Keep every
pre-upgrade backup protected or securely retire it. If one may have left your
control, revoke and re-pair devices that originally joined through the legacy
pairing flow, and rotate legacy service credentials.

Relay protocol 3 retains the optimistic `baseRevision` requirement on every
record mutation and adds atomic publication for a note with new attachments.
The current client uploads each encrypted attachment to a credential-owned
stage, then finalizes the non-deleted note with the exact sorted stage manifest
and note base revision. The relay validates the base revision before publishing
anything and writes the attachments in deterministic consecutive revision
order followed immediately by the note revision in one SQLite transaction.
The mutation receipt makes a lost final response safely replayable without
requiring the already-consumed stages.

A direct attempt to create a new live attachment through the old attachment
record route now fails with HTTP 428 `compound_mutation_required`; replay of a
previously accepted legacy mutation receipt and attachment tombstones remain
supported. Missing `baseRevision` still fails with HTTP 428
`base_revision_required`. These fail-closed responses deliberately prevent an
older or hand-written client from publishing an attachment that no note can
reach. After upgrading the relay, reload or reopen every installed PWA and
update every CLI before editing or uploading files.

## Recover access after losing every device

Recovery requires both secrets with different jobs:

- The recovery kit restores the vault encryption key in the browser.
- The operator recovery token authorizes the relay to mint a new device credential.

New recovery kits use authenticated format v2 and are bound to the relay instance that created them. Editing the stored instance ID or selecting the kit for a different relay makes decryption fail before local keys, sessions, notes, or sync state are opened.

Legacy v1 kits do not contain a relay identity. On a fresh browser, UnKeep shows a dedicated warning and requires confirmation before associating one with the selected relay. A browser that retains local data for that relay also retains a non-secret vault-key fingerprint when access is cleared; a legacy kit with a different key is rejected before vault initialization or network writes. After a successful legacy recovery, download a new recovery kit so future recovery uses authenticated v2.

The operator token proves permission to mint relay access. It does **not** prove that an unbound v1 kit contains the correct encryption key, which is why fresh-browser legacy association requires an explicit trust decision.

Open the server from a replacement device, choose **Restore recovery kit**, select the kit, and enter `UNKEEP_RECOVERY_TOKEN` when prompted. The kit is decrypted locally; neither it nor the vault key is sent to the server. The server receives only the operator token and the replacement device identity.

Protect the operator token like an administrative password. Someone with it can mint relay access and modify or delete ciphertext even without the recovery kit. To rotate it, replace `UNKEEP_RECOVERY_TOKEN` in the protected `.env` with fresh output from `openssl rand -base64 32`, then recreate the container:

```sh
chmod 600 .env
docker compose --env-file .env up -d --force-recreate
```

Rotation does not revoke existing device credentials. Revoke lost devices separately from the device menu.

Failed setup-token and recovery-token submissions are limited independently
per observed network source and globally: five failures per source and 100
failures per endpoint in a five-minute window by default. A limited request
returns HTTP 429 with `Retry-After`; a correct token from that source remains
blocked until the failed-attempt window expires. Successful token checks do not
consume capacity. The in-memory limiter retains at most the configured global
failure count and discards expired sources. These controls slow online
guessing but cannot prevent a distributed denial of recovery; keep the
administrative endpoints behind the same trusted HTTPS boundary as the vault.
The observed source is the direct peer unless `UNKEEP_TRUST_PROXY=1`; enable
that mode only when the trusted proxy replaces client-supplied
`X-Forwarded-For`, or attackers can spoof the per-source key.

The bundled PWA is same-origin and needs no CORS header, so CORS is disabled by
default. If a separately hosted PWA must connect, set
`UNKEEP_ALLOWED_ORIGIN` to its exact HTTP(S) origin, such as
`https://notes.example.com`. `*` remains an explicit operator option, but it
also lets arbitrary browser origins exercise unauthenticated endpoints such as
pairing creation, so it is not recommended.

Android's installed-PWA share target depends on an active service worker to
intercept the plaintext form POST and convert it to a local URL fragment. If
that worker is unavailable, the POST has already reached the reverse proxy and
relay before the relay rejects it with `share_worker_required`; upstream
infrastructure could observe the body even though UnKeep neither stores nor
renders it. Use the fragment-based iOS Shortcut pattern on platforms or threat
models where that fallback exposure is unacceptable.

## Terminal access

The image bundles the `unkeep` CLI, but run it as the separate one-shot
Compose service so its key storage remains isolated from the relay:

```sh
docker compose --env-file .env run --rm --no-deps unkeep-cli --help
docker compose --env-file .env run --rm --no-deps unkeep-cli login --endpoint http://unkeep:3000
docker compose --env-file .env run --rm --no-deps unkeep-cli list
```

These examples assume the relay is already running. `--no-deps` prevents a
routine one-shot command from starting or waiting for the relay service.
Omitting it makes Compose follow `depends_on`, start the relay if needed, wait
for its health check, and leave it running. Naming `unkeep-cli` explicitly
activates the `cli` profile; no separate `--profile` option is needed.

The named `unkeep-cli-config` volume contains the CLI's plaintext note
snapshot, raw vault key, and bearer credential. Protect it like a browser
profile and revoke that device if the volume is exposed. The relay service never mounts this volume. Do not run
`unkeep login` through `docker compose exec unkeep`: the relay root filesystem
is intentionally read-only, and giving it writable CLI state would violate the
separation between ciphertext storage and client keys.

For durable agent access, mint a service credential bundle with
`docker compose --env-file .env run --rm --no-deps unkeep-cli provision
--name <agent>` and export its `UNKEEP_*` values wherever the CLI runs.
Provisioning defaults to read-only; add `--scope read-write` only when needed.
See the [agent scratchpad guide](agent-scratchpad.md).

The CLI serializes config transactions across processes, writes its config
directory as mode `0700`, and atomically replaces the config file at mode
`0600`. On Linux, a dead owner in the same verified PID namespace is recovered
automatically. Owners in another container/PID namespace cannot be checked
safely, so an ambiguous lock fails closed after ten seconds instead of risking
concurrent credential writes. Confirm that no CLI container or process is
still using the config volume before following the error's manual stale-lock
removal guidance.

### Move files through the container

The read-only CLI container does not mount the host working directory. Create a
dedicated directory and opt in for each transfer. Uploads need only a read-only
mount; downloads require a writable one:

```sh
install -d -m 700 transfer
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:ro" --workdir /transfer \
  unkeep-cli clip ./report.pdf
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:rw" --workdir /transfer \
  unkeep-cli paste
```

Mount only the dedicated transfer directory, never a home directory or an
entire repository. `paste` refuses to overwrite an existing path unless
`--force` is supplied. Files created by the container are owned by UID/GID
1000 on Linux.

Use the unauthenticated status endpoint to monitor the relay from the container host or another machine:

```sh
curl https://notes.example.com/api/v1/status
```

Other `/api/v1` request and response shapes are internal wire details. Use the CLI or `@unkeep/client` for integrations instead of scripting raw ciphertext records.

## Backups

Back up the whole `/data` volume while the server is stopped. SQLite uses WAL,
so copying only `unkeep.sqlite` from a running server can silently omit recent
transactions.

```sh
docker compose --env-file .env stop unkeep
tar --numeric-owner -czf "unkeep-data-$(date +%F).tgz" data/
docker compose --env-file .env start unkeep
```

Keep the downloaded recovery kit and operator recovery token in separate
secure locations: a server backup cannot decrypt your notes, and the recovery
kit alone cannot authorize a replacement device with the relay.

Test a backup before depending on it:

```sh
docker compose --env-file .env down
mv data "data.before-restore-$(date +%s)"
install -d -m 700 data
sudo chown 1000:1000 data
tar --numeric-owner -xzf unkeep-data-YYYY-MM-DD.tgz
docker compose --env-file .env run --rm --entrypoint node unkeep server/check-database.mjs
docker compose --env-file .env up -d
```

The check covers both SQLite integrity and protocol-invalid legacy record
metadata. After restoring, open the web app, verify several notes and
attachments, pair a temporary device, then revoke it. Keep the pre-restore
directory until those checks pass. For an upgrade, take the same stopped backup
first and run the candidate image's check command before its first normal
startup; rollback means restoring both the previous image version and that
backup, because schema migrations are one-way.

## Unraid settings

- Web UI / container port: `3000`
- Persistent path: `/data`
- Container variable: `UNKEEP_HOST=0.0.0.0` (the official image already sets
  this explicitly; restrict exposure with the host port mapping or container
  network)
- Required variable: `UNKEEP_SETUP_TOKEN` (32-256 printable non-whitespace ASCII characters)
- Required variable: `UNKEEP_RECOVERY_TOKEN` (same boundary; must differ from `UNKEEP_SETUP_TOKEN`)
- Legacy-only variable: `UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1` permits an explicitly shared or omitted recovery token outside the supplied Compose validation
- Optional variable: `UNKEEP_ADMIN_RATE_WINDOW_MS` (failed setup/recovery-secret window; defaults to 300000, hard maximum 86400000)
- Optional variable: `UNKEEP_ADMIN_SOURCE_RATE_LIMIT` (failed attempts per observed network source and endpoint per window; defaults to 5, hard maximum 1000)
- Optional variable: `UNKEEP_ADMIN_GLOBAL_RATE_LIMIT` (failed attempts across all sources per endpoint per window; defaults to 100, hard maximum 10000)
- Optional variable: `UNKEEP_MAX_ATTACHMENT_SIZE` (maximum plaintext attachment size in bytes; defaults to 25 MiB, hard maximum 100 MiB)
- Optional variable: `UNKEEP_MAX_ENCRYPTED_RECORD_BYTES` (serialized encrypted-envelope budget; defaults to 1 GiB)
- Optional variable: `UNKEEP_MAX_RECORDS` (all note/attachment rows including tombstones; defaults to 100000)
- Optional variable: `UNKEEP_MAX_ATTACHMENTS` (attachment rows including tombstones; defaults to 10000)
- Optional variable: `UNKEEP_MAX_DEVICES` (device rows including revoked devices; defaults to 1000)
- Optional variable: `UNKEEP_MAX_SERVICE_CREDENTIALS` (service-credential rows including revoked credentials; defaults to 10000)
- Optional variable: `UNKEEP_MAX_MUTATION_RECEIPTS` (recent idempotency receipts; defaults to 100000)
- Optional variable: `UNKEEP_MUTATION_RECEIPT_TTL_MS` (receipt retention; defaults to seven days)
- Optional variable: `UNKEEP_ATTACHMENT_STAGE_TTL_MS` (incomplete encrypted attachment-stage inactivity window; defaults to 600000, hard maximum 86400000; each continuously retained stage epoch is capped at one day)
- Optional variable: `UNKEEP_PAIRING_TTL_MS` (pairing request lifetime; defaults to 600000, hard maximum 86400000)
- Optional variable: `UNKEEP_MAX_PENDING_PAIRINGS` (global pending-pairing cap; defaults to 100)
- Optional variable: `UNKEEP_PAIRING_RATE_WINDOW_MS` (rate-limit window in milliseconds; defaults to 60000)
- Optional variable: `UNKEEP_PAIRING_SOURCE_RATE_LIMIT` (requests per source and window; defaults to 10)
- Optional variable: `UNKEEP_PAIRING_GLOBAL_RATE_LIMIT` (requests across all sources and window; defaults to 60)
- Optional variable: `UNKEEP_TRUST_PROXY=1` only when a trusted reverse proxy replaces, rather than appends to, client-supplied `X-Forwarded-For`
- Reverse proxy: HTTPS is required
- Tailscale: prefer Tailscale Serve on the Unraid host; avoid an ephemeral sidecar that must reauthenticate after every restart. The Unraid UI may already own port 443, so use a free HTTPS port such as 3443.
