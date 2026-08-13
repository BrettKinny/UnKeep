# Support

UnKeep is a community-maintained, self-hosted project. Support is best effort;
there is no uptime, response-time, data-recovery, or backward-compatibility
service-level agreement.

## Before asking

1. Read the [README](README.md), [self-hosting guide](docs/self-hosting.md), and
   [threat model](THREAT_MODEL.md).
2. Search [existing issues](https://github.com/BrettKinny/UnKeep/issues),
   including closed issues.
3. Reproduce the problem on the latest supported release if possible.

Use a GitHub issue for a reproducible bug, documentation problem, or feature
request. One issue should cover one independently actionable problem.

Include:

- the UnKeep version or commit and installation method;
- browser, operating system, Node.js, container, and reverse-proxy versions as
  relevant;
- expected and actual behavior;
- minimal reproduction steps;
- sanitized logs and configuration; and
- whether backup, restore, pairing, revocation, or multiple devices are
  involved.

Never post vault keys, recovery kits, setup or recovery tokens, device or
service credentials, private notes, database files, full environment dumps, or
unredacted public URLs. Use
[private vulnerability reporting](SECURITY.md#report-a-vulnerability) for
anything with a plausible security impact.

## Scope

The project can help investigate UnKeep code, documented deployment behavior,
and supported release artifacts. Operators remain responsible for their host,
TLS proxy, DNS, firewall, backups, storage, monitoring, and third-party
container platform.

Only the current release line described in [SECURITY.md](SECURITY.md) is
supported. Development branches and old tags may be useful for comparison but
are not support targets.
