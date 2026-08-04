# `@unkeep/core`

Domain types, validation, schema migrations, Markdown conversion, and client-side cryptography for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { generateMasterKey, type Note } from '@unkeep/core';
```

The package-root types, validation, migration, Markdown, and cryptography
exports are internal workspace seams. The browser's IndexedDB working
copy is retained behind `@unkeep/core/experimental` as an internal migration
surface used by the web app. It has no compatibility guarantee and is not a
separate storage choice. The old Git, S3, local-Markdown, and OAuth experiments
are no longer shipped.

`createRecoveryKit(masterKey, instanceId)` creates an authenticated v2 kit bound to one relay instance. Restore it with `recoverMasterKey(kit, expectedInstanceId)`. `importRecoveryKit` still identifies v1 kits, but they require the separate legacy migration flow and are never accepted as relay-bound v2 kits.

The package is ESM and requires Node.js 22.13 or newer when used in Node. The
experimental working-copy surface depends on IndexedDB and corresponding
browser APIs.

This private workspace package is built into the UnKeep container and is not
published to npm.
