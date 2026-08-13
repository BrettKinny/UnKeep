# `@unkeep/client`

Framework-independent pairing, session, relay, and encrypted-sync primitives for [UnKeep](https://github.com/BrettKinny/UnKeep).

```ts
import { EncryptedSync, RelayClient } from '@unkeep/client';
```

Only imports from the package root are supported. Those exports are the intended public API during the `0.x` line; minor releases may still contain breaking changes. Deep imports and the relay's raw `/api/v1` request and response shapes are internal implementation details rather than a separate compatibility contract.

`EncryptedSync.pull()` separates retrieval from cursor acknowledgement. Persist
the returned notes, tombstones, and attachment bytes durably before calling
`acknowledge(cursor, revisions)` with both values returned by that pull. A
note that cannot be decrypted or normalized is recorded first in a bounded,
instance-scoped local quarantine and returned through `quarantined`; callers
may then acknowledge the page so one poison record cannot block every later
change. Surface that metadata to the operator. `getQuarantinedRecords()`
returns the durable outstanding set, and a later valid revision clears its
entry. Quarantine metadata never contains plaintext or raw exception text.

Writes use optimistic record revisions and durable mutation IDs. If a response
is lost after the relay accepts a mutation, the client replays the exact stored
ciphertext and mutation ID before sending a newer write for that record.

Create a note with new attachments through
`commitNoteWithAttachments(note, uploads)`, preferably using each upload's
reusable async `loadBytes` callback. The SDK hashes and encrypts attachments
sequentially, durably retains at most one in-flight ciphertext payload, and
publishes the sorted attachment set plus note in one relay transaction. Keep
the caller's attachment generations and note outbox durable until the method
returns a `CompoundCommitHandle`. Confirm only local generations whose bytes
match the handle's `contentHash`, compare-clear the exact note outbox, then call
`completeCompoundCommit(handle)`.

On restart, `pendingCompoundCommits()` discovers every accepted handle even if
the caller already cleared its outbox. `resumePendingCompoundCommit(noteId,
uploads?)` resumes an existing uncommitted bundle from its exact persisted
payload and needs loaders only for stages whose ciphertext was never stored.
If those source bytes are irrecoverably gone,
`cancelPendingCompoundCommit(noteId)` can abandon only a pre-finalization
bundle; it deliberately refuses finalizing or accepted mutations. Callers must
serialize ordinary and compound writes to the same note. Do not create a new
live attachment with `uploadAttachment` followed by `push`: protocol 3 requires
the compound path.

Pending mutations are bound to the credential that encrypted and first sent
them. After credential replacement, use
`resumePendingMutationAfterCredentialChange(kind, id)` or
`resumePendingCompoundCommitAfterCredentialChange(noteId, uploads?)`. These
methods authenticate the current credential to the same vault and replay the
exact stored payload. Every failed authentication or write preserves the old
retry root. If an authenticated ordinary-note replay returns
`record_conflict`, call `rebasePendingNoteAfterCredentialChange(note)` to
atomically replace the proven-stale root with a complete freshly encrypted
mutation only after pulling, merging, and acknowledging that exact
`currentRevision` or a newer revision of the same note; a crash cannot fall
between deletion and replacement. The method rejects with
`PendingMutationRebaseRequiresPullError` instead of using a conflict revision
the caller has not applied. If the note advances while pulling, merge and
acknowledge that newer revision; the replacement uses the newer acknowledged
base.
`abandonPendingMutationAfterCredentialChange(kind, id)` is the lower-level
compare-bound alternative and returns true only after this SDK instance has
received that exact authenticated conflict. The caller must already retain the
desired state and must not call it after authentication or authorization
failures. Call `abandonPendingCompoundAfterCredentialChange(noteId)` only after
a write-capable replacement receives a terminal stage conflict and the
application still has a durable note outbox plus the exact attachment bytes
needed to rebuild with fresh attachment IDs.

Attachment IDs are content-record identities, not mutable filenames. Upload
each new or replacement byte sequence under a fresh ID, update the owning
note's attachment metadata, and tombstone the retired ID; the relay permits
only the live-to-deleted transition for an existing attachment ID.

`DeviceKeyStore` binds new wrapped master keys and recovery kits to the relay `instanceId`. Pass the instance ID reported by relay status into first-device provisioning, pairing persistence, recovery, and unlock; a mismatch is rejected before local access or session state is replaced.

Security-sensitive client persistence has an explicit capability contract.
`DeviceKeyStore` installation, rollback, and clearing require
`ClientStorage.transact`, while pairing finalization requires
`ClientStorage.update`. Pairing a web-style client requires the key and session
stores to share the same transaction domain. The SDK fails closed instead of
emulating these operations with separate writes. A caller may select
`storageIsolation: 'externally-serialized'` only when it holds one exclusive
lock across the complete pairing operation and its `initialize` callback
atomically commits the durable key/session bundle; this mode exists for the
UnKeep CLI's locked JSON configuration.

Stored wrapped-key records carry an opaque generation used for exact CAS. The
generation fences structured-cloned, non-extractable `CryptoKey` objects
without exporting key material; every SDK wrapping-key replacement also
changes that generation and its randomized envelope.

Pairing exposes an independently derived fingerprint on both the requester and
approver. Compare every character before approval and cancel on any mismatch;
the relay never supplies the displayed fingerprint. Protocol-v2 fingerprints
and encrypted key-transfer AAD include the relay instance ID. The requester
generates its 32-byte device credential locally. The unauthenticated request
sends only its SHA-256 hash; final consume and subsequent authenticated calls
send the raw bearer over the configured transport, while the relay hashes it
for lookup and never persists or returns it. If the final consume response is
lost, the SDK preserves durable local access with a
`pendingPairingRequestId`. Call `resumePairingFinalization(sessionStore)` on a
later start; retries are safe against the bound relay instance.

Relay activation and local IndexedDB cannot share one distributed transaction.
If the exact pending marker is cleared or replaced while final consume is in
flight, `waitForPairing` fails closed and never reports the stale key/session as
ready. A cleared session triggers a bounded best-effort self-revocation with
the new credential. Revocation cannot be guaranteed while the relay is
unreachable, so an activated orphan credential may still require removal from
another device. A lost consume response is reported as
`finalizationPending: true` only while the exact durable pending marker remains
current.

`RelayClient.mintServiceCredential(name, scope)` accepts `read-only` or
`read-write` and defaults to `read-only`. Read-only credentials can pull
changes and attachment ciphertext but cannot mutate records or use
administrative endpoints. Scope does not limit decryption: a provisioned
client that receives the vault key can decrypt the whole vault, and the relay
cannot enforce label-specific access over encrypted note contents.

Legacy v1 recovery is a two-step API: `validateLegacyRecovery` decrypts and checks retained relay-scoped key fingerprints without writing, while `restoreLegacyDeviceFromRecovery` commits the user-confirmed association and upgrades local storage so the next exported kit is v2. Clearing device access deliberately preserves the non-secret fingerprint while local vault data remains.

The package is ESM and requires Node.js 20 or newer when used in Node. Browser persistence and cryptography integrations require their corresponding Web APIs.

Release candidates are validated from the source tree and identified by their
annotated GitHub tag. The supported deployment artifact is the release image
published to GHCR; build this package from a source checkout when using its
library API.
