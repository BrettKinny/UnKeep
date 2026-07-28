# `@unkeep/cli`

The command-line client for [UnKeep](https://github.com/BrettKinny/UnKeep).

```sh
unkeep --endpoint https://notes.example.com login
unkeep list --label work
unkeep sync
```

The documented executable commands, options, and `--json` output are the intended public interface during the `0.x` line; minor releases may still contain breaking changes. The package-root TypeScript exports exist for the executable and tests but are not a separately supported embedding API.

The CLI is ESM and requires Node.js 20 or newer. This repository produces a locally installable package tarball, but it does not automatically publish one to a registry.
