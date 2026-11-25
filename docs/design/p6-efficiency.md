# p6-efficiency — making the cluster cheaper and faster

Status: planned 2026-10-16 (owner: "hepsini planlayalım ve tamamlayalım"). Load and failure drills are
postponed by the owner (p7-load, p7-failure-tests, p7-sandbox-escape stay open).

Findings from live use (2026-10-15/16, one Windows worker, 4 CPUs / 8 GB):

- Harmless commands (`git status`, writing `out/date.md`) waited 10 minutes for a human approval.
- Only Claude Code and OpenCode are installed; a subscription limit stops all work.
- Every repository job re-installs dependencies from scratch; mirrors already cache git objects.
- The model is chosen per job by hand or by a default; nothing uses the recorded duration, cost and
  outcome of earlier jobs.

## Tasks

| Id | What | Main area |
| --- | --- | --- |
| `p6-safe-auto-approve` (done, [design](p6-safe-auto-approve.md)) | Project policy "safe commands": read-only git, listing, reading and printing inside the workspace, the runtime's own read tools — approved automatically and audited; writes, network, push, deletes, installs keep asking. Classifier per OS shell (bash, zsh, PowerShell, cmd), conservative: anything not proven read-only asks. | master approvals + worker gate |
| `p6-capacity-advice` | Machine page shows recommended parallel jobs from CPUs, RAM and the runtimes' measured peak memory; warns when the configured value is above it; one-click apply through the managed config. Done: [p6-capacity-advice.md](p6-capacity-advice.md). | worker report + web |
| `p6-smart-routing` | Routing rules: job kind / workflow step role (plan, execute, verify, summarise) → model profile and runtime preference; per-project overrides; the scheduler scores candidates with recorded success rate, duration and cost per runtime × model × kind (`job_stats` rollup); explainable placement ("chosen because …"). | scheduler + models + web |
| `p6-quota-scheduling` | Quota awareness: provider pauses and subscription limits feed placement; a job can declare a fallback runtime; deferrable jobs and automations get an off-peak window per project; queue shows "waiting for quota until …". Done: [p6-quota-scheduling.md](p6-quota-scheduling.md). | scheduler + quotas + automations |
| `p6-result-reuse` | Before dispatch, find a finished job with the same project, repository commit, runtime, model and normalised prompt; offer "reuse result" (composer, chat, automations) or attach its summary to the context bundle; never silent. Done: [p6-result-reuse.md](p6-result-reuse.md) (offer in composer and chat; opt-in skip policy for automations and workflow steps). | master jobs + composer |
| `p6-warm-caches` (done, [design](p6-warm-caches.md), ADR-0029) | Per-machine package caches (npm/pnpm store, pip cache, cargo/go caches when present) shared read-mostly across jobs of a project, placed outside the workspace, sandbox-mounted read-only with a per-job writable overlay where the profile allows; size limit and LRU sweep; warm the cache after a successful job. | worker workspace + sandbox |
| `p6-runtime-diversity` | Install Codex and Pi on the Windows worker from the panel (their logins / keys need the owner); placement falls back between installed runtimes when one is paused. | ops + scheduler |

Order: safe-auto-approve and capacity-advice first (largest win, small), then smart-routing and
quota-scheduling (scheduler), then warm-caches and result-reuse. Every task follows AGENTS.md (design note,
tests, security review, docs, changelog) and ships behind project-level settings with safe defaults.

## Also planned (owner, 2026-10-16)

`p6-deploy-integrations` and `p6-deploy-pipeline`: Coolify deploys, Cloudflare Pages deploys and Cloudflare
DNS changes as master-held, policy-checked, audited "ops actions" that agents and the orchestrator request
(tokens never reach workers); see the ADR and design note added by that task.
