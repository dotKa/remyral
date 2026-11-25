import {
  type AssignedMcp,
  compareReleaseVersions,
  MAX_JOB_MCP_EGRESS_HOSTS,
  MAX_JOB_MCP_SERVERS,
  MAX_MCP_ASSIGNMENTS_PER_PROJECT,
  MAX_MCP_TOOL_RULES,
  MCP_FEATURE,
  MCP_STDIO_FEATURE,
  MCP_STARTUP_TIMEOUT_DEFAULT_SEC,
  MCP_TOOL_TIMEOUT_DEFAULT_SEC,
  type McpCallEvent,
  type McpPin,
  type McpProbeReport,
  type McpSpec,
  type McpToolEffect,
  type McpToolRule,
  McpServerId,
  McpToolRules,
  mcpPolicySha256,
  mcpReferencedSlots,
  mcpSetHash,
  mcpSpecEgressHosts,
  mcpToolEffect,
  mcpToolLooksReadOnly,
  ReleaseVersion,
  type RuntimeKind,
  RuntimeKind as RuntimeKindSchema,
  type SignedMcpSpec,
  verifyMcpSpec,
  type OpsOperation,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type ContextActor, stepUpFresh } from '../context/store.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { NotificationDraft } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { ActionView, FleetToolsService } from '../fleet-tools/service.js';
import type { PanelSkillsKey } from '../skills/panel-key.js';
import type { ActorContext } from '../workers/fleet.js';
import {
  type McpFetch,
  type McpInstallView,
  type McpLockView,
  McpStdio,
  type McpStdioWorker,
} from './stdio.js';

/**
 * External MCP servers for jobs (p14-mcp-core, ADR-0054 decision 7, docs/design/p14-mcp-skills.md §2, P3).
 *
 * - **Catalog:** a server (`mcp_servers`) has immutable, panel-signed versions (`mcp_server_versions`: the exact spec
 *   bytes, signed with the panel skills key in its own context `remana-mcp/v1\n`). Publishing is admin + an
 *   always-fresh step-up (the route) — ADR-0054 decision 2. P3 publishes remote servers (http / sse) only.
 * - **Secrets:** a spec names slots; an admin binds each slot to a vault credential (per project or `'*'`). The master
 *   only ever stores the credential id — the value is sealed per worker in the browser (ADR-0016).
 * - **Tool policy:** allow / ask / deny globs per server (per project or `'*'`); unlisted tools are denied. The first
 *   successful probe seeds `ask` for every tool it found (ADR-0054 decision 3); the console suggests read-only ones.
 * - **Assignment + project switch:** server × project (or `'*'`) × runtimes × optional version; nothing reaches a job
 *   while the project's switch (`project_mcp_settings.allowed`, default off) is off.
 * - **Per job:** `issueForJob` pins (server, version, spec hash, policy hash) on the first issue under an advisory lock;
 *   retries reuse the pins. Untrusted-source jobs never get MCP. Missing bindings, vanished versions or a switch turned
 *   off after pinning fail closed ({@link McpUnavailableError} → the job becomes infeasible).
 * - **Calls:** `mcp_call` events (metadata only) land in `job_mcp_calls` and the audit log (`mcp.tool.call`, 500 per
 *   attempt, then one `mcp.tool.calls_truncated`).
 * - **Probe:** the master never connects to an MCP server; `mcp.probe` is a remote op on a chosen `mcp-v1` worker.
 */

export class McpUnavailableError extends Error {
  override name = 'McpUnavailableError';
}

/** The chosen worker lacks `mcp-v1` (a race with placement): the orchestrator tries the next candidate. */
export class McpWorkerUnsupportedError extends Error {
  override name = 'McpWorkerUnsupportedError';
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface McpProbeSender {
  request(
    workerId: string,
    op: OpsOperation,
    actor: { readonly userId: string; readonly ip: string; readonly userAgent: string | null },
  ): Promise<{ readonly id: string }>;
}

interface CounterLike {
  add(value: number, attributes?: Record<string, string>): void;
}

export interface McpServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  /** The panel skills key (SKILLS_PANEL_KEY_FILE): signs published specs. Null: publishing is refused (503). */
  readonly panelKey: PanelSkillsKey | null | (() => PanelSkillsKey | null);
  /** p17-panel-settings Part 5: earlier panel keys still trusted after a rotation. */
  readonly retiredPanelKeys?: () => readonly string[];
  /** SKILLS_PUBLIC_KEYS: offline-signed specs (P4 tooling) verify against them too. */
  readonly publicKeys: readonly string[];
  readonly clock?: () => Date;
  /** Remote operations (late-bound: the remote-ops service reports probe results back here). */
  readonly probes?: () => McpProbeSender | null;
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
  /** Whether a worker is connected right now (the probe picker); absent: every worker counts as offline. */
  readonly connected?: (workerId: string) => boolean;
  /** p6-otel meter (absent: no metrics). */
  readonly meter?: {
    createCounter(name: string, o: { description: string }): CounterLike;
  } | null;
  /** p14-mcp-stdio: the fleet-tools pipeline that installs local packages (late-bound). */
  readonly fleetTools?: () => FleetToolsService | null;
  /** p14-mcp-stdio: registry metadata fetch for the package lookup (tests); default the global fetch. */
  readonly registryFetch?: McpFetch | null;
}

export type McpTransportView = 'http' | 'sse' | 'stdio';

export interface McpServerSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly archived: boolean;
  readonly latest: string | null;
  readonly transport: McpTransportView | null;
  readonly url: string | null;
  readonly runtimes: string[];
  readonly toolCounts: { allow: number; ask: number; deny: number };
  readonly toolsKnown: number;
  readonly assignments: number;
  readonly createdAt: string;
}

export interface McpHeaderView {
  readonly name: string;
  readonly value: string | null;
  readonly secret: string | null;
  readonly format: string | null;
}

/** p14-mcp-stdio: the package of a stdio version (what is installed and how it is started). */
export interface McpPackageView {
  readonly manager: 'npm' | 'pypi';
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bin: string;
  readonly args: string[];
  readonly env: McpHeaderView[];
}

export interface McpVersionView {
  readonly version: string;
  readonly transport: McpTransportView;
  readonly url: string | null;
  readonly package: McpPackageView | null;
  readonly headers: McpHeaderView[];
  readonly secretSlots: { slot: string; why: string }[];
  readonly egressHosts: string[];
  readonly runtimes: string[];
  readonly limits: { startupTimeoutSec: number; toolTimeoutSec: number };
  readonly signer: 'offline' | 'panel';
  readonly keyId: string;
  readonly specSha256: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface McpToolView {
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly schemaSha256: string;
  readonly readOnlyHint: boolean | null;
  readonly suggestedAllow: boolean;
  readonly effect: McpToolEffect;
  readonly probedOnWorker: string;
  readonly probedAt: string;
}

export interface McpPolicySetView {
  readonly project: string;
  readonly rules: McpToolRule[];
  readonly updatedAt: string | null;
}

export interface McpBindingView {
  readonly project: string;
  readonly slot: string;
  readonly credentialId: string;
  readonly updatedAt: string;
}

export interface McpAssignmentView {
  readonly id: string;
  readonly serverId: string;
  readonly project: string;
  readonly runtimes: string[] | null;
  readonly version: string | null;
  readonly createdAt: string;
}

export interface McpProbeView {
  readonly opId: string;
  readonly workerId: string;
  readonly version: string;
  readonly state: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly error: string | null;
  readonly toolCount: number | null;
  readonly at: string;
}

export interface McpServerDetail {
  readonly server: McpServerSummary;
  readonly versions: McpVersionView[];
  readonly tools: McpToolView[];
  readonly policies: McpPolicySetView[];
  readonly secrets: McpBindingView[];
  readonly assignments: McpAssignmentView[];
  readonly probes: McpProbeView[];
  /** p14-mcp-stdio: per machine and version what is installed (stdio servers). */
  readonly installs: McpInstallView[];
  readonly lockfiles: McpLockView[];
  readonly installActions: ActionView[];
  readonly stdioWorkers: McpStdioWorker[];
}

export interface McpPackageInput {
  readonly manager: 'npm' | 'pypi';
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bin: string;
  readonly args?: readonly string[] | undefined;
  readonly env?:
    Readonly<Record<string, string | { secret: string; format?: string | undefined }>> | undefined;
}

export interface McpPublishInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly version: string;
  readonly transport: McpTransportView;
  /** Remote servers (http / sse). */
  readonly url?: string | undefined;
  /** p14-mcp-stdio: local servers. */
  readonly package?: McpPackageInput | undefined;
  readonly headers?:
    Readonly<Record<string, string | { secret: string; format?: string | undefined }>> | undefined;
  readonly secrets?: readonly { slot: string; why: string }[] | undefined;
  readonly egressHosts?: readonly string[] | undefined;
  readonly runtimes: readonly RuntimeKind[];
  readonly limits?:
    { startupTimeoutSec?: number | undefined; toolTimeoutSec?: number | undefined } | undefined;
  /**
   * p14-mcp-chat: where the spec came from when the master resolved it (an MCP Registry entry, a package, a URL);
   * absent: derived from the package / URL as in P3 / P4.
   */
  readonly source?:
    { kind: 'url' | 'npm' | 'pypi' | 'registry'; ref: string; registry?: string | undefined } | undefined;
}

export interface McpProjectView {
  readonly allowed: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly assignments: (McpAssignmentView & { title: string })[];
}

export interface McpJobView {
  readonly setHash: string | null;
  readonly skipped: string | null;
  readonly servers: {
    id: string;
    version: string;
    specSha256: string;
    policySha256: string;
    transport: McpTransportView;
    url: string | null;
    egressHosts: string[];
  }[];
  readonly calls: {
    attemptId: string;
    seq: number;
    server: string;
    tool: string;
    decision: string;
    outcome: string;
    durationMs: number;
    argsBytes: number;
    resultBytes: number;
    at: string;
  }[];
}

/** Placement facts of a job's would-be (or pinned) MCP set; undefined = the job gets no MCP. */
export interface McpPlacementFacts {
  readonly credentials: string[];
  readonly credentialWorkers?: string[];
  /** p14-mcp-stdio: the job's stdio servers (`id@version`) and the machines that have every one installed. */
  readonly stdio?: string[];
  readonly installedWorkers?: string[];
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Audited calls per attempt; later ones are stored but audited once as `mcp.tool.calls_truncated`. */
export const MAX_AUDITED_MCP_CALLS = 500;
/** One probe per server per this window. */
export const MCP_PROBE_INTERVAL_MS = 5 * 60_000;
const MAX_PROBE_LIST = 20;
const MAX_JOB_CALLS_SHOWN = 500;

interface VersionRow {
  server_id: string;
  version: string;
  transport: McpTransportView;
  spec: Buffer;
  spec_sha256: string;
  signature: string;
  key_id: string;
  signer: 'offline' | 'panel';
  runtimes: string[];
  created_by: string | null;
  created_at: Date;
}

interface AssignmentRow {
  id: string;
  server_id: string;
  project: string;
  runtimes: string[] | null;
  version: string | null;
  created_at: Date;
}

interface ResolvedServer {
  readonly pin: McpPin;
  readonly signed: SignedMcpSpec;
  readonly spec: McpSpec;
  readonly rules: McpToolRule[];
  readonly secrets: { slot: string; credentialId: string }[];
}

function bySemverDesc(a: { version: string }, b: { version: string }): number {
  return compareReleaseVersions(b.version, a.version);
}

export function parseStoredSpec(bytes: Buffer): McpSpec | null {
  try {
    return JSON.parse(bytes.toString('utf8')) as McpSpec;
  } catch {
    return null;
  }
}

function valueViews(
  values: Readonly<Record<string, string | { secret: string; format?: string | undefined }>> | undefined,
): McpHeaderView[] {
  return Object.entries(values ?? {}).map(([name, v]) =>
    typeof v === 'string'
      ? { name, value: v, secret: null, format: null }
      : { name, value: null, secret: v.secret, format: v.format ?? null },
  );
}

function versionView(r: VersionRow): McpVersionView {
  const spec = parseStoredSpec(r.spec);
  const remote = spec?.http ?? spec?.sse;
  const stdio = spec?.stdio;
  const headers: McpHeaderView[] = Object.entries(remote?.headers ?? {}).map(([name, v]) =>
    typeof v === 'string'
      ? { name, value: v, secret: null, format: null }
      : { name, value: null, secret: v.secret, format: v.format ?? null },
  );
  return {
    version: r.version,
    transport: r.transport,
    url: remote?.url ?? null,
    package:
      stdio === undefined
        ? null
        : {
            manager: stdio.package.manager,
            name: stdio.package.name,
            version: stdio.package.version,
            integrity: stdio.package.integrity,
            bin: stdio.bin,
            args: [...(stdio.args ?? [])],
            env: valueViews(stdio.env),
          },
    headers,
    secretSlots: (spec?.secrets ?? []).map((s) => ({ slot: s.slot, why: s.why })),
    egressHosts: spec === null ? [] : mcpSpecEgressHosts(spec),
    runtimes: r.runtimes,
    limits: {
      startupTimeoutSec: spec?.limits.startupTimeoutSec ?? MCP_STARTUP_TIMEOUT_DEFAULT_SEC,
      toolTimeoutSec: spec?.limits.toolTimeoutSec ?? MCP_TOOL_TIMEOUT_DEFAULT_SEC,
    },
    signer: r.signer,
    keyId: r.key_id,
    specSha256: r.spec_sha256,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
  };
}

function assignmentView(r: AssignmentRow): McpAssignmentView {
  return {
    id: r.id,
    serverId: r.server_id,
    project: r.project,
    runtimes: r.runtimes,
    version: r.version,
    createdAt: r.created_at.toISOString(),
  };
}

const VERSION_COLUMNS =
  'server_id, version, transport, spec, spec_sha256, signature, key_id, signer, runtimes, created_by::text AS created_by, created_at';
const ASSIGNMENT_COLUMNS = 'id::text AS id, server_id, project, runtimes, version, created_at';

export class McpService {
  /** p14-mcp-stdio: local package installs, lockfiles, the registry lookup. */
  readonly stdio: McpStdio;
  readonly #clock: () => Date;
  readonly #calls: CounterLike | null;
  readonly #issueFailures: CounterLike | null;

  constructor(private readonly deps: McpServiceDeps) {
    this.#clock = deps.clock ?? (() => new Date());
    this.#calls =
      deps.meter?.createCounter('remyral_mcp_calls', {
        description: 'External MCP tool calls reported by workers, by outcome and decision',
      }) ?? null;
    this.#issueFailures =
      deps.meter?.createCounter('remyral_mcp_issue_failures', {
        description: 'Jobs whose external MCP servers could not be issued, by reason',
      }) ?? null;
    this.stdio = new McpStdio({
      pool: deps.pool,
      audit: deps.audit,
      clock: this.#clock,
      ...(deps.fleetTools === undefined ? {} : { fleetTools: deps.fleetTools }),
      ...(deps.connected === undefined ? {} : { connected: deps.connected }),
      ...(deps.registryFetch === undefined ? {} : { fetch: deps.registryFetch }),
    });
  }

  /** The panel key in effect (p17-panel-settings: the panel-generated one, else SKILLS_PANEL_KEY_FILE). */
  private get panelKey(): PanelSkillsKey | null {
    const k = this.deps.panelKey;
    return typeof k === 'function' ? k() : k;
  }

  get panelKeyId(): string | null {
    return this.panelKey?.keyId ?? null;
  }

  get #trusted(): string[] {
    return [
      ...new Set([
        ...this.deps.publicKeys,
        ...(this.panelKey === null ? [] : [this.panelKey.publicKey]),
        ...(this.deps.retiredPanelKeys?.() ?? []),
      ]),
    ];
  }

  // ------------------------------------------------------------------------------------------------ reads

  async workersWithMcp(): Promise<number> {
    const { rows } = await this.deps.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workers
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND features ? $1`,
      [MCP_FEATURE],
    );
    return rows[0]?.n ?? 0;
  }

  /** Approved `mcp-v1` machines (the probe picker), with whether each is connected now. */
  async mcpWorkers(): Promise<{ id: string; name: string; connected: boolean }[]> {
    const { rows } = await this.deps.pool.query<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM workers
        WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND features ? $1 ORDER BY display_name, id`,
      [MCP_FEATURE],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, connected: this.deps.connected?.(r.id) ?? false }));
  }

  async list(): Promise<McpServerSummary[]> {
    const servers = await this.deps.pool.query<{
      id: string;
      title: string;
      description: string;
      archived_at: Date | null;
      created_at: Date;
    }>('SELECT id, title, description, archived_at, created_at FROM mcp_servers ORDER BY id');
    const out: McpServerSummary[] = [];
    for (const s of servers.rows) out.push(await this.#summary(this.deps.pool, s));
    return out;
  }

  async #summary(
    db: Queryable,
    s: { id: string; title: string; description: string; archived_at: Date | null; created_at: Date },
  ): Promise<McpServerSummary> {
    const versions = await db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM mcp_server_versions WHERE server_id = $1`,
      [s.id],
    );
    const latestRow = [...versions.rows].sort(bySemverDesc)[0];
    const latest = latestRow === undefined ? null : versionView(latestRow);
    const tools =
      latest === null
        ? []
        : (
            await db.query<{ name: string }>(
              'SELECT name FROM mcp_server_tools WHERE server_id = $1 AND version = $2',
              [s.id, latest.version],
            )
          ).rows;
    const rules = await this.#rules(db, s.id, '*');
    const toolCounts = { allow: 0, ask: 0, deny: 0 };
    for (const t of tools) toolCounts[mcpToolEffect(rules, t.name)] += 1;
    const assigned = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mcp_assignments WHERE server_id = $1',
      [s.id],
    );
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      archived: s.archived_at !== null,
      latest: latest?.version ?? null,
      transport: latest?.transport ?? null,
      url: latest?.url ?? null,
      runtimes: latest?.runtimes ?? [],
      toolCounts,
      toolsKnown: tools.length,
      assignments: assigned.rows[0]?.n ?? 0,
      createdAt: s.created_at.toISOString(),
    };
  }

  async detail(id: string): Promise<McpServerDetail> {
    const s = await this.#server(this.deps.pool, id);
    const db = this.deps.pool;
    const versions = (
      await db.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM mcp_server_versions WHERE server_id = $1`, [
        id,
      ])
    ).rows.sort(bySemverDesc);
    const rules = await this.#rules(db, id, '*');
    const tools = await db.query<{
      version: string;
      name: string;
      description: string;
      schema_sha256: string;
      read_only_hint: boolean | null;
      probed_on_worker: string;
      probed_at: Date;
    }>(
      `SELECT version, name, description, schema_sha256, read_only_hint, probed_on_worker, probed_at
         FROM mcp_server_tools WHERE server_id = $1 ORDER BY version, name`,
      [id],
    );
    const policyRows = await db.query<{
      project: string;
      tool_glob: string;
      effect: McpToolEffect;
      updated_at: Date;
    }>(
      `SELECT project, tool_glob, effect, updated_at FROM mcp_tool_policies WHERE server_id = $1
        ORDER BY project, position`,
      [id],
    );
    const policies = new Map<string, McpPolicySetView>();
    for (const r of policyRows.rows) {
      const p = policies.get(r.project) ?? { project: r.project, rules: [], updatedAt: null };
      p.rules.push({ tool: r.tool_glob, effect: r.effect });
      const at = r.updated_at.toISOString();
      policies.set(r.project, {
        ...p,
        updatedAt: p.updatedAt === null || at > p.updatedAt ? at : p.updatedAt,
      });
    }
    const secrets = await db.query<{
      project: string;
      slot: string;
      vault_credential_id: string;
      name: string | null;
      updated_at: Date;
    }>(
      `SELECT b.project, b.slot, b.vault_credential_id, c.name, b.updated_at
         FROM mcp_secret_bindings b LEFT JOIN vault_credentials c ON c.id = b.vault_credential_id
        WHERE b.server_id = $1 ORDER BY b.project, b.slot`,
      [id],
    );
    const assignments = await db.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM mcp_assignments WHERE server_id = $1 ORDER BY project`,
      [id],
    );
    return {
      server: await this.#summary(db, s),
      versions: versions.map(versionView),
      tools: tools.rows.map((t) => ({
        version: t.version,
        name: t.name,
        description: t.description,
        schemaSha256: t.schema_sha256,
        readOnlyHint: t.read_only_hint,
        suggestedAllow: mcpToolLooksReadOnly(t.name, t.read_only_hint),
        effect: mcpToolEffect(rules, t.name),
        probedOnWorker: t.probed_on_worker,
        probedAt: t.probed_at.toISOString(),
      })),
      policies: [...policies.values()],
      secrets: secrets.rows.map((b) => ({
        project: b.project,
        slot: b.slot,
        credentialId: b.vault_credential_id,
        credentialName: b.name,
        updatedAt: b.updated_at.toISOString(),
      })),
      assignments: assignments.rows.map(assignmentView),
      probes: await this.#probes(db, id),
      installs: await this.stdio.installViews(db, id),
      lockfiles: await this.stdio.lockViews(db, id),
      installActions: await this.stdio.actions(id),
      stdioWorkers: await this.stdio.workers(),
    };
  }

  async #probes(db: Queryable, id: string): Promise<McpProbeView[]> {
    const { rows } = await db.query<{
      id: string;
      worker_id: string;
      params: Record<string, unknown>;
      state: string;
      reason: string | null;
      detail: string | null;
      result: { mcpProbe?: { toolCount?: number } } | null;
      requested_at: Date;
      updated_at: Date;
    }>(
      `SELECT id::text AS id, worker_id, params, state, reason, detail, result, requested_at, updated_at
         FROM worker_ops WHERE kind = 'mcp.probe' AND params ->> 'serverId' = $1
        ORDER BY requested_at DESC LIMIT ${String(MAX_PROBE_LIST)}`,
      [id],
    );
    return rows.map((r) => {
      const state: McpProbeView['state'] =
        r.state === 'succeeded'
          ? 'succeeded'
          : r.state === 'sent' || r.state === 'accepted'
            ? 'pending'
            : r.state === 'running'
              ? 'running'
              : 'failed';
      return {
        opId: r.id,
        workerId: r.worker_id,
        version: typeof r.params.version === 'string' ? r.params.version : '',
        state,
        error: state === 'failed' ? (r.detail ?? r.reason ?? r.state) : null,
        toolCount: typeof r.result?.mcpProbe?.toolCount === 'number' ? r.result.mcpProbe.toolCount : null,
        at: r.updated_at.toISOString(),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------ publish

  /** A new server or a new version of one, signed with the panel key (the route requires an always-fresh step-up). */
  async publish(
    user: ContextActor,
    input: McpPublishInput,
    meta: RequestMeta = {},
  ): Promise<{ server: McpServerSummary; version: McpVersionView }> {
    this.#privileged(user);
    // p14-mcp-stdio: a local server names its package; a remote one its URL — never both.
    if (
      input.transport === 'stdio'
        ? input.package === undefined || input.url !== undefined
        : input.url === undefined
    ) {
      throw new HttpError(
        422,
        'mcp_stdio_spec_invalid',
        input.transport === 'stdio'
          ? 'A local (stdio) server needs its package (npm / PyPI, exact version, integrity) and no URL.'
          : 'A remote server needs its URL.',
      );
    }
    const key = this.panelKey;
    if (key === null) {
      throw new HttpError(
        503,
        'mcp_panel_key_missing',
        'SKILLS_PANEL_KEY_FILE is not configured on the master: MCP server specs cannot be signed.',
      );
    }
    if (!McpServerId.safeParse(input.id).success) {
      throw new HttpError(
        422,
        'mcp_spec_invalid',
        `Invalid MCP server id: ${input.id}.`,
        {},
        {},
        {
          detail: 'id',
        },
      );
    }
    const values = (
      v: Readonly<Record<string, string | { secret: string; format?: string | undefined }>> | undefined,
    ) =>
      Object.fromEntries(
        Object.entries(v ?? {}).map(([k, x]) => [
          k,
          typeof x === 'string'
            ? x
            : { secret: x.secret, ...(x.format === undefined ? {} : { format: x.format }) },
        ]),
      );
    const pkg = input.package;
    const sourceRef =
      pkg === undefined ? (input.url ?? '').slice(0, 512) : `${pkg.name}@${pkg.version}`.slice(0, 512);
    const source =
      input.source !== undefined
        ? {
            kind: input.source.kind,
            ref: input.source.ref.slice(0, 512),
            ...(input.source.registry === undefined ? {} : { registry: input.source.registry }),
          }
        : pkg === undefined
          ? { kind: 'url' as const, ref: sourceRef }
          : {
              kind: pkg.manager,
              ref: sourceRef,
              registry: pkg.manager === 'npm' ? 'registry.npmjs.org' : 'pypi.org',
            };
    const remote = {
      url: input.url ?? '',
      ...(input.headers === undefined || Object.keys(input.headers).length === 0
        ? {}
        : {
            headers: Object.fromEntries(
              Object.entries(input.headers).map(([k, v]) => [
                k,
                typeof v === 'string'
                  ? v
                  : { secret: v.secret, ...(v.format === undefined ? {} : { format: v.format }) },
              ]),
            ),
          }),
    };
    let packed: ReturnType<PanelSkillsKey['packMcp']>;
    try {
      packed = key.packMcp({
        id: input.id,
        version: input.version,
        transport: input.transport,
        ...(pkg !== undefined
          ? {
              stdio: {
                package: {
                  manager: pkg.manager,
                  name: pkg.name,
                  version: pkg.version,
                  integrity: pkg.integrity,
                },
                bin: pkg.bin,
                ...(pkg.args === undefined || pkg.args.length === 0 ? {} : { args: [...pkg.args] }),
                ...(pkg.env === undefined || Object.keys(pkg.env).length === 0
                  ? {}
                  : { env: values(pkg.env) }),
              },
            }
          : input.transport === 'http'
            ? { http: remote }
            : { sse: remote }),
        secrets: (input.secrets ?? []).map((s) => ({ slot: s.slot, kind: 'generic' as const, why: s.why })),
        egressHosts: [...(input.egressHosts ?? [])],
        runtimes: [...input.runtimes],
        limits: {
          startupTimeoutSec: input.limits?.startupTimeoutSec ?? MCP_STARTUP_TIMEOUT_DEFAULT_SEC,
          toolTimeoutSec: input.limits?.toolTimeoutSec ?? MCP_TOOL_TIMEOUT_DEFAULT_SEC,
        },
        source,
        createdAt: this.#clock().toISOString(),
      });
    } catch (err) {
      const detail = specProblem(err);
      await this.#audit(user, 'mcp.publish', 'denied', `mcp:${input.id}`, { reason: 'invalid_spec' }, meta);
      throw new HttpError(
        422,
        'mcp_spec_invalid',
        `The MCP server spec is invalid: ${detail}.`,
        {},
        {},
        {
          detail,
        },
      );
    }
    const now = this.#clock();
    const bytes = Buffer.from(packed.signed.spec, 'base64');
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mcp-server:${input.id}`]);
      const existing = await tx.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM mcp_servers WHERE id = $1',
        [input.id],
      );
      if (existing.rows[0]?.archived_at != null) {
        throw new HttpError(
          409,
          'mcp_server_archived',
          `MCP server ${input.id} is archived.`,
          {},
          {},
          {
            id: input.id,
          },
        );
      }
      const dup = await tx.query('SELECT 1 FROM mcp_server_versions WHERE server_id = $1 AND version = $2', [
        input.id,
        input.version,
      ]);
      if ((dup.rowCount ?? 0) > 0) {
        throw new HttpError(
          409,
          'mcp_version_exists',
          `MCP server ${input.id} already has version ${input.version}; versions are immutable — publish a new one.`,
          {},
          {},
          { id: input.id, version: input.version },
        );
      }
      if (existing.rows[0] === undefined) {
        await tx.query(
          `INSERT INTO mcp_servers (id, title, description, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.title, input.description ?? '', user.id, now],
        );
      } else {
        await tx.query('UPDATE mcp_servers SET title = $2, description = $3 WHERE id = $1', [
          input.id,
          input.title,
          input.description ?? '',
        ]);
      }
      const hosts = mcpSpecEgressHosts(packed.spec);
      const { rows } = await tx.query<VersionRow>(
        `INSERT INTO mcp_server_versions (server_id, version, transport, spec, spec_sha256, signature, key_id, signer,
                                          egress_hosts, runtimes, provenance, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'panel', $8, $9, $10, $11, $12)
         RETURNING ${VERSION_COLUMNS}`,
        [
          input.id,
          input.version,
          input.transport,
          bytes,
          packed.specSha256,
          packed.signed.signature.signature,
          packed.signed.signature.keyId,
          packed.spec.egressHosts,
          packed.spec.runtimes,
          JSON.stringify(source),
          user.id,
          now,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('MCP version not stored');
      await this.#audit(
        user,
        'mcp.publish',
        'success',
        `mcp:${input.id}`,
        {
          serverId: input.id,
          version: input.version,
          transport: input.transport,
          hosts,
          ...(pkg === undefined
            ? {}
            : { package: `${pkg.manager}:${pkg.name}@${pkg.version}`, integrity: pkg.integrity }),
          runtimes: packed.spec.runtimes,
          slots: packed.spec.secrets.map((s) => s.slot),
          signer: 'panel',
          keyId: packed.signed.signature.keyId,
          specSha256: packed.specSha256,
        },
        meta,
        tx,
      );
      const s = await this.#server(tx, input.id);
      return { server: await this.#summary(tx, s), version: versionView(row) };
    });
  }

  /** Archive: the server leaves every project (assignments removed); its versions stay for pinned jobs' history. */
  async archive(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#privileged(user);
    await withTransaction(this.deps.pool, async (tx) => {
      const s = await this.#server(tx, id);
      if (s.archived_at !== null) return;
      const removed = await tx.query<{ project: string }>(
        'DELETE FROM mcp_assignments WHERE server_id = $1 RETURNING project',
        [id],
      );
      await tx.query('UPDATE mcp_servers SET archived_at = $2 WHERE id = $1', [id, this.#clock()]);
      await this.#audit(
        user,
        'mcp.archive',
        'success',
        `mcp:${id}`,
        { serverId: id, unassigned: removed.rows.map((r) => r.project) },
        meta,
        tx,
      );
    });
  }

  // ------------------------------------------------------------------------------------------- secrets, policy

  async setSecrets(
    user: ContextActor,
    id: string,
    input: { project?: string | undefined; bindings: readonly { slot: string; credentialId: string }[] },
    meta: RequestMeta = {},
  ): Promise<McpBindingView[]> {
    this.#privileged(user);
    const project = input.project ?? '*';
    this.#projectRef(project);
    return withTransaction(this.deps.pool, async (tx) => {
      await this.#server(tx, id);
      if (project !== '*') await this.#projectExists(tx, project);
      const declared = await this.#declaredSlots(tx, id);
      const seen = new Set<string>();
      for (const b of input.bindings) {
        if (!declared.has(b.slot)) {
          throw new HttpError(
            422,
            'mcp_secret_slot_unknown',
            `No version of MCP server ${id} declares the secret slot ${b.slot}.`,
            {},
            {},
            { slot: b.slot },
          );
        }
        if (seen.has(b.slot)) {
          throw new HttpError(
            422,
            'mcp_secret_slot_unknown',
            `Slot ${b.slot} is bound twice.`,
            {},
            {},
            {
              slot: b.slot,
            },
          );
        }
        seen.add(b.slot);
        // p14-workflow-engine 14.3: http-auth / smtp credentials are bound to workflow hosts, never MCP headers.
        const cred = await tx.query(
          "SELECT 1 FROM vault_credentials WHERE id = $1 AND state = 'active' AND kind NOT IN ('http-auth', 'smtp', 'git-ssh-key', 'git-https-token')",
          [b.credentialId],
        );
        if ((cred.rowCount ?? 0) === 0)
          throw new HttpError(404, 'not_found', 'Credential not found.', {}, {}, { reason: 'credential' });
      }
      await tx.query('DELETE FROM mcp_secret_bindings WHERE server_id = $1 AND project = $2', [id, project]);
      const now = this.#clock();
      for (const b of input.bindings) {
        await tx.query(
          `INSERT INTO mcp_secret_bindings (server_id, project, slot, vault_credential_id, created_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, project, b.slot, b.credentialId, user.id, now],
        );
      }
      await this.#audit(
        user,
        'mcp.secrets.bind',
        'success',
        `mcp:${id}`,
        {
          serverId: id,
          project,
          bindings: input.bindings.map((b) => ({ slot: b.slot, vaultId: b.credentialId })),
        },
        meta,
        tx,
      );
      const { rows } = await tx.query<{
        project: string;
        slot: string;
        vault_credential_id: string;
        updated_at: Date;
      }>(
        `SELECT project, slot, vault_credential_id, updated_at FROM mcp_secret_bindings WHERE server_id = $1
          ORDER BY project, slot`,
        [id],
      );
      return rows.map((b) => ({
        project: b.project,
        slot: b.slot,
        credentialId: b.vault_credential_id,
        updatedAt: b.updated_at.toISOString(),
      }));
    });
  }

  async setToolPolicy(
    user: ContextActor,
    id: string,
    input: { project?: string | undefined; rules: readonly McpToolRule[] },
    meta: RequestMeta = {},
  ): Promise<McpPolicySetView[]> {
    this.#privileged(user);
    const project = input.project ?? '*';
    this.#projectRef(project);
    const parsed = McpToolRules.safeParse(input.rules);
    if (!parsed.success || input.rules.length > MAX_MCP_TOOL_RULES) {
      throw new HttpError(
        422,
        'mcp_spec_invalid',
        `The tool policy is invalid: at most ${String(MAX_MCP_TOOL_RULES)} rules of a tool glob and allow / ask / deny.`,
        {},
        {},
        { detail: 'rules' },
      );
    }
    await withTransaction(this.deps.pool, async (tx) => {
      await this.#server(tx, id);
      if (project !== '*') await this.#projectExists(tx, project);
      await this.#writeRules(tx, id, project, parsed.data, user.id);
      await this.#audit(
        user,
        'mcp.tool_policy',
        'success',
        `mcp:${id}`,
        { serverId: id, project, rules: parsed.data.length, policySha256: mcpPolicySha256(parsed.data) },
        meta,
        tx,
      );
    });
    return (await this.detail(id)).policies;
  }

  async #writeRules(
    tx: Queryable,
    id: string,
    project: string,
    rules: readonly McpToolRule[],
    userId: string | null,
  ): Promise<void> {
    await tx.query('DELETE FROM mcp_tool_policies WHERE server_id = $1 AND project = $2', [id, project]);
    const now = this.#clock();
    for (const [i, r] of rules.entries()) {
      await tx.query(
        `INSERT INTO mcp_tool_policies (server_id, project, position, tool_glob, effect, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, project, i, r.tool, r.effect, userId, now],
      );
    }
  }

  async #rules(db: Queryable, id: string, project: string): Promise<McpToolRule[]> {
    const { rows } = await db.query<{ tool_glob: string; effect: McpToolEffect }>(
      'SELECT tool_glob, effect FROM mcp_tool_policies WHERE server_id = $1 AND project = $2 ORDER BY position',
      [id, project],
    );
    return rows.map((r) => ({ tool: r.tool_glob, effect: r.effect }));
  }

  /** A project-specific policy wins over the `'*'` one (no rows at all = every tool denied). */
  async #effectiveRules(db: Queryable, id: string, project: string): Promise<McpToolRule[]> {
    const own = await this.#rules(db, id, project);
    if (own.length > 0) return own;
    return this.#rules(db, id, '*');
  }

  async #declaredSlots(db: Queryable, id: string): Promise<Set<string>> {
    const { rows } = await db.query<{ spec: Buffer }>(
      'SELECT spec FROM mcp_server_versions WHERE server_id = $1',
      [id],
    );
    const out = new Set<string>();
    for (const r of rows) for (const s of parseStoredSpec(r.spec)?.secrets ?? []) out.add(s.slot);
    return out;
  }

  // -------------------------------------------------------------------------------------------------- probe

  /** Sends `mcp.probe` for one version to one `mcp-v1` worker (the master never connects to the server). */
  async probe(
    user: ContextActor,
    id: string,
    version: string,
    workerId: string,
    meta: RequestMeta = {},
  ): Promise<{ opId: string }> {
    this.#privileged(user);
    return this.#sendProbe(user.id, id, version, workerId, meta, false);
  }

  /**
   * p14-mcp-chat: the tool discovery a confirmed install card starts by itself (the remote server right after the
   * publish, a local one when its canary reports it installed). The admin who confirmed the card (fresh code) is the
   * actor; every check of {@link probe} applies except the step-up, which the confirmation already had. Answers why
   * not instead of throwing for the expected cases (no machine, tokens not bound yet, probed moments ago).
   */
  async autoProbe(
    userId: string,
    id: string,
    version: string,
    workerId: string | null,
    meta: RequestMeta = {},
  ): Promise<{ opId: string } | { skipped: string }> {
    let target = workerId;
    if (target === null) {
      const all = await this.mcpWorkers();
      target = all.find((w) => w.connected)?.id ?? null;
    }
    if (target === null) return { skipped: 'no_machine' };
    try {
      return await this.#sendProbe(userId, id, version, target, meta, true);
    } catch (err) {
      if (err instanceof HttpError) {
        return { skipped: err.code.slice(0, 64) };
      }
      throw err;
    }
  }

  async #sendProbe(
    userId: string,
    id: string,
    version: string,
    workerId: string,
    meta: RequestMeta,
    auto: boolean,
  ): Promise<{ opId: string }> {
    const sender = this.deps.probes?.() ?? null;
    if (sender === null)
      throw new HttpError(
        503,
        'mcp_probe_unavailable',
        'Remote operations are not available on this master.',
      );
    const db = this.deps.pool;
    const s = await this.#server(db, id);
    if (s.archived_at !== null) {
      throw new HttpError(409, 'mcp_server_archived', `MCP server ${id} is archived.`, {}, {}, { id });
    }
    const v = await this.#version(db, id, version);
    const w = await db.query<{ ok: boolean }>(
      `SELECT (features ? $2) AS ok FROM workers WHERE id = $1 AND approved_at IS NOT NULL AND revoked_at IS NULL`,
      [workerId, MCP_FEATURE],
    );
    if (w.rows[0] === undefined) {
      throw new HttpError(404, 'worker_not_found', 'Worker not found.', {}, {}, { reason: 'not_found' });
    }
    if (!w.rows[0].ok) {
      throw new HttpError(
        409,
        'mcp_worker_unsupported',
        'This worker build cannot use external MCP servers (mcp-v1); update it or choose another machine.',
      );
    }
    // p14-mcp-stdio: a local server is probed only where exactly this version is installed (the worker starts it).
    if (v.transport === 'stdio') {
      const inst = await db.query<{ stdio: boolean; installed: boolean }>(
        `SELECT (w.features ? $3) AS stdio,
                EXISTS (SELECT 1 FROM mcp_worker_installs i
                         WHERE i.worker_id = w.id AND i.server_id = $1 AND i.version = $2 AND i.state = 'installed')
                  AS installed
           FROM workers w WHERE w.id = $4`,
        [id, version, MCP_STDIO_FEATURE, workerId],
      );
      if (inst.rows[0]?.stdio !== true) {
        throw new HttpError(
          409,
          'mcp_install_unsupported',
          'This worker build cannot install local MCP packages (mcp-stdio-v1); update it.',
        );
      }
      if (!inst.rows[0].installed) {
        throw new HttpError(
          409,
          'mcp_not_installed',
          `${id}@${version} is not installed on this machine; install it first.`,
          {},
          {},
          { server: `${id}@${version}` },
        );
      }
    }
    const recent = await db.query<{ requested_at: Date }>(
      `SELECT requested_at FROM worker_ops WHERE kind = 'mcp.probe' AND params ->> 'serverId' = $1
          AND requested_at > $2 ORDER BY requested_at DESC LIMIT 1`,
      [id, new Date(this.#clock().getTime() - MCP_PROBE_INTERVAL_MS)],
    );
    const last = recent.rows[0];
    if (last !== undefined) {
      const seconds = Math.max(
        1,
        Math.ceil((last.requested_at.getTime() + MCP_PROBE_INTERVAL_MS - this.#clock().getTime()) / 1000),
      );
      throw new HttpError(
        429,
        'mcp_probe_rate_limited',
        `This server's tools were read moments ago; try again in ${String(seconds)} seconds.`,
        { 'retry-after': String(seconds) },
        {},
        { seconds },
      );
    }
    const spec = parseStoredSpec(v.spec);
    const slots = spec === null ? [] : mcpReferencedSlots(spec);
    const secrets: { slot: string; ref: string }[] = [];
    for (const slot of slots) {
      const b = await db.query<{ vault_credential_id: string }>(
        `SELECT vault_credential_id FROM mcp_secret_bindings WHERE server_id = $1 AND project = '*' AND slot = $2`,
        [id, slot],
      );
      const cred = b.rows[0]?.vault_credential_id;
      if (cred === undefined) {
        throw new HttpError(
          409,
          'mcp_secret_unbound',
          `Secret slot ${slot} of MCP server ${id} is not bound to a vault credential (for all projects).`,
          {},
          {},
          { slot },
        );
      }
      secrets.push({ slot, ref: `secret:vault-${cred}` });
    }
    const op = await sender.request(
      workerId,
      {
        kind: 'mcp.probe',
        server: { spec: v.spec.toString('base64'), signature: { keyId: v.key_id, signature: v.signature } },
        secrets,
      },
      { userId, ip: meta.ip ?? '', userAgent: meta.userAgent ?? null },
    );
    await this.#audit(
      { id: userId, role: 'admin', mfaAt: null },
      'mcp.probe',
      'success',
      `mcp:${id}`,
      {
        serverId: id,
        version,
        workerId,
        opId: op.id,
        specSha256: v.spec_sha256,
        ...(auto ? { auto: true } : {}),
      },
      meta,
    );
    return { opId: op.id };
  }

  /** OPS_UPDATE of a finished `mcp.probe`: store the tools (untrusted text), seed `ask` rules on the first probe. */
  async onProbeFinished(input: {
    readonly workerId: string;
    readonly opId: string;
    readonly params: Record<string, unknown>;
    readonly state: string;
    readonly reason: string | null;
    readonly report: McpProbeReport | undefined;
  }): Promise<void> {
    const id = typeof input.params.serverId === 'string' ? input.params.serverId : null;
    const version = typeof input.params.version === 'string' ? input.params.version : null;
    if (id === null || version === null) return;
    const ok = input.state === 'succeeded' && input.report !== undefined;
    await withTransaction(this.deps.pool, async (tx) => {
      const v = await tx.query<{ spec_sha256: string }>(
        'SELECT spec_sha256 FROM mcp_server_versions WHERE server_id = $1 AND version = $2',
        [id, version],
      );
      // The op names the exact spec it probed; a mismatch is not stored.
      if (v.rows[0] === undefined || v.rows[0].spec_sha256 !== input.params.specSha256) return;
      let seeded = 0;
      if (ok) {
        const report = input.report;
        const now = this.#clock();
        await tx.query('DELETE FROM mcp_server_tools WHERE server_id = $1 AND version = $2', [id, version]);
        const seen = new Set<string>();
        for (const t of report.tools) {
          if (seen.has(t.name)) continue;
          seen.add(t.name);
          await tx.query(
            `INSERT INTO mcp_server_tools (server_id, version, name, description, schema_sha256, read_only_hint,
                                           probed_on_worker, probed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              id,
              version,
              t.name,
              clipBytes(t.description, 1024),
              t.schemaSha256,
              t.readOnlyHint ?? null,
              input.workerId,
              now,
            ],
          );
        }
        // ADR-0054 decision 3: after install every tool asks; tools the policy never names stay denied.
        if ((await this.#rules(tx, id, '*')).length === 0 && seen.size > 0) {
          const names = [...seen]
            .slice(0, MAX_MCP_TOOL_RULES)
            .filter((n) => /^[A-Za-z0-9_./-]{1,128}$/.test(n));
          await this.#writeRules(
            tx,
            id,
            '*',
            names.map((n) => ({ tool: n, effect: 'ask' as const })),
            null,
          );
          seeded = names.length;
        }
      }
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: input.workerId },
          action: 'mcp.probe.result',
          target: `mcp:${id}`,
          outcome: ok ? 'success' : 'failure',
          metadata: {
            serverId: id,
            version,
            opId: input.opId,
            state: input.state,
            ...(input.reason === null ? {} : { reason: input.reason }),
            ...(ok ? { tools: input.report.tools.length, seededAsk: seeded } : {}),
          },
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------------------------------- assignments

  async assign(
    user: ContextActor,
    input: {
      serverId: string;
      project: string;
      runtimes?: readonly RuntimeKind[] | null | undefined;
      version?: string | null | undefined;
    },
    meta: RequestMeta = {},
  ): Promise<McpAssignmentView> {
    this.#privileged(user);
    this.#projectRef(input.project);
    const runtimes =
      input.runtimes === undefined || input.runtimes === null ? null : [...new Set(input.runtimes)].sort();
    if (
      runtimes !== null &&
      (runtimes.length === 0 || runtimes.some((r) => !RuntimeKindSchema.safeParse(r).success))
    ) {
      throw new HttpError(400, 'invalid_runtimes', 'Runtimes must be a non-empty list of known runtimes.');
    }
    const version = input.version ?? null;
    if (version !== null && !ReleaseVersion.safeParse(version).success) {
      throw new HttpError(
        400,
        'invalid_version',
        'Version must be a semantic version.',
        {},
        {},
        {
          reason: 'semver',
        },
      );
    }
    return withTransaction(this.deps.pool, async (tx) => {
      const s = await this.#server(tx, input.serverId);
      if (s.archived_at !== null) {
        throw new HttpError(
          409,
          'mcp_server_archived',
          `MCP server ${input.serverId} is archived.`,
          {},
          {},
          {
            id: input.serverId,
          },
        );
      }
      if (input.project !== '*') await this.#projectExists(tx, input.project);
      if (version !== null) await this.#version(tx, input.serverId, version);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mcp-assign:${input.project}`]);
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM mcp_assignments WHERE project = $1 AND server_id <> $2',
        [input.project, input.serverId],
      );
      if ((count.rows[0]?.n ?? 0) >= MAX_MCP_ASSIGNMENTS_PER_PROJECT) {
        throw new HttpError(
          409,
          'mcp_assignment_limit',
          `At most ${String(MAX_MCP_ASSIGNMENTS_PER_PROJECT)} MCP servers per project.`,
          {},
          {},
          { max: MAX_MCP_ASSIGNMENTS_PER_PROJECT },
        );
      }
      const now = this.#clock();
      const { rows } = await tx.query<AssignmentRow>(
        `INSERT INTO mcp_assignments (server_id, project, runtimes, version, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (server_id, project) DO UPDATE SET runtimes = EXCLUDED.runtimes, version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [input.serverId, input.project, runtimes, version, user.id, now],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('assignment not stored');
      await this.#audit(
        user,
        'mcp.assign',
        'success',
        `mcp:${input.serverId}`,
        { serverId: input.serverId, project: input.project, runtimes, version },
        meta,
        tx,
      );
      return assignmentView(row);
    });
  }

  async unassign(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#privileged(user);
    if (!UUID.test(id))
      throw new HttpError(404, 'not_found', 'Assignment not found.', {}, {}, { reason: 'assignment' });
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<AssignmentRow>(
        `DELETE FROM mcp_assignments WHERE id = $1 RETURNING ${ASSIGNMENT_COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (row === undefined)
        throw new HttpError(404, 'not_found', 'Assignment not found.', {}, {}, { reason: 'assignment' });
      await this.#audit(
        user,
        'mcp.unassign',
        'success',
        `mcp:${row.server_id}`,
        { serverId: row.server_id, project: row.project },
        meta,
        tx,
      );
    });
  }

  // ---------------------------------------------------------------------------------------- project switch

  async project(project: string): Promise<McpProjectView> {
    if (!PROJECT.test(project)) throw new HttpError(404, 'project_not_found', 'Project not found.');
    await this.#projectExists(this.deps.pool, project);
    const { rows } = await this.deps.pool.query<{
      allowed: boolean;
      updated_at: Date;
      updated_by: string | null;
    }>(
      'SELECT allowed, updated_at, updated_by::text AS updated_by FROM project_mcp_settings WHERE project_id = $1',
      [project],
    );
    const a = await this.deps.pool.query<AssignmentRow & { title: string }>(
      `SELECT a.id::text AS id, a.server_id, a.project, a.runtimes, a.version, a.created_at, s.title
         FROM mcp_assignments a JOIN mcp_servers s ON s.id = a.server_id
        WHERE (a.project = $1 OR a.project = '*') AND s.archived_at IS NULL
        ORDER BY a.server_id, (a.project = '*')`,
      [project],
    );
    return {
      allowed: rows[0]?.allowed === true,
      updatedAt: rows[0]?.updated_at.toISOString() ?? null,
      updatedBy: rows[0]?.updated_by ?? null,
      assignments: a.rows.map((r) => ({ ...assignmentView(r), title: r.title })),
    };
  }

  async setProject(
    user: ContextActor,
    project: string,
    allowed: boolean,
    meta: RequestMeta = {},
  ): Promise<McpProjectView> {
    this.#privileged(user);
    if (!PROJECT.test(project)) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const before = await withTransaction(this.deps.pool, async (tx) => {
      await this.#projectExists(tx, project);
      const prev = await tx.query<{ allowed: boolean }>(
        'SELECT allowed FROM project_mcp_settings WHERE project_id = $1 FOR UPDATE',
        [project],
      );
      const was = prev.rows[0]?.allowed === true;
      await tx.query(
        `INSERT INTO project_mcp_settings (project_id, allowed, updated_by, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id) DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [project, allowed, user.id, this.#clock()],
      );
      await this.#audit(
        user,
        'project.mcp',
        'success',
        `project:${project}`,
        { project, from: was, to: allowed },
        meta,
        tx,
      );
      return was;
    });
    if (allowed && !before) await this.#notifyEnabled(user, project);
    return this.project(project);
  }

  async #notifyEnabled(user: ContextActor, project: string): Promise<void> {
    const notifier = this.deps.notify?.() ?? null;
    if (notifier === null) return;
    try {
      const who = await this.deps.pool
        .query<{ username: string }>('SELECT username FROM users WHERE id = $1', [user.id])
        .then((r) => r.rows[0]?.username ?? user.id);
      const at = this.#clock().toISOString();
      await notifier.notify(this.deps.pool, await globalRecipients(this.deps.pool, 'owner'), {
        kind: 'mcp.project_enabled',
        severity: 'critical',
        title: `MCP turned on for project ${project}`,
        body: `${who} turned on external MCP servers for project ${project}. Its jobs now get the MCP servers assigned to it, with their bound tokens and the servers' network hosts. If this was not you, turn the switch off and review the audit log.`,
        link: `/projects/${encodeURIComponent(project)}`,
        dedupeKey: `mcp.project_enabled:${project}:${at}`,
      });
    } catch {
      // A notification failure never undoes the change (the audit row is written).
    }
  }

  // ------------------------------------------------------------------------------------------- job delivery

  /**
   * The job's ASSIGN_JOB `mcp`. The first call pins the servers (or `'none'` with a skip reason); later calls
   * return exactly the pinned versions and rules, re-verified. Throws {@link McpUnavailableError} when a pinned server
   * cannot be delivered (the job becomes infeasible). `null`: the job gets no MCP.
   */
  async issueForJob(jobId: string, workerId: string): Promise<AssignedMcp | null> {
    try {
      return await this.#issue(jobId, workerId);
    } catch (err) {
      if (err instanceof McpUnavailableError) {
        this.#issueFailures?.add(1, { reason: err.message.split(' ')[0] ?? 'error' });
        await this.deps.audit
          .record({
            actor: { type: 'system', id: 'scheduler' },
            action: 'mcp.issue',
            target: `job:${jobId}`,
            outcome: 'failure',
            metadata: { jobId, workerId, reason: err.message.slice(0, 300) },
          })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  async #issue(jobId: string, workerId: string): Promise<AssignedMcp | null> {
    if (!UUID.test(jobId)) return null;
    return withTransaction(this.deps.pool, async (tx) => {
      const j = await this.#job(tx, jobId);
      if (j === null) return null;
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`job-mcp:${jobId}`]);
      const set = await tx.query<{ set_hash: string }>(
        'SELECT set_hash FROM job_mcp_sets WHERE job_id = $1',
        [jobId],
      );
      let resolved: ResolvedServer[];
      let fresh = false;
      if (set.rows[0] !== undefined) {
        if (set.rows[0].set_hash === 'none') return null;
        // Pinned: the switch must still be on (fail closed when it was turned off after pinning).
        if (!(await this.#allowed(tx, j.project))) {
          throw new McpUnavailableError(
            'project_switch_off: MCP was turned off for the project after this job pinned its servers',
          );
        }
        resolved = await this.#pinned(tx, jobId, j.project);
      } else {
        const skip = await this.#skipReason(tx, j);
        const candidates = skip === null ? await this.#resolve(tx, j.project, j.runtime) : [];
        const now = this.#clock();
        if (skip !== null || candidates.length === 0) {
          const assignedAny =
            skip === null ? false : (await this.#assignmentsFor(tx, j.project, j.runtime)).length > 0;
          await tx.query(
            `INSERT INTO job_mcp_sets (job_id, set_hash, pinned_at, skipped) VALUES ($1, 'none', $2, $3)`,
            [jobId, now, assignedAny ? skip : null],
          );
          return null;
        }
        resolved = candidates;
        fresh = true;
        const hosts = [...new Set(resolved.flatMap((r) => mcpSpecEgressHosts(r.spec)))].sort();
        if (hosts.length > MAX_JOB_MCP_EGRESS_HOSTS) {
          throw new McpUnavailableError(
            `egress_hosts: the job's MCP servers need ${String(hosts.length)} hosts (limit ${String(MAX_JOB_MCP_EGRESS_HOSTS)})`,
          );
        }
        for (const r of resolved) {
          await tx.query(
            `INSERT INTO job_mcp_pins (job_id, server_id, version, spec_sha256, policy_sha256, pinned_at, rules)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              jobId,
              r.pin.id,
              r.pin.version,
              r.pin.specSha256,
              r.pin.policySha256,
              now,
              JSON.stringify(r.rules),
            ],
          );
        }
        await tx.query(
          `INSERT INTO job_mcp_sets (job_id, set_hash, pinned_at, egress_hosts) VALUES ($1, $2, $3, $4)`,
          [jobId, mcpSetHash(resolved.map((r) => r.pin)), now, hosts],
        );
      }
      const worker = await tx.query<{ ok: boolean; stdio: boolean }>(
        'SELECT (features ? $2) AS ok, (features ? $3) AS stdio FROM workers WHERE id = $1',
        [workerId, MCP_FEATURE, MCP_STDIO_FEATURE],
      );
      if (worker.rows[0]?.ok !== true) {
        throw new McpWorkerUnsupportedError(`worker ${workerId} has no mcp-v1`);
      }
      // p14-mcp-stdio: every stdio server must be installed on this machine (placement checked it; this is the race).
      const stdioPins = resolved.filter((r) => r.spec.transport === 'stdio').map((r) => r.pin);
      if (stdioPins.length > 0) {
        if (!worker.rows[0].stdio) {
          throw new McpWorkerUnsupportedError(`worker ${workerId} has no mcp-stdio-v1`);
        }
        const have = await this.stdio.installedWorkers(tx, stdioPins);
        if (!have.includes(workerId)) {
          throw new McpWorkerUnsupportedError(`worker ${workerId} lacks a local MCP install of this job`);
        }
      }
      const setHash = mcpSetHash(resolved.map((r) => r.pin));
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'scheduler' },
          action: 'mcp.issue',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: {
            jobId,
            workerId,
            setHash,
            pinned: fresh,
            servers: resolved.map((r) => `${r.pin.id}@${r.pin.version}`),
          },
        },
        tx,
      );
      return {
        setHash,
        servers: resolved.map((r) => r.signed),
        policies: resolved.map((r) => ({ server: r.pin.id, rules: r.rules })),
        secrets: resolved.flatMap((r) =>
          r.secrets.map((s) => ({ server: r.pin.id, slot: s.slot, ref: `secret:vault-${s.credentialId}` })),
        ),
      };
    });
  }

  /**
   * Placement facts: whether the job will get MCP (pinned or would-be) and which vault credentials its workers must
   * hold. Undefined = no MCP (also on any doubt: the issue itself fails closed later).
   */
  async placementFor(jobId: string): Promise<McpPlacementFacts | undefined> {
    if (!UUID.test(jobId)) return undefined;
    const db = this.deps.pool;
    const j = await this.#job(db, jobId);
    if (j === null) return undefined;
    const set = await db.query<{ set_hash: string }>('SELECT set_hash FROM job_mcp_sets WHERE job_id = $1', [
      jobId,
    ]);
    let credentials: string[];
    if (set.rows[0] !== undefined) {
      if (set.rows[0].set_hash === 'none') return undefined;
      const pins = await db.query<{ server_id: string; version: string }>(
        'SELECT server_id, version FROM job_mcp_pins WHERE job_id = $1',
        [jobId],
      );
      credentials = [];
      for (const p of pins.rows) {
        const v = await db.query<{ spec: Buffer }>(
          'SELECT spec FROM mcp_server_versions WHERE server_id = $1 AND version = $2',
          [p.server_id, p.version],
        );
        const spec = v.rows[0] === undefined ? null : parseStoredSpec(v.rows[0].spec);
        for (const slot of spec === null ? [] : mcpReferencedSlots(spec)) {
          const c = await this.#binding(db, p.server_id, j.project, slot);
          if (c !== null) credentials.push(c);
        }
      }
    } else {
      if ((await this.#skipReason(db, j)) !== null) return undefined;
      let resolved: ResolvedServer[];
      try {
        resolved = await this.#resolve(db, j.project, j.runtime);
      } catch {
        return undefined;
      }
      if (resolved.length === 0) return undefined;
      credentials = resolved.flatMap((r) => r.secrets.map((s) => s.credentialId));
    }
    credentials = [...new Set(credentials)].sort();
    const stdio = await this.#stdioPins(db, jobId, j.project, j.runtime, set.rows[0] !== undefined);
    const stdioFacts =
      stdio.length === 0
        ? {}
        : {
            stdio: stdio.map((p) => `${p.id}@${p.version}`),
            installedWorkers: await this.stdio.installedWorkers(db, stdio),
          };
    if (credentials.length === 0) return { credentials, ...stdioFacts };
    const { rows } = await db.query<{ worker_id: string }>(
      `SELECT r.worker_id FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
        WHERE r.credential_id = ANY ($1::text[]) AND r.state = 'active' AND c.state = 'active'
          AND r.acked_version = r.version
        GROUP BY r.worker_id HAVING count(DISTINCT r.credential_id) = $2`,
      [credentials, credentials.length],
    );
    return { credentials, credentialWorkers: rows.map((r) => r.worker_id), ...stdioFacts };
  }

  /** p14-mcp-stdio: the stdio servers (id, version) of a job's pinned or would-be MCP set. */
  async #stdioPins(
    db: Queryable,
    jobId: string,
    project: string,
    runtime: RuntimeKind,
    pinned: boolean,
  ): Promise<{ id: string; version: string }[]> {
    if (pinned) {
      const { rows } = await db.query<{ id: string; version: string }>(
        `SELECT p.server_id AS id, p.version FROM job_mcp_pins p
           JOIN mcp_server_versions v ON v.server_id = p.server_id AND v.version = p.version
          WHERE p.job_id = $1 AND v.transport = 'stdio'`,
        [jobId],
      );
      return rows;
    }
    try {
      return (await this.#resolve(db, project, runtime))
        .filter((r) => r.spec.transport === 'stdio')
        .map((r) => ({ id: r.pin.id, version: r.pin.version }));
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------------------------- p14-mcp-stdio installs

  /** The signed stdio version an install action carries (refuses remote / archived / unknown versions). */
  async #stdioVersion(id: string, version: string) {
    const db = this.deps.pool;
    const s = await this.#server(db, id);
    if (s.archived_at !== null) {
      throw new HttpError(409, 'mcp_server_archived', `MCP server ${id} is archived.`, {}, {}, { id });
    }
    const v = await this.#version(db, id, version);
    const spec = parseStoredSpec(v.spec);
    if (v.transport !== 'stdio' || spec?.stdio === undefined) {
      throw new HttpError(
        422,
        'mcp_stdio_spec_invalid',
        'Only local (stdio) servers are installed on machines; a remote server needs no install.',
        {},
        {},
        { reason: 'install' },
      );
    }
    return {
      serverId: id,
      version,
      specSha256: v.spec_sha256,
      manager: spec.stdio.package.manager,
      signed: { spec: v.spec.toString('base64'), signature: { keyId: v.key_id, signature: v.signature } },
    };
  }

  #fleet(): FleetToolsService {
    const f = this.deps.fleetTools?.() ?? null;
    if (f === null)
      throw new HttpError(
        503,
        'unavailable',
        'The fleet tools service is not available.',
        {},
        {},
        { reason: 'fleet' },
      );
    return f;
  }

  #actor(user: ContextActor, meta: RequestMeta): ActorContext {
    return { userId: user.id, ip: meta.ip ?? '', userAgent: meta.userAgent ?? null };
  }

  /**
   * Installs one stdio version on machines (ADR-0054 decision 2: admin + always-fresh step-up, checked by the route and
   * again here). Without a stored lockfile the rollout is canary-first: one canary resolves the lock.
   */
  async install(
    user: ContextActor,
    id: string,
    version: string,
    input: {
      readonly workers: readonly string[] | 'all';
      readonly rollout?: 'all' | 'canary-first' | undefined;
    },
    meta: RequestMeta = {},
  ): Promise<ActionView> {
    this.#privileged(user);
    const recipe = await this.#stdioVersion(id, version);
    const lock = await this.stdio.lock(id, version);
    return this.#fleet().createMcp(
      {
        kind: 'mcp.install',
        recipe,
        workers: input.workers,
        rollout: input.rollout,
        lockStored: lock !== null,
      },
      this.#actor(user, meta),
    );
  }

  async remove(
    user: ContextActor,
    id: string,
    version: string,
    input: { readonly workers: readonly string[] | 'all' },
    meta: RequestMeta = {},
  ): Promise<ActionView> {
    this.#privileged(user);
    const db = this.deps.pool;
    await this.#server(db, id);
    const v = await this.#version(db, id, version);
    const spec = parseStoredSpec(v.spec);
    if (v.transport !== 'stdio' || spec?.stdio === undefined) {
      throw new HttpError(
        422,
        'mcp_stdio_spec_invalid',
        'Only local (stdio) servers are installed on machines; a remote server needs no install.',
        {},
        {},
        { reason: 'install' },
      );
    }
    return this.#fleet().createMcp(
      {
        kind: 'mcp.remove',
        recipe: {
          serverId: id,
          version,
          specSha256: v.spec_sha256,
          manager: spec.stdio.package.manager,
          signed: { spec: v.spec.toString('base64'), signature: { keyId: v.key_id, signature: v.signature } },
        },
        workers: input.workers,
        lockStored: true,
      },
      this.#actor(user, meta),
    );
  }

  async continueInstall(user: ContextActor, actionId: string, meta: RequestMeta = {}): Promise<ActionView> {
    this.#privileged(user);
    return this.#fleet().continue(actionId, this.#actor(user, meta), { mcp: true });
  }

  async retryInstall(
    user: ContextActor,
    actionId: string,
    workers: readonly string[] | undefined,
    meta: RequestMeta = {},
  ): Promise<ActionView> {
    this.#privileged(user);
    return this.#fleet().retry(actionId, workers, this.#actor(user, meta), { mcp: true });
  }

  async #job(
    db: Queryable,
    jobId: string,
  ): Promise<{
    project: string;
    runtime: RuntimeKind;
    sourceTrust: string | null;
    kind: string | null;
  } | null> {
    const { rows } = await db.query<{
      project: string;
      runtime: string;
      source_trust: string | null;
      kind: string | null;
    }>(
      `SELECT project, spec->>'runtime' AS runtime, spec->>'sourceTrust' AS source_trust, spec->>'kind' AS kind
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const runtime = RuntimeKindSchema.safeParse(r.runtime);
    if (!runtime.success) return null;
    return { project: r.project, runtime: runtime.data, sourceTrust: r.source_trust, kind: r.kind };
  }

  /** Why a job gets no MCP regardless of assignments (null: it may). */
  async #skipReason(
    db: Queryable,
    j: { project: string; sourceTrust: string | null; kind: string | null },
  ): Promise<string | null> {
    if (j.kind === 'integration' || j.kind === 'machine-admin' || j.kind === 'function') return 'job_kind';
    // ADR-0010 §3: fork / external-contributor jobs never get a server with a token.
    if (j.sourceTrust !== 'trusted') return 'untrusted_source';
    if (!(await this.#allowed(db, j.project))) return 'project_switch_off';
    return null;
  }

  async #allowed(db: Queryable, project: string): Promise<boolean> {
    const { rows } = await db.query<{ allowed: boolean }>(
      'SELECT allowed FROM project_mcp_settings WHERE project_id = $1',
      [project],
    );
    return rows[0]?.allowed === true;
  }

  async #assignmentsFor(db: Queryable, project: string, runtime: RuntimeKind): Promise<AssignmentRow[]> {
    const { rows } = await db.query<AssignmentRow>(
      `SELECT a.id::text AS id, a.server_id, a.project, a.runtimes, a.version, a.created_at
         FROM mcp_assignments a JOIN mcp_servers s ON s.id = a.server_id AND s.archived_at IS NULL
        WHERE (a.project = $1 OR a.project = '*') AND (a.runtimes IS NULL OR $2 = ANY (a.runtimes))
        ORDER BY a.server_id, (a.project = '*')`,
      [project, runtime],
    );
    return rows;
  }

  async #resolve(db: Queryable, project: string, runtime: RuntimeKind): Promise<ResolvedServer[]> {
    const out: ResolvedServer[] = [];
    const seen = new Set<string>();
    for (const a of await this.#assignmentsFor(db, project, runtime)) {
      // A project-specific assignment wins over an "all projects" one.
      if (seen.has(a.server_id)) continue;
      seen.add(a.server_id);
      const versions = await db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM mcp_server_versions WHERE server_id = $1`,
        [a.server_id],
      );
      const chosen = versions.rows
        .filter((v) => (a.version === null ? true : v.version === a.version))
        .filter((v) => v.runtimes.includes(runtime))
        .sort(bySemverDesc)[0];
      if (chosen === undefined) continue;
      out.push(await this.#deliver(db, chosen, project));
      if (out.length >= MAX_JOB_MCP_SERVERS) break;
    }
    return out;
  }

  async #pinned(db: Queryable, jobId: string, project: string): Promise<ResolvedServer[]> {
    const pins = await db.query<{
      server_id: string;
      version: string;
      spec_sha256: string;
      policy_sha256: string;
      rules: unknown;
    }>(
      `SELECT server_id, version, spec_sha256, policy_sha256, rules FROM job_mcp_pins WHERE job_id = $1
        ORDER BY server_id`,
      [jobId],
    );
    const out: ResolvedServer[] = [];
    for (const p of pins.rows) {
      const v = await db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM mcp_server_versions WHERE server_id = $1 AND version = $2`,
        [p.server_id, p.version],
      );
      const row = v.rows[0];
      if (row === undefined) throw new McpUnavailableError(`version_gone: ${p.server_id}@${p.version}`);
      if (row.spec_sha256 !== p.spec_sha256)
        throw new McpUnavailableError(`spec_changed: ${p.server_id}@${p.version}`);
      // Retries keep the tool policy snapshot of the first issue (a later policy edit applies to new jobs).
      const snapshot = McpToolRules.safeParse(p.rules);
      if (!snapshot.success || mcpPolicySha256(snapshot.data) !== p.policy_sha256) {
        throw new McpUnavailableError(
          `policy_missing: the pinned tool policy of ${p.server_id} is unreadable`,
        );
      }
      out.push(await this.#deliver(db, row, project, snapshot.data));
    }
    return out;
  }

  async #deliver(
    db: Queryable,
    row: VersionRow,
    project: string,
    pinnedRules?: McpToolRule[],
  ): Promise<ResolvedServer> {
    const signed: SignedMcpSpec = {
      spec: row.spec.toString('base64'),
      signature: { keyId: row.key_id, signature: row.signature },
    };
    const verified = verifyMcpSpec(signed, this.#trusted);
    if (!verified.ok) {
      throw new McpUnavailableError(
        `signature: ${row.server_id}@${row.version} does not verify (${verified.reason})`,
      );
    }
    if (verified.specSha256 !== row.spec_sha256) {
      throw new McpUnavailableError(`spec_changed: ${row.server_id}@${row.version}`);
    }
    const rules = pinnedRules ?? (await this.#effectiveRules(db, row.server_id, project));
    const secrets: { slot: string; credentialId: string }[] = [];
    for (const slot of mcpReferencedSlots(verified.spec)) {
      const c = await this.#binding(db, row.server_id, project, slot);
      if (c === null) {
        throw new McpUnavailableError(
          `secret_unbound: secret slot ${slot} of MCP server ${row.server_id} is not bound to an active vault credential`,
        );
      }
      secrets.push({ slot, credentialId: c });
    }
    return {
      pin: {
        id: row.server_id,
        version: row.version,
        specSha256: row.spec_sha256,
        policySha256: mcpPolicySha256(rules),
      },
      signed,
      spec: verified.spec,
      rules,
      secrets,
    };
  }

  /** The vault credential bound to a slot: the project's own binding, else the `'*'` one; only active credentials. */
  async #binding(db: Queryable, serverId: string, project: string, slot: string): Promise<string | null> {
    const { rows } = await db.query<{ vault_credential_id: string }>(
      `SELECT b.vault_credential_id FROM mcp_secret_bindings b
         JOIN vault_credentials c ON c.id = b.vault_credential_id AND c.state = 'active'
        WHERE b.server_id = $1 AND (b.project = $2 OR b.project = '*') AND b.slot = $3
        ORDER BY (b.project = '*') LIMIT 1`,
      [serverId, project, slot],
    );
    return rows[0]?.vault_credential_id ?? null;
  }

  async jobView(jobId: string): Promise<McpJobView> {
    const db = this.deps.pool;
    const set = await db.query<{ set_hash: string; skipped: string | null }>(
      'SELECT set_hash, skipped FROM job_mcp_sets WHERE job_id = $1',
      [jobId],
    );
    const pins = await db.query<{
      server_id: string;
      version: string;
      spec_sha256: string;
      policy_sha256: string;
      transport: McpTransportView | null;
      spec: Buffer | null;
    }>(
      `SELECT p.server_id, p.version, p.spec_sha256, p.policy_sha256, v.transport, v.spec
         FROM job_mcp_pins p LEFT JOIN mcp_server_versions v ON v.server_id = p.server_id AND v.version = p.version
        WHERE p.job_id = $1 ORDER BY p.server_id`,
      [jobId],
    );
    const calls = await db.query<{
      attempt_id: string;
      seq: number;
      server_id: string;
      tool: string;
      decision: string;
      outcome: string;
      duration_ms: number;
      args_bytes: number;
      result_bytes: number;
      at: Date;
    }>(
      `SELECT * FROM (
         SELECT attempt_id::text AS attempt_id, seq, server_id, tool, decision, outcome, duration_ms, args_bytes,
                result_bytes, at
           FROM job_mcp_calls WHERE job_id = $1 ORDER BY at DESC, seq DESC LIMIT ${String(MAX_JOB_CALLS_SHOWN)}
       ) c ORDER BY at, seq`,
      [jobId],
    );
    return {
      setHash: set.rows[0]?.set_hash ?? null,
      skipped: set.rows[0]?.skipped ?? null,
      servers: pins.rows.map((p) => {
        const spec = p.spec === null ? null : parseStoredSpec(p.spec);
        return {
          id: p.server_id,
          version: p.version,
          specSha256: p.spec_sha256,
          policySha256: p.policy_sha256,
          transport: p.transport ?? 'http',
          url: (spec?.http ?? spec?.sse)?.url ?? null,
          egressHosts: spec === null ? [] : mcpSpecEgressHosts(spec),
        };
      }),
      calls: calls.rows.map((c) => ({
        attemptId: c.attempt_id,
        seq: c.seq,
        server: c.server_id,
        tool: c.tool,
        decision: c.decision,
        outcome: c.outcome,
        durationMs: c.duration_ms,
        argsBytes: c.args_bytes,
        resultBytes: c.result_bytes,
        at: c.at.toISOString(),
      })),
    };
  }

  /**
   * EVENT `mcp_call` (inside the inbox transaction: exactly once per worker seq). Only servers pinned to the job are
   * recorded; every call is audited until {@link MAX_AUDITED_MCP_CALLS} per attempt, then once more as truncated.
   */
  async recordCall(
    tx: Queryable,
    input: { jobId: string; attemptId: string; workerId: string; event: McpCallEvent; at: Date },
  ): Promise<boolean> {
    const { jobId, attemptId, workerId, event } = input;
    const pinned = await tx.query('SELECT 1 FROM job_mcp_pins WHERE job_id = $1 AND server_id = $2', [
      jobId,
      event.server,
    ]);
    if ((pinned.rowCount ?? 0) === 0) return false;
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`job-mcp-calls:${attemptId}`]);
    const count = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM job_mcp_calls WHERE job_id = $1 AND attempt_id = $2',
      [jobId, attemptId],
    );
    const seq = count.rows[0]?.n ?? 0;
    await tx.query(
      `INSERT INTO job_mcp_calls (job_id, attempt_id, seq, server_id, tool, decision, outcome, duration_ms, args_bytes,
                                  args_sha256, result_bytes, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        jobId,
        attemptId,
        seq,
        event.server,
        event.tool,
        event.decision,
        event.outcome,
        Math.min(event.durationMs, 2_147_483_647),
        Math.min(event.argsBytes, 2_147_483_647),
        event.argsSha256,
        Math.min(event.resultBytes, 2_147_483_647),
        input.at,
      ],
    );
    this.#calls?.add(1, { outcome: event.outcome, decision: event.decision });
    if (seq < MAX_AUDITED_MCP_CALLS) {
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: 'mcp.tool.call',
          target: `job:${jobId}`,
          outcome: event.outcome === 'ok' ? 'success' : event.outcome === 'denied' ? 'denied' : 'failure',
          metadata: {
            jobId,
            attemptId,
            server: event.server,
            tool: event.tool,
            decision: event.decision,
            outcome: event.outcome,
            durationMs: event.durationMs,
            argsBytes: event.argsBytes,
            argsSha256: event.argsSha256,
            resultBytes: event.resultBytes,
          },
        },
        tx,
      );
    } else if (seq === MAX_AUDITED_MCP_CALLS) {
      await this.deps.audit.record(
        {
          actor: { type: 'worker', id: workerId },
          action: 'mcp.tool.calls_truncated',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: { jobId, attemptId, audited: MAX_AUDITED_MCP_CALLS },
        },
        tx,
      );
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------------ helpers

  async #server(
    db: Queryable,
    id: string,
  ): Promise<{ id: string; title: string; description: string; archived_at: Date | null; created_at: Date }> {
    if (!McpServerId.safeParse(id).success) {
      throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found.');
    }
    const { rows } = await db.query<{
      id: string;
      title: string;
      description: string;
      archived_at: Date | null;
      created_at: Date;
    }>('SELECT id, title, description, archived_at, created_at FROM mcp_servers WHERE id = $1', [id]);
    const s = rows[0];
    if (s === undefined) throw new HttpError(404, 'mcp_server_not_found', 'MCP server not found.');
    return s;
  }

  async #version(db: Queryable, id: string, version: string): Promise<VersionRow> {
    const { rows } = await db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM mcp_server_versions WHERE server_id = $1 AND version = $2`,
      [id, version],
    );
    const v = rows[0];
    if (v === undefined) {
      throw new HttpError(
        404,
        'mcp_version_not_found',
        `MCP server version ${version} not found.`,
        {},
        {},
        {
          version,
        },
      );
    }
    return v;
  }

  #projectRef(project: string): void {
    if (project !== '*' && !PROJECT.test(project)) {
      throw new HttpError(400, 'invalid_project', 'Invalid project id.');
    }
  }

  async #projectExists(db: Queryable, project: string): Promise<void> {
    const r = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
  }

  #privileged(user: ContextActor): void {
    if (user.role !== 'admin' && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Not allowed.');
    if (!stepUpFresh(user.mfaAt, this.#clock(), user.stepUpMaxAgeMs)) {
      throw new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
  }

  async #audit(
    user: ContextActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
    db?: Queryable,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: user.id },
        action,
        target,
        outcome,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata,
      },
      db,
    );
  }
}

/** A short, client-safe description of why a spec did not validate (zod issues or the size limit). */
function specProblem(err: unknown): string {
  if (err instanceof RangeError) return 'larger than 16 KiB';
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`)
      .join('; ')
      .slice(0, 400);
  }
  return 'invalid';
}

function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > max) out = out.slice(0, Math.max(0, out.length - 16));
  return out;
}
