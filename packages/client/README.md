# `@unkeep/client`

Framework-independent pairing, session, relay, and encrypted-sync primitives for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { EncryptedSync, RelayClient } from '@unkeep/client';
```

Only imports from the package root are supported. Those exports are the intended public API during the `0.x` line; minor releases may still contain breaking changes. Deep imports and the relay's raw `/api/v1` request and response shapes are internal implementation details rather than a separate compatibility contract.

`EncryptedSync.pull()` separates retrieval from cursor acknowledgement. Persist the returned notes, tombstones, and attachment bytes durably before calling `acknowledge(cursor, revisions)` with both values returned by that pull.

Writes use optimistic record revisions and durable mutation IDs. If a response is lost after the relay accepts a mutation, the client replays the exact stored ciphertext and mutation ID before sending a newer write for that record.

`DeviceKeyStore` binds new wrapped master keys and recovery kits to the relay `instanceId`. Pass the instance ID reported by relay status into first-device provisioning, pairing persistence, recovery, and unlock; a mismatch is rejected before local access or session state is replaced.

Legacy v1 recovery is a two-step API: `validateLegacyRecovery` decrypts and checks retained relay-scoped key fingerprints without writing, while `restoreLegacyDeviceFromRecovery` commits the user-confirmed association and upgrades local storage so the next exported kit is v2. Clearing device access deliberately preserves the non-secret fingerprint while local vault data remains.

The package is ESM and requires Node.js 20 or newer when used in Node. Browser persistence and cryptography integrations require their corresponding Web APIs.

This repository produces a locally installable package tarball, but it does not automatically publish one to a registry.
