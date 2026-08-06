# UnKeep as an agent scratchpad

UnKeep is two things sharing one encrypted vault:

1. **A self-hosted Google Keep replacement** — the PWA you open in a browser.
2. **A scratchpad for AI agents and scripts** — the same notes, reachable from any terminal through the `unkeep` CLI with a small environment bundle.

Anything an agent writes shows up as a card in the browser on the next sync,
and anything you jot down on your phone is one `unkeep get` away inside a
coding session. Notes are encrypted client-side in both directions. The relay
stores ciphertext plus the credential hashes, record relationships, revisions,
device IDs, and timing metadata needed to authorize and synchronize it.

## Provision an agent

Agents never pair interactively. Instead, an already-paired human device mints a **service credential** and hands the agent a four-field bundle.

One-time setup on your own machine (interactive):

```sh
pnpm install && pnpm build                           # builds core, client, and the CLI
alias unkeep="node /path/to/UnKeep/apps/cli/dist/bin.js"

unkeep --endpoint https://unkeep.example.com login   # compare the fingerprint, then approve
```

No checkout handy? The Docker image provides an isolated client service:

```sh
docker compose --env-file .env run --rm --no-deps \
  unkeep-cli login --endpoint http://unkeep:3000
```

Its `unkeep-cli-config` volume persists a plaintext note snapshot, the device
credential, and the raw vault key without mounting them into the relay
container. Protect that volume like a browser profile. The mode-`0600` `.env` from the self-hosting setup is needed
for Compose interpolation. `--no-deps` assumes the relay is already running;
omit it only when Compose should start and wait for that dependency. Do not log
in through `docker compose exec unkeep`.

Then mint a bundle per agent or environment. Read-only is the safe default:

```sh
unkeep provision --name "review bot"
unkeep provision --name "claude-code laptop" --scope read-write
```

This prints:

```
UNKEEP_ENDPOINT=https://unkeep.example.com
UNKEEP_CREDENTIAL=<service credential>
UNKEEP_VAULT_KEY=<base64url vault key>
UNKEEP_SCOPE=read-only
```

Export the three connection secrets in the agent's environment (a devcontainer,
a CI job, a Claude Code environment, a cron script) and retain
`UNKEEP_SCOPE` alongside them as explicit authorization metadata. The
authorized `unkeep` commands work non-interactively with no config file,
browser, or pairing. Add `--json` to `provision` to get the same deterministic
four-field bundle as a single JSON object. The scope value is the relay's
server-confirmed result, not merely the requested CLI flag.

`read-only` credentials can list, get, sync, and download attachments, but relay writes and every credential/device/pairing administration endpoint reject them. `read-write` credentials can also put/delete notes and upload/delete attachments. Neither scope is an encryption boundary: both bundles contain `UNKEEP_VAULT_KEY`, decrypt the entire vault, and can retain plaintext. Label-scoped credentials are not possible in the current design because labels and note contents are encrypted from the relay.

Manage access with:

```sh
unkeep credentials list           # devices and service credentials
unkeep credentials revoke <id>    # takes effect on the credential's next request
```

### Security notes

- The bundle's `UNKEEP_VAULT_KEY` **decrypts the whole vault**. Treat the bundle like a password: keep it in a secret store, never commit it, and mint one per agent so revocation is targeted.
- Prefer the default `read-only` scope for review, search, indexing, and backup jobs. Grant `--scope read-write` only to agents that must edit the vault.
- Revoking a service credential blocks future relay access but cannot un-share
  the vault key or erase copied plaintext. UnKeep has no in-place master-key
  rotation: after a bundle leak, contain the affected environment, revoke the
  credential, preserve a safe export, create a new vault with new credentials,
  and re-import only the data you still trust.
- Give agents their own vault (a second UnKeep container is cheap) if they should not read your personal notes.

## The scratchpad workflow

Note and clipboard commands sync with the relay before operating, so agents use
current note state. Administrative, setup, and help commands perform only the
requests relevant to that command. All commands support `--json` for stable,
machine-readable output on stdout; errors go to stderr with a non-zero exit
code.

```sh
# Jot something down (ID is generated and printed)
unkeep put --title "Build failure notes" --content "segfault repros on arm64 only"

# Pipe content in
git diff --stat | unkeep put --title "WIP diff summary" --label scratch

# Find it again
unkeep list -q segfault --json
unkeep list --label scratch

# Read it
unkeep get 4f7c2d9e-… --json     # full note as JSON
unkeep get 4f7c2d9e-…            # just the content

# Update in place (same ID overwrites)
unkeep put 4f7c2d9e-… --content "fixed: alignment bug in the parser"

# Move it to Trash (recoverable)
unkeep delete 4f7c2d9e-…

# Review or restore trashed notes
unkeep list --trash
unkeep restore 4f7c2d9e-…

# Permanently delete a note that is already in Trash
unkeep delete 4f7c2d9e-… --permanent
```

Useful conventions:

- **Label your scratch.** `--label scratch` (or a per-agent label like `--label claude`) keeps agent noise filterable in the browser, and `unkeep list --label claude` gives the agent its own view.
- **Stable IDs for well-known notes.** IDs are free-form (`[a-zA-Z0-9_-]`), so a recurring note like `unkeep put todo-agent --content "…"` acts as a named mailbox both sides know how to find.
- **Delete is recoverable by default.** `unkeep delete` moves a note to Trash. Use `--permanent` only after reviewing the note in Trash; permanent deletion cannot be undone.

## Moving files

The encrypted clipboard moves files between any paired machine, agent sandbox, or the browser:

```sh
unkeep clip ./build.log        # encrypt + upload (25 MB limit)
unkeep clip --list             # newest first
unkeep paste                   # download the latest clip to the CWD
unkeep paste <attachment-id>   # or a specific one
```

Attachments also appear on the Clipboard note in the PWA.

When using the Compose client, explicitly mount only a dedicated transfer
directory. Upload through a read-only mount and grant write access only when
downloading:

```sh
install -d -m 700 transfer
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:ro" --workdir /transfer \
  unkeep-cli clip ./build.log
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/transfer:/transfer:rw" --workdir /transfer \
  unkeep-cli paste
```

Do not expose a home directory or repository to the client container merely to
transfer one file.

## Drop-in agent instructions

Paste this into a project's `CLAUDE.md` / `AGENTS.md` to teach an agent the scratchpad (assumes the bundle is in the environment and `unkeep` is on `PATH`):

```markdown
## Scratchpad

A shared, persistent scratchpad is available via the `unkeep` CLI (auth comes
from the environment). Use it to leave notes for the humans on this project and
to read notes they leave for you.

- `unkeep list --json` / `unkeep list -q <text> --json` — find notes
- `unkeep get <id> --json` — read one
- `unkeep put --title <t> --content <c> --label claude` — create (prints the new ID)
- `unkeep put <id> --content <c>` — update
- `unkeep delete <id>` — move a note to Trash
- `unkeep list --trash` / `unkeep restore <id>` — review or recover trashed notes
- `unkeep delete <id> --permanent` — permanently delete a note already in Trash
- `unkeep clip <file>` / `unkeep paste` — move files in and out

Label everything you create with `claude` so it is easy to filter. Check the
note titled with ID `todo-agent`, if present, for standing instructions.
```

## Connection reference

Flags override environment variables, which override the config file written by `login` (`$XDG_CONFIG_HOME/unkeep/config.json`).

| Flag | Environment variable | Meaning |
|------|----------------------|---------|
| `--endpoint <url>` | `UNKEEP_ENDPOINT` | Relay base URL |
| `--credential <token>` | `UNKEEP_CREDENTIAL` | Device or service credential |
| `--vault-key <key>` | `UNKEEP_VAULT_KEY` | Base64/base64url/hex vault key |
| `--config-dir <path>` | — | Override the config directory |

An endpoint is bound to its credential and vault key. If an override selects a
different origin from the saved profile, supply all three `UNKEEP_*` connection
values together; an endpoint-only override fails before transmitting a saved
bearer credential.

HTTPS is required for public endpoints; plain HTTP is accepted for localhost, private ranges, and container networks (e.g. an agent sandbox talking to `http://unkeep:3000` on the same Docker network).
