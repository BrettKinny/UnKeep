# Releasing UnKeep

Release candidates are produced by `.github/workflows/release.yml`. The
workflow is tag-gated: a manual dispatch validates a candidate without
publishing, while an annotated `vX.Y.Z-rc.N` tag enters one serialized
publication chain.

The release surface is GitHub and GHCR only. The workflow publishes:

- `linux/amd64` and `linux/arm64` images to
  `ghcr.io/brettkinny/unkeep`;
- immutable-by-policy image tags for the exact version and source SHA;
- OCI SBOM and provenance attestations alongside the GHCR image; and
- a prerelease GitHub Release containing the image digest, exported amd64
  SPDX SBOM, `compose.release.yaml`, `THIRD_PARTY_NOTICES.md`, the preserved
  Node runtime license, the exact container corresponding-source archive and
  metadata, and `SHA256SUMS`.

The packages are build and test inputs, not separately published registry
artifacts. `pnpm smoke:packages` still packs and exercises them locally during
the release gates.

Do not create a release tag until every prerequisite below is complete.

## One-time history and privacy gate

Before making a repository or release public, scan the complete Git object
history and every available ref, including branches, tags, remote-tracking
refs, pull-request refs, and commit subjects and bodies. Check for
credentials, recovery material, private notes, environment data, personal
collaboration metadata, and private session or service links. Perform the
review locally in an isolated mirror and use a secret scanner across all refs;
do not paste sensitive findings into an issue, pull request, commit, or
Actions log.

Rewriting or force-pushing `main` and tags does not purge closed pull-request
refs, provider caches, forks, clones, downloaded artifacts, or old workflow
logs. If private material reached the existing remote, revoke affected
credentials and publish from a genuinely fresh repository and reviewed,
squashed public history.

## One-time GitHub configuration

1. Decide repository visibility deliberately and complete the history/privacy
   review before the first public release.
2. Enable **release immutability** under **Settings → General → Releases**.
   An administrator can verify it with:

```sh
   gh api --method PUT \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     repos/BrettKinny/UnKeep/immutable-releases
   gh api \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     repos/BrettKinny/UnKeep/immutable-releases
```

   The final command must return an enabled value. Run this with an
   administrator-authenticated session; the workflow's short-lived token
   cannot read repository Administration settings.
3. Create a GitHub environment named exactly `release`.
4. Add an environment configuration variable named `UNKEEP_RELEASE_GUARD`
   with the exact value `BrettKinny/UnKeep:release:v1`.
5. After an administrator confirms release immutability, add
   `UNKEEP_IMMUTABLE_RELEASES_GUARD` to `release` with the exact value
   `BrettKinny/UnKeep:immutable-releases-reviewed:v1`. This records a manual
   review; it is not authentication and does not continuously query GitHub.
6. Leave `UNKEEP_CONTAINER_COMPLIANCE_GUARD` unset until the exact container
   source and notice review is complete. Then add it to `release` with the
   exact value
   `BrettKinny/UnKeep:container-compliance:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32:v1`.
   The digest is bound to the Dockerfile's pinned Node/Alpine base image. Any
   base-image change requires a new reviewed bundle and sentinel value.
7. Restrict the environment to selected tags matching `v*-rc.*`.
8. Require maintainer approval for deployments, prevent self-review where the
   repository plan permits it, and disable administrator bypass if practical.
9. Protect release tags with a repository ruleset so only maintainers can
   create or update `v*` tags.
10. Keep the repository's default token permission read-only. Each publication
    job must declare only the GitHub, package, attestation, or OIDC permission
    required for its own write; no long-lived registry token is needed.
11. On the first tag-triggered run, the workflow may bootstrap the linked GHCR
    package with untagged platform digests. GitHub creates a first container
    package as private, so the anonymous-read gate is expected to stop that
    run before release tags or the GitHub prerelease are created. Make the
    linked `unkeep` package public, then rerun the same annotated tag. This is
    safe only when no immutable image tag or published GitHub release exists.
    Do not bypass the anonymous-read gate.

The external-write chain uses these permissions:

| Order | Job | Environment | Declared permissions |
| --- | --- | --- | --- |
| 1 | `stage_container` | `release` | `contents: read`, `packages: write` |
| 2 | `draft_release` | `release` | `contents: write` |
| 3 | `promote_image` | `release` | `contents: read`, `packages: write`, `attestations: write`, `id-token: write` |
| 4 | `finalize_release` | `release` | `contents: write` |

No job holds the union of release, package, attestation, and OIDC write
permissions. The jobs form one dependency chain and cannot publish
independently. Each checks its environment guards and the validated output
sentinel from `stage_container`. The staging job binds downstream writes to
the same source SHA, workflow run, and run attempt, preventing a later job from
being rerun in a new attempt to bypass the fresh release-slot inventory.

GitHub may request approval separately for the sequential deployment jobs.
That repeated approval is intentional: review the completed prior stage and
any draft incident record before approving the next one. An approval does not
broaden a job's token permissions or authorize later jobs out of order.

The guards are configuration interlocks, not authentication. They do not
replace tag protection, required reviewers, release immutability, or the
documented source and notice review.

## Prepare and validate a candidate

Update the candidate version consistently in the workspace manifests, CLI
version, release Compose image reference, and curated `CHANGELOG.md` section.
Run the checks from the reviewed source commit:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm audit --audit-level high
pnpm notices:check
pnpm check
pnpm lint
pnpm test
pnpm smoke:packages
pnpm test:e2e
```

The workflow repeats the relevant gates on the validated commit, also checks
Node 20 package compatibility, builds and scans the container, verifies the
non-root/minimal runtime posture, exports the container source and notices,
and binds the image metadata to the exact source SHA and version.

For a validation-only run, dispatch the workflow with a branch, tag, or commit
in its `ref` input. It must not create a release or push a release image.

For publication, create an annotated tag from a commit contained in `main`:

```sh
version=0.2.0-rc.1
git tag --sign --annotate "v$version" -m "UnKeep $version"
git push origin "v$version"
```

The `prepare` job rejects an unprotected, lightweight, mismatched, or
non-ancestor tag, and validates the candidate version, Compose image defaults,
CLI version, and curated release notes before any external write.

## Publication chain

All handoffs are treated as untrusted input. Expected filenames, versions,
checksums, job-output digests, the staging manifest, and the promoted-image
record bind each step to the previously verified candidate.

1. `stage_container` verifies the protected environment, immutable-release
   review, and container-compliance guards. It inventories GHCR, requires an
   unused version and source-SHA image-tag slot, validates the source bundle
   and notices, and stages the release assets. A registry error fails closed.
2. `draft_release` creates or validates the immutable GitHub prerelease draft
   and uploads the checked release assets. The draft remains unpublished while
   image promotion and attestation complete.
3. `promote_image` builds the pinned multi-platform image, pushes only the
   validated version and source-SHA tags, and attaches BuildKit SBOM and
   provenance attestations. It rechecks the source binding, labels, digest,
   and anonymous read path.
4. `finalize_release` verifies the promoted digest, attestations, checksums,
   release metadata, and every local asset against the immutable release
   attestation before clearing draft state and publishing the GitHub
   prerelease.

The release stays a draft until the final verification succeeds. A later
failure therefore leaves a maintainer-visible recovery record instead of an
incomplete public GitHub release.

## Verify published artifacts

Replace the version and source SHA below for a later candidate:

```sh
version=0.2.0-rc.1
docker buildx imagetools inspect "ghcr.io/brettkinny/unkeep:$version"
gh attestation verify \
  "oci://ghcr.io/brettkinny/unkeep:$version" \
  --repo BrettKinny/UnKeep

gh release view "v$version" --repo BrettKinny/UnKeep
gh release verify "v$version" --repo BrettKinny/UnKeep
release_dir="$(mktemp -d)"
gh release download "v$version" --repo BrettKinny/UnKeep --dir "$release_dir"
for asset in "$release_dir"/*; do
  gh release verify-asset "v$version" "$asset" --repo BrettKinny/UnKeep
done
(cd "$release_dir" && sha256sum --check SHA256SUMS)
```

Verify that the version and `sha-<40-character-commit>` image tags resolve to
the digest recorded in `unkeep-<version>-image-digest.txt`. Confirm the
release bundle includes `THIRD_PARTY_NOTICES.md`, `NODE_RUNTIME_LICENSE`, and
`compose.release.yaml`, plus the container source archive, metadata, and
source-binding record. The exported SBOM is an amd64 convenience asset; the
multi-architecture image's per-platform SBOM attestations remain attached to
the registry manifest. Deploy by the recorded image digest where
reproducibility matters.

## Failure and rollback policy

Versioned GHCR tags, source-SHA GHCR tags, annotated release tags, and
published GitHub releases are immutable by policy. Do not delete, overwrite,
or recreate any of them.

A tag-triggered run may be retried for the same candidate only when it stopped
before creating every immutable public name: neither release image tag exists
and no published GitHub release was created. A private draft or untagged
candidate image does not consume the release slot. Use **Re-run all jobs** so
`stage_container` performs a fresh inventory; do not rerun a later publication
job by itself.

If either immutable GHCR tag or the GitHub release exists, preserve the failed
candidate as an incident record. Do not expect a rebuild to complete missing
artifacts: the multi-platform manifest is not proven byte-for-byte
reproducible. Advance the version to the next `rc.N`, update the manifests,
CLI version, Compose reference, changelog, and release docs, then repeat every
release gate and create a new annotated tag.

For an incident:

1. Preserve the failed workflow run, annotated tag, draft release, registry
   objects, and logs. Do not delete or overwrite them.
2. Inventory GHCR and GitHub release state before making any repair. Use the
   repository's GHCR inventory helper with an authenticated session and treat
   timeouts or ambiguous responses as unknown state, not absence.
3. If all immutable names are absent, correct the transient cause and rerun
   the same annotated tag with `stage_container` included in the new attempt.
4. If any immutable name exists, leave it preserved and publish the next
   release-candidate version after repeating the full review and gates.

For a security incident, preserve evidence, follow `SECURITY.md`, revoke
affected credentials, and publish a new fixed version. Removing a public
artifact does not remove copies already downloaded by users.

## Updating pinned actions

Every action in the workflow is pinned to a full commit SHA. When upgrading,
resolve the desired release tag in the action's official repository, review
its release notes and action metadata, replace the SHA and version comment
together, then run the manual validation workflow.

The Docker setup actions and container scanner also fetch executables and
images, so pin their transitive inputs rather than relying on mutable
defaults. Verify replacements against their official upstream release and
confirm both `linux/amd64` and `linux/arm64` are present before updating.
