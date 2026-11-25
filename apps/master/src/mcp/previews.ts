import { createHash, randomUUID } from 'node:crypto';
import { compareReleaseVersions, type McpSpec, McpServerId } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { ContextActor } from '../context/store.js';
import { type Pool, withTransaction } from '../db/pool.js';
import type { ActionView, FleetToolsService } from '../fleet-tools/service.js';
import { HttpError } from '../http/errors.js';
import {
  type McpDiscovery,
  type McpFinding,
  type McpProposalPublish,
  type McpResolveInput,
  type McpWarning,
} from './discovery.js';
import { type McpServerDetail, type McpService, parseStoredSpec, type RequestMeta } from './service.js';
import type { McpStdioWorker } from './stdio.js';

/**
 * p14-mcp-chat (ADR-0054 P5, docs/design/p14-mcp-skills.md §4.2, §4.3, §15): install previews — the one path by which
 * the chat card (`propose_mcp_install`) and Yetenekler → Keşfet install an MCP server.
 *
 * 1. **Preview** (`preview`): the master resolves the reference itself ({@link McpDiscovery.resolve}: exact version,
 *    registry integrity, bin, secret slots, warnings) and stores the proposal with its sha256. Nothing is signed or
 *    installed; via the chat it needs an admin, via the console an admin with a standard step-up.
 * 2. **Confirm** (`publish`): admin + an **always-fresh** authenticator code (ADR-0054 decision 2; the route and the
 *    chat draft executor check it; the services check the role and a standard window again). The preview is claimed
 *    once (and only with the sha256 the card showed), then: the spec is panel-signed (`McpService.publish`; an identical
 *    published version is reused), the server is assigned to the card's project, the project's MCP switch is turned on
 *    only when the person ticked it (off by default), a local package's install starts **canary first** (the other
 *    machines wait for a second fresh-code confirmation: `continue`), and tool discovery runs — right away for a remote
 *    server, when the canary reports the install for a local one. Every tool then asks (ADR-0054 decision 3); the
 *    progress view suggests allowing the read-only ones and the person allows them on the policy table.
 * 3. **Progress** (`progress`): the preview, the install action, per-machine installs, probes, tools with suggestions.
 *
 * Nothing the assistant writes reaches the spec except validated hosts (shown as its suggestion), an npm bin among the
 * package's own bins / a PyPI console-script name, a server id and runtimes; no tool rule, token or value ever does.
 */

const PREVIEW_TTL_MS = 24 * 3600_000;
const MAX_OPEN_PREVIEWS = 20;

export type McpPreviewState = 'previewed' | 'published' | 'discarded' | 'expired';

export interface McpProposal {
  readonly serverId: string;
  /** The catalog version a confirmation publishes (or reuses). */
  readonly version: string;
  /** An identical version is already published: the confirmation installs / assigns it without signing again. */
  readonly reuse: boolean;
  /** The server's newest published version before this one (null: a new server). */
  readonly latest: string | null;
  readonly publish: McpProposalPublish;
  readonly pinnedVersion: string | null;
  readonly bins: string[];
  readonly file: string | null;
  readonly license: string | null;
  readonly repository: string | null;
  readonly publishedAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly warnings: McpWarning[];
  readonly findings: McpFinding[];
  readonly egressSuggested: string[];
  /** ADR-0054 decision 3, fixed: never taken from the assistant or the registry. */
  readonly toolPolicy: { readonly initial: 'ask'; readonly unlisted: 'deny'; readonly suggestReadOnly: true };
  /** A local package is installed on machines (canary first); a remote server needs no install. */
  readonly install: { readonly needed: boolean; readonly machines: McpStdioWorker[] };
}

export interface McpPreviewView {
  readonly id: string;
  readonly state: McpPreviewState;
  readonly via: 'chat' | 'panel';
  readonly sourceKind: McpResolveInput['kind'];
  readonly source: { ref: string; version: string | null };
  readonly proposal: McpProposal;
  readonly proposalSha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly published: {
    readonly by: string | null;
    readonly at: string;
    readonly serverId: string;
    readonly version: string;
    readonly project: string | null;
    readonly actionId: string | null;
    readonly probeOpId: string | null;
    readonly probeSkipped: string | null;
  } | null;
}

export interface McpPreviewPublishResult {
  readonly previewId: string;
  readonly serverId: string;
  readonly version: string;
  readonly reused: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly project: string | null;
  readonly assigned: boolean;
  readonly assignError: string | null;
  readonly projectEnabled: boolean;
  readonly actionId: string | null;
  readonly installError: string | null;
  readonly probe:
    { readonly opId: string } | { readonly skipped: string } | { readonly after: 'canary' } | null;
}

export interface McpPreviewProgress {
  readonly preview: McpPreviewView;
  readonly action: ActionView | null;
  readonly installs: McpServerDetail['installs'];
  readonly probes: McpServerDetail['probes'];
  readonly tools: McpServerDetail['tools'];
  readonly rules: { tool: string; effect: 'allow' | 'ask' | 'deny' }[];
  readonly secretSlots: { slot: string; why: string }[];
  readonly boundSlots: string[];
}

export interface McpPreviewDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly mcp: McpService;
  readonly discovery: McpDiscovery;
  readonly fleetTools?: () => FleetToolsService | null;
}

interface PreviewRow {
  id: string;
  source_kind: McpResolveInput['kind'];
  source: { ref: string; version: string | null };
  proposal: McpProposal;
  proposal_sha256: string;
  via: 'chat' | 'panel';
  state: McpPreviewState;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  published_by: string | null;
  published_at: Date | null;
  server_id: string | null;
  version: string | null;
  project: string | null;
  action_id: string | null;
  probe_op_id: string | null;
  probe_skipped: string | null;
}

const COLUMNS = `id::text AS id, source_kind, source, proposal, proposal_sha256, via, state, created_by::text AS created_by,
  created_at, expires_at, published_by::text AS published_by, published_at, server_id, version, project,
  action_id::text AS action_id, probe_op_id, probe_skipped`;

function view(r: PreviewRow, now: Date): McpPreviewView {
  const expired = r.state === 'previewed' && r.expires_at <= now;
  return {
    id: r.id,
    state: expired ? 'expired' : r.state,
    via: r.via,
    sourceKind: r.source_kind,
    source: r.source,
    proposal: r.proposal,
    proposalSha256: r.proposal_sha256,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    published:
      r.state !== 'published' || r.server_id === null || r.version === null || r.published_at === null
        ? null
        : {
            by: r.published_by,
            at: r.published_at.toISOString(),
            serverId: r.server_id,
            version: r.version,
            project: r.project,
            actionId: r.action_id,
            probeOpId: r.probe_op_id === '' ? null : r.probe_op_id,
            probeSkipped: r.probe_skipped,
          },
  };
}

/** What makes two specs "the same server": the package (manager + name) or the remote URL. */
function identity(spec: { stdio?: McpSpec['stdio']; http?: McpSpec['http']; sse?: McpSpec['sse'] }): string {
  if (spec.stdio !== undefined) return `${spec.stdio.package.manager}:${spec.stdio.package.name}`;
  return `url:${spec.http?.url ?? spec.sse?.url ?? ''}`;
}

function sameRelease(spec: McpSpec, p: McpProposalPublish): boolean {
  if (spec.transport !== p.transport) return false;
  if (p.package !== undefined) {
    const s = spec.stdio?.package;
    return (
      s !== undefined &&
      s.manager === p.package.manager &&
      s.name === p.package.name &&
      s.version === p.package.version &&
      s.integrity === p.package.integrity &&
      spec.stdio?.bin === p.package.bin
    );
  }
  return (spec.http ?? spec.sse)?.url === p.url;
}

function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (m === null) return '1.0.0';
  return `${m[1] ?? '1'}.${m[2] ?? '0'}.${String(Number(m[3] ?? '0') + 1)}`;
}

function hash(proposal: McpProposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
}

export class McpPreviewService {
  constructor(private readonly d: McpPreviewDeps) {
    // A local server's tools are discovered on its canary as soon as the canary reports the install.
    d.mcp.stdio.onInstalled((serverId, version, workerId) => this.afterInstall(serverId, version, workerId));
  }

  #admin(user: ContextActor): void {
    if (user.role !== 'admin' && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Not allowed.');
  }

  // ---------------------------------------------------------------------------------------------- preview

  async preview(
    user: ContextActor,
    input: McpResolveInput & { readonly serverId?: string | undefined },
    opts: { readonly via: 'chat' | 'panel' },
    meta: RequestMeta = {},
  ): Promise<McpPreviewView> {
    this.#admin(user);
    const now = this.d.clock();
    await this.d.pool.query(
      `UPDATE mcp_previews SET state = 'expired' WHERE state = 'previewed' AND expires_at <= $1`,
      [now],
    );
    const open = await this.d.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mcp_previews WHERE created_by = $1 AND state = 'previewed'`,
      [user.id],
    );
    if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_PREVIEWS) {
      throw new HttpError(
        429,
        'mcp_preview_limit',
        `At most ${String(MAX_OPEN_PREVIEWS)} open MCP install previews; confirm or discard some first.`,
        {},
        {},
        { max: MAX_OPEN_PREVIEWS },
      );
    }
    if (input.serverId !== undefined && !McpServerId.safeParse(input.serverId).success) {
      throw new HttpError(
        422,
        'mcp_spec_invalid',
        `Invalid MCP server id: ${input.serverId.slice(0, 40)}.`,
        {},
        {},
        { detail: 'id' },
      );
    }
    const resolved = await this.d.discovery.resolve(user.id, input);
    const target = await this.#target(input.serverId ?? null, resolved.suggestedId, resolved.publish);
    const machines = resolved.publish.transport === 'stdio' ? await this.d.mcp.stdio.workers() : [];
    const proposal: McpProposal = {
      serverId: target.id,
      version: target.version,
      reuse: target.reuse,
      latest: target.latest,
      publish: { ...resolved.publish, id: target.id, version: target.version },
      pinnedVersion: resolved.pinnedVersion,
      bins: resolved.bins,
      file: resolved.file,
      license: resolved.license,
      repository: resolved.repository,
      publishedAt: resolved.publishedAt,
      downloadsWeekly: resolved.downloadsWeekly,
      warnings: resolved.warnings,
      findings: resolved.findings,
      egressSuggested: resolved.egressSuggested,
      toolPolicy: { initial: 'ask', unlisted: 'deny', suggestReadOnly: true },
      install: { needed: resolved.publish.transport === 'stdio', machines },
    };
    const sha = hash(proposal);
    const id = randomUUID();
    const { rows } = await this.d.pool.query<PreviewRow>(
      `INSERT INTO mcp_previews (id, source_kind, source, proposal, proposal_sha256, via, state, created_by, created_at,
                                 expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'previewed', $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        id,
        resolved.sourceKind,
        JSON.stringify({ ref: resolved.ref.slice(0, 512), version: resolved.pinnedVersion }),
        JSON.stringify(proposal),
        sha,
        opts.via,
        user.id,
        now,
        new Date(now.getTime() + PREVIEW_TTL_MS),
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('preview not stored');
    await this.#audit(user, 'mcp.preview', 'success', `mcp:${target.id}`, meta, {
      previewId: id,
      via: opts.via,
      sourceKind: resolved.sourceKind,
      ref: resolved.ref.slice(0, 200),
      pinnedVersion: resolved.pinnedVersion,
      serverId: target.id,
      version: target.version,
      reuse: target.reuse,
      transport: resolved.publish.transport,
      ...(resolved.publish.package === undefined
        ? {}
        : {
            package: `${resolved.publish.package.manager}:${resolved.publish.package.name}@${resolved.publish.package.version}`,
            integrity: resolved.publish.package.integrity,
          }),
      warnings: resolved.warnings.map((w) => w.code),
      proposalSha256: sha,
    });
    return view(row, now);
  }

  /**
   * The catalog id and version a proposal publishes: a new server (`1.0.0`), the next patch of a server that already
   * serves the same package / URL, or the existing version when it is exactly this release. An id held by another
   * package is never reused: a free `-2`… suffix is chosen, or (an id the caller named) the preview is refused.
   */
  async #target(
    named: string | null,
    suggested: string,
    publish: Omit<McpProposalPublish, 'id' | 'version'>,
  ): Promise<{ id: string; version: string; reuse: boolean; latest: string | null }> {
    const ours = identity({
      ...(publish.package === undefined
        ? {}
        : {
            stdio: {
              package: publish.package,
              bin: publish.package.bin,
            },
          }),
      ...(publish.url === undefined ? {} : { http: { url: publish.url } }),
    });
    const candidates =
      named !== null
        ? [named]
        : [suggested, ...Array.from({ length: 8 }, (_, i) => `${suggested.slice(0, 29)}-${String(i + 2)}`)];
    for (const id of candidates) {
      const server = await this.d.pool.query<{ archived_at: Date | null }>(
        'SELECT archived_at FROM mcp_servers WHERE id = $1',
        [id],
      );
      if (server.rows[0] === undefined) return { id, version: '1.0.0', reuse: false, latest: null };
      const versions = await this.d.pool.query<{ version: string; spec: Buffer }>(
        'SELECT version, spec FROM mcp_server_versions WHERE server_id = $1',
        [id],
      );
      const specs = versions.rows
        .map((r) => ({ version: r.version, spec: parseStoredSpec(r.spec) }))
        .filter((r): r is { version: string; spec: McpSpec } => r.spec !== null)
        .sort((a, b) => compareReleaseVersions(b.version, a.version));
      const latest = specs[0];
      const same = latest === undefined || identity(latest.spec) === ours;
      if (server.rows[0].archived_at === null && same) {
        const exact = specs.find((s) => sameRelease(s.spec, { ...publish, id, version: s.version }));
        if (exact !== undefined) {
          return { id, version: exact.version, reuse: true, latest: latest?.version ?? null };
        }
        return {
          id,
          version: latest === undefined ? '1.0.0' : bumpPatch(latest.version),
          reuse: false,
          latest: latest?.version ?? null,
        };
      }
      if (named !== null) {
        throw new HttpError(
          409,
          'mcp_server_id_taken',
          `MCP server id ${id} belongs to another package or URL${server.rows[0].archived_at === null ? '' : ' (archived)'}; choose another id.`,
          {},
          {},
          { id },
        );
      }
    }
    throw new HttpError(
      409,
      'mcp_server_id_taken',
      `No free MCP server id near ${suggested}; give one.`,
      {},
      {},
      { id: suggested },
    );
  }

  async get(user: ContextActor, id: string): Promise<McpPreviewView> {
    this.#admin(user);
    return view(await this.#row(id), this.d.clock());
  }

  async #row(id: string): Promise<PreviewRow> {
    const { rows } = await this.d.pool.query<PreviewRow>(
      `SELECT ${COLUMNS} FROM mcp_previews WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'mcp_preview_not_found', 'MCP install preview not found.');
    return r;
  }

  async discard(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#admin(user);
    const r = await this.d.pool.query(
      `UPDATE mcp_previews SET state = 'discarded' WHERE id = $1 AND state = 'previewed' RETURNING 1`,
      [id],
    );
    if ((r.rowCount ?? 0) === 0) {
      const row = await this.#row(id);
      if (row.state !== 'discarded') {
        throw new HttpError(
          409,
          'mcp_preview_closed',
          `This MCP install preview is ${row.state}.`,
          {},
          {},
          { state: row.state },
        );
      }
      return;
    }
    await this.#audit(user, 'mcp.preview.discard', 'success', `mcp-preview:${id}`, meta, { previewId: id });
  }

  // ---------------------------------------------------------------------------------------------- confirm

  /**
   * The confirmation (always-fresh step-up checked by the caller). `expectSha` is the proposal hash the card showed —
   * a preview whose proposal is not exactly that is never published.
   */
  async publish(
    user: ContextActor,
    id: string,
    opts: {
      readonly expectSha?: string | undefined;
      readonly project?: string | null | undefined;
      readonly enableProject?: boolean | undefined;
      readonly workers?: 'all' | readonly string[] | undefined;
    },
    meta: RequestMeta = {},
  ): Promise<McpPreviewPublishResult> {
    this.#admin(user);
    const now = this.d.clock();
    const project = opts.project ?? null;
    if (opts.enableProject === true && (project === null || project === '*')) {
      throw new HttpError(
        400,
        'invalid_request',
        'The MCP switch is turned on for one project: name the project.',
        {},
        {},
        { reason: 'enable_project' },
      );
    }
    const claimed = await this.d.pool.query<PreviewRow>(
      `UPDATE mcp_previews SET state = 'published', published_by = $2, published_at = $3, server_id = proposal->>'serverId',
              version = proposal->>'version', project = $5
        WHERE id = $1 AND state = 'previewed' AND expires_at > $3 AND ($4::text IS NULL OR proposal_sha256 = $4)
        RETURNING ${COLUMNS}`,
      [id, user.id, now, opts.expectSha ?? null, project],
    );
    const row = claimed.rows[0];
    if (row === undefined) {
      const r = await this.#row(id);
      const state = view(r, now).state;
      throw new HttpError(
        409,
        'mcp_preview_closed',
        state === 'previewed'
          ? 'The preview behind this card changed; propose it again.'
          : `This MCP install preview is ${state}; propose it again.`,
        {},
        {},
        { state },
      );
    }
    const p = row.proposal;
    const release = async (): Promise<void> => {
      await this.d.pool.query(
        `UPDATE mcp_previews SET state = 'previewed', published_by = NULL, published_at = NULL, server_id = NULL,
                version = NULL, project = NULL WHERE id = $1`,
        [id],
      );
    };
    // 1. The signed spec (or the identical published version).
    let reused = p.reuse;
    try {
      if (!p.reuse) await this.d.mcp.publish(user, p.publish, meta);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'mcp_version_exists') {
        reused = true;
      } else {
        await release();
        throw err;
      }
    }
    // 2. Assignment and (only when ticked) the project switch.
    let assigned = false;
    let assignError: string | null = null;
    let projectEnabled = false;
    if (project !== null) {
      try {
        await this.d.mcp.assign(
          user,
          { serverId: p.serverId, project, runtimes: [...p.publish.runtimes] },
          meta,
        );
        assigned = true;
        if (opts.enableProject === true) {
          await this.d.mcp.setProject(user, project, true, meta);
          projectEnabled = true;
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        assignError = err.code;
      }
    }
    // 3. A local package: canary first (the rest wait for `continue` with another fresh code).
    let actionId: string | null = null;
    let installError: string | null = null;
    if (p.publish.transport === 'stdio') {
      try {
        const action = await this.d.mcp.install(
          user,
          p.serverId,
          p.version,
          { workers: opts.workers ?? 'all', rollout: 'canary-first' },
          meta,
        );
        actionId = action.id;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        installError = err.code;
      }
    }
    // 4. Tool discovery: now for a remote server, after the canary's install for a local one.
    let probe: McpPreviewPublishResult['probe'] = null;
    if (p.publish.transport !== 'stdio') {
      probe = await this.d.mcp.autoProbe(user.id, p.serverId, p.version, null, meta);
    } else if (actionId !== null) {
      probe = { after: 'canary' };
    }
    await this.d.pool.query(
      `UPDATE mcp_previews SET action_id = $2, auto_probe = $3, probe_op_id = $4, probe_skipped = $5 WHERE id = $1`,
      [
        id,
        actionId,
        probe !== null && 'after' in probe,
        probe !== null && 'opId' in probe ? probe.opId : null,
        probe !== null && 'skipped' in probe ? probe.skipped : null,
      ],
    );
    const result: McpPreviewPublishResult = {
      previewId: id,
      serverId: p.serverId,
      version: p.version,
      reused,
      transport: p.publish.transport,
      project,
      assigned,
      assignError,
      projectEnabled,
      actionId,
      installError,
      probe,
    };
    await this.#audit(user, 'mcp.preview.publish', 'success', `mcp:${p.serverId}`, meta, {
      ...result,
      via: row.via,
      proposalSha256: row.proposal_sha256,
    });
    return result;
  }

  /** The canary (or any machine) reported the install: probe once for a published preview that waits for it. */
  async afterInstall(serverId: string, version: string, workerId: string): Promise<void> {
    const claim = await withTransaction(this.d.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; published_by: string | null }>(
        `UPDATE mcp_previews SET probe_op_id = ''
          WHERE id = (SELECT id FROM mcp_previews
                       WHERE server_id = $1 AND version = $2 AND state = 'published' AND auto_probe
                         AND probe_op_id IS NULL
                       ORDER BY published_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id::text AS id, published_by::text AS published_by`,
        [serverId, version],
      );
      return rows[0] ?? null;
    });
    if (claim === null || claim.published_by === null) return;
    const out = await this.d.mcp.autoProbe(claim.published_by, serverId, version, workerId);
    await this.d.pool.query('UPDATE mcp_previews SET probe_op_id = $2, probe_skipped = $3 WHERE id = $1', [
      claim.id,
      'opId' in out ? out.opId : null,
      'skipped' in out ? out.skipped : null,
    ]);
  }

  // --------------------------------------------------------------------------------------------- progress

  async progress(id: string): Promise<McpPreviewProgress> {
    const row = await this.#row(id);
    const v = view(row, this.d.clock());
    const empty: McpPreviewProgress = {
      preview: v,
      action: null,
      installs: [],
      probes: [],
      tools: [],
      rules: [],
      secretSlots: row.proposal.publish.secrets,
      boundSlots: [],
    };
    if (v.published === null) return empty;
    const { serverId, version } = v.published;
    const detail = await this.d.mcp.detail(serverId);
    const fleet = this.d.fleetTools?.() ?? null;
    const action =
      v.published.actionId === null || fleet === null
        ? null
        : await fleet.get(v.published.actionId).catch(() => null);
    const rules = detail.policies.find((x) => x.project === '*')?.rules ?? [];
    return {
      preview: v,
      action,
      installs: detail.installs.filter((i) => i.version === version),
      probes: detail.probes.filter((x) => x.version === version),
      tools: detail.tools.filter((t) => t.version === version),
      rules: rules.map((r) => ({ tool: r.tool, effect: r.effect })),
      secretSlots:
        detail.versions.find((x) => x.version === version)?.secretSlots ?? row.proposal.publish.secrets,
      boundSlots: detail.secrets.filter((s) => s.project === '*').map((s) => s.slot),
    };
  }

  async #audit(
    user: ContextActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string,
    meta: RequestMeta,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.d.audit.record({
      actor: { type: 'user', id: user.id },
      action,
      target,
      outcome,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata,
    });
  }
}

/** The facts of a proposal the chat card shows (payload of the `mcp_install` draft). */
export function proposalCard(v: McpPreviewView): Record<string, unknown> {
  const p = v.proposal;
  return {
    previewId: v.id,
    proposalSha256: v.proposalSha256,
    sourceKind: v.sourceKind,
    ref: v.source.ref,
    pinnedVersion: v.source.version,
    serverId: p.serverId,
    version: p.version,
    reuse: p.reuse,
    latest: p.latest,
    title: p.publish.title,
    description: p.publish.description,
    transport: p.publish.transport,
    url: p.publish.url ?? null,
    package: p.publish.package ?? null,
    headers: p.publish.headers ?? null,
    secrets: p.publish.secrets,
    egressHosts: p.publish.egressHosts,
    egressSuggested: p.egressSuggested,
    runtimes: p.publish.runtimes,
    registrySource: p.publish.source,
    license: p.license,
    repository: p.repository,
    publishedAt: p.publishedAt,
    downloadsWeekly: p.downloadsWeekly,
    warnings: p.warnings,
    findings: p.findings,
    toolPolicy: p.toolPolicy,
    install: {
      needed: p.install.needed,
      machines: p.install.machines.map((m) => ({
        id: m.id,
        name: m.name,
        canary: m.canary,
        connected: m.connected,
      })),
    },
  };
}
