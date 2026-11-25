import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  compareVersions,
  type CustomToolInstall,
  type CustomToolRecipe,
  customPackagePrompt,
  MachineAdminReport,
  MCP_STDIO_FEATURE,
  type McpLockfile,
  type McpPackageManager,
  type NpmScriptApproval,
  type OpsOperation,
  type SignedMcpSpec,
  RemoteOpsReport,
  type RuntimeInstallReport,
  RuntimeKind,
  type RuntimeVerifyReport,
  ToolInventoryReport,
  type UnverifiedRuntimeSource,
  toolPlatform,
  ToolRecipeId,
  type VersionCatalog,
  type ToolPlatform,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { MachineAdminService } from '../machine-admin/service.js';
import type { NotificationDraft } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { Queryable } from '../db/pool.js';
import type { RemoteOpsService } from '../remote-ops/service.js';
import type { ActorContext } from '../workers/fleet.js';
import { CATALOG } from './catalog.js';
import type { VersionFeedService } from './feed.js';
import {
  type ActionKind,
  buildCatalog,
  buildMachine,
  type CatalogView,
  type MachineInput,
  type MatrixMachine,
  type MatrixPolicy,
  type Summary,
  summarize,
} from './matrix.js';
import type { CustomRecipeStore } from './recipes.js';
import { RuntimeReleases, type RuntimeCandidate } from './releases.js';
import type { CandidateView, RuntimeVerificationService } from './verification.js';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md §3–§5, ADR-0052): the fleet matrix, bulk actions and the weekly
 * update digest.
 *
 * A bulk action fans out into one target per machine. Every target goes through the path a single-machine change
 * takes — never a weaker one:
 *  - release recipe installs / removes and runtime installs → `RemoteOpsService.request` (signed OPS_COMMAND; the worker
 *    re-checks its pinned set and recipes; rate limits apply per machine and per admin);
 *  - Linux distribution recipes and custom package installs → `MachineAdminService.createTask` (a machine-admin job:
 *    owner opt-in per machine, every elevated command approved unless full access is allowed);
 *  - custom downloads → OPS_COMMAND `tool.install.custom` (worker-enforced: owner opt-in + local ceiling + allowlist +
 *    checksum).
 * The route checked the admin's role and step-up (always-fresh for machine administration) when the action was
 * created; when a target is dispatched later (its machine was offline) the creator must still be an enabled owner /
 * admin, and the action must not have expired (≤ 7 days; machine administration ≤ 24 h).
 *
 * Rollout `canary-first`: the targets on canary machines (worker_runtime_policies.canary) run first; the others wait
 * (`held`) until an admin continues after the canaries succeeded — the same staging as the runtime policy.
 */

/**
 * p14-mcp-stdio (ADR-0054 P4): installing / removing a local MCP server version is a bulk action of its own kinds
 * through the same pipeline (targets, canary-first, retries, expiry, the creator's role re-checked at dispatch). Only
 * the MCP routes create, continue and retry them (admin + always-fresh step-up, ADR-0054 decision 2).
 */
export type FleetActionKind = ActionKind | 'mcp.install' | 'mcp.remove';
export const MCP_ACTION_KINDS: ReadonlySet<FleetActionKind> = new Set(['mcp.install', 'mcp.remove']);

/** What an MCP action installs: the signed spec (public; the worker verifies it with its own keys). */
export interface McpActionRecipe {
  readonly serverId: string;
  readonly version: string;
  readonly specSha256: string;
  readonly manager: McpPackageManager;
  readonly signed: SignedMcpSpec;
}

export interface NewMcpAction {
  readonly kind: 'mcp.install' | 'mcp.remove';
  readonly recipe: McpActionRecipe;
  readonly workers: readonly string[] | 'all';
  readonly rollout?: 'all' | 'canary-first' | undefined;
  /** A lockfile for this version is stored already (installs then may roll out to all at once). */
  readonly lockStored: boolean;
}

export interface NewAction {
  readonly kind: ActionKind;
  readonly item: string;
  readonly version?: string | undefined;
  /**
   * p16-runtime-updates: `runtime.install` of a version outside the machines' pinned sets (the feed's latest when no
   * version is named), labelled unverified — only while the security policy allows it.
   */
  readonly unverified?: boolean | undefined;
  readonly workers: readonly string[] | 'all';
  readonly rollout?: 'all' | 'canary-first' | undefined;
  readonly expiresInHours?: number | undefined;
  readonly approvalPolicy?: 'ask-all' | 'allow-all' | undefined;
  /**
   * p17-update-channel (owner upgrade, owner-only route): the owner's explicit choice of an exact upstream version —
   * not subject to the `fleet.unverifiedRuntimeUpdates` switch (the install is still labelled unverified).
   */
  readonly ownerUpgrade?: boolean | undefined;
  /** p17-update-channel (owner upgrade of a tool): the published assets of a version outside the recipes. */
  readonly toolSource?: OwnerToolSource | undefined;
}

/** p17-update-channel: per platform the template URL and the upstream's published SHA-256 and size. */
export interface OwnerToolSource {
  readonly build?: string | undefined;
  readonly assets: Readonly<Partial<Record<ToolPlatform, { url: string; sha256: string; size: number }>>>;
}

export type TargetState =
  'queued' | 'held' | 'sent' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'expired' | 'cancelled';

const OPEN_TARGET = new Set<TargetState>(['queued', 'held', 'sent', 'running']);
const IN_FLIGHT = new Set<TargetState>(['sent', 'running']);

export interface ActionTargetView {
  readonly workerId: string;
  readonly name: string;
  readonly phase: 1 | 2;
  readonly state: TargetState;
  readonly version: string | null;
  readonly attempts: number;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly opId: string | null;
  readonly jobId: string | null;
  readonly updatedAt: string;
}

export interface ActionView {
  readonly id: string;
  readonly kind: FleetActionKind;
  readonly item: string;
  readonly version: string | null;
  readonly rollout: 'all' | 'canary-first';
  readonly state: 'running' | 'held' | 'done' | 'cancelled';
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly counts: Partial<Record<TargetState, number>>;
  readonly targets: ActionTargetView[];
}

export interface FleetToolsView {
  readonly generatedAt: string;
  readonly feed: { readonly enabled: boolean; readonly checkedAt: string | null };
  readonly catalog: CatalogView[];
  readonly machines: MatrixMachine[];
  readonly summary: Summary;
  /** p16-runtime-updates: the security policy's fleet switch as the matrix applied it. */
  readonly policy: MatrixPolicy;
  /** p16-runtime-updates: resolved runtime versions outside the pins and their verification (newest first). */
  readonly candidates: readonly CandidateView[];
}

/** p16-runtime-updates: the recipe column of a `runtime.install` action with unverified targets. */
interface UnverifiedRecipe {
  readonly unverified: Readonly<Record<string, Omit<UnverifiedRuntimeSource, 'lock'>>>;
}

function unverifiedRecipe(raw: unknown): UnverifiedRecipe | null {
  if (raw === null || typeof raw !== 'object') return null;
  const u = (raw as { unverified?: unknown }).unverified;
  return u !== null && typeof u === 'object' ? (raw as UnverifiedRecipe) : null;
}

export const ADMIN_KINDS: ReadonlySet<ActionKind> = new Set([
  'tool.elevated',
  'custom.install',
  'custom.remove',
]);
const MAX_TARGETS = 200;
const MAX_EXPIRY_H = 168;
const MAX_ADMIN_EXPIRY_H = 24;
const TICK_MS = 15_000;
const MAX_ATTEMPTS = 10;
/** Codes of a remote-op refusal that mean "try again when the machine is back", not "failed". */
const REQUEUE = new Set(['worker_offline', 'rate_limited']);

interface WorkerRow {
  id: string;
  display_name: string;
  state: string;
  os: string | null;
  arch: string | null;
  features: unknown;
  tool_inventory: unknown;
  tool_inventory_at: Date | null;
  remote_ops: unknown;
  machine_admin: unknown;
  policy: string | null;
  canary: boolean | null;
}

interface ActionRow {
  id: string;
  kind: FleetActionKind;
  item: string;
  version: string | null;
  recipe: unknown;
  rollout: 'all' | 'canary-first';
  approval_policy: 'ask-all' | 'allow-all' | null;
  state: ActionView['state'];
  created_by: string | null;
  created_ip: string | null;
  created_at: Date;
  expires_at: Date;
  finished_at: Date | null;
}

interface TargetRow {
  action_id: string;
  worker_id: string;
  name: string;
  phase: 1 | 2;
  state: TargetState;
  version: string | null;
  attempts: number;
  reason: string | null;
  detail: string | null;
  op_id: string | null;
  job_id: string | null;
  updated_at: Date;
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

export interface FleetToolsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly feed: VersionFeedService;
  readonly recipes: CustomRecipeStore;
  readonly remoteOps: () => RemoteOpsService | null;
  readonly machineAdmin: () => MachineAdminService | null;
  readonly connected: (workerId: string) => boolean;
  /** p14-mcp-stdio: the stored lockfile of a server version (null: none yet — the canary makes it). */
  readonly mcpLock?: (serverId: string, version: string) => Promise<McpLockfile | null>;
  /**
   * p19-install-scripts (ADR-0068): the active install script approvals an `mcp.install` carries to this machine — null
   * when it does not advertise `mcp-install-scripts-v1` (it keeps refusing packages with install scripts).
   */
  readonly mcpInstallScripts?: (workerId: string) => Promise<readonly NpmScriptApproval[] | null>;
  /**
   * p16-runtime-updates: the security policy's fleet switches (read per view and per dispatch). Absent: unverified
   * updates are off (the conservative default; compose always passes the policy).
   */
  readonly policy?: () => Promise<MatrixPolicy>;
  /** p16-runtime-updates: resolves and stores runtime releases outside the pins. Absent: none can be installed. */
  readonly releases?: RuntimeReleases;
  /** p16-runtime-updates: the automatic verification (candidates in the view, results of `runtime.verify`). */
  readonly verification?: () => RuntimeVerificationService | null;
  /** p17-update-channel: the master's newest accepted version catalog (null / absent: none). */
  readonly versionCatalog?: () => VersionCatalog | null;
  /** The notification service (weekly digest); null before it exists. */
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
}

export class FleetToolsService {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });
  #lastTick = 0;
  #ticking: Promise<void> | null = null;

  constructor(private readonly d: FleetToolsDeps) {}

  // ------------------------------------------------------------------------------------------ matrix

  async #machines(only?: string): Promise<MachineInput[]> {
    const { rows } = await this.d.pool.query<WorkerRow>(
      `SELECT w.id, w.display_name, w.state, w.facts->>'os' AS os, w.facts->>'arch' AS arch, w.features,
              w.tool_inventory, w.tool_inventory_at, w.remote_ops, w.machine_admin, p.policy, p.canary
         FROM workers w LEFT JOIN worker_runtime_policies p ON p.worker_id = w.id
        WHERE w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL
          AND ($1::text IS NULL OR w.id = $1)
        ORDER BY w.display_name, w.id`,
      [only ?? null],
    );
    const ids = rows.map((r) => r.id);
    const rt =
      ids.length === 0
        ? []
        : (
            await this.d.pool.query<{
              worker_id: string;
              runtime: string;
              version: string;
              installed: boolean;
              pinned_version: string | null;
              last_reported_at: Date;
            }>(
              `SELECT worker_id, runtime, version, installed, pinned_version, last_reported_at FROM worker_runtimes
                WHERE worker_id = ANY($1) AND present ORDER BY last_reported_at DESC`,
              [ids],
            )
          ).rows;
    return rows.map((w) => {
      const inv = ToolInventoryReport.safeParse(w.tool_inventory);
      const ops = RemoteOpsReport.safeParse(w.remote_ops);
      const ma = MachineAdminReport.safeParse(w.machine_admin);
      return {
        workerId: w.id,
        name: w.display_name,
        os: w.os ?? '',
        arch: w.arch ?? '',
        state: w.state,
        connected: this.d.connected(w.id),
        features: strings(w.features),
        inventory: inv.success ? inv.data : null,
        inventoryAt: w.tool_inventory_at?.toISOString() ?? null,
        remoteOps: ops.success ? ops.data.runtimes : null,
        runtimes: rt
          .filter((r) => r.worker_id === w.id)
          .map((r) => ({
            runtime: r.runtime,
            version: r.version,
            installed: r.installed,
            pinned: r.pinned_version,
          })),
        machineAdminEnabled: ma.success && ma.data.enabled,
        canary: w.canary === true,
        policy: w.policy,
      };
    });
  }

  async #customRecipes(): Promise<CustomToolRecipe[]> {
    return (await this.d.recipes.list()).map((r) => r.recipe);
  }

  /** p16-runtime-updates: the policy's fleet switches (off when unknown). */
  async #policy(): Promise<MatrixPolicy> {
    if (this.d.policy === undefined) return { unverifiedRuntimeUpdates: false };
    return this.d.policy().catch((err: unknown) => {
      this.d.log.warn({ err }, 'security policy unreadable; unverified runtime updates treated as off');
      return { unverifiedRuntimeUpdates: false };
    });
  }

  async view(worker?: string): Promise<FleetToolsView> {
    const [inputs, feed, custom, policy] = await Promise.all([
      this.#machines(worker),
      this.d.feed.rows(),
      this.#customRecipes(),
      this.#policy(),
    ]);
    if (worker !== undefined && inputs.length === 0) {
      throw new HttpError(404, 'worker_not_found', 'No such worker.');
    }
    const vc = this.d.versionCatalog?.() ?? null;
    const machines = inputs.map((m) => buildMachine(m, feed, custom, policy, vc));
    // The fleet default pins come from all machines, also when one machine is asked for.
    const all =
      worker === undefined
        ? machines
        : (await this.#machines()).map((m) => buildMachine(m, feed, custom, policy, vc));
    const candidates =
      (await this.d
        .verification?.()
        ?.candidates()
        .catch(() => [])) ?? [];
    const checked = [...feed.values()].map((f) => f.checkedAt.getTime());
    return {
      generatedAt: this.d.clock().toISOString(),
      feed: {
        enabled: this.d.feed.enabled,
        checkedAt: checked.length === 0 ? null : new Date(Math.max(...checked)).toISOString(),
      },
      catalog: buildCatalog(feed, this.d.feed.enabled, all, custom, vc),
      machines,
      summary: summarize(machines),
      policy,
      candidates,
    };
  }

  // ----------------------------------------------------------------------------------------- actions

  /** Validates the item for the kind; returns the custom recipe for custom kinds. */
  async #item(kind: ActionKind, item: string): Promise<CustomToolRecipe | null> {
    if (kind === 'runtime.install') {
      if (!RuntimeKind.safeParse(item).success)
        throw new HttpError(400, 'item_invalid', 'Not a runtime of this platform.');
      return null;
    }
    if (kind === 'tool.install' || kind === 'tool.remove' || kind === 'tool.elevated') {
      if (!ToolRecipeId.safeParse(item).success)
        throw new HttpError(
          400,
          'item_invalid',
          'No release recipe for this tool.',
          {},
          {},
          { reason: 'recipe' },
        );
      return null;
    }
    const name = item.startsWith('custom:') ? item.slice('custom:'.length) : item;
    const stored = await this.d.recipes.byName(name);
    if (stored === null) throw new HttpError(404, 'recipe_not_found', 'No such custom tool recipe.');
    return stored.recipe;
  }

  /** Per machine: the version to install and why it cannot run there (null: it can). */
  #plan(
    kind: ActionKind,
    item: string,
    requested: string | undefined,
    m: MatrixMachine,
    custom: CustomToolRecipe | null,
    opts: {
      readonly unverified?: boolean;
      readonly policy?: MatrixPolicy;
      readonly ownerUpgrade?: boolean;
      readonly toolSource?: OwnerToolSource;
    } = {},
  ): { version: string | null; skip: string | null; unverified?: boolean; catalog?: boolean } {
    const cellId = custom === null ? item : `custom:${custom.name}`;
    const cell = m.cells.find((c) => c.item === cellId);
    if (cell?.blocked === 'not_operable') return { version: null, skip: 'not_operable' };
    switch (kind) {
      case 'runtime.install': {
        if (!m.features.remoteOps) return { version: null, skip: 'worker_update_required' };
        const v =
          requested ??
          (opts.unverified === true
            ? (cell?.unverifiedAction?.version ?? cell?.latest)
            : (cell?.action?.version ?? cell?.pinned)) ??
          null;
        if (v === null) return { version: null, skip: 'version_not_available' };
        if (cell?.available === undefined || cell.available.includes(v)) {
          if (cell?.installed === v && requested === undefined)
            return { version: v, skip: 'already_current' };
          return { version: v, skip: null };
        }
        // p17-update-channel: an unverified version-catalog version — the worker has its source; the owner's policy.
        if (cell.catalogUnverified?.includes(v) === true) {
          if (opts.unverified !== true) return { version: v, skip: 'version_not_available' };
          if (opts.policy?.unverifiedRuntimeUpdates !== true)
            return { version: v, skip: 'unverified_updates_disabled' };
          if (cell.installed === v) return { version: v, skip: 'already_current' };
          return { version: v, skip: null, unverified: true, catalog: true };
        }
        // p16-runtime-updates: outside this worker release's pinned set — only as an unverified update.
        if (opts.unverified !== true) return { version: v, skip: 'version_not_available' };
        if (opts.policy?.unverifiedRuntimeUpdates !== true && opts.ownerUpgrade !== true)
          return { version: v, skip: 'unverified_updates_disabled' };
        if (!m.features.runtimeUnverified) return { version: v, skip: 'worker_update_required' };
        if (cell.blocked === 'platform_unsupported') return { version: v, skip: 'platform_unsupported' };
        if (cell.unverifiedSupported === false) return { version: v, skip: 'unverified_install_unavailable' };
        // The pin itself, but this machine's software cannot install it yet (an older worker release than the
        // pin's policy / release): the machine needs its software update first, not "not newer".
        if (cell.pinned !== null && v === cell.pinned) return { version: v, skip: 'worker_update_required' };
        if (cell.pinned !== null && (compareVersions(v, cell.pinned) ?? 0) <= 0)
          return { version: v, skip: 'version_not_newer' };
        if (cell.installed === v) return { version: v, skip: 'already_current' };
        return { version: v, skip: null, unverified: true };
      }
      case 'tool.install':
      case 'tool.remove': {
        if (!m.features.tools) return { version: null, skip: 'worker_update_required' };
        const v =
          requested ??
          (kind === 'tool.install' ? cell?.action?.version : cell?.installed) ??
          cell?.pinned ??
          null;
        if (v === null)
          return { version: null, skip: kind === 'tool.remove' ? 'not_installed' : 'platform_unsupported' };
        // p17-update-channel: an owner upgrade to a version outside the recipes, with its published asset.
        if (kind === 'tool.install' && opts.toolSource !== undefined) {
          if (!m.features.versionCatalog) return { version: v, skip: 'worker_update_required' };
          const platform = toolPlatform(m.os, m.arch);
          if (platform === null || opts.toolSource.assets[platform] === undefined)
            return { version: v, skip: 'platform_unsupported' };
          if (cell?.installed === v) return { version: v, skip: 'already_current' };
          return { version: v, skip: null, unverified: true, catalog: true };
        }
        // p17-update-channel: an unverified catalog recipe only under the owner's policy.
        if (kind === 'tool.install' && cell?.catalogUnverified?.includes(v) === true) {
          if (opts.policy?.unverifiedRuntimeUpdates !== true)
            return { version: v, skip: 'unverified_updates_disabled' };
          if (cell.installed === v) return { version: v, skip: 'already_current' };
          return { version: v, skip: null, unverified: true, catalog: true };
        }
        if (kind === 'tool.install' && cell?.action?.kind === 'tool.elevated')
          return { version: v, skip: 'machine_admin_required' };
        if (kind === 'tool.install' && cell?.action === null && requested === undefined)
          return { version: v, skip: cell.blocked ?? 'already_current' };
        if (kind === 'tool.remove' && cell?.source !== 'managed')
          return { version: v, skip: 'not_installed' };
        return { version: v, skip: null };
      }
      case 'tool.elevated': {
        if (!m.features.machineAdmin) return { version: null, skip: 'worker_update_required' };
        if (!m.machineAdminEnabled) return { version: null, skip: 'machine_admin_not_enabled' };
        if (m.os !== 'linux') return { version: null, skip: 'platform_unsupported' };
        if (cell?.installed !== null && cell?.installed !== undefined && requested === undefined)
          return { version: 'distro', skip: 'already_current' };
        return { version: 'distro', skip: null };
      }
      case 'custom.install':
      case 'custom.remove': {
        if (custom === null) return { version: null, skip: 'recipe_not_found' };
        const platform = toolPlatform(m.os, m.arch);
        const step = platform === null ? undefined : custom.platforms[platform];
        if (step === undefined) return { version: null, skip: 'no_platform_step' };
        if (kind === 'custom.remove' && step.kind === 'package')
          return { version: null, skip: 'package_remove_unsupported' };
        if (step.kind === 'download' && !m.features.customTools)
          return { version: null, skip: 'worker_update_required' };
        if (step.kind === 'package' && !m.features.machineAdmin)
          return { version: null, skip: 'worker_update_required' };
        if (!m.machineAdminEnabled) return { version: null, skip: 'machine_admin_not_enabled' };
        if (kind === 'custom.install' && cell?.status === 'current' && requested === undefined)
          return { version: custom.version, skip: 'already_current' };
        if (kind === 'custom.remove' && cell?.source !== 'managed')
          return { version: custom.version, skip: 'not_installed' };
        return { version: custom.version, skip: null };
      }
    }
  }

  /**
   * p16-runtime-updates: what a `runtime.install` action would do per machine now — the same planning as `create`
   * without storing, resolving or sending anything (the assistant's draft_runtime_update shows it on the card; the
   * confirmation plans again).
   */
  async planRuntimeUpdate(input: {
    readonly runtime: RuntimeKind;
    readonly version?: string | undefined;
    readonly workers: readonly string[] | 'all';
    readonly unverified?: boolean | undefined;
  }): Promise<{
    readonly policy: MatrixPolicy;
    readonly plans: readonly {
      readonly workerId: string;
      readonly name: string;
      readonly canary: boolean;
      readonly installed: string | null;
      readonly pin: string | null;
      readonly version: string | null;
      readonly skip: string | null;
      readonly unverified: boolean;
    }[];
  }> {
    const view = await this.view();
    const policy = view.policy;
    const wanted =
      input.workers === 'all'
        ? view.machines
        : view.machines.filter((m) => input.workers.includes(m.workerId));
    return {
      policy,
      plans: wanted.map((m) => {
        const cell = m.cells.find((c) => c.item === input.runtime);
        const p = this.#plan('runtime.install', input.runtime, input.version, m, null, {
          ...(input.unverified === undefined ? {} : { unverified: input.unverified }),
          policy,
        });
        return {
          workerId: m.workerId,
          name: m.name,
          canary: m.canary,
          installed: cell?.installed ?? null,
          pin: cell?.unverifiedActive?.pin ?? cell?.pinned ?? null,
          version: p.version,
          skip: p.skip,
          unverified: p.unverified === true,
        };
      }),
    };
  }

  async create(input: NewAction, admin: boolean, actor: ActorContext): Promise<ActionView> {
    if (ADMIN_KINDS.has(input.kind) !== admin) {
      throw new HttpError(
        400,
        'wrong_route',
        admin
          ? 'Release recipes and runtimes go through POST /fleet/tools/actions.'
          : 'Machine administration (elevated recipes, custom tools) goes through POST /fleet/tools/admin-actions.',
        {},
        {},
        { reason: admin ? 'release' : 'admin' },
      );
    }
    const custom = await this.#item(input.kind, input.item);
    const maxH = admin ? MAX_ADMIN_EXPIRY_H : MAX_EXPIRY_H;
    const hours = Math.min(Math.max(input.expiresInHours ?? 24, 1), maxH);
    if (input.expiresInHours !== undefined && input.expiresInHours > maxH) {
      throw new HttpError(
        400,
        'expiry_too_long',
        `At most ${String(maxH)} hours for this action.`,
        {},
        {},
        { hours: maxH },
      );
    }
    const view = await this.view();
    const wanted =
      input.workers === 'all'
        ? view.machines
        : view.machines.filter((m) => input.workers.includes(m.workerId));
    if (input.workers !== 'all') {
      const unknown = input.workers.filter((id) => !view.machines.some((m) => m.workerId === id));
      if (unknown.length > 0)
        throw new HttpError(
          404,
          'worker_not_found',
          `No such worker: ${unknown.slice(0, 3).join(', ')}.`,
          {},
          {},
          { reason: 'list', workers: unknown.slice(0, 3).join(', ') },
        );
    }
    if (wanted.length === 0) throw new HttpError(400, 'no_targets', 'Choose at least one machine.');
    if (wanted.length > MAX_TARGETS)
      throw new HttpError(400, 'too_many_targets', 'Too many machines at once.');
    const rollout = input.rollout ?? 'all';
    const policy =
      input.kind === 'runtime.install' || input.kind === 'tool.install' ? await this.#policy() : undefined;
    const plans = wanted.map((m) => ({
      m,
      ...this.#plan(input.kind, input.item, input.version, m, custom, {
        ...(input.unverified === undefined ? {} : { unverified: input.unverified }),
        ...(policy === undefined ? {} : { policy }),
        ...(input.ownerUpgrade === true ? { ownerUpgrade: true } : {}),
        ...(input.toolSource === undefined ? {} : { toolSource: input.toolSource }),
      }),
    }));
    if (plans.every((p) => p.skip !== null)) {
      throw new HttpError(
        409,
        'nothing_to_do',
        'None of the chosen machines can take this action now.',
        {},
        {
          skipped: plans.map((p) => ({ workerId: p.m.workerId, reason: p.skip })),
        },
      );
    }
    // p16-runtime-updates: every unverified version is resolved from the registry once (exact version document, sha512)
    // before anything is stored; a version that cannot be resolved refuses the whole action with its reason.
    const unverifiedVersions = [
      ...new Set(
        plans
          .filter((p) => p.skip === null && p.unverified === true && p.catalog !== true)
          .map((p) => p.version ?? ''),
      ),
    ];
    let unverified: UnverifiedRecipe | null = null;
    if (unverifiedVersions.length > 0) {
      const releases = this.d.releases;
      if (releases === undefined)
        throw new HttpError(
          409,
          'feed_disabled',
          'This master reads no package registry (FLEET_TOOLS_FEED=off), so it cannot resolve a version outside the pins.',
        );
      const runtime = RuntimeKind.parse(input.item);
      const resolved: Record<string, Omit<UnverifiedRuntimeSource, 'lock'>> = {};
      for (const v of unverifiedVersions) {
        const c = await releases.resolve(runtime, v);
        resolved[v] = { package: c.package, packageVersion: c.packageVersion, integrity: c.integrity };
      }
      unverified = { unverified: resolved, ...(input.ownerUpgrade === true ? { ownerUpgrade: true } : {}) };
    }
    const runnable = plans.filter((p) => p.skip === null);
    if (rollout === 'canary-first' && !runnable.some((p) => p.m.canary)) {
      throw new HttpError(
        409,
        'no_canary_machine',
        'None of the chosen machines is a canary. Mark one as canary (Machines > <machine> > Runtimes > policy) or roll out to all at once.',
      );
    }
    const now = this.d.clock();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + hours * 3600_000);
    const recipe =
      custom !== null
        ? JSON.stringify(custom)
        : input.toolSource !== undefined
          ? JSON.stringify({ ownerTool: input.toolSource })
          : unverified !== null
            ? JSON.stringify(unverified)
            : input.ownerUpgrade === true
              ? JSON.stringify({ ownerUpgrade: true })
              : null;
    const storedRecipe = custom === null ? null : await this.d.recipes.byName(custom.name);
    await withTransaction(this.d.pool, async (tx) => {
      await tx.query(
        `INSERT INTO fleet_tool_actions (id, kind, item, version, recipe_id, recipe, rollout, approval_policy, state,
                                         created_by, created_ip, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11, $12)`,
        [
          id,
          input.kind,
          custom === null ? input.item : `custom:${custom.name}`,
          input.version ?? null,
          storedRecipe?.id ?? null,
          recipe,
          rollout,
          admin ? (input.approvalPolicy ?? 'ask-all') : null,
          actor.userId,
          actor.ip.slice(0, 64),
          now,
          expiresAt,
        ],
      );
      for (const p of plans) {
        const phase = rollout === 'canary-first' && !p.m.canary ? 2 : 1;
        const state: TargetState = p.skip !== null ? 'skipped' : phase === 2 ? 'held' : 'queued';
        await tx.query(
          `INSERT INTO fleet_tool_action_targets (action_id, worker_id, phase, state, version, reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, p.m.workerId, phase, state, p.version, p.skip, now],
        );
      }
      await this.d.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'fleet.tools.action',
          target: `fleet-tool-action:${id}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: {
            kind: input.kind,
            item: custom === null ? input.item : `custom:${custom.name}`,
            version: input.version ?? null,
            rollout,
            expiresAt: expiresAt.toISOString(),
            ...(admin ? { approvalPolicy: input.approvalPolicy ?? 'ask-all' } : {}),
            ...(custom === null ? {} : { recipeVersion: custom.version }),
            // p16-runtime-updates: versions outside the release pins (labelled unverified on the machines).
            ...(unverified === null
              ? {}
              : {
                  unverified: true,
                  unverifiedVersions,
                  unverifiedTargets: runnable.filter((p) => p.unverified === true).length,
                }),
            targets: runnable.length,
            skipped: plans.length - runnable.length,
          },
        },
        tx,
      );
    });
    await this.#dispatch(id);
    return this.get(id);
  }

  async #targets(actionId: string): Promise<TargetRow[]> {
    const { rows } = await this.d.pool.query<TargetRow>(
      `SELECT t.action_id::text AS action_id, t.worker_id, w.display_name AS name, t.phase, t.state, t.version,
              t.attempts, t.reason, t.detail, t.op_id::text AS op_id, t.job_id::text AS job_id, t.updated_at
         FROM fleet_tool_action_targets t JOIN workers w ON w.id = t.worker_id
        WHERE t.action_id = $1 ORDER BY t.phase, w.display_name, t.worker_id`,
      [actionId],
    );
    return rows;
  }

  async #action(id: string): Promise<ActionRow> {
    const { rows } = await this.d.pool.query<ActionRow>(
      `SELECT id::text AS id, kind, item, version, recipe, rollout, approval_policy, state,
              created_by::text AS created_by, created_ip, created_at, expires_at, finished_at
         FROM fleet_tool_actions WHERE id::text = $1`,
      [id],
    );
    const a = rows[0];
    if (a === undefined)
      throw new HttpError(404, 'action_not_found', 'No such fleet action.', {}, {}, { reason: 'fleet' });
    return a;
  }

  #viewOf(a: ActionRow, targets: readonly TargetRow[]): ActionView {
    const counts: Partial<Record<TargetState, number>> = {};
    for (const t of targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
    return {
      id: a.id,
      kind: a.kind,
      item: a.item,
      version: a.version,
      rollout: a.rollout,
      state: a.state,
      createdAt: a.created_at.toISOString(),
      createdBy: a.created_by,
      expiresAt: a.expires_at.toISOString(),
      finishedAt: a.finished_at?.toISOString() ?? null,
      counts,
      targets: targets.map((t) => ({
        workerId: t.worker_id,
        name: t.name,
        phase: t.phase,
        state: t.state,
        version: t.version,
        attempts: t.attempts,
        reason: t.reason,
        detail: t.detail === null ? null : this.#redactor.redact(t.detail),
        opId: t.op_id,
        jobId: t.job_id,
        updatedAt: t.updated_at.toISOString(),
      })),
    };
  }

  async get(id: string): Promise<ActionView> {
    await this.#sync(id);
    const a = await this.#action(id);
    return this.#viewOf(a, await this.#targets(id));
  }

  async list(): Promise<ActionView[]> {
    const { rows } = await this.d.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM fleet_tool_actions ORDER BY created_at DESC LIMIT 20',
    );
    const out: ActionView[] = [];
    for (const r of rows) out.push(await this.get(r.id));
    return out;
  }

  async #setTarget(
    actionId: string,
    workerId: string,
    patch: {
      state: TargetState;
      reason?: string | null;
      detail?: string | null;
      opId?: string | null;
      jobId?: string | null;
      attempt?: boolean;
    },
  ): Promise<void> {
    await this.d.pool.query(
      `UPDATE fleet_tool_action_targets
          SET state = $3,
              reason = CASE WHEN $4::boolean THEN $5 ELSE reason END,
              detail = CASE WHEN $6::boolean THEN $7 ELSE detail END,
              op_id = COALESCE($8::uuid, op_id), job_id = COALESCE($9::uuid, job_id),
              attempts = attempts + CASE WHEN $10::boolean THEN 1 ELSE 0 END, updated_at = $11
        WHERE action_id = $1 AND worker_id = $2`,
      [
        actionId,
        workerId,
        patch.state,
        patch.reason !== undefined,
        patch.reason ?? null,
        patch.detail !== undefined,
        patch.detail === undefined || patch.detail === null
          ? null
          : this.#redactor.redact(patch.detail).slice(0, 500),
        patch.opId ?? null,
        patch.jobId ?? null,
        patch.attempt === true,
        this.d.clock(),
      ],
    );
  }

  /** The creator must still be an enabled owner / admin when a queued target is dispatched. */
  async #actorStillAllowed(userId: string | null): Promise<boolean> {
    if (userId === null) return false;
    const { rows } = await this.d.pool.query<{ ok: boolean }>(
      `SELECT (disabled_at IS NULL AND role IN ('owner', 'admin')) AS ok FROM users WHERE id::text = $1`,
      [userId],
    );
    return rows[0]?.ok === true;
  }

  /** The operation of one target (remote-op kinds). */
  #op(a: ActionRow, version: string | null, os: string, arch: string): OpsOperation | null {
    switch (a.kind) {
      case 'runtime.install':
        return version === null
          ? null
          : { kind: 'runtime.install', runtime: RuntimeKind.parse(a.item), version };
      case 'tool.install': {
        if (version === null) return null;
        // p17-update-channel: an owner upgrade carries the platform's published asset.
        const owner = (a.recipe as { ownerTool?: OwnerToolSource } | null)?.ownerTool;
        const platform = toolPlatform(os, arch);
        const asset = owner === undefined || platform === null ? undefined : owner.assets[platform];
        if (owner !== undefined && asset === undefined) return null;
        return {
          kind: 'tool.install',
          tool: ToolRecipeId.parse(a.item),
          version,
          ...(asset === undefined
            ? {}
            : { asset: { ...asset, ...(owner?.build === undefined ? {} : { build: owner.build }) } }),
        };
      }
      case 'tool.remove':
        return version === null ? null : { kind: 'tool.remove', tool: ToolRecipeId.parse(a.item), version };
      case 'custom.install':
      case 'custom.remove': {
        const r = a.recipe as CustomToolRecipe | null;
        const platform = toolPlatform(os, arch);
        const step = r === null || platform === null ? undefined : r.platforms[platform];
        if (r === null || step?.kind !== 'download') return null;
        if (a.kind === 'custom.remove')
          return { kind: 'tool.remove.custom', name: r.name, version: r.version };
        const { kind: _kind, ...download } = step;
        const recipe: CustomToolInstall = {
          name: r.name,
          version: r.version,
          download,
          check: { args: [...r.check.args] },
        };
        return { kind: 'tool.install.custom', recipe };
      }
      case 'tool.elevated':
      case 'mcp.install':
      case 'mcp.remove':
        return null;
    }
  }

  /** Dispatch runs per action, one after another (see {@link #dispatch}). */
  readonly #dispatching = new Map<string, Promise<void>>();

  /**
   * Sends every queued target of the action whose machine is connected. Runs of one action are serialised: the
   * request that created the action and the orchestrator tick both dispatch, and two concurrent runs read the same
   * `queued` targets and sent every operation twice (the target then tracked the second operation while the worker
   * answered the first). Only the replica holding a worker's session sends to it, so ordering within this process is
   * enough.
   */
  #dispatch(actionId: string): Promise<void> {
    const prev = this.#dispatching.get(actionId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.#dispatchNow(actionId));
    this.#dispatching.set(actionId, run);
    void run
      .finally(() => {
        if (this.#dispatching.get(actionId) === run) this.#dispatching.delete(actionId);
      })
      .catch(() => undefined);
    return run;
  }

  async #dispatchNow(actionId: string): Promise<void> {
    const a = await this.#action(actionId);
    if (a.state !== 'running') return;
    const now = this.d.clock();
    if (a.expires_at.getTime() <= now.getTime()) {
      await this.d.pool.query(
        `UPDATE fleet_tool_action_targets SET state = 'expired', reason = 'expired', updated_at = $2
          WHERE action_id = $1 AND state IN ('queued', 'held')`,
        [actionId, now],
      );
      return;
    }
    const targets = (await this.#targets(actionId)).filter((t) => t.state === 'queued');
    if (targets.length === 0) return;
    const allowed = await this.#actorStillAllowed(a.created_by);
    const actor: ActorContext = { userId: a.created_by ?? '', ip: a.created_ip ?? '', userAgent: null };
    // p14-mcp-stdio: without a stored lock exactly one machine (a canary) resolves it; the others wait for it.
    let lockless =
      a.kind === 'mcp.install' && (await this.#mcpLockOf(a)) === null
        ? (await this.#targets(actionId)).some((t) => IN_FLIGHT.has(t.state))
        : false;
    for (const t of targets) {
      if (!allowed) {
        await this.#setTarget(actionId, t.worker_id, {
          state: 'failed',
          reason: 'actor_not_authorised',
          detail: 'the admin who started this action is no longer an enabled owner/admin',
        });
        continue;
      }
      if (!this.d.connected(t.worker_id)) continue; // stays queued until the machine is back (or the action expires)
      if (t.attempts >= MAX_ATTEMPTS) {
        await this.#setTarget(actionId, t.worker_id, { state: 'failed', reason: 'too_many_attempts' });
        continue;
      }
      if (a.kind === 'mcp.install') {
        const lock = await this.#mcpLockOf(a);
        if (lock === null && t.phase === 2) {
          await this.#setTarget(actionId, t.worker_id, {
            state: 'failed',
            reason: 'mcp_lock_missing',
            detail: 'no lockfile was captured on a canary machine for this version',
          });
          continue;
        }
        if (lock === null && lockless) continue; // another machine is resolving the lock right now
        if (lock === null) lockless = true;
        await this.#sendMcp(a, t, actor, lock);
        continue;
      }
      if (a.kind === 'mcp.remove') {
        await this.#sendMcp(a, t, actor, null);
        continue;
      }
      await this.#send(a, t, actor);
    }
  }

  async #mcpLockOf(a: ActionRow): Promise<McpLockfile | null> {
    const r = a.recipe as McpActionRecipe | null;
    if (r === null || this.d.mcpLock === undefined) return null;
    return this.d.mcpLock(r.serverId, r.version);
  }

  /** p14-mcp-stdio: one machine's `mcp.install` (with the stored lock, or none for the canary) / `mcp.remove`. */
  async #sendMcp(a: ActionRow, t: TargetRow, actor: ActorContext, lock: McpLockfile | null): Promise<void> {
    const r = a.recipe as McpActionRecipe | null;
    try {
      if (r === null) {
        await this.#setTarget(a.id, t.worker_id, { state: 'failed', reason: 'recipe_not_found' });
        return;
      }
      const ops = this.d.remoteOps();
      if (ops === null)
        throw new HttpError(
          503,
          'unavailable',
          'remote operations are not available',
          {},
          {},
          { reason: 'remote_ops' },
        );
      const scripts =
        a.kind === 'mcp.install' ? ((await this.d.mcpInstallScripts?.(t.worker_id)) ?? null) : null;
      const op: OpsOperation =
        a.kind === 'mcp.install'
          ? {
              kind: 'mcp.install',
              server: r.signed,
              ...(lock === null ? {} : { lock }),
              ...(scripts === null ? {} : { installScripts: [...scripts] }),
            }
          : { kind: 'mcp.remove', id: r.serverId, version: r.version };
      const v = await ops.request(t.worker_id, op, actor);
      await this.#setTarget(a.id, t.worker_id, {
        state: v.state === 'failed' ? 'failed' : 'sent',
        opId: v.id,
        reason: v.state === 'failed' ? (v.reason ?? 'send_failed') : null,
        detail:
          v.state === 'failed'
            ? v.detail
            : lock === null && a.kind === 'mcp.install'
              ? 'resolving the lockfile'
              : null,
        attempt: true,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (REQUEUE.has(err.code)) {
          await this.#setTarget(a.id, t.worker_id, {
            state: 'queued',
            reason: err.code,
            detail: err.publicMessage,
            attempt: err.code === 'rate_limited',
          });
          return;
        }
        await this.#setTarget(a.id, t.worker_id, {
          state: 'failed',
          reason: err.code.slice(0, 64),
          detail: err.publicMessage,
          attempt: true,
        });
        return;
      }
      this.d.log.error({ err, actionId: a.id, workerId: t.worker_id }, 'MCP install target failed');
      await this.#setTarget(a.id, t.worker_id, { state: 'failed', reason: 'internal', attempt: true });
    }
  }

  /**
   * p14-mcp-stdio: a bulk install / removal of one MCP server version (the MCP routes checked admin + always-fresh
   * step-up). Installs without a stored lockfile always go canary-first: one canary resolves the lock, then the rest
   * install exactly that lock after an admin continues.
   */
  async createMcp(input: NewMcpAction, actor: ActorContext): Promise<ActionView> {
    const inputs = await this.#machines();
    const wanted =
      input.workers === 'all' ? inputs : inputs.filter((m) => input.workers.includes(m.workerId));
    if (input.workers !== 'all') {
      const unknown = input.workers.filter((id) => !inputs.some((m) => m.workerId === id));
      if (unknown.length > 0)
        throw new HttpError(
          404,
          'worker_not_found',
          `No such worker: ${unknown.slice(0, 3).join(', ')}.`,
          {},
          {},
          { reason: 'list', workers: unknown.slice(0, 3).join(', ') },
        );
    }
    if (wanted.length === 0) throw new HttpError(400, 'no_targets', 'Choose at least one machine.');
    if (wanted.length > MAX_TARGETS)
      throw new HttpError(400, 'too_many_targets', 'Too many machines at once.');
    const plans = wanted.map((m) => ({
      m,
      skip: m.features.includes(MCP_STDIO_FEATURE) ? null : 'worker_update_required',
    }));
    if (plans.every((p) => p.skip !== null)) {
      throw new HttpError(
        409,
        'mcp_install_unsupported',
        'This worker build cannot install local MCP packages (mcp-stdio-v1); update it.',
        {},
        { skipped: plans.map((p) => ({ workerId: p.m.workerId, reason: p.skip })) },
      );
    }
    const runnable = plans.filter((p) => p.skip === null);
    const rollout =
      input.kind === 'mcp.install' && !input.lockStored ? 'canary-first' : (input.rollout ?? 'all');
    if (rollout === 'canary-first' && !runnable.some((p) => p.m.canary)) {
      throw new HttpError(
        409,
        'no_canary_machine',
        'None of the chosen machines is a canary. Mark one as canary (Machines > <machine> > Runtimes > policy): the first install resolves the lockfile there.',
        {},
        {},
        { reason: 'mcp' },
      );
    }
    const now = this.d.clock();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + 24 * 3600_000);
    const item = `mcp:${input.recipe.serverId}`;
    await withTransaction(this.d.pool, async (tx) => {
      await tx.query(
        `INSERT INTO fleet_tool_actions (id, kind, item, version, recipe_id, recipe, rollout, approval_policy, state,
                                         created_by, created_ip, created_at, expires_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, NULL, 'running', $7, $8, $9, $10)`,
        [
          id,
          input.kind,
          item,
          input.recipe.version,
          JSON.stringify(input.recipe),
          rollout,
          actor.userId,
          actor.ip.slice(0, 64),
          now,
          expiresAt,
        ],
      );
      for (const p of plans) {
        const phase = rollout === 'canary-first' && !p.m.canary ? 2 : 1;
        const state: TargetState = p.skip !== null ? 'skipped' : phase === 2 ? 'held' : 'queued';
        await tx.query(
          `INSERT INTO fleet_tool_action_targets (action_id, worker_id, phase, state, version, reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, p.m.workerId, phase, state, input.recipe.version, p.skip, now],
        );
      }
      await this.d.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: input.kind === 'mcp.install' ? 'mcp.install' : 'mcp.remove',
          target: `mcp:${input.recipe.serverId}`,
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata: {
            actionId: id,
            serverId: input.recipe.serverId,
            version: input.recipe.version,
            specSha256: input.recipe.specSha256,
            manager: input.recipe.manager,
            rollout,
            lockStored: input.lockStored,
            targets: runnable.length,
            skipped: plans.length - runnable.length,
          },
        },
        tx,
      );
    });
    await this.#dispatch(id);
    return this.get(id);
  }

  /** p14-mcp-stdio: the recent install / removal actions of one MCP server. */
  async listForItem(item: string, limit = 5): Promise<ActionView[]> {
    const { rows } = await this.d.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM fleet_tool_actions WHERE item = $1 ORDER BY created_at DESC LIMIT $2`,
      [item, limit],
    );
    const out: ActionView[] = [];
    for (const r of rows) out.push(await this.get(r.id));
    return out;
  }

  async #send(a: ActionRow, t: TargetRow, actor: ActorContext): Promise<void> {
    const { rows } = await this.d.pool.query<{ os: string | null; arch: string | null }>(
      `SELECT facts->>'os' AS os, facts->>'arch' AS arch FROM workers WHERE id = $1`,
      [t.worker_id],
    );
    const os = rows[0]?.os ?? '';
    const arch = rows[0]?.arch ?? '';
    try {
      // p16-runtime-updates: a runtime action's recipe column holds its unverified sources, not a custom recipe.
      const r =
        a.kind === 'custom.install' || a.kind === 'custom.remove'
          ? (a.recipe as CustomToolRecipe | null)
          : null;
      const platform = toolPlatform(os, arch);
      const packageStep =
        r !== null && platform !== null && r.platforms[platform]?.kind === 'package' ? platform : null;
      if (a.kind === 'tool.elevated' || (a.kind === 'custom.install' && packageStep !== null)) {
        const ma = this.d.machineAdmin();
        if (ma === null)
          throw new HttpError(
            503,
            'unavailable',
            'machine administration is not available',
            {},
            {},
            { reason: 'machine_admin' },
          );
        const job = await ma.createTask(
          t.worker_id,
          a.kind === 'tool.elevated'
            ? {
                title: '',
                prompt: '',
                recipe: { tool: ToolRecipeId.parse(a.item), version: 'distro' },
                approvalPolicy: a.approval_policy ?? 'ask-all',
              }
            : {
                title: `Install custom tool ${r?.title ?? ''} ${r?.version ?? ''}`.trim(),
                prompt: customPackagePrompt(
                  r as CustomToolRecipe,
                  packageStep as NonNullable<typeof packageStep>,
                ),
                approvalPolicy: a.approval_policy ?? 'ask-all',
              },
          actor,
        );
        await this.#setTarget(a.id, t.worker_id, {
          state: 'sent',
          jobId: job.jobId,
          reason: null,
          detail: null,
          attempt: true,
        });
        return;
      }
      let op = this.#op(a, t.version, os, arch);
      if (op === null) {
        await this.#setTarget(a.id, t.worker_id, { state: 'skipped', reason: 'no_platform_step' });
        return;
      }
      // p16-runtime-updates: a version outside this worker's pinned set travels with its signed source — only while
      // the policy still allows it (re-read at dispatch: a target queued for an offline machine may go out later).
      if (op.kind === 'runtime.install') {
        const source = await this.#unverifiedSource(a, t, op.version);
        if (source === 'disabled') {
          await this.#setTarget(a.id, t.worker_id, {
            state: 'failed',
            reason: 'unverified_updates_disabled',
            detail: 'the security policy no longer allows runtime versions outside the release pins',
          });
          return;
        }
        if (source !== null) op = { ...op, unverified: source };
      }
      const ops = this.d.remoteOps();
      if (ops === null)
        throw new HttpError(
          503,
          'unavailable',
          'remote operations are not available',
          {},
          {},
          { reason: 'remote_ops' },
        );
      const v = await ops.request(t.worker_id, op, actor);
      const state: TargetState = v.state === 'failed' ? 'failed' : 'sent';
      await this.#setTarget(a.id, t.worker_id, {
        state,
        opId: v.id,
        reason: v.state === 'failed' ? (v.reason ?? 'send_failed') : null,
        detail: v.state === 'failed' ? v.detail : null,
        attempt: true,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (REQUEUE.has(err.code)) {
          await this.#setTarget(a.id, t.worker_id, {
            state: 'queued',
            reason: err.code,
            detail: err.publicMessage,
            attempt: err.code === 'rate_limited',
          });
          return;
        }
        await this.#setTarget(a.id, t.worker_id, {
          state: 'failed',
          reason: err.code.slice(0, 64),
          detail: err.publicMessage,
          attempt: true,
        });
        return;
      }
      this.d.log.error({ err, actionId: a.id, workerId: t.worker_id }, 'fleet tool action target failed');
      await this.#setTarget(a.id, t.worker_id, { state: 'failed', reason: 'internal', attempt: true });
    }
  }

  /**
   * p16-runtime-updates: the source a `runtime.install` target carries — null when the version is in the worker's pinned
   * set (or the action has no unverified versions), `disabled` when the policy was switched off meanwhile.
   */
  async #unverifiedSource(
    a: ActionRow,
    t: TargetRow,
    version: string,
  ): Promise<UnverifiedRuntimeSource | 'disabled' | null> {
    const recipe = unverifiedRecipe(a.recipe);
    const base = recipe?.unverified[version];
    const { rows } = await this.d.pool.query<{ remote_ops: unknown }>(
      'SELECT remote_ops FROM workers WHERE id = $1',
      [t.worker_id],
    );
    const report = RemoteOpsReport.safeParse(rows[0]?.remote_ops);
    if (base === undefined) {
      // p17-update-channel: an unverified catalog version travels as a plain install (the worker has the source), only
      // while the policy still allows it.
      const catalogUnverified = report.success
        ? (report.data.runtimes.find((r) => r.runtime === a.item)?.catalogUnverified ?? [])
        : [];
      if (catalogUnverified.includes(version) && !(await this.#policy()).unverifiedRuntimeUpdates)
        return 'disabled';
      return null;
    }
    // p17-update-channel: the owner's explicit upgrade is not subject to the switch.
    if ((a.recipe as { ownerUpgrade?: boolean } | null)?.ownerUpgrade === true) {
      const candidate = (await this.d.releases?.get(RuntimeKind.parse(a.item), version)) ?? null;
      return candidate === null ? { ...base } : RuntimeReleases.source(candidate);
    }
    const available = report.success
      ? (report.data.runtimes.find((r) => r.runtime === a.item)?.available ?? [])
      : [];
    if (available.includes(version)) return null;
    if (!(await this.#policy()).unverifiedRuntimeUpdates) return 'disabled';
    const candidate: RuntimeCandidate | null =
      (await this.d.releases?.get(RuntimeKind.parse(a.item), version)) ?? null;
    return candidate === null ? { ...base } : RuntimeReleases.source(candidate);
  }

  /**
   * p16-runtime-updates: a terminal update of an unverified `runtime.install` (the first lock is kept for every later
   * machine) or of a `runtime.verify` (handed to the verification service).
   */
  async onRuntimeUpdate(input: {
    readonly workerId: string;
    readonly opId: string;
    readonly kind: 'runtime.install' | 'runtime.verify';
    readonly params: Record<string, unknown>;
    readonly state: string;
    readonly reason: string | null;
    readonly detail: string | null;
    readonly install: RuntimeInstallReport | undefined;
    readonly verify: RuntimeVerifyReport | undefined;
  }): Promise<void> {
    if (input.kind === 'runtime.verify') {
      await this.d.verification?.()?.onResult(input);
      return;
    }
    const lock = input.install?.lock;
    if (lock !== undefined && input.install !== undefined && this.d.releases !== undefined) {
      const stored = await this.d.releases.storeLock(
        input.install.runtime,
        input.install.version,
        input.workerId,
        lock,
      );
      if (stored) {
        this.d.log.info(
          { runtime: input.install.runtime, version: input.install.version, workerId: input.workerId },
          'runtime release lock stored (every later machine installs exactly this tree)',
        );
      }
    }
  }

  /** p16-runtime-updates: "Şimdi doğrula" — the verification of a runtime version on a canary machine now. */
  async verifyRuntimeNow(
    runtime: RuntimeKind,
    version: string | undefined,
    actor: ActorContext,
  ): Promise<{ id: string; workerId: string }> {
    const v = this.d.verification?.() ?? null;
    if (v === null)
      throw new HttpError(
        503,
        'unavailable',
        'Runtime verification is not available.',
        {},
        {},
        { reason: 'runtime_verify' },
      );
    return v.verifyNow(runtime, version, actor);
  }

  /** p16-runtime-updates: the stored lockfile of a runtime release outside the pins (package-lock.json v3). */
  async runtimeLock(runtime: RuntimeKind, version: string): Promise<Record<string, unknown>> {
    const c = (await this.d.releases?.get(runtime, version)) ?? null;
    if (c === null) throw new HttpError(404, 'candidate_not_found', 'No such runtime release.');
    if (c.lock === null)
      throw new HttpError(404, 'lock_not_found', 'No machine has resolved the lockfile of this release yet.');
    const raw = gunzipSync(Buffer.from(c.lock.gz, 'base64'), { maxOutputLength: 4 * 1024 * 1024 });
    if (createHash('sha256').update(raw).digest('hex') !== c.lock.sha256) {
      throw new HttpError(500, 'lock_corrupt', 'The stored lockfile does not match its sha256.');
    }
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  }

  /** Follows the remote operations / jobs of in-flight targets and settles the action's state. */
  async #sync(actionId: string): Promise<void> {
    const a = await this.#action(actionId);
    if (a.state === 'done' || a.state === 'cancelled') return;
    const targets = await this.#targets(actionId);
    for (const t of targets.filter((x) => IN_FLIGHT.has(x.state))) {
      if (t.op_id !== null) {
        // Read through RemoteOpsService: it marks operations without news `lost` after their timeout.
        const ops = this.d.remoteOps();
        const op =
          ops === null
            ? (
                await this.d.pool.query<{ state: string; reason: string | null; detail: string | null }>(
                  'SELECT state, reason, detail FROM worker_ops WHERE id = $1',
                  [t.op_id],
                )
              ).rows[0]
            : await ops.op(t.worker_id, t.op_id).catch(() => undefined);
        if (op === undefined) continue;
        const st =
          op.state === 'succeeded'
            ? 'succeeded'
            : ['failed', 'refused', 'cancelled', 'lost'].includes(op.state)
              ? 'failed'
              : ['accepted', 'running', 'waiting_for_user'].includes(op.state)
                ? 'running'
                : null;
        if (st !== null && st !== t.state) {
          await this.#setTarget(actionId, t.worker_id, {
            state: st,
            reason: st === 'failed' ? (op.reason ?? op.state) : null,
            detail: op.detail,
          });
        }
      } else if (t.job_id !== null) {
        const { rows } = await this.d.pool.query<{ state: string }>(
          'SELECT state::text AS state FROM jobs WHERE id = $1',
          [t.job_id],
        );
        const js = rows[0]?.state;
        const st =
          js === 'SUCCEEDED'
            ? 'succeeded'
            : js === 'FAILED' || js === 'CANCELLED' || js === 'LOST'
              ? 'failed'
              : js === undefined || js === 'QUEUED'
                ? null
                : 'running';
        if (st !== null && st !== t.state) {
          await this.#setTarget(actionId, t.worker_id, {
            state: st,
            reason: st === 'failed' ? `job_${(js ?? '').toLowerCase()}` : null,
          });
        }
      }
    }
    // Expiry of what never left.
    const now = this.d.clock();
    if (a.expires_at.getTime() <= now.getTime()) {
      await this.d.pool.query(
        `UPDATE fleet_tool_action_targets SET state = 'expired', reason = 'expired', updated_at = $2
          WHERE action_id = $1 AND state IN ('queued', 'held')`,
        [actionId, now],
      );
    }
    const after = await this.#targets(actionId);
    const open = after.filter((t) => OPEN_TARGET.has(t.state));
    let next: ActionView['state'] = a.state;
    if (open.length === 0) next = 'done';
    else if (open.every((t) => t.state === 'held')) next = 'held';
    if (next !== a.state) {
      await this.d.pool.query(
        `UPDATE fleet_tool_actions SET state = $2, finished_at = CASE WHEN $2 = 'done' THEN $3::timestamptz ELSE NULL END
          WHERE id = $1`,
        [actionId, next, now],
      );
      if (next === 'done') {
        await this.d.audit.record({
          actor: { type: 'system', id: 'fleet-tools' },
          action: 'fleet.tools.action.done',
          target: `fleet-tool-action:${actionId}`,
          outcome: after.some((t) => t.state === 'failed' || t.state === 'expired') ? 'failure' : 'success',
          metadata: Object.fromEntries(
            [...new Set(after.map((t) => t.state))].map((s) => [
              s,
              after.filter((t) => t.state === s).length,
            ]),
          ),
        });
      }
    }
  }

  async #audit(action: string, id: string, actor: ActorContext, metadata: Record<string, unknown> = {}) {
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action,
      target: `fleet-tool-action:${id}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata,
    });
  }

  /** MCP actions only through the MCP routes (always-fresh step-up), the others only through the fleet routes. */
  #route(a: ActionRow, mcp: boolean): void {
    if (MCP_ACTION_KINDS.has(a.kind) === mcp) return;
    if (mcp)
      throw new HttpError(
        404,
        'action_not_found',
        'No such MCP install action.',
        {},
        {},
        { reason: 'fleet' },
      );
    throw new HttpError(
      400,
      'wrong_route',
      'Local MCP server installs are continued and retried from Skills > MCP servers (always-fresh step-up).',
      {},
      {},
      { reason: 'mcp' },
    );
  }

  /** Canary-first: the canary machines succeeded — the held machines are queued now. */
  async continue(
    id: string,
    actor: ActorContext,
    opts: { readonly mcp?: boolean } = {},
  ): Promise<ActionView> {
    await this.#sync(id);
    const a = await this.#action(id);
    this.#route(a, opts.mcp === true);
    if (a.kind === 'mcp.install' && (await this.#mcpLockOf(a)) === null) {
      throw new HttpError(
        409,
        'mcp_lock_missing',
        'This version has no lockfile yet: install it on a canary machine first.',
      );
    }
    const targets = await this.#targets(id);
    const phase1 = targets.filter((t) => t.phase === 1);
    if (!targets.some((t) => t.state === 'held'))
      throw new HttpError(409, 'nothing_held', 'No machine waits for this action.');
    if (phase1.some((t) => OPEN_TARGET.has(t.state)))
      throw new HttpError(409, 'canary_running', 'The canary machines have not finished yet.');
    if (
      phase1.some((t) => t.state === 'failed' || t.state === 'expired') ||
      !phase1.some((t) => t.state === 'succeeded')
    ) {
      throw new HttpError(
        409,
        'canary_not_verified',
        'Continue only after the canary machines succeeded (retry them first).',
      );
    }
    if (a.state === 'cancelled') throw new HttpError(409, 'action_cancelled', 'The action was cancelled.');
    const now = this.d.clock();
    await this.d.pool.query(
      `UPDATE fleet_tool_action_targets SET state = 'queued', updated_at = $2 WHERE action_id = $1 AND state = 'held'`,
      [id, now],
    );
    await this.d.pool.query(
      `UPDATE fleet_tool_actions SET state = 'running',
              expires_at = GREATEST(expires_at, $2::timestamptz + (expires_at - created_at)) WHERE id = $1`,
      [id, now],
    );
    await this.#audit('fleet.tools.action.continue', id, actor);
    await this.#dispatch(id);
    return this.get(id);
  }

  async retry(
    id: string,
    workers: readonly string[] | undefined,
    actor: ActorContext,
    opts: { readonly mcp?: boolean } = {},
  ): Promise<ActionView> {
    await this.#sync(id);
    const a = await this.#action(id);
    this.#route(a, opts.mcp === true);
    if (a.state === 'cancelled') throw new HttpError(409, 'action_cancelled', 'The action was cancelled.');
    const targets = (await this.#targets(id)).filter(
      (t) =>
        (t.state === 'failed' || t.state === 'expired') &&
        (workers === undefined || workers.includes(t.worker_id)),
    );
    if (targets.length === 0) throw new HttpError(409, 'nothing_to_retry', 'No failed machine to retry.');
    const now = this.d.clock();
    const hours = ADMIN_KINDS.has(a.kind as ActionKind) ? MAX_ADMIN_EXPIRY_H : 24;
    await this.d.pool.query(
      `UPDATE fleet_tool_action_targets SET state = 'queued', reason = NULL, detail = NULL, updated_at = $3
        WHERE action_id = $1 AND worker_id = ANY($2)`,
      [id, targets.map((t) => t.worker_id), now],
    );
    await this.d.pool.query(
      `UPDATE fleet_tool_actions SET state = 'running', finished_at = NULL,
              expires_at = GREATEST(expires_at, $2::timestamptz) WHERE id = $1`,
      [id, new Date(now.getTime() + hours * 3600_000)],
    );
    await this.#audit('fleet.tools.action.retry', id, actor, { workers: targets.map((t) => t.worker_id) });
    await this.#dispatch(id);
    return this.get(id);
  }

  async cancel(id: string, actor: ActorContext): Promise<ActionView> {
    const a = await this.#action(id);
    if (a.state === 'done' || a.state === 'cancelled')
      throw new HttpError(409, 'action_finished', 'The action has finished.');
    const now = this.d.clock();
    await this.d.pool.query(
      `UPDATE fleet_tool_action_targets SET state = 'cancelled', reason = 'cancelled', updated_at = $2
        WHERE action_id = $1 AND state IN ('queued', 'held')`,
      [id, now],
    );
    // Operations already sent run to their end on the machine (cancel them on the machine page).
    await this.d.pool.query(
      `UPDATE fleet_tool_actions SET state = 'cancelled', finished_at = $2 WHERE id = $1`,
      [id, now],
    );
    await this.#audit('fleet.tools.action.cancel', id, actor);
    return this.get(id);
  }

  /** A worker connected: its queued targets go out now. */
  async onWorkerConnected(workerId: string): Promise<void> {
    const { rows } = await this.d.pool.query<{ id: string }>(
      `SELECT DISTINCT a.id::text AS id FROM fleet_tool_actions a
         JOIN fleet_tool_action_targets t ON t.action_id = a.id
        WHERE a.state = 'running' AND t.worker_id = $1 AND t.state = 'queued'`,
      [workerId],
    );
    for (const r of rows) await this.#dispatch(r.id);
  }

  // -------------------------------------------------------------------------------------- scheduler

  /** Orchestrator tick step (self-throttled): feeds, open actions (dispatch + sync), the weekly digest. */
  tick(force = false): Promise<void> {
    const now = this.d.clock().getTime();
    if (!force && now - this.#lastTick < TICK_MS) return Promise.resolve();
    this.#lastTick = now;
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    await this.d.feed.tick().catch((err: unknown) => {
      this.d.log.warn({ err }, 'tool version feeds failed');
    });
    const { rows } = await this.d.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM fleet_tool_actions WHERE state IN ('running', 'held') ORDER BY created_at LIMIT 50`,
    );
    for (const r of rows) {
      try {
        await this.#dispatch(r.id);
        await this.#sync(r.id);
      } catch (err) {
        this.d.log.warn({ err, actionId: r.id }, 'fleet tool action step failed');
      }
    }
    await this.digest().catch((err: unknown) => {
      this.d.log.warn({ err }, 'tool update digest failed');
    });
    // p16-runtime-updates: the automatic verification of newer runtime versions (hourly, self-throttled).
    await this.d
      .verification?.()
      ?.tick()
      .catch((err: unknown) => {
        this.d.log.warn({ err }, 'runtime verification step failed');
      });
  }

  // ------------------------------------------------------------------------------------ settings

  async settings(): Promise<{ digestEnabled: boolean; lastDigestAt: string | null }> {
    const { rows } = await this.d.pool.query<{ digest_enabled: boolean; last_digest_at: Date | null }>(
      'SELECT digest_enabled, last_digest_at FROM fleet_tool_settings WHERE id',
    );
    const r = rows[0];
    return {
      digestEnabled: r?.digest_enabled ?? true,
      lastDigestAt: r?.last_digest_at?.toISOString() ?? null,
    };
  }

  async setSettings(digestEnabled: boolean, actor: ActorContext) {
    const before = await this.settings();
    await this.d.pool.query(
      `INSERT INTO fleet_tool_settings (id, digest_enabled, updated_by, updated_at) VALUES (true, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET digest_enabled = $1, updated_by = $2, updated_at = $3`,
      [digestEnabled, actor.userId, this.d.clock()],
    );
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'fleet.tools.settings',
      target: 'fleet-tools',
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { before: before.digestEnabled, after: digestEnabled },
    });
    return this.settings();
  }

  /**
   * Weekly digest (`tools.updates`, owners and admins): on Mondays from 08:00 UTC, once per ISO week, when the fleet
   * has updates. Returns whether one was sent.
   */
  async digest(force = false): Promise<boolean> {
    const s = await this.settings();
    if (!s.digestEnabled && !force) return false;
    const now = this.d.clock();
    const week = isoWeek(now);
    if (!force) {
      if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return false;
      if (s.lastDigestAt !== null && isoWeek(new Date(s.lastDigestAt)) === week) return false;
    }
    const notifier = this.d.notify?.() ?? null;
    const view = await this.view();
    await this.d.pool.query('UPDATE fleet_tool_settings SET last_digest_at = $1 WHERE id', [now]);
    if (notifier === null || view.summary.updates === 0) return false;
    const items = new Map<string, number>();
    for (const m of view.machines) {
      for (const c of m.cells) {
        if (c.status === 'update_available' || c.status === 'pin_differs')
          items.set(c.item, (items.get(c.item) ?? 0) + 1);
      }
    }
    const label = (id: string) => view.catalog.find((c) => c.id === id)?.label ?? id;
    const top = [...items.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id, n]) => `${label(id)} (${String(n)})`)
      .join(', ');
    const recipients = await globalRecipients(this.d.pool, 'admin');
    const sent = await notifier.notify(this.d.pool, recipients, {
      kind: 'tools.updates',
      severity: 'info',
      title: `${String(view.summary.updates)} tool and runtime updates on ${String(view.summary.machinesWithUpdates)} machines`,
      body: `Updates or pin differences: ${top}. ${String(view.summary.actionable)} can be applied from Machines > Tools and versions now.`,
      link: '/machines/tools',
      dedupeKey: `tools.updates:${week}`,
    });
    return sent > 0;
  }
}

/** `2026-W43` (ISO 8601 week of the UTC date). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}

export { CATALOG };
