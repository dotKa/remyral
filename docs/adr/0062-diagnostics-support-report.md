# ADR-0062: Diagnostics may leave the installation as a redacted support report, by e-mail, on request

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** owner (request: "doctor/diagnostic özelliğide getirelim. sorun varsa bize rapor alıp mail ile
  iletebilirler"), agent
- **Related:** p16-doctor; [design note](../design/p16-doctor.md); ADR-0006 (redaction); ADR-0016 (vault values sealed
  to the machines); ADR-0017 (signed remote operations); ADR-0056 (security policy, step-up events); migration 0147

## Context

Remyral is installed by a customer for one company (self-hosted). When something breaks, the vendor today needs SSH or a
screen share to see what the console already knows: health checks, versions, configuration, the master's warn / error
log, failed jobs, the machines' state. The owner wants customers to run diagnostics themselves and send the vendor a
report by e-mail. Until now no data left the installation on its own initiative except to the providers the customer
connected (Coolify, Cloudflare, GitHub, model APIs) and to notification channels the users chose. Sending diagnostics
to the vendor changes the trust model: a bundle of operational data goes to a third party.

## Decision

1. **Only on an explicit request, never automatically.** A person with `support.report` (owners and admins) presses
   "Raporu e-postayla gönder" in Ayarlar → Tanılama (or confirms the assistant's card). The daily diagnostics run only
   notifies the installation's own owners and admins; it never sends anything off-site.
2. **Previewed and redacted.** The bundle is built first and shown file by file (path, section, size, hash, the summary
   text exactly as packed); the user unticks sections. Content is metadata by construction (closed codes, ids,
   numbers, an **allowlist** of configuration keys); every value and every file passes the Redactor (patterns,
   secret-looking keys, the exact SMTP passwords the master holds). Job prompts and titles are a separate, never
   preselected section; outputs, diffs, workspace files and secrets are never part of it.
3. **One recipient the owner controls.** The support address is a setting (default `old-support@example.com`) only the owner
   changes; the request can add a copy only to the sender's own notification e-mail, not name an address.
4. **The security policy decides the code.** A new step-up event `support.report` (category data) covers sending and
   changing the support address / SMTP: off in Serbest, on in Dengeli and Sıkı. Building, previewing and downloading
   the bundle stay local and ask for no code.
5. **The master sends with SMTP it is configured for**: an owner-configured server (its password sealed with an HKDF
   sub-key of the master key — the vault cannot be used, its values are sealed to the machines, ADR-0016) or the
   notification SMTP of the environment. TLS mandatory, certificates verified. Attachments up to 10 MB; larger bundles
   send the summary only and are downloaded by hand.
6. **Audited.** Every send (and failure), build, download and settings change: who, to whom, size, sections, SHA-256.

## Consequences

- The vendor can be sent a useful report without remote access; the customer sees exactly what leaves.
- A mistaken send discloses operational metadata (machine names, project ids, error messages) to the vendor address —
  bounded by the preview, the redaction, the owner-controlled address and the step-up event.
- The machine doctor (`remyral-worker doctor`) works without the master; its `--out` file is attached by hand.
- Rolling back is removing the feature; nothing else depends on it (migration 0147 is additive).

## Alternatives considered

- **Upload to a vendor endpoint (HTTPS).** Needs a vendor service, credentials and availability; e-mail fits a
  single-company install and the owner's wording.
- **Automatic send on new problems.** Rejected: data must not leave without a person's decision.
- **Workers send the mail.** The master holds the data; workers would need SMTP credentials and a second path.
