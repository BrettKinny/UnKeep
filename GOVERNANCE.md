# Governance

UnKeep is a maintainer-led open-source project. Brett Kinny is the current lead
maintainer and project owner.

## Project scope

The project prioritizes a single-user, self-hosted notes vault with trusted
multi-device access, a local-first web experience, and stable terminal and
agent workflows. Multi-user collaboration, hosted accounts, and legacy storage
adapter experiments are outside the current supported product scope unless a
maintainer accepts a design that changes it.

## Roles

- **Contributors** propose issues, documentation, designs, code, tests, and
  reviews.
- **Maintainers** triage work, review and merge pull requests, manage releases
  and security reports, and protect project infrastructure.
- The **lead maintainer** resolves decisions that do not reach consensus and is
  responsible for appointing or removing maintainers.

Maintainer access is granted by invitation based on sustained constructive
participation, sound judgment, security awareness, and willingness to perform
review and maintenance work. It is not earned by contribution count alone.

## Decisions

Routine changes are decided through public issues and pull requests. Maintainers
prefer reasoned consensus, but consensus does not require unanimity. The lead
maintainer has final merge and release authority.

Changes to encryption, pairing, recovery, storage migrations, protocol
semantics, public package APIs, licensing, or the threat model should be
discussed before implementation and may require an ADR. Security fixes may be
developed privately until coordinated disclosure is safe.

Pull requests require maintainer review and passing required checks. Authors do
not approve their own security-sensitive change when an independent qualified
reviewer is available. Maintainers may close work that is unsafe, out of scope,
inactive, duplicative, or too costly to maintain, with a public explanation
unless confidentiality prevents one.

## Releases and compatibility

Maintainers publish releases from protected, reviewed commits after documented
verification. During `0.x`, breaking changes are possible, but they should be
called out in the changelog with a migration path where practical. Security
support follows [SECURITY.md](SECURITY.md).

## Conduct and disputes

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Technical disputes should be resolved with evidence, tests, prototypes, or an
ADR. Conduct reports are handled separately from technical disagreement.

## Continuity

If the lead maintainer steps down, they should nominate a successor from the
maintainers and document the transfer of repository, package, image, domain,
and security-reporting access. The MIT License always permits the community to
fork the project if stewardship cannot continue.
