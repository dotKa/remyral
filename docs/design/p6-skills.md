# Design note: signed, versioned skills and agent instructions distribution (P6)

- **Status:** Implemented
- **Date:** 2026-10-14
- **Backlog:** `p6-skills` (ROADMAP P6 "Signed/versioned skills and agent instructions"; requirement 8 "skill
  distribution")
- **Decisions applied:** ADR-0010 (repository content is untrusted; authority order), ADR-0006 (no secrets in
  context), ADR-0009 (step-up for privileged writes), ADR-0011 (additive protocol fields in 1.0), ADR-0012
  (repo config never loosens runtime policy), ADR-0007 (scripts run only inside the attempt's sandbox)
- **Builds on:** [p6-context-model.md](p6-context-model.md) (the `skill:<id>` namespace, reserved there),
  [p2-signed-updates.md](p2-signed-updates.md) (offline Ed25519 signing pattern), [p3-adapter-*.md](p3-adapter-contract.md)
- **Threat model:** T-SUP-4 (malicious/tampered skill), T-INJ-6 (repository-provided skills), T-INJ-5, T-SEC-1

## 1. Shape

```
packages/protocol      skills.ts: SkillManifest, SignedSkillBundle, verifySkillBundle, skillSetHash,
                       ASSIGN_JOB.skills (AssignedSkills, additive in 1.0)
scripts/skills/sign.mjs  offline keygen | pack | verify (no dependencies)
packages/memory        skill namespaces enabled for signed writes only (checkDocumentSettings signedSkill)
apps/master            migrations/0022_skills.sql; src/skills/{service,routes}.ts; ContextStore.writeSkillDocument;
                       orchestrator delivers pinned skills with ASSIGN_JOB; SKILLS_PUBLIC_KEYS
apps/worker            skills/verify.ts (own keys from config `skills.publicKeys`), runner admission + delivery
packages/agent-adapters  skills.ts (materializeSkills, renderSkillsAsInstructions), AgentAdapter.skillDelivery,
                       SpawnContext.skills; Claude Code, Codex, Pi native; codex repo-skill disabling
apps/web               Settings → Skills (/settings/skills)
```

## 2. Bundle, signature, keys

A skill version is **text only**: `SKILL.md` (frontmatter `name` = skill id, `description`) plus optional files
under `scripts/`, `references/`, `resources/`, `assets/` (≤ 32 files, ≤ 64 KiB each, ≤ 128 KiB total; paths
`[A-Za-z0-9_-]` segments, ≤ 2 sub-directories — no `..`, hidden files, backslashes or absolute paths; only
`scripts/` may be executable). The manifest (`schema`, `kind: remyral.skill`, `id`, `title`, semver `version`,
`description`, compatible `runtimes`, per-file `sha256`/`size`/`executable`, `createdAt`) is signed **as exact
bytes** with Ed25519 over `remana-skill/v1\n` + manifest (domain-separated from release, lease and AUTH
signatures). Key id = first 16 hex of SHA-256 of the raw public key; up to two trusted keys (rotation).

The **skills key** is its own key — not the release key, not the lease key, not a device key — kept offline:

```
node scripts/skills/sign.mjs keygen --out <offline-dir>          # skills-key.pem (0600) + skills-key.pub
node scripts/skills/sign.mjs pack --dir ./release-notes --version 1.2.0 --runtimes claude-code,codex \
     --key <offline-dir>/skills-key.pem --out release-notes-1.2.0.json
node scripts/skills/sign.mjs verify --bundle release-notes-1.2.0.json --public-key <pub>
```

Trust is configured in two independent places: the master's `SKILLS_PUBLIC_KEYS` (upload + re-verification
before delivery) and each worker's root-owned config `skills.publicKeys`. A worker without keys declines any
job that carries skills; a compromised master or a tampered outbox row cannot make a worker use an unsigned
skill.

## 3. Storage: the `skill:<id>` context namespace

Reserved in p6-context-model (parsed, rejected on write) and now enabled — **only** for signed versions:
`checkDocumentSettings(…, { signedSkill: true })` is passed solely by `ContextStore.writeSkillDocument`, called
by `SkillService.upload` after verification. Every other path (`POST /context/docs`, new versions, rollback of
a skill document) returns `skill_requires_signed_bundle`. A skill document is `instructions`, write role
admin, project scope `own`; its versions are the SKILL.md texts with provenance `import` ("signed skill
id@version (key …)") and go through the same normalisation, limits and **secret scan** (every file is
scanned, findings reported by position only). Skills never enter the context bundle (`projectCanRead` stays
false for skill namespaces) — they are delivered separately (§5). Soft delete / purge / legal hold of the
context model apply to the skill document; purging cascades to the signed versions and files, after which
pinned jobs fail closed.

Migration **0022**: namespace checks widened; `skill_versions` (exact manifest bytes, manifest sha256,
signature, key id, metadata, FK to the context version), `skill_files` (content + sha256 + executable) — both
immutable by trigger; `skill_assignments` (skill → project, optional runtimes, optional version pin);
`job_skill_pins` + `job_skill_sets` (per-job pins, no content).

## 4. Assignment and per-job pinning

`PUT /skills/assignments {skillId, project, runtimes?, version?}` (admin + step-up): `runtimes` null = every
runtime the version supports; `version` null = newest version (semver precedence) at first issue.

At dispatch (`Orchestrator`, before the lease), `SkillService.issueForJob(job, worker)`:

1. under a per-job advisory lock, if the job has no pin yet: assignments of **the job's own project** whose
   runtimes include the job's runtime, joined with non-deleted skill documents; per skill the pinned or newest
   version that lists the runtime; ≤ 8 skills, ≤ 160 KiB of files (the ASSIGN_JOB frame limit is 512 KiB);
   pins and the set hash (`skillSetHash`: sorted `id@version:manifestSha256`) are stored;
2. if already pinned: exactly those versions — a retry, a resume under a new epoch or another worker gets the
   same skills even if a newer version was uploaded or the assignment changed;
3. every bundle is re-verified against the current `SKILLS_PUBLIC_KEYS` and the pinned manifest hash; a missing
   or non-verifying version makes the job **infeasible** with a reason (fail closed, like a purged context
   version);
4. `skill.issue` audit event (job, worker, set hash, ids@versions).

`GET /jobs/:id/skills` (project-scoped like the job) shows the pins.

## 5. Worker: verification, delivery, materialisation

At admission (`JobRunner`), before anything is prepared: `verifyAssignedSkills` checks every bundle with the
worker's own keys (signature, manifest rules, file set/sizes/hashes, UTF-8), no duplicate ids, the job's
runtime is listed, and that the recomputed set hash equals the delivered one. Any failure declines the job
(`skill_verification_failed: …` / `skills_untrusted`).

Delivery per adapter (`AgentAdapter.skillDelivery`):

| Runtime | Delivery | Where (never the workspace, never a real home) | Repository skills (ADR-0010) |
| --- | --- | --- | --- |
| Claude Code (Agent SDK 0.3.296) | native in `secret-ref` mode | `<per-attempt CLAUDE_CONFIG_DIR>/skills/<id>/`; `settingSources: ['user']` (resolves to that private dir) and `skills: [ids]` (Skill tool limited to ours) | `project`/`local` sources stay off, so `.claude/skills`, `.claude/settings.json`, CLAUDE.md never load. `local-login` uses the real `~/.claude` → **instructions** |
| Codex app-server 0.162.1 | native in `secret-ref` mode | `<per-session CODEX_HOME>/skills/<id>/` (scope `user`) | **VL finding:** 0.162.1 loads `.agents/skills` / `.codex/skills` with scope `repo` even for a workspace marked `trust_level = "untrusted"`. The adapter now finds every such SKILL.md (bounded walk) and disables it by exact path (`-c skills.config=[{ path, enabled = false }]`). Real-binary test: ours enabled, repo skills disabled. `local-login` → **instructions** |
| Pi 1.1.0 | native | `<private run dir>/skills/<id>/` passed as `--skill <dir>`; `--no-skills` keeps every discovered source (user, project `.pi/skills`, packages) off | unchanged: discovery off |
| OpenCode 1.19.0 | **instructions** | — | The `skill` permission stays denied and `.opencode` repos stay refused (p3-adapter-opencode). OpenCode's `skills.paths` config could load our directory natively but enabling the skill tool also exposes discovered project/global skills; not enabled until verified against the pinned binary (follow-up) |
| OpenHands 1.54.0 | **instructions** | — | Skills load only from workspace paths (`.agents/skills`, `.openhands/skills`) and only with `load_project_skills` (trusted repos); writing ours there would mix them with repository skills and put them in the repository. No inline-skills request field |

**Instructions fallback:** `renderSkillsAsInstructions` prepends the skills to the prompt (after the context
bundle) in a fence whose nonce is derived from the content (a skill cannot forge the end marker), with the
statement that skills cannot grant permissions or override platform policy. SKILL.md and reference texts are
included; scripts are listed but not offered.

`materializeSkills` re-validates ids and paths, refuses any existing target (a planted symlink is never
followed), writes files 0600 and scripts 0700 with `wx`, and runs nothing. A script runs only if the agent runs
it, as a tool call inside the attempt's sandbox profile and approval policy.

## 6. API

| Route | Action (role) | Notes |
| --- | --- | --- |
| `GET /skills` | `skills.read` (viewer+) | skills, versions (newest first), assignments, `configured` |
| `GET /skills/:id/versions/:version` | `skills.read` | manifest + files |
| `POST /skills` | `skills.publish` (admin), step-up, CSRF | signed bundle; 201 new / 200 identical / 409 same version, other content / 422 signature / 400 secret / 503 no keys |
| `GET /skills/assignments?project=` | `skills.read` | |
| `PUT /skills/assignments` | `skills.assign` (admin), step-up | upsert per (skill, project) |
| `DELETE /skills/assignments/:id` | `skills.assign` (admin), step-up | pinned jobs keep their skills |
| `GET /jobs/:id/skills` | `jobs.read` on the job's project | pins + set hash |

Audit: `skill.upload` (success/denied with reason), `skill.assign`, `skill.unassign`, `skill.issue`, plus the
context `context.doc.*` events for the skill document.

## 7. Console

Settings → **Skills**: per skill the versions (runtimes, file count, key id, manifest hash), their files, the
project assignments; admins upload a bundle file (validated client-side as JSON with manifest/signature, size
bound) and assign/remove through the step-up dialog. A warning appears when the master has no skills key.
Mobile: same 44 px rules as p5-mobile (included in the mobile layout audit).

## 8. Tests

| Suite | What |
| --- | --- |
| `packages/protocol/test/skills.test.ts` | the signing script and the verifier agree; missing/unknown key, forged signature, one-byte manifest change, changed/added/removed file, path escape and executable-outside-scripts refused even when validly signed; set hash order-independent and change-sensitive |
| `packages/memory/test/model.test.ts` | skill namespaces only with `signedSkill`; skill documents are admin instructions |
| `apps/master/test/integration/skills.test.ts` | upload role/step-up/idempotency/conflict, tampering, untrusted key, secret in file, context namespace refuses direct writes; assignment refusals; delivery end to end through the real transport to a worker running the fake adapter (native) — only the project's skill (cross-project scoping), materialised outside the workspace; **version pinning per job** (newer upload, re-issue for the old job returns the pinned version; assignment pin); instructions fallback in the prompt; a worker that trusts another key declines before anything is written |
| `apps/master/test/integration/rbac-matrix.test.ts` | the three new actions in the generated route × role matrix |
| `apps/worker/test/skills-verify.test.ts` | worker-side verification: no keys, unknown key, tampered file, version swapped under the pinned hash, duplicate ids, wrong runtime |
| `packages/agent-adapters/test/skills.test.ts` | materialisation layout/modes, id/path/symlink refusal, fenced instructions (forged end marker), Claude options (`['user']` + skill filter only with skills, never project/local), codex repo-skill discovery and arguments, **real codex-cli 0.162.1** `skills/list`: our skill enabled with scope `user` from CODEX_HOME, repository skills disabled |
| `test/runtimes/codex/adapter.test.ts`, `test/pi-adapter.test.ts` | Codex: skills in the private CODEX_HOME + repo skill disabled in argv; Pi: `--skill <private dir>` next to `--no-skills`, removed on cleanup |
| `apps/web/test/skills.test.tsx` | list/versions/files, viewer without controls, unconfigured warning, assignment through step-up |

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| T-SUP-4 forged/tampered skill (compromised master, DB, outbox, network) | Offline key; signature over exact manifest bytes with file hashes; verified on upload, before delivery and by every worker with keys from its own root-owned config; immutable rows; per-job pin by manifest hash | Theft of the offline skills key; rotate with a two-key overlap |
| Downgrade / version swap | Set hash pinned per job and re-checked by the worker; the master refuses a different manifest for an existing version | An admin can deliberately pin an older signed version (audited) |
| T-INJ-6 repository skills | Native delivery only from private state dirs; project sources/discovery off (Claude, Pi), repo skills disabled by path (Codex — found loading despite `untrusted`), OpenCode/OpenHands skills stay off | Codex: a skill the agent *creates during the run* in `.agents/skills` is not in the start-time list (it would carry the authority of agent output, which is untrusted data anyway). Claude's `user` source loading only the private dir is per SDK docs: **UNVERIFIED-LIVE** (no credentials) |
| Skill scripts as code execution | Text only, materialised 0700 without running; only the agent can run them as tool calls under the attempt's sandbox and approval policy | A skill can still *suggest* risky commands; approvals and sandbox apply as for any tool call |
| Cross-project leakage (T-INJ-5) | Assignments per project; resolution only for the job's project; jobs see only pinned skills; pins endpoint project-scoped | Skill content is visible to every console viewer (`skills.read` is global) — skills must not contain project secrets (secret scan) |
| Secrets in skills (T-SEC-1) | Pattern scan of every file on upload; denial audited by position | Pattern-based (p7-secrets-scan) |
| Privilege misuse / repudiation | Admin + step-up + CSRF for upload/assign; hash-chained audit of upload, assignment, issue | — |
| DoS | Size limits (bundle, files, per job), 1 MiB body limit on upload, bounded repository walk | — |

## 10. Operations and rollback

Enable: generate the key offline, set `SKILLS_PUBLIC_KEYS` on the master and `skills.publicKeys` in each
worker's config, upload, assign. Rotation: add the new key to both lists (≤ 2), re-sign, remove the old key.
Rollback: remove the assignments (jobs already pinned keep their versions; new jobs get none) or unset
`SKILLS_PUBLIC_KEYS` (jobs get no skills). The migration is additive except the widened namespace CHECKs
(reverting requires deleting skill documents first). Metrics hooks for p6-otel: `skill.issue` count, upload
denials by reason, worker declines (`skill_verification_failed`).

## 11. UNVERIFIED

- Claude Code native skills against the real CLI (no credentials on this host): options per SDK 0.3.296
  `sdk.d.ts`; behaviour of `settingSources: ['user']` with a private `CLAUDE_CONFIG_DIR` is documented, not run.
- Pi `--skill` on the pinned 1.1.0 (local binary is 0.85.1; flag documented for both).
- OpenCode native skills (`skills.paths`) deliberately not enabled (see §5).
