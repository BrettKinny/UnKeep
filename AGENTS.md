# Agent working agreement

These instructions apply to coding agents working in this repository.

Read [CLAUDE.md](CLAUDE.md) for the current architecture and commands; despite
its filename, that guidance applies to every agent. Read
[THREAT_MODEL.md](THREAT_MODEL.md) before changing encryption, pairing,
recovery, credentials, synchronization, sharing, imports, browser rendering,
or terminal output.

## Product boundary

UnKeep is a single-user, self-hosted notes vault used across trusted devices,
terminals, and agents. It is not a multi-user collaboration system. The
supported path is the local IndexedDB working copy plus `EncryptedSync` and the
SQLite relay. Legacy Git, S3, local Markdown, and selectable-adapter code is
experimental.

## Change discipline

- Preserve local-first durability and explicit conflict handling.
- Treat decrypted notes, agent writes, URLs, filenames, archives, and terminal
  content as untrusted input.
- Add adversarial tests for changes to security or multi-device invariants.
- Keep CLI JSON deterministic and diagnostics on stderr.
- Never add live credentials, recovery kits, databases, private notes,
  environment files, or generated build artifacts.
- Use [SECURITY.md](SECURITY.md) for vulnerability reporting and
  [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) for normal issue
  workflow.

Before handing off a change, run the relevant subset of `pnpm check`,
`pnpm lint`, `pnpm test`, `pnpm smoke:packages`, and `pnpm test:e2e`, and state
exactly what was and was not verified.
