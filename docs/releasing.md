# Releasing UnKeep

UnKeep release candidates are container-first. The release workflow publishes a
multi-architecture image to GHCR and an immutable GitHub prerelease containing
the deployment and verification assets. npm publication is deferred to a later
release.

The public packages are still packed, installed, and smoke-tested as
validation-only artifacts. They are retained in GitHub Actions for inspection,
but they are not uploaded to the GitHub Release or written to npm.

Manual workflow dispatch validates a candidate and cannot publish. Publication
requires an annotated `vX.Y.Z-rc.N` tag on a commit contained in `main`.

## Release outputs

The workflow publishes:

- `linux/amd64` and `linux/arm64` images at
  `ghcr.io/brettkinny/unkeep:<version>`;
- a source-SHA image tag for the same manifest;
- OCI SBOM and provenance attestations for the image; and
- an immutable GitHub prerelease with `compose.release.yaml`, checksums,
  third-party notices, the Node runtime license, the image digest, an amd64
  SPDX JSON SBOM, and the exact container corresponding-source bundle and
  source-to-image binding.

The npm validation tarballs are Actions artifacts only. Issue 11 tracks the
package-name bootstrap and trusted-publishing work for a future release.

## One-time GitHub configuration

1. Keep the source repository public.
2. Enable release immutability under **Settings → General → Releases**. Verify
   it with an administrator-authenticated GitHub CLI session:

   ```sh
   gh api \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     repos/BrettKinny/UnKeep/immutable-releases
   ```

   The workflow's short-lived `GITHUB_TOKEN` cannot read repository Administration settings,
   so this check must remain manual. Re-run the administrator check immediately before creating a release tag.
3. Keep the GitHub environment named `release`, restricted to selected tags
   matching `v*-rc.*`.
4. Set `UNKEEP_RELEASE_GUARD` in that environment to exactly
   `BrettKinny/UnKeep:release:v1`.
5. After confirming release immutability, set
   `UNKEEP_IMMUTABLE_RELEASES_GUARD` to exactly
   `BrettKinny/UnKeep:immutable-releases-reviewed:v1`.
6. After reviewing the exact container sources and notices, set
   `UNKEEP_CONTAINER_COMPLIANCE_GUARD` to exactly
   `BrettKinny/UnKeep:container-compliance:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32:v1`.
   The workflow derives its expected sentinel from the source producer's
   Dockerfile-bound base digest. A base-image change therefore requires a new
   source bundle, review, and sentinel value.
7. Protect `v*` tags with the repository ruleset and keep the repository's
   default `GITHUB_TOKEN` permission read-only.

The environment needs no secrets. Its guards are public configuration
sentinels, not credentials. Self-review is acceptable for this single-maintainer
project; the environment still provides an explicit publication boundary.

The publication jobs have these permissions:

| Order | Job | Permissions |
| --- | --- | --- |
| 1 | `stage_container` | `contents: read`, `packages: write` |
| 2 | `draft_release` | `contents: write` |
| 3 | `promote_image` | `contents: read`, `packages: write`, `attestations: write`, `id-token: write` |
| 4 | `finalize_release` | `contents: write` |

All four jobs use the `release` environment and verify the release,
immutability, and container-compliance guards. Only `promote_image` receives an
OIDC identity, and it uses that identity for the image provenance attestation.
There is no npm publishing identity in this workflow.

Each downstream job is bound to the same workflow run and attempt as
`stage_container`. Re-run all jobs after a publication-stage failure so the
release-slot inventory is performed again.

## Dry run

From the Actions page, choose **Release candidate**, select **Run workflow**,
and optionally provide a branch, tag, or commit in `ref`.

A manual run:

1. validates synchronized package, CLI, Compose, and changelog versions;
2. runs the dependency audit, notice check, type-check, lint, tests, package
   smoke tests, Playwright, and Node 20 compatibility check;
3. packs all three npm packages, installs and exercises the exact tarball bytes
   on Node 20 and Node 22, and runs `npm publish --dry-run` against explicit
   local tarball paths; and
4. builds and scans both container architectures, checks the hardened runtime,
   generates the amd64 SBOM, and builds the corresponding-source bundle.

The dry run has no write permissions, does not use the protected environment,
does not log in to a registry, and cannot publish a package, image, release, or
tag. Inspect these Actions artifacts:

- `npm-validation-assets` — validation-only package tarballs;
- `release-dry-run-<sha>` — deployment, notice, licence, and SBOM assets; and
- `container-source-assets-<version>-<sha>` — exact corresponding sources and
  metadata.

## Container corresponding sources

The unprivileged `container-sources` job builds and verifies the exact source
archive for both architectures from the pinned Node/Alpine base image. It
records the archive and metadata hashes as job outputs and retains those bytes
once in `container-source-assets-<version>-<sha>`.

After staging the exact platform images, `stage_container` creates
`unkeep-<version>-container-source-binding.json`, binding the source bundle to
both staged image digests. Every later publication job verifies that binding.

The logical release bundle is split across Actions artifacts to avoid retaining
several copies of the large source archive. Consumers reassemble the exact-name
bundle and verify the staging checksum manifest. The immutable GitHub Release
contains the complete assembled bundle.

The source bundle documents corresponding source and build inputs; it does not
claim that rebuilding produces byte-for-byte identical image manifests.

## Publish a release candidate

Before tagging:

- merge the intended changes into `main`;
- confirm CI and CodeQL are green for the exact release commit;
- update the changelog and public documentation;
- verify all manifests and the CLI report the intended version;
- run `pnpm release:check` and `pnpm notices:check`;
- inspect the successful dry-run artifacts, especially the container source
  archive, metadata, platform inventories, and hashes;
- verify release immutability and all three environment guards;
- complete an install, pairing, sync, revocation, backup, and restore drill;
  and
- run the manual dry-run workflow against the intended commit.

Create an annotated, preferably signed, tag on that exact commit:

```sh
git switch main
git pull --ff-only
git tag -s v0.2.0-rc.1 -m "UnKeep v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

The serialized publication chain is:

1. `stage_container` verifies the unused GHCR version and source-SHA tags,
   revalidates the tag and source bundle, pushes untagged amd64 and arm64
   images, pulls and scans those exact digests, exports compliance assets, and
   records the staging manifest and source binding.
2. `draft_release` verifies the staging bundle and creates a draft GitHub
   prerelease using the curated changelog section as its title and body.
3. `promote_image` verifies the draft bytes and source binding, repeats the
   GHCR collision check, combines only the staged digests under the version and
   source-SHA tags, verifies anonymous access, and creates provenance.
4. `finalize_release` verifies the promoted image and every release asset,
   creates `SHA256SUMS`, uploads and downloads the final bundle, and publishes
   the immutable prerelease. The publication request atomically restores the source-derived title and body
   while clearing draft state.

The workflow rejects lightweight or unprotected tags, malformed versions,
version drift, commits outside `main`, missing guards, private repositories,
stale Compose references, and consumed GHCR release tags.

## First GHCR publication

GitHub may create the first linked container package as private. In that case,
the anonymous-access gate stops the first run after pushing only untagged
platform digests. Make the linked `unkeep` package public, then re-run all jobs
for the same annotated tag. Untagged candidate digests do not consume the
release slot; the version and source-SHA tags do.

## Verify published artifacts

```sh
docker buildx imagetools inspect ghcr.io/brettkinny/unkeep:0.2.0-rc.1
gh attestation verify \
  oci://ghcr.io/brettkinny/unkeep:0.2.0-rc.1 \
  --repo BrettKinny/UnKeep

gh release view v0.2.0-rc.1 --repo BrettKinny/UnKeep
gh release verify v0.2.0-rc.1 --repo BrettKinny/UnKeep
release_dir="$(mktemp -d)"
gh release download v0.2.0-rc.1 \
  --repo BrettKinny/UnKeep \
  --dir "$release_dir"
(cd "$release_dir" && sha256sum --check SHA256SUMS)
```

Verify that both GHCR tags resolve to the digest recorded in
`unkeep-<version>-image-digest.txt`. Confirm the release includes the notices,
runtime license, Compose file, SBOM, source archive, source metadata, source
binding, image digest, and checksums.

## Failure policy

The version and source-SHA image tags are treated as immutable release names.
Do not delete, overwrite, or recreate them to recover a failed release.

A same-version retry is allowed only if neither GHCR release tag exists. A
private draft release or untagged candidate image does not consume the release
slot. Use **Re-run all jobs**, ensuring `stage_container` runs in the new
attempt and repeats the inventory.

If either GHCR release tag exists, preserve the workflow run, annotated tag,
draft release, image objects, and logs. Advance every package manifest,
CLI-reported version, changelog entry, Compose reference, and release document
to the next RC, repeat the release gates, and create a new annotated tag.

The workflow cannot prove that a rebuilt multi-platform image is identical to
an existing manifest, so matching labels do not make a partially promoted
candidate resumable. Restrict package-write access and deploy by the recorded
digest where reproducibility matters.

For a security incident, preserve evidence, follow `SECURITY.md`, revoke
affected credentials, and publish a new fixed version.

## Future npm publication

Publishing `@unkeep/core`, `@unkeep/client`, and `@unkeep/cli` is intentionally
outside this release. Before enabling it, complete issue 11, reserve and verify
the package names, review the independent-install use cases, design a dedicated
trusted-publisher boundary, and restore registry-aware partial-publication
tests and recovery documentation. Do not add a static registry token to the
current release workflow.

## Updating pinned actions

Every action and release tool in the workflow is pinned. When upgrading one,
review its official release notes and action metadata, update the full commit
SHA and version comment together, and run the complete manual dry run.
