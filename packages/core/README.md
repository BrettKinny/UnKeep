# `@unkeep/core`

Domain types, validation, schema migrations, Markdown conversion, and client-side cryptography for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { generateMasterKey, type Note } from '@unkeep/core';
```

The documented package-root types, validation, migration, Markdown, and
cryptography exports are the intended public API during the `0.x` line; minor
releases may still contain breaking changes. The browser's IndexedDB working
copy is retained behind `@unkeep/core/experimental` as an internal migration
surface used by the web app. It has no compatibility guarantee and is not a
separate storage choice. The old Git, S3, local-Markdown, and OAuth experiments
are no longer shipped.

`createRecoveryKit(masterKey, instanceId)` creates an authenticated v2 kit bound to one relay instance. Restore it with `recoverMasterKey(kit, expectedInstanceId)`. `importRecoveryKit` still identifies v1 kits, but they require the separate legacy migration flow and are never accepted as relay-bound v2 kits.

The package is ESM and requires Node.js 20 or newer when used in Node. The
experimental working-copy surface depends on IndexedDB and corresponding
browser APIs.

Release-candidate tags publish this package to npm under the `next` dist-tag
through the protected release workflow. Pin an exact prerelease version when
evaluating it.
