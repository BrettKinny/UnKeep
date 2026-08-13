# `@unkeep/cli`

The command-line client for [UnKeep](https://github.com/BrettKinny/UnKeep).

## Install

The release image provides a separate one-shot Compose client whose key volume
is isolated from the relay:

```sh
docker compose --env-file .env run --rm --no-deps unkeep-cli --help
docker compose --env-file .env run --rm --no-deps unkeep-cli login --endpoint http://unkeep:3000
```

The protected, mode-`0600` `.env` is created during
[self-host setup](../../docs/self-hosting.md). It is required for Compose
interpolation even when the relay already exists. `--no-deps` keeps a routine
one-shot command from starting or waiting for the relay; omit it when that
behavior is intentional. Naming the CLI service activates its profile
automatically.

From a source checkout, run `pnpm build:packages`, then execute
`node apps/cli/dist/bin.js`.

Release images and source/release assets are published through GitHub and
GHCR. There is no registry install step for the CLI.

The CLI is ESM and requires Node.js 20 or newer.

## Authenticate

Pair a terminal interactively with an existing trusted device:

```sh
unkeep --endpoint https://notes.example.com login
unkeep list --label work
unkeep sync
```

`login` prints a pairing code and a four-group security fingerprint. Compare
the complete fingerprint with the approving device before approving; the value
is derived independently from the requester key and is not accepted from the
relay. Cancel if any character differs.

`login` writes the relay endpoint, device credential, vault key, and device ID
atomically beneath `$XDG_CONFIG_HOME/unkeep/config.json` (or
`~/.config/unkeep/config.json`). The directory is tightened to mode `0700` and
the file to mode `0600`; protect both as secrets.
If the relay's final response is lost, the file retains a non-secret pending
request marker and later CLI commands retry finalization without discarding the
working credential or vault key.

Config transactions are serialized across CLI processes. On Linux, a lock
abandoned by a dead process in the same verified PID namespace is recovered
automatically. Cross-container/PID-namespace owners are deliberately treated
as ambiguous because numeric PIDs can collide; the command fails closed after
ten seconds with owner-aware manual recovery guidance. Never delete the lock
while another `unkeep` process or container may still be using the same config
directory.

For noninteractive agents, provision a separate revocable service bundle from a
paired terminal:

```sh
unkeep provision --name "summarizer"
unkeep provision --name "writer" --scope read-write
```

The default scope is `read-only`: it permits sync and encrypted downloads but
rejects note/attachment mutations and all administrative endpoints. Use
`--scope read-write` only for an agent that must change the vault. Both scopes
still receive the vault key and can decrypt every note and attachment; relay
authorization cannot restrict an encrypted vault by label.

Flags override environment variables, which override the config file:

| Flag | Environment |
| --- | --- |
| `--endpoint` | `UNKEEP_ENDPOINT` |
| `--credential` | `UNKEEP_CREDENTIAL` |
| `--vault-key` | `UNKEEP_VAULT_KEY` |

An endpoint is bound to its saved credential and vault key. Overriding it with
a different origin never reuses those saved secrets: provide the new endpoint,
credential, and vault key together, or the CLI fails before making a request.

Avoid secret-bearing command-line flags in shared environments because process
lists and shell history may record them. Prefer a protected config file or
short-lived secret-store environment injection. Every agent bundle contains
the vault key and can decrypt the entire vault; relay authorization cannot
retroactively erase a copied key.

## Container file transfer

The hardened Compose service has a read-only root filesystem and does not mount
the host working directory. Opt in with a dedicated transfer directory:

```sh
install -d -m 700 transfer
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:ro" --workdir /transfer \
  unkeep-cli clip ./report.pdf
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:rw" --workdir /transfer \
  unkeep-cli paste
```

Use the read-only mount for `clip`; grant write access only for `paste`. Do not
mount a home directory or repository just to move one file. `paste` refuses to
overwrite an existing path unless `--force` is supplied.

`clip` first creates a private, fsynced staging snapshot under the CLI config
directory using bounded reads. It encrypts and stages the attachment, then asks
the relay to publish that exact ciphertext and the updated Clipboard note in
one atomic compound mutation. Its durable intent and encrypted mutation are
replayed under the config lock on the next connected command, so a lost stage
or final response reuses one attachment ID and a concurrent Clipboard edit is
merged before success is reported. The SDK completion handle is cleared only
after the local note cache and intent update is durable; recovery verifies the
attachment content hash before reconciling the remaining crash window. The
plaintext staging snapshot may temporarily consume up to the 25 MiB attachment
limit and is removed after local completion. If the original device credential
is replaced, the CLI first authenticates the replacement to the same vault.
It preserves exact retry state for invalid or read-only credentials and uses a
fresh attachment identity when a private stage remains reserved to the old
credential.

## Machine output

`--json` writes exactly one JSON value followed by a newline on stdout.
Diagnostics go to stderr. The current stable shapes are:

| Command | JSON result |
| --- | --- |
| `login` | `{ "endpoint", "deviceId", "paired": true }` |
| `provision` | `{ "UNKEEP_ENDPOINT", "UNKEEP_CREDENTIAL", "UNKEEP_VAULT_KEY", "UNKEEP_SCOPE" }` |
| `credentials list` | Array of device/service credential records; service records include `scope` |
| `credentials revoke` | `{ "id", "revoked": true }` |
| `list` | Array of complete note records |
| `get`, `put` | One complete note record |
| `delete` | `{ "id", "deleted": true }` |
| `sync` | `{ "cursor", "pulled", "deleted", "quarantined" }` |
| `clip`, `clip --list` | Attachment record, or array of attachment records |
| `paste` | `{ "id", "name", "path", "size" }` |

Exit status is `0` for success and `1` for invalid input, authentication,
network, conflict, storage, or other operational failure. Scripts should parse
JSON rather than human output and treat new object fields as forward-compatible
additions during the `0.x` line.

Interactive TTY output escapes terminal control and bidirectional formatting
characters. JSON and redirected output intentionally preserve note data
exactly; do not print that raw data back to an interactive terminal without
sanitizing it.

Each note command pulls remote changes before operating and uses optimistic
record revisions. A conflict or failed durable write returns non-zero instead
of silently claiming success.

The documented executable commands, options, and `--json` output are the
intended public interface during the `0.x` line; minor releases may still
contain breaking changes. The package deliberately has no package-root exports;
use the `unkeep` executable rather than importing it as a library.
