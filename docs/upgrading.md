# Upgrading from preview releases

Fresh installs of 0.2.1 or later can skip this page. It collects the one-time
changes that matter when a relay created by a `0.1.x` or `0.2.0-rc` preview is
upgraded. Database migrations run automatically on first start and are
one-way, so always follow the [backup and upgrade steps](self-hosting.md#upgrade)
and run the database check before the first start on a new version.

After upgrading the relay, reload every installed PWA and update every CLI
before editing or uploading files. The relay refuses some writes from older
clients (see [atomic attachments](#atomic-attachments-schema-v11-protocol-3)).

## Tokens

Both tokens must now be 32-256 printable ASCII characters without whitespace,
and the recovery token is required and must differ from the setup token. If an
old token doesn't meet that, replace it with `openssl rand -base64 32` before
upgrading. This doesn't touch vault data or devices.

### Setup-token recovery

Early previews let the setup token double as the recovery token. To keep that
behaviour temporarily, set `UNKEEP_ALLOW_SETUP_TOKEN_RECOVERY=1` and (because
Compose requires it) set `UNKEEP_RECOVERY_TOKEN` to the same value. This
weakens the separation between setup and recovery; replacing it with a
distinct recovery token is the recommended fix.

## Pairing scrub (schema v5 and v6)

Outstanding pairing requests are discarded, legacy raw device tokens are
removed, and the database is vacuumed so their bytes don't linger in free
pages. Allow free disk space roughly equal to the database size for the first
start; startup stops if the scrub can't finish. Restart any pairing that was in
progress.

The scrub can't reach old backups or snapshots. Keep pre-upgrade backups
protected or destroy them. If one may have leaked, revoke and re-pair devices
that joined through the old pairing flow and replace old service credentials.

## Device lineage (schema v7)

Revoking a device now also revokes every device it approved, directly or
indirectly. Devices from before this change have unknown lineage and show
`approvedByDeviceId: null`, the same as the first device and recovered
devices, so revoking one device won't revoke them.

Service credentials created before issuer tracking show an **unknown legacy
issuer** and aren't revoked with any device. Credentials from before scopes
existed keep read-write access. Revoke and re-mint both kinds from a trusted
device.

If the device list can't be trusted, use the
[emergency revoke-all](self-hosting.md#if-a-device-is-lost-or-compromised).

## Storage limits (schema v8)

Existing encrypted data is measured and counted toward the new
[storage limits](configuration.md#storage-limits). A vault already over a
limit keeps working but can't grow until the limit is raised.

## Record IDs (schema v9)

Note and attachment IDs must be 1-128 ASCII letters, digits, `_`, or `-`. If an
old database contains an invalid row, both the database check and the first
start fail without changing or printing it. Restore the backup with the
previous image, fix or export the note there, and check again. Don't delete
ciphertext unless you accept losing that record.

## Atomic attachments (schema v11, protocol 3)

A note and its new attachments are now published together in one
transaction, so another device never sees an attachment without its note.
Older clients that upload attachments the old way get HTTP 428
`compound_mutation_required` and must be updated.

When a deleted note's attachments are removed, the relay keeps a small
tombstone but drops the encrypted bytes. This frees quota, but it isn't secure
erasure: old bytes can remain in free pages, the WAL, snapshots, backups, and
other devices.
