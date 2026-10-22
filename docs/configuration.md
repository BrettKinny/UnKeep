# Configuration reference

The relay is configured entirely through environment variables. Only the two
tokens are required; everything else has a safe default. A value outside its
documented range stops the relay at startup instead of being silently
clamped.

## Tokens

| Variable | Purpose |
| --- | --- |
| `UNKEEP_SETUP_TOKEN` | One-time secret that creates the vault on the first device. Required until the vault is initialized. |
| `UNKEEP_RECOVERY_TOKEN` | Operator secret that lets a recovery kit restore access after every device is lost. Required, and must differ from the setup token. |

Both must be 32-256 printable ASCII characters with no whitespace. Generate
each one separately with `openssl rand -base64 32`; don't use memorable
passwords. The tokens are configuration, not database rows, so changing them
never touches vault data or existing devices.

After the vault is initialized, the setup token can do nothing further. Outside
Compose you may omit it; Compose requires both variables to be present.

Anyone with the recovery token can create relay access and modify or delete
ciphertext (but not read notes without a recovery kit), so protect it like an
administrator password. To rotate it, replace the value and recreate the
container. Rotation does not revoke existing devices.

`UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1` is a legacy opt-in that lets the setup
token also act as the recovery token. Leave it unset; see
[upgrading](upgrading.md#setup-token-recovery).

## Network

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `UNKEEP_HOST` | `127.0.0.1` from source, `0.0.0.0` in the image | Listen address (IP or ASCII hostname). Restrict exposure with the host port mapping. |
| `UNKEEP_TRUST_PROXY` | off | Set to `1` only behind a proxy that *replaces* `X-Forwarded-For`. Otherwise clients could spoof the address that rate limits are keyed on. |
| `UNKEEP_ALLOWED_ORIGIN` | none | Exact origin (such as `https://notes.example.com`) allowed to call the relay cross-origin. Not needed when the bundled web app is used. `*` is accepted but not recommended, because any website could then start pairing requests. |
| `UNKEEP_LINK_PREVIEWS` | off | Set to `1` to enable [link previews](self-hosting.md#link-previews). The relay then sees previewed URLs in plaintext and needs outbound internet access. |

## Files and identity

| Variable | Default | Purpose |
| --- | --- | --- |
| `UNKEEP_DATA_DIR` | `/data` in the image, `./data` from source | Directory holding `unkeep.sqlite`. |
| `UNKEEP_WEB_DIR` | bundled build | Built PWA served by the relay. |
| `PUID` / `PGID` | `1000` | Only used when the container starts as root (the Unraid setup). The relay gives the data directory to this user and group, then permanently switches to them. Must not be `0`. |

## Storage limits

| Variable | Default | Maximum |
| --- | --- | --- |
| `UNKEEP_MAX_ATTACHMENT_SIZE` | 25 MiB | 100 MiB |
| `UNKEEP_MAX_ENCRYPTED_RECORD_BYTES` | 1 GiB | 1 TiB |
| `UNKEEP_MAX_RECORDS` | 100,000 | 10,000,000 |
| `UNKEEP_MAX_ATTACHMENTS` | 10,000 | 1,000,000 |
| `UNKEEP_MAX_DEVICES` | 1,000 | 100,000 |
| `UNKEEP_MAX_SERVICE_CREDENTIALS` | 10,000 | 1,000,000 |
| `UNKEEP_MAX_MUTATION_RECEIPTS` | 100,000 | 1,000,000 |
| `UNKEEP_MUTATION_RECEIPT_TTL_MS` | 7 days | 90 days |
| `UNKEEP_ATTACHMENT_STAGE_TTL_MS` | 10 minutes | 1 day |

Sizes are in bytes and durations in milliseconds.

- **Attachment size** is enforced by the relay. The web app and CLI have their
  own fixed 25 MiB limit, so raising this alone doesn't allow bigger files.
- **Record and attachment counts** include deleted records (tombstones).
  **Device and credential counts** include revoked ones, so their history
  stays auditable.
- When a limit is reached, new growth fails with HTTP 507 and an error such as
  `record_count_limit`. Edits and deletions that don't grow usage still work,
  as do listing and revoking. Raise a limit only after checking there is disk
  space for the database, its WAL, and backups.
- **Mutation receipts** let a client safely retry a write whose response was
  lost. Expired and then the oldest receipts are pruned, so size them for the
  longest realistic client outage.
- **Attachment stages** hold encrypted uploads until their note is saved. A
  stage expires after the inactivity window (all of a client's stages refresh
  together while an upload is progressing), and no group of stages lives
  longer than one day. Stages count toward the storage limits.

## Rate limits

| Variable | Default | Maximum |
| --- | --- | --- |
| `UNKEEP_ADMIN_RATE_WINDOW_MS` | 5 minutes | 1 day |
| `UNKEEP_ADMIN_SOURCE_RATE_LIMIT` | 5 | 1,000 |
| `UNKEEP_ADMIN_GLOBAL_RATE_LIMIT` | 100 | 10,000 |
| `UNKEEP_PAIRING_TTL_MS` | 10 minutes | 1 day |
| `UNKEEP_MAX_PENDING_PAIRINGS` | 100 | |
| `UNKEEP_PAIRING_RATE_WINDOW_MS` | 60 seconds | |
| `UNKEEP_PAIRING_SOURCE_RATE_LIMIT` | 10 | |
| `UNKEEP_PAIRING_GLOBAL_RATE_LIMIT` | 60 | |

The `ADMIN` limits count *failed* setup and recovery token attempts, per
network source and per endpoint across all sources. A limited source gets HTTP
429 with `Retry-After`, and stays blocked (even with the right token) until
the window passes. This slows guessing but cannot prevent someone from
deliberately locking out recovery, so keep the relay behind the same trusted
HTTPS boundary as the vault.

## Client limits

These are fixed in the web app and CLI:

- Attachments: 25 MiB per file.
- Vault export: 10,000 notes, 10,000 attachments, 32 MiB of note text,
  96 MiB of attachment bytes, and a 256 MiB file.
- Google Keep import: 10,000 entries and 512 MiB expanded, with 4 MiB per note.
- Quick Send: about 100 KiB of note data and up to 20 small attachments;
  some apps truncate long links sooner.
- Recovery kit files: 64 KiB.
