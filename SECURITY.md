# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, never in a public issue, discussion or pull request.

Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a
vulnerability** (GitHub security advisories). Only the maintainers can see the report. If that is not possible for you,
write to info@remyral.com with "Security" in the subject and ask for a private channel; do not include exploit details in
the first message.

A useful report contains:

- the affected component (control plane / console / worker / installer / release tooling) and version or commit;
- the steps to reproduce, or a proof of concept, and the impact you expect;
- whether the issue is already known publicly.

Redact hostnames, IP addresses, tokens and other personal data from logs, probe output and diagnostics reports before you
attach them.

## What to expect

- We acknowledge a report as soon as we can and keep you updated while we investigate.
- We agree with you on a disclosure date. Fixes are released first; the advisory is published afterwards, with credit to
  the reporter unless you prefer otherwise.
- Please give us a reasonable time to fix the issue before any public disclosure, and do not access, modify or delete
  data that is not yours while testing.

## Supported versions

Security fixes are made on the main branch and shipped in the next release of the control plane and the worker. Older
releases are not patched; update to the latest release (`sudo remyral-ctl upgrade`, and the worker update channel in the
console).

## Defaults

A new installation starts on the **Dengeli** (Balanced) security preset: an authenticator code is asked for the safe
core and for credentials, logins, the sandbox, machine administration, production deploys, integrations, releases and
MCP installs. The **Serbest** (Free) preset waives the code for everything outside the safe core and lets approvals pass
by themselves; it is meant for a single-person, closed installation and is chosen explicitly in the setup wizard or in
Settings → Security. An upgrade never changes the preset an installation already has. See
[docs/ops/selfhost-install.md](docs/ops/selfhost-install.md) and ADR-0056.

## Scope and design

The threat model is in [docs/security/threat-model.md](docs/security/threat-model.md); the security-relevant decisions are
recorded as ADRs in [docs/adr/](docs/adr/README.md). Reports about third-party runtimes (Claude Code, Codex, Pi,
OpenCode) or dependencies should also go to their upstream projects.
