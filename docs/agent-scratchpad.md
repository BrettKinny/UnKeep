# UnKeep as an agent scratchpad

UnKeep is two things sharing one encrypted vault:

1. **A self-hosted Google Keep replacement** — the PWA you open in a browser.
2. **A scratchpad for AI agents and scripts** — the same notes, reachable from any terminal through the `unkeep` CLI with nothing but three environment variables.

Anything an agent writes shows up as a card in the browser on the next sync, and anything you jot down on your phone is one `unkeep get` away inside a coding session. Notes are encrypted client-side in both directions; the relay only ever stores ciphertext.

## Provision an agent

Agents never pair interactively. Instead, an already-paired human device mints a **service credential** and hands the agent a three-variable bundle.

One-time setup on your own machine (interactive):

```sh
pnpm install && pnpm build                           # builds core, client, and the CLI
alias unkeep="node /path/to/UnKeep/apps/cli/dist/bin.js"

unkeep --endpoint https://unkeep.example.com login   # approve the code on a paired device
```

Then mint a bundle per agent or environment:

```sh
unkeep provision --name "claude-code laptop"
```

This prints:

```
UNKEEP_ENDPOINT=https://unkeep.example.com
UNKEEP_CREDENTIAL=<service credential>
UNKEEP_VAULT_KEY=<base64url vault key>
```

Export those three variables in the agent's environment (a devcontainer, a CI job, a Claude Code environment, a cron script) and every `unkeep` command works non-interactively — no config file, no browser, no pairing. Add `--json` to `provision` to get the bundle as a single JSON object instead.

Manage access with:

```sh
unkeep credentials list           # devices and service credentials
unkeep credentials revoke <id>    # takes effect on the credential's next request
```

### Security notes

- The bundle's `UNKEEP_VAULT_KEY` **decrypts the whole vault**. Treat the bundle like a password: keep it in a secret store, never commit it, and mint one per agent so revocation is targeted.
- Revoking a service credential blocks relay access but cannot un-share the vault key. If a bundle leaks, rotate what it protects.
- Give agents their own vault (a second UnKeep container is cheap) if they should not read your personal notes.

## The scratchpad workflow

Every command syncs with the relay first, so agents always operate on current state. All commands support `--json` for stable, machine-readable output on stdout; errors go to stderr with a non-zero exit code.

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

# Clean up after yourself
unkeep delete 4f7c2d9e-…
```

Useful conventions:

- **Label your scratch.** `--label scratch` (or a per-agent label like `--label claude`) keeps agent noise filterable in the browser, and `unkeep list --label claude` gives the agent its own view.
- **Stable IDs for well-known notes.** IDs are free-form (`[a-zA-Z0-9_-]`), so a recurring note like `unkeep put todo-agent --content "…"` acts as a named mailbox both sides know how to find.
- **Archive instead of delete** (`--archived`) when a human might still want to review the note.

## Moving files

The encrypted clipboard moves files between any paired machine, agent sandbox, or the browser:

```sh
unkeep clip ./build.log        # encrypt + upload (25 MB limit)
unkeep clip --list             # newest first
unkeep paste                   # download the latest clip to the CWD
unkeep paste <attachment-id>   # or a specific one
```

Attachments also appear on the Clipboard note in the PWA.

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
- `unkeep delete <id>` — remove notes you no longer need
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

HTTPS is required for public endpoints; plain HTTP is accepted for localhost, private ranges, and container networks (e.g. an agent sandbox talking to `http://unkeep:3000` on the same Docker network).
