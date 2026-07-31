# Releasing UnKeep

UnKeep release candidates are produced by
`.github/workflows/release.yml`. The workflow is deliberately tag-gated:
manual dispatch validates a candidate but can never publish, while an annotated
`vX.Y.Z-rc.N` tag can enter a serialized publication chain. Every external-write
job independently targets and validates a protected environment. Container and
GitHub Release writes use `release`; npm publication alone uses `release-npm`
so no image-attestation job can mint an npm-accepted OIDC identity.

The workflow publishes:

- `@unkeep/core`, then `@unkeep/client`, then `@unkeep/cli` to npm with the
  `next` dist-tag;
- `linux/amd64` and `linux/arm64` images to
  `ghcr.io/brettkinny/unkeep`;
- immutable-by-policy image tags for the exact version and source SHA;
- OCI SBOM and provenance attestations alongside the GHCR image; and
- a prerelease GitHub Release containing the three npm tarballs, an exported
  amd64 SPDX JSON SBOM, the image digest, `compose.release.yaml`,
  `THIRD_PARTY_NOTICES.md`, the preserved Node runtime license, the exact
  container corresponding-source archive, its metadata and staged-image
  binding, and `SHA256SUMS`.

Do not create a release tag until every prerequisite below is complete.

## One-time history and privacy gate

Before changing repository visibility, scan the complete Git object history and
every available ref, including branches, tags, remote-tracking refs, pull
request refs, and the subjects and bodies of every commit. Check for credentials,
recovery material, private notes, environment data, personal collaboration
metadata, and private session or service links. Perform the review locally in
an isolated mirror, use a secret scanner across all refs rather than only
`main`, and do not paste sensitive findings into an issue, pull request, commit,
or Actions log.

Rewriting or force-pushing `main` and tags does not purge closed-pull-request
refs, provider caches, forks, clones, downloaded artifacts, or old workflow
logs. If private collaboration metadata or a secret reached the existing
remote, revoke any credential and publish from a genuinely fresh repository
and reviewed, squashed public history. Do not reuse the old remote or assume
that deleting its visible refs erased the retained data.

## One-time GitHub configuration

1. Make the source repository public. npm trusted-publishing provenance is not
   generated from a private source repository, and the workflow refuses to
   publish while visibility is private.
2. Enable **release immutability** under **Settings → General → Releases**.
   This locks a published release's tag and assets and gives the release its
   own verifiable GitHub attestation. An administrator can enable and verify
   the same setting through the versioned REST API:

   ```sh
   gh api --method PUT \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     repos/BrettKinny/UnKeep/immutable-releases
   gh api \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     repos/BrettKinny/UnKeep/immutable-releases
   ```
   The final command must return an enabled value. Run it with an
   administrator-authenticated `gh` session: the workflow's short-lived
   `GITHUB_TOKEN` cannot read repository Administration settings and therefore
   cannot honestly perform this check itself.
3. Create a GitHub environment named exactly `release`.
4. Add an environment configuration variable named
   `UNKEEP_RELEASE_GUARD` with the exact value
   `BrettKinny/UnKeep:release:v1`. This public, non-secret sentinel makes the
   four container and GitHub Release jobs fail before their external write if
   the environment was omitted or accidentally created without its release
   configuration.
5. Create a second GitHub environment named exactly `release-npm`. Add
   `UNKEEP_NPM_RELEASE_GUARD` there with the exact value
   `BrettKinny/UnKeep:release-npm:v1`. Only `publish_npm` references this
   environment. npm's trusted-publisher configuration cannot restrict an OIDC
   identity by job name, so this separate environment is the credential
   boundary that prevents `promote_image` from authenticating to npm.
6. Only after an administrator has confirmed that release immutability is
   enabled, add `UNKEEP_IMMUTABLE_RELEASES_GUARD` to **both** environments with
   the exact value
   `BrettKinny/UnKeep:immutable-releases-reviewed:v1`. This public, non-secret
   sentinel records the manual review; it is not authentication and does not
   query or enforce the setting. All five external-write jobs require it.
   Re-run the administrator check immediately before creating a release tag
   and confirm the setting again when approving protected deployments. Leave
   the guard unset if the setting cannot be proved enabled.
7. Leave `UNKEEP_CONTAINER_COMPLIANCE_GUARD` unset in **both** environments
   until the exact container source and notice review described below is
   complete. Its absence intentionally stops `stage_container` before any GHCR
   write, and every later publication job checks it again. After the reviewed
   source/notice bundle or other documented compliance path is ready, add the
   environment variable to both environments with the exact value
   `BrettKinny/UnKeep:container-compliance:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32:v1`.
   The digest in this sentinel is the Dockerfile's pinned Node/Alpine OCI index.
   The workflow derives its expected sentinel from the source producer's
   Dockerfile-bound base digest. Any base-image change therefore requires a new
   bundle, review, and protected-environment value; the old review cannot
   authorize it.
8. Restrict both environments to selected tags matching `v*-rc.*`.
9. After the repository becomes public and before creating any release tag,
   require a maintainer to approve deployments in both environments and
   prevent self-review where the repository plan permits it. Disable
   administrator bypass if practical.
10. Protect release tags with a repository ruleset so only maintainers can
   create or update `v*` tags.
11. Keep the repository's default `GITHUB_TOKEN` permission read-only. Each
   publication job declares only the release, package, OIDC, or attestation
   permission required for its own write; it stores no registry token.
12. The first tag-triggered run intentionally bootstraps the linked GHCR package
   by pushing only untagged platform digests. GitHub creates a first container
   package as private, so the anonymous-read gate is expected to stop that run
   before it creates image release tags, publishes npm packages, or exposes the
   GitHub prerelease. Make the linked `unkeep` package public, then rerun the
   same workflow for the same annotated tag. The collision preflight ignores
   the untagged candidate digests but still refuses any existing version or
   source-SHA tag. This same-tag retry is allowed only because the stopped run
   created no immutable npm version or GHCR release tag. It restarts publication
   from an unused release slot; it is not completion of a partially published
   release. Do not bypass the anonymous-read gate.

The publication chain uses these exact environments and job permissions:

| Order | Job | Environment | Declared permissions |
| --- | --- | --- | --- |
| 1 | `stage_container` | `release` | `contents: read`, `packages: write` |
| 2 | `draft_release` | `release` | `contents: write` |
| 3 | `promote_image` | `release` | `contents: read`, `packages: write`, `attestations: write`, `id-token: write` |
| 4 | `publish_npm` | `release-npm` | `contents: read`, `id-token: write` |
| 5 | `finalize_release` | `release` | `contents: write` |

No job holds the former union of GitHub Release, package, attestation, and OIDC
write permissions. Permissions omitted from a job declaration are unavailable
to that job. The jobs form one dependency chain and cannot publish
independently. Each one references its assigned protected environment, checks
its environment-specific guard, the shared immutable-release review guard,
and the shared compliance guard, and requires the validated output sentinel
from `stage_container`.
`stage_container` also binds every downstream write to the same GitHub run ID
and run attempt. A later publication job cannot be re-run by itself in a new
attempt and thereby bypass the fresh release-slot inventory.
The separate `release-npm` identity is security-critical: npm authorizes a
trusted publisher by repository, workflow filename, and environment, not by
job. Although `promote_image` needs `id-token: write` for GitHub image
attestation, its `release` environment claim cannot match npm's `release-npm`
trusted publisher. A static regression test enforces that `publish_npm` is the
only job with both `environment: release-npm` and `id-token: write`.
Depending on both environments' rules and the repository plan, GitHub may
request approval separately for each of the five sequential deployment jobs.
Repeated approval is intentional: review the completed prior stage and any
draft incident record before approving the next one. An approval does not
broaden that job's declared token permissions or authorize later jobs out of
order.

Neither `release` nor `release-npm` needs secrets. Their distinct release
guards detect missing environment setup. The shared immutable-release sentinel
records an administrator's manual setting review, while the separate
container-compliance sentinel is a manual publication interlock, not evidence
or a legal determination by itself. None of the sentinels is authentication,
continuously observes GitHub settings, or replaces tag protection, a required
reviewer, or the documented review. GitHub supplies the short-lived
`GITHUB_TOKEN`, and npm authentication uses OIDC.
GitHub Free does not offer required reviewers for a private repository, so
revisit both environments immediately after the visibility change rather than
assuming their pre-publication settings are sufficient.

## One-time npm configuration

The `@unkeep` npm scope must exist and the release maintainer must have publish
permission. Configure a GitHub Actions trusted publisher separately for each
package:

- `@unkeep/core`
- `@unkeep/client`
- `@unkeep/cli`

Use these exact values in each package's npm settings:

| Field | Value |
| --- | --- |
| Organization or user | `BrettKinny` |
| Repository | `UnKeep` |
| Workflow filename | `release.yml` |
| Environment | `release-npm` |
| Allowed action | `npm publish` |

Names and capitalization are significant. The workflow uses a GitHub-hosted
runner, Node `24.15.0`, its bundled npm CLI, and `id-token: write`; no
`NPM_TOKEN` should be added. It fails unless the bundled npm is at least
`11.5.1`, the minimum trusted-publishing version, and deliberately does not
install fresh registry tooling inside the privileged publishing job.

Trusted publishers can only be configured after a package exists. Check all
three names before proceeding:

```sh
npm view @unkeep/core version
npm view @unkeep/client version
npm view @unkeep/cli version
```

If they return `E404`, reserve them with the non-release version
`0.0.0-bootstrap.0` and the non-default `bootstrap` dist-tag. Do **not** use
`0.2.0-rc.1` for this step: npm versions cannot be republished, and consuming
that version would prevent the verified workflow from publishing the real
candidate.

Perform the bootstrap from a disposable worktree at the intended, reviewed
source commit. These edits must never be committed:

```sh
release_sha="$(git rev-parse HEAD)"
bootstrap_root="$(mktemp -d)"
git worktree add --detach "$bootstrap_root/repo" "$release_sha"
cd "$bootstrap_root/repo"

corepack enable
pnpm install --frozen-lockfile
npm pkg set version=0.0.0-bootstrap.0 --prefix packages/core
npm pkg set version=0.0.0-bootstrap.0 --prefix packages/client
npm pkg set version=0.0.0-bootstrap.0 --prefix apps/cli
perl -0pi -e \
  "s/export const VERSION = '[^']+';/export const VERSION = '0.0.0-bootstrap.0';/" \
  apps/cli/src/help.ts

pnpm smoke:packages
mkdir release-assets
pnpm --filter @unkeep/core pack --pack-destination "$PWD/release-assets"
pnpm --filter @unkeep/client pack --pack-destination "$PWD/release-assets"
pnpm --filter @unkeep/cli pack --pack-destination "$PWD/release-assets"

npm login
npm publish --registry=https://registry.npmjs.org/ --access public --tag bootstrap \
  ./release-assets/unkeep-core-0.0.0-bootstrap.0.tgz
npm publish --registry=https://registry.npmjs.org/ --access public --tag bootstrap \
  ./release-assets/unkeep-client-0.0.0-bootstrap.0.tgz
npm publish --registry=https://registry.npmjs.org/ --access public --tag bootstrap \
  ./release-assets/unkeep-cli-0.0.0-bootstrap.0.tgz
npm logout

cd -
git worktree remove "$bootstrap_root/repo"
rmdir "$bootstrap_root"
```

Review the three tarballs before the first `npm publish`, use an interactive
maintainer login with 2FA, and stop immediately if any name is already owned by
someone else. After the bootstrap versions exist, configure each trusted
publisher using the table above, require 2FA, disallow traditional publishing
tokens, and optionally deprecate the bootstrap versions as namespace
reservations. Never add the bootstrap credential to this workflow.

## Dry run

From the repository's Actions page, choose **Release candidate**, select **Run
workflow**, and optionally enter a branch, tag, or commit in `ref`.

A manual run:

1. validates the synchronized package and CLI versions;
2. fails closed on high or critical dependency advisories, then runs
   type-checking, linting, all tests, package smoke tests, Playwright, and the
   Node 20 compatibility check;
3. packs the exact npm tarballs, proves their internal runtime dependencies are
   pinned to the same release version, installs and exercises those exact
   tarball bytes under both Node 20 and Node 22, pins every npm operation to
   `https://registry.npmjs.org/`, and runs `npm publish --dry-run` in dependency
   order; and
4. builds `linux/amd64` and `linux/arm64` candidate containers with the version
   and commit embedded in their labels, runtime environments, and deterministic
   service-worker cache identity, verifies their runtime licensing files and
   minimal toolchains, fails closed on high or critical container
   vulnerabilities, and generates an amd64 SBOM.

It does not reference either protected release environment, receive write
permissions, log in to a registry, publish a package or image, create a tag, or
create a GitHub Release. Inspect the `npm-release-assets` and
`release-dry-run-<sha>` workflow artifacts, plus the independently retained
`container-source-assets-<version>-<sha>` artifact, before continuing.

## Container corresponding-source bundle

The unprivileged `container-sources` job checks out the validated release SHA
and reads the two runtime architectures from the exact digest-pinned
`node:22-alpine` OCI index. It requires the amd64 and arm64 installed Alpine
package inventories to have identical package, version, license, source-origin,
and embedded aports-commit identities. The Dockerfile also copies the Node
runtime license from the pinned amd64 archive into both final platforms because
the upstream arm64 source-built image does not install that file. It then
produces:

- `unkeep-<version>-container-sources.tar.gz`, containing the raw OCI
  descriptors and installed-package databases, the exact Docker Node recipe,
  the signed Node source release and pinned release key, the actual
  amd64 x64-musl input archive, and every installed Alpine origin's recipe,
  local patches, and checksum-verified upstream distfiles; and
- `unkeep-<version>-container-sources.json`, binding the archive hash to the
  release version and SHA, pinned base index and platform digests, Node version,
  and internal source manifest.

Alpine recipes are resolved from each installed package's embedded `c:` commit,
not a mutable branch. Split packages are deduplicated by their `o:` source
origin, and source fetching is evaluated for both `x86_64` and `aarch64` so
architecture-conditional inputs are included. The archive is deterministic,
has fixed ownership and timestamps, and rejects non-regular entries, unsafe
paths, excessive members, and excessive expanded sizes during verification.
Safe recipe-internal symlinks are copied to regular files and recorded in
`NORMALIZED-SYMLINKS.json`; absolute, escaping, or otherwise unsafe symlinks
fail the build.
`CONTAINER-LICENSES.json` maps every Alpine runtime package and both Node
architecture inputs to bundled license texts. Canonical SPDX texts are fetched
from the immutable license-list-data commit recorded in that mapping, and the
Node source and amd64 binary input must contain the same bundled Node license.

The producer passes the archive and metadata hashes separately as job outputs
and preserves both files in the independently named, 14-day
`container-source-assets-<version>-<sha>` artifact. The dry run downloads and
verifies those exact retained bytes. A
tag-triggered run verifies them before the first registry login. After pushing
the untagged platform candidates, `stage_container` re-inspects each exact
digest-addressed image and requires its full Alpine package source identities,
Node version, and Node binary hash to match `SOURCE-INVENTORY.json`. It then
creates
`unkeep-<version>-container-source-binding.json`, which binds the verified
source bytes to both exact staged image digests. Every later publication job
rechecks that binding, the exact-name staging manifest, and the remote draft
bytes. The final `SHA256SUMS` and immutable GitHub Release attestation cover all
three source-compliance assets.

To avoid retaining several 233 MB copies against the repository's Actions
storage quota, the logical release bundle is split across Actions artifacts:
the source producer retains the archive and metadata once, while staging and
final diagnostic artifacts retain the other files. Consumers download both
parts into one exact-name directory before checking the staging manifest.
The immutable GitHub Release itself contains the complete assembled bundle.

The bundle documents corresponding source and build inputs; it is not a claim
that the container is bit-for-bit reproducible. In particular, the amd64 Node
runtime comes from the checksum-pinned unofficial x64-musl binary named in the
exact Docker Node recipe, while arm64 is built from the signed official Node
source release. Preserve that distinction when changing the base image.

## Publish a release candidate

Before tagging:

- merge all intended changes into protected `main`;
- confirm CI and CodeQL are green at the exact release commit. Immediately
  after making the repository public, manually dispatch CodeQL against that
  exact protected `main` SHA and wait for it to pass before creating a tag;
- update the changelog and public documentation;
- verify all manifests and the CLI report the intended `X.Y.Z-rc.N` version;
- regenerate `THIRD_PARTY_NOTICES.md` with `pnpm notices` and verify it with
  `pnpm notices:check`;
- inspect the `container-source-assets-<version>-<sha>` artifact from the
  successful dry run. Confirm the two platform inventories, Node provenance
  distinction, exact aports commits, complete source manifest, and archive
  hashes. Keep `UNKEEP_CONTAINER_COMPLIANCE_GUARD` unset in both protected
  environments until that review is complete, then set it in both to the exact
  digest-bound sentinel above;
- re-run the administrator REST check and verify release immutability is still
  enabled; verify `UNKEEP_IMMUTABLE_RELEASES_GUARD` and the shared compliance
  guard in both protected environments, `UNKEEP_RELEASE_GUARD` in `release`,
  and `UNKEEP_NPM_RELEASE_GUARD` in `release-npm`;
- complete an install, pairing, sync, revocation, backup, and restore drill; and
- run the manual dry-run workflow against the intended commit.

Create an annotated, preferably signed, tag on that exact commit:

```sh
git switch main
git pull --ff-only
git tag -s v0.2.0-rc.1 -m "UnKeep v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

Pushing the tag is the publication trigger. The workflow rejects:

- a private repository;
- lightweight tags;
- tags not shaped like `vX.Y.Z-rc.N`;
- a tag that differs from package or CLI versions;
- a release commit not contained in `origin/main`;
- an unprotected triggering tag or missing immutable-release review sentinel;
- a Compose release image that does not match the candidate version; and
- a local Compose service that does not wire the documented build version and
  revision arguments.

All verification and packing jobs must pass before `stage_container` can
request the first `release` environment approval. After that approval, the
workflow can make an external write and must no longer be treated as a dry run.
Each later job is a separate protected deployment and can request another
approval. `publish_npm` is the one deployment that requests `release-npm`;
the other four request `release`. Approve them only in chain order after
reviewing the completed prior job; do not use a rerun or manual approval to
skip a failed boundary.

The serialized jobs enforce these handoffs:

1. `stage_container` downloads the three packed npm tarballs and independently
   hashed source assets, requires their exact versioned filenames and the
   SHA-256 values produced by their respective `package` and
   `container-sources` jobs, and runs the package smoke harness again. It
   inventories all three npm versions and
   both GHCR release tags, revalidates the annotated tag, and only then pushes
   untagged canonical `linux/amd64` and `linux/arm64` digests. It pulls those
   exact digests back, exercises both hardened runtimes, checks their
   architecture and embedded release identity, scans both with Trivy, and
   requires anonymous access. It exports the amd64 SBOM and Node runtime
   license, binds the source archive to both exact staged platform digests,
   records an exact-name SHA-256 manifest for the complete logical staging
   bundle, and uploads the non-source portion and manifest as separate workflow
   artifacts while retaining the source portion in its independently hashed
   producer artifact.
   Its run-attempt output also authorizes the remaining jobs only for this
   exact attempt.
2. `draft_release` downloads the staged non-source assets, independently
   retained source assets, and staging manifest; checks the manifest digest
   passed through the prior job output; requires exactly the expected versioned
   assets; and verifies every checksum. After revalidating the tag it
   creates, or strictly reuses, a draft prerelease and uploads only that checked
   bundle. The release notes are the curated `CHANGELOG.md` section for the
   exact version; commit titles and pull requests are never synthesized into
   release notes. It verifies the draft's exact title and body after creation.
3. `promote_image` re-pulls the staged platform digests and checks their
   architectures, non-root user, labels, and source revision. It downloads and
   validates the staging manifest, downloads every draft asset from GitHub,
   and checks those bytes against the manifest. It reinventories npm and GHCR,
   revalidates the tag, draft state, and exact source-derived release title and
   body immediately before promotion, and combines only the verified platform
   digests under the version and source-SHA tags.
   It requires anonymous access to the promoted image, rechecks both tags, adds
   the GitHub provenance attestation, and records the promoted digest in a
   separate workflow artifact.
4. `publish_npm` revalidates the exact tarball names, SHA-256 values, and smoke
   tests; the staging manifest; the promoted-image record; every remote draft
   asset byte; and both public GHCR tags. It proves all three npm versions are
   absent, then repeats the tag, draft state, exact source-derived release
   title and body, and version-absence checks immediately before each
   dependency-ordered OIDC publication. A partial sequence is therefore
   detected, not silently resumed.
5. `finalize_release` revalidates the exact staging bundle, its manifest, and
   the promoted-image record. It checks all three npm versions and `next`
   dist-tags plus both public GHCR tags against the recorded digest. It creates
   `SHA256SUMS` from an exact asset list, uploads the final bundle to the draft,
   downloads every asset back, compares every byte, and verifies the checksums.
   It rechecks the tag, draft metadata, npm state, and image digests immediately
   before changing the draft into an immutable prerelease. The publication
   request atomically restores the source-derived title and body while clearing
   draft state. It then verifies GitHub's release immutability and release
   attestation, rechecks the published title and body, and verifies every local
   asset against the immutable release attestation.

Cross-runner artifacts are treated as untrusted input rather than trusted by
artifact name alone. Expected filenames, embedded versions, package smoke
tests, job-output digests, the staging checksum manifest, and the
promoted-image record bind each handoff to the previously verified candidate.
Every checkout after `prepare` uses the validated source SHA, and every
checkout disables persisted Git credentials.

Before the first external write, the workflow proves that all three npm
packages already exist under their expected names, then proves that their exact
release versions and both immutable GHCR tags are absent. Registry errors fail
closed rather than being treated as absence. A missing npm package is a failed
bootstrap, not an available version. The release-slot helper inventories all
five immutable names before failing, so a partially consumed candidate
produces one complete diagnostic and the required next release-candidate
version. It does not treat matching package metadata or image labels as
resumable: the current multi-platform image build is not proven byte-for-byte
reproducible.

The GHCR collision check first resolves whether `BrettKinny` is a user or
organization namespace, inventories every existing package version through
paginated API results, and treats ambiguous API responses as failures. It
repeats that inventory immediately before promotion. GHCR does not expose an
atomic create-if-absent tag operation, so a residual race remains between that
last check and tag creation. Restrict package-write access to this workflow and
release maintainers, never run two releases concurrently, and always deploy by
the verified digest rather than trusting a mutable tag alone.

The GitHub prerelease remains a draft throughout image promotion, attestation,
npm publication, and final asset verification. Once `draft_release` has
succeeded, a later failure therefore leaves a visible-to-maintainers recovery
record instead of publishing an incomplete GitHub release. If the draft job
itself failed after creating a draft, preserve whatever draft state exists.
Every registry transition compares its title and body with the release commit's
curated `CHANGELOG.md` section, and final publication supplies those fields in
the same request that clears draft state.
Once any immutable registry name was created, that draft is an incident record
for the consumed candidate, not a same-version resume point.

The dependency audit intentionally fails closed. A registry timeout or outage
therefore blocks the release just like a high-severity advisory. Wait for the
registry to recover and rerun all jobs against the same commit only when the
run stopped before creating any npm version or immutable GHCR release tag.
`stage_container` must execute in the current attempt; its release-slot check
enforces that boundary. Do not remove or bypass the audit for a release.

## Verify published artifacts

Replace the version below when checking a later candidate:

```sh
npm view --registry=https://registry.npmjs.org/ \
  @unkeep/core@0.2.0-rc.1 version dist.integrity dist.attestations
npm view --registry=https://registry.npmjs.org/ \
  @unkeep/client@0.2.0-rc.1 version dist.integrity dist.attestations
npm view --registry=https://registry.npmjs.org/ \
  @unkeep/cli@0.2.0-rc.1 version dist.integrity dist.attestations

docker buildx imagetools inspect ghcr.io/brettkinny/unkeep:0.2.0-rc.1
gh attestation verify \
  oci://ghcr.io/brettkinny/unkeep:0.2.0-rc.1 \
  --repo BrettKinny/UnKeep

gh release view v0.2.0-rc.1
gh release verify v0.2.0-rc.1 --repo BrettKinny/UnKeep
release_dir="$(mktemp -d)"
gh release download v0.2.0-rc.1 --dir "$release_dir"
for asset in "$release_dir"/*; do
  gh release verify-asset v0.2.0-rc.1 "$asset" \
    --repo BrettKinny/UnKeep
done
(cd "$release_dir" && sha256sum --check SHA256SUMS)
```

Verify that the version tag and `sha-<40-character-commit>` tag resolve to the
digest recorded in `unkeep-<version>-image-digest.txt`. The exported SBOM is an
amd64 convenience asset; the multi-architecture image's per-platform BuildKit
SBOM attestations remain attached to the registry manifest. Release
immutability and `gh release verify-asset` authenticate the GitHub assets;
`SHA256SUMS` remains useful as a portable corruption check but is not a
signature by itself. Confirm the release bundle includes
`THIRD_PARTY_NOTICES.md`, `NODE_RUNTIME_LICENSE`, and
`compose.release.yaml`, plus
`unkeep-<version>-container-sources.tar.gz`,
`unkeep-<version>-container-sources.json`, and
`unkeep-<version>-container-source-binding.json`. GHCR does not provide
server-side immutable tags, so
the release-slot helper refuses to start publication when any exact npm version
or either release image tag already exists. Deployments should still pin the
recorded image digest where reproducibility matters.

## Failure and rollback policy

npm versions and release tags are immutable. Do not delete and recreate a tag,
overwrite an image's version tag, or try to republish an npm version.

### Partial-publication runbook

A tag-triggered run may be retried for the same release candidate only when it
stopped before creating every immutable public name: none of the three exact
npm versions and neither the version nor source-SHA GHCR tag may exist. A
private draft release or untagged candidate image does not consume the release
slot. `scripts/check-release-slot.mjs` applies this policy before the first
GHCR login and repeats it immediately before tag promotion.

A safe retry must execute `stage_container` in the current GitHub run attempt
so that this inventory runs again. Use **Re-run all jobs** when a later
publication job failed. Do not use **Re-run failed jobs** to resume
`draft_release`, `promote_image`, `publish_npm`, or `finalize_release` from an
earlier attempt; the workflow's run-attempt binding deliberately rejects that
path. If `stage_container` itself was the failed job, retrying it and its
dependent jobs is safe because it performs the fresh slot check.

If any exact npm version or either GHCR release tag exists, the release
candidate is consumed. Do not rerun it expecting the workflow or a maintainer
to complete the missing artifacts, even when npm integrity, image labels, or
the source commit appear to match. The workflow cannot currently prove that a
rebuild reproduces the existing per-platform manifests, so it deliberately
uses next-RC-only recovery.

1. Stop publication and preserve the failed workflow run, annotated tag, draft
   release, registry objects, and logs. Do not delete, overwrite, or recreate
   any of them.
2. Inventory the five immutable names and the draft:

   ```sh
   version=0.2.0-rc.1
   release_sha="$(git rev-list -n 1 "v$version")"
   for package in @unkeep/core @unkeep/client @unkeep/cli; do
     npm view --registry=https://registry.npmjs.org/ \
       "$package@$version" version dist.integrity dist.attestations
     npm view --registry=https://registry.npmjs.org/ \
       "$package" dist-tags.next
   done
   ghcr_inventory="$(mktemp)"
   GH_TOKEN="$(gh auth token)" node scripts/inventory-ghcr.mjs \
     BrettKinny unkeep "$ghcr_inventory"
   jq -s ".[] | select(any(.metadata.container.tags[]?;
       . == \"$version\" or . == \"sha-$release_sha\")) |
       {id, tags: .metadata.container.tags}" "$ghcr_inventory"
   rm "$ghcr_inventory"
   gh release view "v$version" \
     --json isDraft,isPrerelease,assets,url
   ```

   An npm `E404`, an absent GHCR selection, or an absent draft is expected for
   an artifact that was never created. Any other registry error is unknown
   state, not proof of absence.
3. If all five immutable names are absent, correct the transient cause and
   rerun the same annotated tag with `stage_container` included in the new
   attempt. This is a fresh attempt from an unused release slot, not
   partial-publication recovery; the workflow rechecks the complete inventory
   and strictly validates or reuses any existing draft.
4. If any immutable name exists, leave the failed candidate preserved. Advance
   every package manifest, the CLI-reported version, changelog entry, Compose
   image reference, and release documentation to the next `rc.N`; commit those
   changes, repeat every release gate, and create a new annotated tag on that
   new commit.
5. Inspect `dist-tags.next` for all three packages. Sequential publication can
   leave `next` pointing at different candidates after a partial failure. The
   workflow's OIDC identity is intentionally limited to `npm publish`; it
   cannot repair dist-tags. With an authenticated maintainer session and 2FA,
   explicitly repoint all three packages to one coherent prior or replacement
   candidate:

   ```sh
   repaired_version=0.2.0-rc.2
   for package in @unkeep/core @unkeep/client @unkeep/cli; do
     npm dist-tag add \
       --registry=https://registry.npmjs.org/ \
       "$package@$repaired_version" next
   done
   ```

   Verify all three tags after the repair and record the incident. Never point
   `next` at an incomplete candidate.
6. Deprecate any incomplete npm versions with a clear pointer to the next RC
   rather than silently replacing them. Do not point users at an orphaned
   image tag or publish the old draft as though it were complete.

For a security incident, preserve evidence, follow `SECURITY.md`, revoke
affected credentials, and publish a new fixed version. Removing a public
artifact does not remove copies already downloaded by users.

## Updating pinned actions

Every action in the workflow is pinned to a full commit SHA. When upgrading,
resolve the desired release tag in the action's official repository, review its
release notes and action metadata, replace the SHA and version comment
together, then run the manual dry-run workflow.

The Docker setup actions and container scanner also fetch executables and
images, so pin their transitive inputs rather than relying on mutable defaults.
The current workflow pins Buildx `v0.36.0`, BuildKit `v0.32.0`, Trivy `0.72.0`,
and `tonistiigi/binfmt` `qemu-v10.2.3-68`; every image is pinned by OCI index
digest. Verify a replacement against its official upstream release and confirm
both `linux/amd64` and `linux/arm64` are present before updating:

```sh
gh release view v0.36.0 --repo docker/buildx
gh release view v0.32.0 --repo moby/buildkit
gh release view v0.72.0 --repo aquasecurity/trivy
gh release view deploy/v10.2.3-68 --repo tonistiigi/binfmt
docker buildx imagetools inspect docker.io/moby/buildkit:v0.32.0
docker buildx imagetools inspect docker.io/aquasec/trivy:0.72.0
docker buildx imagetools inspect \
  docker.io/tonistiigi/binfmt:qemu-v10.2.3-68
```
