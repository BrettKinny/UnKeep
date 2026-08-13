# Security policy

UnKeep stores sensitive personal data and grants every paired client access to
the same vault. Security reports are welcome and should be handled privately
until a fix is available.

## Supported versions

During the public preview, the latest published release candidate receives
security fixes. After a stable `0.2.0`, only the latest patch of the latest
`0.x` minor release will be supported. Superseded candidates, older minors, and
development snapshots do not normally receive backports.

| Version | Security support |
| --- | --- |
| Latest published release or release candidate | Yes |
| Superseded candidates, older releases, and tags | No |
| `main` and development branches | Best effort; not a supported release |

Self-hosted operators are responsible for applying updates. A fix may require a
relay restart, database migration, credential rotation, or client refresh; the
advisory will call that out when applicable.

## Report a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/BrettKinny/UnKeep/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

If private reporting is unavailable, contact the repository owner privately
through the contact details on their GitHub profile and ask for a secure
reporting channel. Do not include exploit details in a public message.

Include, when possible:

- the affected version, commit, deployment shape, browser, and operating system;
- a minimal reproduction and the security impact;
- whether the issue has been exploited or disclosed elsewhere;
- any suggested mitigation or fix; and
- a safe way to contact you for follow-up.

Use generated test data. Never send a live vault key, recovery kit, setup or
recovery token, device or service credential, database, or private note.

The maintainer will acknowledge reports on a best-effort basis, validate the
impact, coordinate a fix and release, and credit reporters who want attribution.
Please allow a reasonable remediation window before public disclosure.

## Security boundaries

Read [THREAT_MODEL.md](THREAT_MODEL.md) before deploying UnKeep or assessing a
report. In particular, end-to-end encryption protects against an
honest-but-curious relay; it does not make a compromised relay that serves the
web client harmless. Revocation also cannot erase keys or plaintext already
copied to a device or agent.
