import {
  MachineAdminReport,
  PreviewTunnelsReport,
  SandboxStatusReport,
  SERVICES_FEATURE,
  ToolInventoryReport,
} from '@remyral/protocol';
import type { ProjectReadiness } from './project-setup.js';

/**
 * p20-scope-preview (docs/design/p20-scope-preview.md §4; tools a job needs are installed automatically): the
 * work-specific readiness check behind the assistant's `check_work_readiness`. Before a job or a
 * service starts, the master decides — from what it already knows (the project's readiness, the machine's sandbox
 * status, tool inventory, tunnel report, machine-admin report, the caller's role and the security policy) — what the
 * work still needs:
 *
 *  - `prepare`: preparation the assistant runs NOW (the machine's sandbox prepare, a tool install such as cloudflared),
 *    each with the exact tool call and whether it runs at once in this turn (`runsAtOnce`);
 *  - `ask`: the ONE thing only the user can decide (a machine assignment, opening network access, a panel setting, a
 *    runtime login) as a single question with its reason;
 *  - `blocked`: what nobody can fix from the chat (an owner-only fix, a hold).
 *
 * Pure: {@link assessWork} (unit tested); the reads are in ChatTools. Nothing here acts.
 */

export type WorkKind = 'job' | 'service';
export type WorkTunnel = 'none' | 'quick' | 'named';
export type WorkNetwork = 'none' | 'allowlist' | 'web';

export interface WorkRequest {
  readonly project: string;
  readonly kind: WorkKind;
  /** The machine the user named (id or name), if any. */
  readonly worker?: string | undefined;
  /** The sandbox profile the work needs; default: `host-restricted` for a service, the project's best for a job. */
  readonly sandboxProfile?: string | undefined;
  readonly tunnel?: WorkTunnel | undefined;
  /** The network access the work needs (e.g. `allowlist` for npm installs, `web` for any public host). */
  readonly network?: WorkNetwork | undefined;
}

/** What the master knows about one machine (raw report columns, parsed defensively). */
export interface WorkerFacts {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly features: unknown;
  readonly localProjects: unknown;
  readonly sandboxStatus: unknown;
  readonly previewTunnels: unknown;
  readonly toolInventory: unknown;
  readonly machineAdmin: unknown;
}

export interface WorkContext {
  /** The caller may run the machine's sandbox prepare / tool installs (workers.ops.write). */
  readonly canPrepare: boolean;
  /** This turn's drafts run at once (the "otonomi" block's run_at_once / plan / follow-up state). */
  readonly runsAtOnce: boolean;
  /** `chatMachineAdmin` applies to this turn (no always-fresh code for a privileged prepare / elevated install). */
  readonly machineAdminByPolicy: boolean;
}

export interface WorkCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkPrepare {
  readonly tool: 'draft_machine_prepare' | 'draft_tool_install';
  readonly input: Readonly<Record<string, unknown>>;
  readonly why: string;
  /** It runs at once when called in this turn (else it is a card the user confirms). */
  readonly runsAtOnce: boolean;
}

export interface WorkVerdict {
  readonly ready: boolean;
  readonly worker: { readonly id: string; readonly name: string } | null;
  readonly checks: readonly WorkCheck[];
  readonly prepare: readonly WorkPrepare[];
  readonly ask: { readonly reason: string; readonly question: string; readonly next?: string } | null;
  readonly blocked: { readonly reason: string; readonly message: string } | null;
  readonly next: string;
}

const NET_RANK: Readonly<Record<string, number>> = { none: 0, allowlist: 1, web: 2 };

const features = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Picks the machine: the named one, else a machine that can run the work now (assigned, online). */
function pickWorker(
  req: WorkRequest,
  workers: readonly WorkerFacts[],
  readiness: ProjectReadiness | null,
): WorkerFacts | null {
  if (req.worker !== undefined) {
    const ref = req.worker.toLowerCase();
    return workers.find((w) => w.id.toLowerCase() === ref || w.name.toLowerCase() === ref) ?? null;
  }
  const online = (w: WorkerFacts) => w.state === 'online' || w.state === 'busy';
  if (req.kind === 'service') {
    const ok = workers.filter(
      (w) =>
        online(w) &&
        features(w.features).includes(SERVICES_FEATURE) &&
        (!Array.isArray(w.localProjects) || w.localProjects.includes(req.project)),
    );
    return ok[0] ?? workers.find(online) ?? workers[0] ?? null;
  }
  const rank = { now: 2, later: 1, no: 0 } as const;
  const byReadiness = [...(readiness?.machines ?? [])].sort(
    (a, b) => rank[b.canRun] - rank[a.canRun] || Number(b.preferred) - Number(a.preferred),
  );
  for (const m of byReadiness) {
    const w = workers.find((x) => x.id === m.id);
    if (w !== undefined) return w;
  }
  return workers.find(online) ?? workers[0] ?? null;
}

/** The deterministic verdict (see the module comment). */
export function assessWork(
  req: WorkRequest,
  readiness: ProjectReadiness | null,
  workers: readonly WorkerFacts[],
  ctx: WorkContext,
): WorkVerdict {
  const checks: WorkCheck[] = [];
  const prepare: WorkPrepare[] = [];
  // Set through the closures below: the casts keep TypeScript from narrowing both to their initial null.
  let ask = null as WorkVerdict['ask'];
  let blocked = null as WorkVerdict['blocked'];
  const askOnce = (a: NonNullable<WorkVerdict['ask']>) => {
    ask ??= a;
  };
  const blockOnce = (b: NonNullable<WorkVerdict['blocked']>) => {
    blocked ??= b;
  };

  // The project: holds, repository, network.
  if (readiness === null) {
    blockOnce({ reason: 'project_not_found', message: `Project ${req.project} was not found.` });
  } else {
    if (readiness.holds.length > 0) {
      const h = readiness.holds[0];
      checks.push({ check: 'holds', ok: false, detail: h?.message ?? 'held' });
      blockOnce({ reason: `hold_${h?.code ?? 'unknown'}`, message: h?.message ?? 'The project is held.' });
    } else checks.push({ check: 'holds', ok: true, detail: 'no kill switch, budget or cost brake holds it' });
    if (readiness.kind === 'repository') {
      const repo = readiness.repository;
      const linked = repo !== null && repo.linked;
      checks.push({
        check: 'repository',
        ok: linked,
        detail: linked ? 'linked' : 'no repository linked (Project → Repository)',
      });
      if (!linked)
        askOnce({
          reason: 'repository_missing',
          question: `Project ${req.project} has no repository yet — which repository should it use (or should one be created)?`,
          next: 'create_repository / draft_project_create',
        });
    }
    const have = NET_RANK[readiness.network.mode] ?? 0;
    const want = NET_RANK[req.network ?? 'none'] ?? 0;
    const netOk = want <= have;
    checks.push({
      check: 'network',
      ok: netOk,
      detail: `project jobs reach: ${readiness.network.mode}${netOk ? '' : `; the work needs ${String(req.network)}`}`,
    });
    if (!netOk)
      askOnce({
        reason: 'network_closed',
        question: `The work needs network access "${String(req.network)}" but project ${req.project} allows "${readiness.network.mode}" — may I open it (only what it needs)?`,
        next: 'draft_project_network (execute: true after the user said yes)',
      });
  }

  // The machine.
  const w = pickWorker(req, workers, readiness);
  if (w === null) {
    checks.push({ check: 'machine', ok: false, detail: 'no machine found' });
    blockOnce({
      reason: req.worker === undefined ? 'no_machine' : 'machine_not_found',
      message:
        req.worker === undefined
          ? 'No enrolled machine can take this work.'
          : `No machine named ${req.worker}.`,
    });
  } else {
    const online = w.state === 'online' || w.state === 'busy';
    checks.push({ check: 'machine_online', ok: online, detail: `${w.name}: ${w.state}` });
    if (!online)
      blockOnce({
        reason: 'machine_offline',
        message: `${w.name} is ${w.state}: the work can start once it is online (a watch: create_watch machine online).`,
      });
    const m = readiness?.machines.find((x) => x.id === w.id);
    if (req.kind === 'service') {
      const svc = features(w.features).includes(SERVICES_FEATURE);
      checks.push({
        check: 'services',
        ok: svc,
        detail: svc ? 'the worker runs services' : 'the worker needs an update to run services',
      });
      if (!svc)
        blockOnce({ reason: 'worker_update_needed', message: `${w.name}’s worker cannot run services yet.` });
      const has = !Array.isArray(w.localProjects) || w.localProjects.includes(req.project);
      checks.push({
        check: 'project_on_machine',
        ok: has,
        detail: has ? 'the machine has the project' : 'the machine is not assigned to this project',
      });
      if (!has)
        askOnce({
          reason: 'machine_not_assigned',
          question: `${w.name} is not assigned to project ${req.project} — may I assign it?`,
          next: 'draft_project_machines add',
        });
    } else if (m !== undefined) {
      checks.push({
        check: 'can_run_jobs',
        ok: m.canRun !== 'no',
        detail:
          m.canRun === 'no'
            ? m.why.map((x) => `${x.code}: ${x.message}`).join('; ') || 'cannot run the project’s jobs'
            : `can run now: ${String(m.canRun === 'now')}`,
      });
      if (m.canRun === 'no' && m.assignable)
        askOnce({
          reason: 'machine_not_assigned',
          question: `${w.name} is not assigned to project ${req.project} — may I assign it?`,
          next: 'draft_project_machines add',
        });
      const runtimeWhy = m.why.find((x) => /runtime|login|auth/.test(x.code));
      if (m.canRun === 'no' && runtimeWhy !== undefined)
        askOnce({
          reason: runtimeWhy.code,
          question: `${w.name}: ${runtimeWhy.message} — this needs you (a runtime login or install on that machine).`,
        });
    }

    // Sandbox profile.
    const profile = req.sandboxProfile ?? (req.kind === 'service' ? 'host-restricted' : null);
    const status = SandboxStatusReport.safeParse(w.sandboxStatus);
    if (profile !== null && status.success) {
      const p = status.data.profiles.find((x) => x.profile === profile);
      if (p === undefined || p.ready) {
        checks.push({ check: 'sandbox', ok: true, detail: `${profile}: ready` });
      } else {
        checks.push({
          check: 'sandbox',
          ok: false,
          detail: `${profile}: ${p.code ?? 'not ready'}${p.reason === undefined ? '' : ` — ${p.reason}`}`,
        });
        if (p.fix === 'prepare' || p.fix === 'prepare_privileged') {
          const privileged = p.fix === 'prepare_privileged';
          if (ctx.canPrepare)
            prepare.push({
              tool: 'draft_machine_prepare',
              input: { workerId: w.id, privileged },
              why: `${profile} sandbox is not ready on ${w.name} (${p.code ?? 'prepare'})${privileged ? ' — the privileged helper installs what it needs (e.g. bubblewrap)' : ''}`,
              runsAtOnce: ctx.runsAtOnce && (!privileged || ctx.machineAdminByPolicy),
            });
          else
            askOnce({
              reason: 'prepare_needs_admin',
              question: `${w.name}’s ${profile} sandbox needs Prepare, which only an administrator can run — ask an administrator?`,
            });
        } else if (p.fix === 'panel')
          askOnce({
            reason: `sandbox_${p.code ?? 'panel'}`,
            question: `${w.name}: ${p.reason ?? `${profile} is not allowed`} — may I change that setting${p.remedy === undefined ? '' : ` (${p.remedy})`}?`,
            next: 'change_settings project_execution / the machine’s Sandbox & policy',
          });
        else if (p.fix === 'owner')
          blockOnce({
            reason: `sandbox_${p.code ?? 'owner'}`,
            message: `${w.name}: ${p.reason ?? `${profile} is not available`} — only the machine’s owner can fix it${p.remedy === undefined ? '' : ` (${p.remedy})`}.`,
          });
      }
    }

    // Tunnel: cloudflared on the machine.
    if (req.tunnel === 'quick' || req.tunnel === 'named') {
      const rep = PreviewTunnelsReport.safeParse(w.previewTunnels);
      const inv = ToolInventoryReport.safeParse(w.toolInventory);
      const found =
        (rep.success && rep.data.cloudflared !== null) ||
        (inv.success && inv.data.tools.some((t) => t.name === 'cloudflared' && t.found));
      checks.push({
        check: 'cloudflared',
        ok: found,
        detail: found ? 'cloudflared is installed' : 'cloudflared is not installed on the machine',
      });
      if (!found) {
        const recipe = inv.success ? inv.data.recipes.find((r) => r.tool === 'cloudflared') : undefined;
        if (recipe !== undefined && recipe.supported && ctx.canPrepare)
          prepare.push({
            tool: 'draft_tool_install',
            input: { workerId: w.id, tool: 'cloudflared', version: recipe.version },
            why: `the ${req.tunnel} tunnel needs cloudflared on ${w.name}`,
            runsAtOnce: ctx.runsAtOnce && (!recipe.elevated || ctx.machineAdminByPolicy),
          });
        else if (recipe !== undefined && recipe.supported)
          askOnce({
            reason: 'cloudflared_needs_admin',
            question: `${w.name} needs cloudflared for the tunnel; only an administrator can install it — ask an administrator?`,
          });
        else
          blockOnce({
            reason: 'cloudflared_unsupported',
            message: `${w.name} has no cloudflared recipe${recipe?.unsupportedReason === undefined ? '' : ` (${recipe.unsupportedReason})`}: pick another machine.`,
          });
      }
      if (req.tunnel === 'named')
        checks.push({
          check: 'named_tunnel',
          ok: true,
          detail:
            'a named link needs the project’s preview links (Project → Deploy → Preview links); start_service says so if they are missing — a quick tunnel needs no setup',
        });
    }

    // Machine administration (only relevant for elevated preparation).
    const ma = MachineAdminReport.safeParse(w.machineAdmin);
    const elevatedPrep = prepare.some(
      (p) => p.input.privileged === true || (p.tool === 'draft_tool_install' && !p.runsAtOnce),
    );
    if (elevatedPrep && ma.success && ma.data.localVeto)
      checks.push({
        check: 'machine_admin',
        ok: false,
        detail: `${w.name}’s own configuration vetoes machine administration (local veto): elevated steps wait for a human`,
      });
  }

  const ready = blocked === null && ask === null && prepare.length === 0 && checks.every((c) => c.ok);
  const next =
    blocked !== null
      ? 'blocked: tell the user the reason in one sentence; do not start the work'
      : prepare.length > 0
        ? `run ${prepare.map((p) => p.tool).join(', ')} now (each as given)${ask === null ? ', then start the work' : ', then ask the one question'}`
        : ask !== null
          ? 'ask the user the one question (prose or ask_user), then continue'
          : 'ready: start the work';
  return {
    ready,
    worker: w === null ? null : { id: w.id, name: w.name },
    checks,
    prepare,
    ask,
    blocked,
    next,
  };
}
