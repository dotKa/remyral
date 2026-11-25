# Design note: `p5-git-identity` — per-project git commit identity

- **Task:** `p5-git-identity`. Live finding 2026-10-15: on the Windows worker an agent's own `git commit` used the
  Windows user's personal email (the machine's global git config); the publish commit always said
  `Remyral Agent <agent@remyral.invalid>`.
- **Date:** 2026-10-15
- **Binding inputs:** ADR-0004 §3 (attempt trailer, publish commit), ADR-0011 (additive protocol), ADR-0009 / p5-rbac
  (authz, step-up), p1-audit-schema, p3-secrets-worker (minimal runtime env).

## Decision

The commit identity (author and committer) of agent work is a **project setting**, with an optional
**workspace-wide default**; the master resolves it and sends it to the worker with each repository job.

Resolution, in order: the project's identity → the workspace default → `Remyral Agent <agent@remyral.invalid>`.

## Shape

```
packages/protocol      git-identity.ts: rules (gitIdentityProblem), DEFAULT_GIT_IDENTITY, GIT_IDENTITY_ENV,
                       gitIdentityEnv; ASSIGN_JOB.gitIdentity (optional, additive in 1.0)
packages/agent-adapters  minimalEnv keeps GIT_AUTHOR_* / GIT_COMMITTER_* (Claude Code, Codex allowlists)
apps/worker            publish commit author/committer = gitIdentity; repository jobs' runtime env gets
                       GIT_AUTHOR_NAME/EMAIL + GIT_COMMITTER_NAME/EMAIL (every sandbox profile passes it)
apps/master            migration 0040 (projects.git_author_*, git_identity_default); git-identity module;
                       GET/PUT /projects/:id/git-identity, GET/PUT /settings/git-identity; orchestrator resolves
                       it at ASSIGN_JOB; plain-git merge commits use a configured identity
apps/web               Projects → Repository → Git identity; Settings → Integrations → Default git identity
```

## Rules

- **Validation** (shared by API, console and the ASSIGN_JOB schema): name 1–100 characters, no control characters
  (incl. line breaks, tab, DEL, C1) and no `<`/`>`, no leading/trailing spaces (the API trims first); email a simple
  `local@domain.tld` address without whitespace, angle brackets or control characters, at most 254 characters. The
  database repeats the checks (and that name and email are set together).
- **Authorization.** Project identity: `projects.git.read` (members read) / `projects.git.write` (admins, step-up).
  Default: `git.identity.read` / `git.identity.write` (admins; write with step-up).
- **Audit.** `project.git_identity.update` (target `project:<id>`) and `settings.git_identity.update` (target
  `settings:git-identity`) with `before`, `after`, `changed`, in the change's transaction. Denials are audited by the
  authz layer under the same action names.
- **When it applies.** At dispatch (ASSIGN_JOB): queued jobs pick up a change; a running attempt keeps the identity
  it was assigned.

## Worker

- The publish commit (`publishAttempt`) is authored and committed with `gitIdentity` (`user.name` / `user.email` as
  command-line config: both author and committer). An older master sends nothing → Remyral Agent (unchanged).
- Repository jobs: `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` are added to the runtime's non-secret env.
  git reads them before any config, so the agent's own commits carry the project identity regardless of the
  machine's git config. Pi, OpenCode and OpenHands pass the job env as is; Claude Code and Codex build theirs from
  an allowlist, which now includes these four names. Host profiles hand the env to the process; the container
  profile forwards it into the container. Workspace (scratch) jobs have no repository and get no identity.

## Master-side commits

The master creates commits itself only when merging into a **plain git** remote (`LocalGitProvider.merge`, a
`commit-tree` merge or squash). With a project / workspace identity configured, that identity signs the merge
commit; with none the existing `Remyral Git Flow <gitflow@remyral.invalid>` stays. GitHub merges go through the API and
carry the App's identity (unchanged).

## Security

The identity is not a secret (it is visible on every commit). It is never used for authentication or authorization;
git hosts may attribute commits to the account owning the email, so admins should pick an address they control (for
GitHub, a verified or noreply address). Validation keeps it from injecting extra header lines into commit objects.

## Compatibility and rollback

ASSIGN_JOB.gitIdentity is optional: older workers drop it (Zod strips unknown keys) and keep committing as Remyral
Agent. Migration 0040 only adds nullable columns and a new table; rolling back the code leaves them unused.
