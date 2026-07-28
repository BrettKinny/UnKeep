# `@unkeep/core`

Domain types, validation, schema migrations, Markdown conversion, and client-side cryptography for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { generateMasterKey, type Note } from '@unkeep/core';
```

Only imports from the package root are supported. The documented types, validation, migration, Markdown, and cryptography exports are the intended public API during the `0.x` line; minor releases may still contain breaking changes. The legacy Git, S3, local Markdown, and local-only adapter exports are experimental and are not part of the supported product workflow.

The package is ESM and requires Node.js 20 or newer when used in Node. Individual adapters also depend on their corresponding browser or platform APIs.

This repository produces a locally installable package tarball, but it does not automatically publish one to a registry.
