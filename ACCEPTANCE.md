# Full v1.0 Production Acceptance Matrix

> **What this file is.** The acceptance criteria written at the start of development and used to plan and check the
> work towards v1.0. The boxes are ticked only when an item has been verified end to end on real machines, so an
> unchecked box means "not signed off"; it does not say whether the feature exists (the design notes and the test
> suites show what is built and how it is tested). It is kept as the yardstick for the v1.0 release.

All items are required; missing checks block release.

## Fleet and connectivity
- [ ] Workers on every supported OS family enroll from different networks without opening inbound router ports.
- [ ] Worker identities can be approved, revoked and rotated, with immediate enforcement.
- [ ] A powered-off worker is not assigned new jobs; offline work is queued or redirected according to policy.
- [ ] Worker daemon survives process crash/reboot and restores correct status.
- [ ] Reconnection replays missed events without duplicate irreversible actions.
- [ ] Intel/ARM and four operating-system families are tested for actual supported features.

## Runtimes
- ~~OpenHands can launch, stream, cancel and report a repository task.~~ Removed by owner decision (ADR-0023, 2026-10-15); four runtimes remain.
- [ ] Claude Code can launch, stream, cancel and report a repository task.
- [ ] Codex can launch, stream, cancel and report a repository task.
- [ ] Pi can launch, stream, cancel and report a repository task.
- [ ] OpenCode can launch, stream, cancel and report a repository task.
- [ ] Unsupported native features show truthful state, not simulated success.

## Orchestration
- [ ] DAG fan-out/fan-in across at least three workers passes integration tests.
- [ ] Per-worker and provider concurrency/budgets enforced.
- [ ] Crash during lease ownership reconciles safely.
- [ ] Conflicting branch edits produce reviewable conflicts, not silent overwrite.
- [ ] An explicit approval is required for protected merge and destructive actions.
- [ ] Queue survives master/Redis restart; Postgres state reconciles.

## UX, memory, monitoring
- [ ] Mobile dashboard spawns, supervises and cancels jobs securely.
- [ ] Real-time logs are ordered, searchable and safely redacted.
- [ ] Project instructions and global context are versioned and permission-scoped.
- [ ] Tool/model usage and costs show source and gaps.
- [ ] Users can export task records and delete context per retention policy.
- [ ] Operational alarms fire for offline worker, backlog, failure spikes and budget threshold.

## Security and recoverability
- [ ] SSO/MFA and role checks cover all management actions.
- [ ] No worker backend or arbitrary shell is publicly reachable.
- [ ] Secrets cannot be read from dashboard JS, log streams or persisted prompts.
- [ ] Threat model and external dependency scan reviewed.
- [ ] Backup restore to a fresh EC2 is demonstrated with documented recovery time.
- [ ] CI/CD, rollbacks, upgrade compatibility and documented runbooks tested.
