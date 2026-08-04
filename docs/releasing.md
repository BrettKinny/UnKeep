# Releasing UnKeep

UnKeep is distributed as one self-hosted container. npm packages and arm64
images are intentionally out of scope. The initial preview supports
`linux/amd64` only.

The release process is deliberately small: ordinary CI validates changes, a
manual run validates a candidate without publishing, and a version tag publishes
the container plus a compact GitHub release.

## What CI protects

Pull requests and `main` run:

- Node 22 type checks, lint, unit and integration tests;
- Playwright browser tests;
- generated third-party notice verification;
- an amd64 container build, hardened-runtime smoke test, and CLI storage test;
  and
- a high/critical container vulnerability scan.

CodeQL remains a separate workflow. The application security invariants in
`THREAT_MODEL.md` are more important than distribution ceremony: changes to
encryption, synchronization, pairing, recovery, imports, or untrusted rendering
must retain their adversarial tests.

## Candidate dry run

From the Actions page, choose **Release**, select **Run workflow**, and provide
the branch, tag, or commit to validate. A manual run has read-only repository
permissions and cannot publish an image or GitHub release.

It repeats the release checks, runs `pnpm audit`, builds the exact amd64
candidate with version and revision metadata, smoke-tests it, and scans it with
Trivy.

## One-time GitHub configuration

Keep a GitHub environment named `release`. It needs no secrets, variables, or
required reviewers. The environment is simply the boundary at which the
publishing job receives `packages: write` and `contents: write` permissions.

The repository's default `GITHUB_TOKEN` permission should remain read-only.
The workflow grants write permissions only to the tagged publication job.

## Publish a preview

Before tagging:

1. Merge the intended changes into `main`.
2. Confirm CI and CodeQL are green for that commit.
3. Update `CHANGELOG.md` and any user-facing documentation.
4. Run a manual Release workflow against the exact commit.
5. Complete an install, pairing, sync, revocation, backup, and restore drill.

Create and push an annotated tag:

```sh
git switch main
git pull --ff-only
git tag -a v0.2.0-rc.1 -m "UnKeep v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

Tags must match `vX.Y.Z` with an optional suffix such as `-rc.1`, and the tagged
commit must be contained in `main`.

The tagged workflow:

1. repeats candidate validation;
2. builds and pushes one `linux/amd64` image to GHCR under the version and
   source-SHA tags; and
3. creates a GitHub release containing the Compose file, third-party notices,
   image digest, and checksums.

Prerelease-looking versions such as `0.2.0-rc.1` create GitHub prereleases.
The image includes BuildKit provenance and SBOM attestations.

## Verify a release

Download the release assets and verify their checksums:

```sh
release_dir="$(mktemp -d)"
gh release download v0.2.0-rc.1 \
  --repo BrettKinny/UnKeep \
  --dir "$release_dir"
(cd "$release_dir" && sha256sum --check SHA256SUMS)
```

The digest file records the complete `ghcr.io/brettkinny/unkeep@sha256:...`
reference and `architecture=linux/amd64`. Deploy that digest through
`UNKEEP_IMAGE`; do not rely on a mutable convenience tag.

## Failure policy

The workflow may be rerun for the same tag. It updates release assets and
rebuilds the same version and source-SHA image tags. If a broken preview has
already been used by someone else, preserve it for diagnosis and publish the
fix under the next prerelease number instead of silently changing what users
received.

For a security incident, preserve evidence, follow `SECURITY.md`, revoke
affected credentials, and publish a new fixed version.

## Deferred distribution

npm publication is not planned. The core, client, and CLI workspaces are
private implementation packages, and the CLI ships inside the container.

arm64 is also deferred. If real users need it, add native GitHub arm64 runners
and a small manifest-assembly job. Do not restore QEMU-based builds.

Before the first public container release, perform a focused licence review of
the actual image contents and retain only the notices or source artifacts that
review determines are required.
