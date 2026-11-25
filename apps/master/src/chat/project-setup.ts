import {
  effectiveRepoEgress,
  type RepoEgressMode,
  RepoEgressPreset,
  type RuntimeKind,
} from '@remyral/protocol';
import { authorize, type Subject } from '../authz/model.js';
import { type PreviewDeps, previewPlacement } from '../composer/preview.js';
import type { Queryable } from '../db/pool.js';
import type { RepositoryState } from '../gitflow/service.js';
import { HttpError } from '../http/errors.js';
import type { RepoEgressService } from '../repo-egress/service.js';
import type { PreferredWorkersService } from '../worker-config/preferred.js';
import type { ProjectWorkerView, WorkerConfigService } from '../worker-config/service.js';
import { egressEntryProblem, normaliseEgressEntry } from '../workflows/egress.js';
import { adminCard, type ReadResult } from './admin-actions.js';
import type { OpsApplyContext } from './ops-tools.js';
import type { DraftPlan } from './settings-actions.js';

/**
 * p18-project-bootstrap Part B (docs/design/p18-project-bootstrap.md §4): the assistant sets up — or asks about — a new
 * project's repository, network and machines before its first job: a closed network or unconnected machines are
 * either fixed in the same flow or asked about interactively, never left for the person to discover.
 *
 * - `describe_project_readiness` (read, viewer+ of the project: `projects.workers.read`): the repository state (incl.
 *   empty), the network access in force and whether an admin decided it, every enrolled machine with whether it can run
 *   the project's jobs and why not (the composer's placement preview — the same facts dispatch uses), the runtimes per
 *   machine, the holds and what is missing.
 * - `draft_project_network` → op `project.network` (Projeler → Politika → Ağ erişimi, `projects.egress.write`, the
 *   console's always-fresh class, event projects.policy). Opening access is a card unless the user explicitly asked
 *   (`cardDefault`), like loosening a budget.
 * - `draft_project_machines` → op `project.machines` (Projeler → Makineler, `projects.workers.write`, event
 *   machines.config): assignment changes (add / remove, applied to the assignment AT CONFIRMATION — nobody else's
 *   change is reverted) and the project's preferred machines (the minimal project-level placement default, §5).
 *
 * Both are administration cards (`settings_change`, target "admin") run by ChatOpsTools.apply → {@link apply} through
 * the console's services (their validation and audit), inside ChatAdmin.run's re-authorization and `source: chat`.
 */

export interface ChatProjectSetupDeps {
  readonly db: Queryable;
  /** The composer's placement preview facts (the same as dispatch); null: machines are not evaluated. */
  readonly preview: () => PreviewDeps | null;
  /** GitFlowService.repositoryState (provider call); null: unavailable. */
  readonly repoState: () => ((project: string) => Promise<RepositoryState | null>) | null;
  readonly egress: () => RepoEgressService | null;
  readonly workers: () => WorkerConfigService | null;
  readonly preferred: () => PreferredWorkersService | null;
}

type Fail = Extract<DraftPlan, { ok: false }>;

function fail(code: Fail['code'], message: string): Fail {
  return {
    ok: false,
    code,
    message: code === 'forbidden' ? `The signed-in user is not allowed to ${message}.` : message,
  };
}

function can(subject: Subject, action: string, project: string): 'allow' | 'role' | 'hidden' {
  const d = authorize(subject, action, { project });
  if (d.allow) return 'allow';
  return d.reason === 'not_visible' ? 'hidden' : 'role';
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** What a project still needs (the plan continuation and rule 56 act on the first three). */
export type ReadinessGap = 'repository' | 'network' | 'machines' | 'holds';

export interface MachineReadiness {
  readonly id: string;
  readonly name: string;
  readonly os: string | null;
  readonly arch: string | null;
  readonly online: boolean;
  /** Panel-managed (its configuration assigns projects) — only such machines can be assigned here. */
  readonly managed: boolean;
  readonly assigned: boolean;
  readonly preferred: boolean;
  /** `now`: could take a job now; `later`: once free / online; `no`: not as configured (see `why`). */
  readonly canRun: 'now' | 'later' | 'no';
  /** Only "not assigned" keeps it from running the project's jobs: assigning it would make it able to. */
  readonly assignable: boolean;
  readonly runtimes: readonly string[];
  readonly why: readonly { readonly code: string; readonly message: string }[];
}

export interface ProjectReadiness {
  readonly project: string;
  readonly name: string;
  readonly kind: 'repository' | 'workspace';
  readonly repository:
    | { readonly linked: false }
    | ({ readonly linked: true } & Omit<RepositoryState, 'detail'> & { readonly detail?: string })
    | null;
  readonly network: {
    readonly mode: string;
    readonly presets: readonly string[];
    readonly hosts: readonly string[];
    readonly decided: boolean;
    readonly setting: string;
    readonly unsupportedMachines: readonly string[];
  };
  readonly runtime: string | null;
  readonly machines: readonly MachineReadiness[];
  readonly holds: readonly { readonly code: string; readonly message: string }[];
  readonly missing: readonly ReadinessGap[];
}

const NETWORK_RANK: Readonly<Record<string, number>> = { none: 0, allowlist: 1, web: 2 };

/**
 * Whether a network change opens access (more reachable than before): a wider mode, or new presets / hosts while the
 * allowlist stays. Such a change is a card unless the user explicitly asked for it.
 */
export function networkOpens(
  prev: { readonly mode: string; readonly presets: readonly string[]; readonly hosts: readonly string[] },
  next: { readonly mode: string; readonly presets: readonly string[]; readonly hosts: readonly string[] },
): boolean {
  const a = NETWORK_RANK[prev.mode] ?? 0;
  const b = NETWORK_RANK[next.mode] ?? 0;
  if (b !== a) return b > a;
  if (next.mode !== 'allowlist') return false;
  return (
    next.presets.some((p) => !prev.presets.includes(p)) || next.hosts.some((h) => !prev.hosts.includes(h))
  );
}

export class ChatProjectSetup {
  constructor(private readonly deps: ChatProjectSetupDeps) {}

  /**
   * p18-project-bootstrap: the repair hint of a job that failed because its base branch was missing (describe_job's
   * `repairHint`) — null when the job's transitions carry no such failure. Words for the model (English), with the
   * repository's state now and the machines that start empty repositories (`workspace-empty-repo-v1`).
   */
  async baseRefRepairHint(jobId: string, project: string): Promise<string | null> {
    const { rows } = await this.deps.db.query<{ reason: string }>(
      `SELECT reason FROM job_transitions
        WHERE job_id = $1 AND reason LIKE '%base ref "%" was not found in the repository%'
        ORDER BY id DESC LIMIT 1`,
      [jobId],
    );
    const reason = rows[0]?.reason;
    if (reason === undefined) return null;
    const ref = /base ref "([^"\n]{1,255})"/.exec(reason)?.[1] ?? '';
    if (/\(the repository is empty/.test(reason))
      return `The repository is empty (no "${ref}" branch yet) and this kind of job (an integration or pull request job) cannot start one: run an ordinary job of the project first — it creates the base branch's empty first commit — then retry this one.`;
    const lookup = this.deps.repoState();
    const state = lookup === null ? null : await lookup(project).catch(() => null);
    if (state?.state === 'empty') {
      const { rows: ready } = await this.deps.db.query<{ display_name: string }>(
        `SELECT display_name FROM workers
          WHERE features ? 'workspace-empty-repo-v1' AND approved_at IS NOT NULL AND revoked_at IS NULL
            AND archived_at IS NULL ORDER BY display_name LIMIT 10`,
      );
      return `The repository is EMPTY (no branch yet). The machine that ran the job has an older Remyral that cannot start an empty repository; newer machines (worker feature workspace-empty-repo-v1${
        ready.length === 0 ? ': none yet' : `: ${ready.map((r) => r.display_name).join(', ')}`
      }) create the base branch's empty first commit themselves and the job's work arrives as a pull request. Update the machine (worker_release_status / manage_release) or run the job on such a machine, then retry it (draft_job_action retry). Only if no machine can be updated, the user can push a first commit to "${ref}" themselves.`;
    }
    if (state?.state === 'ready')
      return `The branch "${ref}" is not in the repository, but the project's base branch ${state.baseBranch} exists: retry the job from ${state.baseBranch} (draft_job baseRef) or ask the user which existing branch to use.`;
    return `The branch "${ref}" does not exist in the repository${
      state?.state === 'base_missing' ? ` and neither does the project's base branch ${state.baseBranch}` : ''
    }: ask the user which existing branch to use and change the project's base branch (Projeler → proje → Repo) or the job's baseRef. Never create or force-push branches yourself.`;
  }

  /** `describe_project_readiness` for the user who sent the turn. */
  async readiness(subject: Subject, i: Record<string, unknown>): Promise<ReadResult> {
    const project = typeof i.project === 'string' ? i.project : '';
    const c = can(subject, 'projects.workers.read', project);
    if (c === 'hidden') return { ok: false, code: 'not_found', message: 'Project not found.' };
    if (c === 'role')
      return { ok: false, code: 'forbidden', message: 'Reading this project’s setup is not allowed.' };
    const r = await this.evaluate(project, { provider: true });
    if (r === null) return { ok: false, code: 'not_found', message: 'Project not found.' };
    return { ok: true, data: { ...r, suggestions: suggestions(r) } };
  }

  /**
   * The readiness of `project` (null: no such project). `provider: false` skips the repository provider call (the
   * plan continuation's cheap check: linked or not only).
   */
  async evaluate(project: string, opts: { readonly provider: boolean }): Promise<ProjectReadiness | null> {
    const { rows } = await this.deps.db.query<{
      name: string;
      kind: string;
      host_execution: boolean;
      repository_url: string | null;
      base_branch: string | null;
      provider: string | null;
      ws_egress: string | null;
      ws_hosts: string[] | null;
    }>(
      `SELECT p.name, p.kind, p.host_execution, g.repository_url, g.base_branch, g.provider,
              w.egress AS ws_egress, w.allow_hosts AS ws_hosts
         FROM projects p LEFT JOIN project_git_configs g ON g.project = p.id
         LEFT JOIN project_workspaces w ON w.project = p.id
        WHERE p.id = $1`,
      [project],
    );
    const p = rows[0];
    if (p === undefined) return null;
    const kind = p.kind === 'workspace' ? 'workspace' : 'repository';

    // Repository.
    let repository: ProjectReadiness['repository'] = null;
    if (kind === 'repository') {
      if (p.repository_url === null) repository = { linked: false };
      else {
        const lookup = opts.provider ? this.deps.repoState() : null;
        const state =
          lookup === null
            ? null
            : await lookup(project).catch((err: unknown): RepositoryState => ({
                provider: p.provider ?? '',
                repositoryUrl: p.repository_url ?? '',
                baseBranch: p.base_branch ?? '',
                state: 'unknown',
                detail: err instanceof Error ? clip(err.message, 200) : 'error',
              }));
        repository = {
          linked: true,
          provider: state?.provider ?? p.provider ?? '',
          repositoryUrl: state?.repositoryUrl ?? p.repository_url,
          baseBranch: state?.baseBranch ?? p.base_branch ?? '',
          state: state?.state ?? 'unknown',
          ...(state?.detail === undefined ? {} : { detail: state.detail }),
        };
      }
    }

    // Network.
    let network: ProjectReadiness['network'];
    if (kind === 'workspace') {
      network = {
        mode: p.ws_egress ?? 'none',
        presets: [],
        hosts: p.ws_hosts ?? [],
        decided: true,
        setting: `Projects → ${project} → Workspace`,
        unsupportedMachines: [],
      };
    } else {
      const svc = this.deps.egress();
      const view = svc === null ? null : await svc.get(project);
      network = {
        mode: view?.mode ?? 'none',
        presets: view?.presets ?? [],
        hosts: view?.hosts ?? [],
        decided: view?.updatedAt != null,
        setting: `Projects → ${project} → Policy → Network access`,
        unsupportedMachines: (view?.unsupportedWorkers ?? []).map((w) => w.name),
      };
    }

    // Machines: the placement preview (the same facts dispatch uses), the assignment and the preferred machines.
    const assignment = new Map<string, ProjectWorkerView>();
    const workerSvc = this.deps.workers();
    if (workerSvc !== null) {
      for (const w of await workerSvc.projectWorkers(project).catch(() => [])) assignment.set(w.workerId, w);
    }
    const preferred = new Set(
      (await this.deps
        .preferred()
        ?.forProject(project)
        .catch(() => [])) ?? ([] as readonly string[]),
    );
    const previewDeps = this.deps.preview();
    let runtime: string | null = null;
    let holds: { code: string; message: string }[] = [];
    const machines: MachineReadiness[] = [];
    if (previewDeps !== null) {
      const all = await previewPlacement(previewDeps, { project });
      runtime =
        all.routing.runtime ??
        all.runtimes.find((r) => r.eligible.length > 0)?.runtime ??
        all.runtimes.find((r) => r.feasible.length > 0)?.runtime ??
        all.runtimes[0]?.runtime ??
        null;
      // A host-execution project's jobs default to a host profile: evaluate both and keep each machine's best.
      const profiles = p.host_execution
        ? (['container', 'host-restricted'] as const)
        : (['container'] as const);
      const details =
        runtime === null
          ? []
          : await Promise.all(
              profiles.map((sandboxProfile) =>
                previewPlacement(previewDeps, {
                  project,
                  runtime: runtime as RuntimeKind,
                  sandboxProfile,
                  sourceTrust: 'trusted',
                }),
              ),
            );
      const first = details[0]?.placement ?? null;
      holds = (first?.holds ?? []).map((h) => ({ code: h.code, message: clip(h.message, 300) }));
      for (const w of all.workers) {
        let best: {
          canRun: 'now' | 'later' | 'no';
          why: { code: string; message: string; permanent: boolean }[];
        } = {
          canRun: 'no',
          why: [{ code: 'not_evaluated', message: 'no runtime to evaluate', permanent: true }],
        };
        for (const d of details) {
          const pl = d.placement;
          if (pl === null) continue;
          const reasons = pl.rejected.find((r) => r.workerId === w.id)?.reasons ?? [];
          const candidate = pl.candidates.some((x) => x.workerId === w.id);
          const canRun: 'now' | 'later' | 'no' = candidate
            ? 'now'
            : reasons.length > 0 && reasons.every((r) => !r.permanent)
              ? 'later'
              : reasons.length === 0
                ? 'later'
                : 'no';
          const rank = { now: 2, later: 1, no: 0 } as const;
          if (
            rank[canRun] > rank[best.canRun] ||
            (canRun === best.canRun && reasons.length < best.why.length)
          )
            best = {
              canRun,
              why: reasons.map((r) => ({
                code: r.code,
                message: clip(r.message, 240),
                permanent: r.permanent,
              })),
            };
        }
        const a = assignment.get(w.id);
        const permanent = best.why.filter((r) => r.permanent);
        machines.push({
          id: w.id,
          name: w.name,
          os: w.os,
          arch: w.arch,
          online: w.connected,
          managed: a?.managed ?? false,
          assigned: a?.assigned ?? false,
          preferred: preferred.has(w.id),
          canRun: best.canRun,
          assignable:
            best.canRun === 'no' &&
            permanent.length > 0 &&
            permanent.every(
              (r) => r.code === 'project_not_assigned' || r.code === 'project_not_in_worker_allowlist',
            ),
          runtimes: all.runtimes.filter((r) => r.feasible.includes(w.id)).map((r) => r.runtime),
          why: best.why.slice(0, 4).map((r) => ({ code: r.code, message: r.message })),
        });
      }
    }

    const missing: ReadinessGap[] = [];
    if (
      kind === 'repository' &&
      (repository === null || !repository.linked || repository.state === 'base_missing')
    )
      missing.push('repository');
    if (!network.decided) missing.push('network');
    if (previewDeps !== null && !machines.some((m) => m.canRun !== 'no')) missing.push('machines');
    if (holds.length > 0) missing.push('holds');
    return {
      project,
      name: p.name,
      kind,
      repository,
      network,
      runtime,
      machines,
      holds,
      missing,
    };
  }

  // ------------------------------------------------------------------------------------------- plans (cards)

  async plan(subject: Subject, tool: string, i: Record<string, unknown>): Promise<DraftPlan> {
    if (tool === 'draft_project_network') return this.#planNetwork(subject, i);
    if (tool === 'draft_project_machines') return this.#planMachines(subject, i);
    return fail('invalid', `${tool} is not a project setup change.`);
  }

  async #planNetwork(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const project = typeof i.project === 'string' ? i.project : '';
    const c = can(subject, 'projects.egress.write', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'change the network access of this project (project admins)');
    const svc = this.deps.egress();
    if (svc === null) return fail('unavailable', 'Network access settings are not available.');
    let view;
    try {
      view = await svc.get(project);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return fail('not_found', 'Project not found.');
      throw err;
    }
    if (view.kind !== 'repository')
      return fail(
        'invalid',
        'This is a workspace project: its network access is set on its Workspace tab (Projeler → proje → Çalışma alanı).',
      );
    const mode: RepoEgressMode = i.mode === 'allowlist' || i.mode === 'web' ? i.mode : 'none';
    const presets =
      mode === 'allowlist'
        ? RepoEgressPreset.options.filter((x) => strings(i.presets).includes(x))
        : ([] as RepoEgressPreset[]);
    const hostsIn = mode === 'allowlist' ? strings(i.hosts) : [];
    const hosts = [...new Set(hostsIn.map(normaliseEgressEntry))].sort();
    for (const h of hosts) {
      const problem = egressEntryProblem(h);
      if (problem !== null)
        return fail(
          'invalid',
          `${h}: not a public host name (${problem}); LAN, private, loopback and metadata addresses are never allowed.`,
        );
    }
    if (mode === 'allowlist' && presets.length === 0 && hosts.length === 0)
      return fail('invalid', 'An allowlist needs at least one preset or host (or use mode none).');
    const prev = { mode: view.mode, presets: [...view.presets], hosts: [...view.hosts] };
    const next = { mode, presets: [...presets], hosts };
    const same =
      prev.mode === next.mode &&
      prev.presets.join(',') === next.presets.join(',') &&
      [...prev.hosts].sort().join(',') === next.hosts.join(',');
    if (same && view.updatedAt !== null)
      return fail('invalid', 'Nothing to change: this is the setting in force.');
    const opens = networkOpens(prev, next);
    const effective = effectiveRepoEgress(mode, presets, hosts);
    return adminCard(
      'project.network',
      `Network access of ${project}: ${mode}`,
      { project, mode, presets, hosts, previous: prev },
      {
        project,
        from: prev,
        to: next,
        reach:
          mode === 'none'
            ? 'model APIs only'
            : mode === 'web'
              ? 'any public host on port 443'
              : `${String(effective.hosts.length)} host(s) on top of the model APIs`,
        ...(opens ? { opens: 'This change OPENS network access for the project’s jobs.' } : {}),
        ...(view.unsupportedWorkers.length === 0
          ? {}
          : {
              olderMachines: `${view.unsupportedWorkers.map((w) => w.name).join(', ')} keep model APIs only (older Remyral).`,
            }),
        link: `/projects/${encodeURIComponent(project)}?tab=policy`,
      },
      project,
      { cardDefault: opens },
    );
  }

  async #planMachines(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const project = typeof i.project === 'string' ? i.project : '';
    const c = can(subject, 'projects.workers.write', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'choose the machines of this project (project admins)');
    const svc = this.deps.workers();
    if (svc === null) return fail('unavailable', 'Machine assignment is not available.');
    let list: ProjectWorkerView[];
    try {
      list = await svc.projectWorkers(project);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return fail('not_found', 'Project not found.');
      throw err;
    }
    const byId = new Map(list.map((w) => [w.workerId, w]));
    const add = [...new Set(strings(i.add))];
    const remove = [...new Set(strings(i.remove))];
    const preferredIn = i.preferred === undefined ? null : [...new Set(strings(i.preferred))].sort();
    const unknown = [...add, ...remove, ...(preferredIn ?? [])].filter((id) => !byId.has(id));
    if (unknown.length > 0)
      return fail(
        'invalid',
        `Unknown machine id(s): ${unknown.slice(0, 5).join(', ')}. Machines: ${list
          .slice(0, 20)
          .map((w) => `${w.workerId} (${w.displayName})`)
          .join(', ')}.`,
      );
    if (add.some((id) => remove.includes(id)))
      return fail('invalid', 'A machine cannot be both added and removed.');
    const toAdd = add.filter((id) => byId.get(id)?.assigned !== true);
    const toRemove = remove.filter((id) => byId.get(id)?.assigned === true);
    const preferredSvc = this.deps.preferred();
    const prevPreferred = preferredSvc === null ? [] : [...(await preferredSvc.forProject(project))].sort();
    if (preferredIn !== null && preferredSvc === null)
      return fail('unavailable', 'Preferred machines are not available.');
    const preferredChanges = preferredIn !== null && preferredIn.join(',') !== prevPreferred.join(',');
    if (toAdd.length === 0 && toRemove.length === 0 && !preferredChanges)
      return fail('invalid', 'Nothing to change: the machines are already set like that.');
    if (toAdd.length > 0) {
      const { rows } = await this.deps.db.query<{ kind: string; repository_url: string | null }>(
        `SELECT p.kind, g.repository_url FROM projects p LEFT JOIN project_git_configs g ON g.project = p.id
          WHERE p.id = $1`,
        [project],
      );
      if (rows[0]?.kind !== 'workspace' && rows[0]?.repository_url == null)
        return fail(
          'invalid',
          `Project ${project} has no linked repository yet: link it first (machines only check out registered repositories).`,
        );
    }
    const name = (id: string): string => byId.get(id)?.displayName ?? id;
    return adminCard(
      'project.machines',
      `Machines of ${project}`,
      {
        project,
        add: toAdd,
        remove: toRemove,
        ...(preferredChanges ? { preferred: preferredIn, previousPreferred: prevPreferred } : {}),
        names: Object.fromEntries(
          [...toAdd, ...toRemove, ...(preferredIn ?? [])].map((id) => [id, name(id)]),
        ),
      },
      {
        project,
        ...(toAdd.length === 0 ? {} : { assign: toAdd.map(name) }),
        ...(toRemove.length === 0 ? {} : { unassign: toRemove.map(name) }),
        ...(preferredChanges
          ? {
              preferred: preferredIn.map(name),
              preferredNote:
                'Preferred machines: every job of the project prefers them; another eligible machine still runs a job when they cannot.',
            }
          : {}),
        ...(toAdd.some((id) => byId.get(id)?.connected !== true)
          ? { offline: 'Some machines are offline: they apply the change when they connect.' }
          : {}),
        link: `/projects/${encodeURIComponent(project)}?tab=machines`,
      },
      project,
    );
  }

  // --------------------------------------------------------------------------------------------- run (card)

  /** Runs a confirmed card (ChatAdmin.run re-checked the op's action for the confirming user in the project). */
  async apply(
    op: 'project.network' | 'project.machines',
    p: Record<string, unknown>,
    ctx: OpsApplyContext,
  ): Promise<Record<string, unknown>> {
    const project = String(p.project);
    const unavailable = (what: string): HttpError =>
      new HttpError(503, 'unavailable', `${what} is not available.`, {}, {}, { reason: 'admin' });
    if (op === 'project.network') {
      const svc = this.deps.egress();
      if (svc === null) throw unavailable('Network access settings');
      const view = await svc.set({ userId: ctx.actor.userId }, project, {
        mode: p.mode === 'allowlist' || p.mode === 'web' ? p.mode : 'none',
        presets: RepoEgressPreset.options.filter((x) => strings(p.presets).includes(x)),
        hosts: strings(p.hosts),
      });
      return {
        project,
        mode: view.mode,
        presets: view.presets,
        hosts: view.hosts,
        link: `/projects/${encodeURIComponent(project)}?tab=policy`,
      };
    }
    const actor = { userId: ctx.actor.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent };
    const out: Record<string, unknown> = { project };
    const add = strings(p.add);
    const remove = strings(p.remove);
    if (add.length > 0 || remove.length > 0) {
      const svc = this.deps.workers();
      if (svc === null) throw unavailable('Machine assignment');
      // Applied to the assignment as it is NOW (a change made since the card was drafted is kept).
      const current = (await svc.projectWorkers(project)).filter((w) => w.assigned).map((w) => w.workerId);
      const wanted = [...new Set([...current.filter((id) => !remove.includes(id)), ...add])];
      const after = await svc.setProjectWorkers(project, { workerIds: wanted }, actor);
      out.assigned = after.filter((w) => w.assigned).map((w) => w.displayName);
    }
    if (Array.isArray(p.preferred)) {
      const svc = this.deps.preferred();
      if (svc === null) throw unavailable('Preferred machines');
      const view = await svc.set(project, { workerIds: strings(p.preferred) }, actor);
      out.preferred = view.workerIds;
    }
    out.link = `/projects/${encodeURIComponent(project)}?tab=machines`;
    return out;
  }
}

/** Concrete next steps for what is missing (the assistant turns them into one question with a recommended option). */
function suggestions(r: ProjectReadiness): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.repository !== null && r.repository.linked && r.repository.state === 'empty')
    out.repository =
      'Empty repository: the first job creates the base branch with an empty first commit (machines on the newest Remyral); its work then arrives as a pull request.';
  if (r.repository !== null && r.repository.linked && r.repository.state === 'base_missing')
    out.repository = `The base branch ${r.repository.baseBranch} does not exist in this (non-empty) repository: choose an existing branch as the project's base branch.`;
  if (r.repository !== null && !r.repository.linked)
    out.repository = 'Link a repository first (draft_project_create repository / Projects → Repository).';
  if (r.missing.includes('network'))
    out.network =
      'Network access was never decided. Propose draft_project_network mode allowlist with the presets the repository needs (npm / pypi / crates / go / maven; github or gitlab for dependencies from git) and the hosts the user named; keep none when the work needs no network. Ask first.';
  const assignable = r.machines.filter((m) => m.assignable);
  if (r.missing.includes('machines') && assignable.length > 0)
    out.machines = `No machine can run this project's jobs yet. Assignable now: ${assignable
      .map((m) => `${m.name} (${m.id}, ${m.os ?? '?'}${m.online ? '' : ', offline'})`)
      .join(
        '; ',
      )}. Propose draft_project_machines add with the online ones (Linux first for repository work) and, when the user wants a default, preferred. Ask first.`;
  else if (r.missing.includes('machines'))
    out.machines =
      'No machine can run this project’s jobs and none is only missing the assignment: read each machine’s why (runtime login, sandbox, OS) and tell the user what to fix.';
  return out;
}
