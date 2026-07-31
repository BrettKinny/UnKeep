# Contributing to UnKeep

Thank you for helping build a self-hosted notes vault that works equally well
for people, terminals, and agents.

## Before starting

- Search [existing issues](https://github.com/BrettKinny/UnKeep/issues) and pull
  requests before opening a duplicate.
- Discuss substantial features, protocol changes, cryptography, storage
  migrations, or public API changes in an issue first.
- Report suspected vulnerabilities privately according to
  [SECURITY.md](SECURITY.md).
- Keep a pull request focused enough to review and revert independently.

## Development setup

UnKeep's repository build uses Node.js 22.13.0 or newer and pnpm 10.

```sh
corepack enable
pnpm install
pnpm dev
```

Useful verification commands:

```sh
pnpm check
pnpm lint
pnpm notices:check
pnpm test
pnpm smoke:packages
pnpm test:e2e
```

Run the checks relevant to your change. Changes to synchronization, pairing,
recovery, imports, service workers, or release artifacts should include the
corresponding integration or end-to-end test. Use generated fixtures rather
than a real vault or credential.

## Design constraints

- Preserve the local-first path: commit locally before normal remote sync.
- Never send plaintext notes, attachments, vault keys, or recovery material to
  the relay.
- Treat decrypted records, imported files, agent writes, filenames, URLs, and
  terminal content as untrusted input.
- Preserve offline opening for an already initialized browser.
- Keep `unkeep --json` deterministic and machine-readable; send diagnostics to
  stderr and retain meaningful non-zero exit codes.
- Maintain compatibility deliberately. Public packages and CLI behavior are
  `0.x`, while raw relay routes and deep imports are internal.
- The current product path is IndexedDB plus `EncryptedSync` and the UnKeep
  relay. Legacy Git, S3, local Markdown, and selectable-adapter code is
  experimental and should not be expanded without an accepted design.
- Describe security guarantees using the boundaries in
  [THREAT_MODEL.md](THREAT_MODEL.md).

## Pull requests

A good pull request includes:

- the problem and user-visible outcome;
- security, privacy, migration, and backward-compatibility effects;
- tests that fail without the change and pass with it;
- documentation updates for changed behavior; and
- the exact commands used to verify the result.

Do not include generated build output, local databases, credentials, recovery
kits, environment files, or personal note content. By contributing, you agree
that your contribution is licensed under the repository's
[MIT License](LICENSE).

Maintainers may ask for a smaller change, additional adversarial tests, or an
ADR before accepting work that changes trust boundaries or protocol semantics.
