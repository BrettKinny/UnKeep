# `@unkeep/core`

Domain types, validation, schema migrations, Markdown conversion, and client-side cryptography for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { generateMasterKey, type Note } from '@unkeep/core';
```

The documented package-root types, validation, migration, Markdown,
and cryptography exports are the intended public API during the `0.x` line;
minor releases may still contain breaking changes. The local working-copy and
legacy Git, S3, local Markdown, adapter-configuration, and OAuth helpers are
isolated behind `@unkeep/core/experimental`. That subpath has no compatibility
guarantee and is not a supported product backend.

`createRecoveryKit(masterKey, instanceId)` creates an authenticated v2 kit bound to one relay instance. Restore it with `recoverMasterKey(kit, expectedInstanceId)`. `importRecoveryKit` still identifies v1 kits, but they require the separate legacy migration flow and are never accepted as relay-bound v2 kits.

The package is ESM and requires Node.js 20 or newer when used in Node.
Experimental adapters also depend on their corresponding browser or platform
APIs.

Release-candidate tags publish this package to npm under the `next` dist-tag
through the protected release workflow. Pin an exact prerelease version when
evaluating it.
