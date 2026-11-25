import { createHash, randomUUID } from 'node:crypto';
import {
  type AssignedPreviews,
  JobSpec,
  PREVIEW_LIMITS,
  PREVIEW_CONTAINER_FEATURE,
  PREVIEW_TUNNELS_FEATURE,
  SITE_PUBLISH_FEATURE,
  DEPLOY_FEEDBACK_FEATURE,
  type PreviewProtection,
  type PreviewResultPayload,
  type PreviewTunnelInfo,
  PreviewTunnelsReport,
  type PreviewTunnelState,
  type TunnelStatusPayload,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import type { CloudflareClient } from '../ops/cloudflare.js';
import { ProviderCallError } from '../ops/coolify.js';
import type { OpsIntegrations } from '../ops/integrations.js';
import {
  type DeployTargets,
  OpsError,
  type OpsKind,
  type OpsActionView,
  type PreviewSettings,
  TunnelCloseParams,
  TunnelExtendParams,
  TunnelOpenParams,
} from '../ops/model.js';
import { nameInZone, protectedRecordReason } from '../ops/policy.js';
import type { DeployOnSuccessService } from '../ops/on-success.js';
import type { DeployFeedbackService } from '../ops/feedback.js';
import {
  type OpsActor,
  type OpsHandlerAction,
  type OpsKindHandler,
  type OpsPlan,
  type OpsService,
  providerText,
} from '../ops/service.js';
import type { LeaseSigner } from '../orchestration/lease-signer.js';
import type { WorkerSession } from '../workers/types.js';
import {
  type ConnectorView,
  extendedExpiry,
  lifetimeMinutes,
  previewAvailability,
  previewHostname,
  previewSlug,
  protectionsOffered,
  type TunnelView,
  tunnelDecision,
} from './model.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';

/**
 * p8-preview-tunnels (ADR-0032, docs/design/p8-preview-tunnels.md): preview links through Cloudflare Tunnel.
 *
 * - **Requests** come from a person (job page / REST, `previews.open`), from the job's agent (`open_preview` tool →
 *   PREVIEW_REQUEST, fenced by the live lease, the job's creator re-authorized) or from the job's auto-open (the
 *   port a human declared at submission). Every open / close / extend is an ops action (`tunnel.*`): the project
 *   policy decides (open job-bound: auto by default; new stable reservation: approval), it is audited and listed
 *   with the deploys.
 * - **Execution** (this class is the ops kind handler): the master creates a remotely-managed tunnel with ONE
 *   ingress rule `hostname → http://localhost:<port>`, the proxied CNAME and — if asked — an Access application, and
 *   sends the job's worker TUNNEL_START with only that tunnel's connector token (fetched from Cloudflare each time,
 *   never stored, never logged). Closing deletes the Access app, the service token, the DNS record and the tunnel
 *   (which revokes the token).
 * - **Lifecycle** (`sweep`, an orchestrator tick step): job-bound tunnels close when their attempt is no longer the
 *   live lease or their lifetime ends; stable tunnels detach (connector stopped, hostname kept) and close at expiry;
 *   failed tear-downs are retried; connectors of disconnected workers show `down`. Reconnects re-send TUNNEL_START.
 */

export interface PreviewServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly ops: () => OpsService | null;
  readonly integrations: OpsIntegrations;
  /** The master key box (the service-token secret is sealed under its sub-key `preview-tunnels`). */
  readonly box: SecretBox;
  readonly signer: LeaseSigner;
  readonly session: (workerId: string) => WorkerSession | undefined;
  /** Host of PUBLIC_ORIGIN (always protected). */
  readonly consoleHost: string | null;
  /** OPS_PROTECTED_HOSTS: further host names protected like the console host (default none). */
  readonly protectedHosts?: readonly string[];
  /** p17-domain-wizard: the console's live host names (a saved address is protected at once). */
  readonly liveConsoleHosts?: () => readonly string[];
  /** OPS_CONTROL_PLANE_ADDRESSES. */
  readonly controlPlaneAddresses: readonly string[];
  /** Posts an assistant note into a chat thread (the conversation a job was drafted in). */
  readonly chatNote?: (threadId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
  /** Longest an `opening` record may stay so before the sweep tears it down (a crash mid-open). Default 10 min. */
  readonly openingTimeoutMs?: number;
  /**
   * p10-publish-bundle (ADR-0038): records a job agent's `publish_site` request (run as one `pages.publish` when the
   * job succeeds).
   */
  readonly deployOnSuccess?: () => DeployOnSuccessService | null;
  /** p12-deploy-feedback (ADR-0048): the in-job deploy tools (`deploy_status`, `deploy_logs`, `request_redeploy`). */
  readonly deployFeedback?: () => DeployFeedbackService | null;
}

interface TunnelRow {
  id: string;
  project: string;
  name: string;
  stable: boolean;
  hostname: string;
  zone_id: string;
  zone_name: string;
  protection: PreviewProtection;
  cf_tunnel_id: string | null;
  dns_record_id: string | null;
  access_app_id: string | null;
  service_token_id: string | null;
  service_token_client_id: string | null;
  service_token_secret: Buffer | null;
  state: PreviewTunnelState;
  job_id: string | null;
  attempt_id: string | null;
  epoch: number | null;
  worker_id: string | null;
  port: number | null;
  port_check: 'owned' | 'declared' | null;
  connector_state: ConnectorView | null;
  connector_detail: string | null;
  connector_at: Date | null;
  started_at: Date | null;
  opened_by_type: 'user' | 'system';
  opened_by_id: string;
  opener: string | null;
  open_action_id: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
}

const COLS = `t.id::text AS id, t.project, t.name, t.stable, t.hostname, t.zone_id, t.zone_name, t.protection,
  t.cf_tunnel_id::text AS cf_tunnel_id, t.dns_record_id, t.access_app_id::text AS access_app_id,
  t.service_token_id::text AS service_token_id, t.service_token_client_id, t.service_token_secret, t.state,
  t.job_id::text AS job_id, t.attempt_id::text AS attempt_id, t.epoch, t.worker_id, t.port, t.port_check,
  t.connector_state, t.connector_detail, t.connector_at, t.started_at, t.opened_by_type, t.opened_by_id,
  (SELECT username FROM users u WHERE t.opened_by_type = 'user' AND u.id::text = t.opened_by_id) AS opener,
  t.open_action_id::text AS open_action_id, t.expires_at, t.created_at, t.updated_at, t.closed_at, t.close_reason`;

/** States in which Cloudflare resources may exist (counted against the limits, swept). */
const OPEN_STATES = ['opening', 'active', 'idle', 'closing'] as const;

interface LiveAttempt {
  readonly jobId: string;
  readonly project: string;
  readonly attemptId: string;
  readonly epoch: number;
  readonly workerId: string;
  readonly spec: JobSpec | null;
  readonly createdByType: string;
  readonly createdById: string | null;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const TUNNEL_KINDS: readonly OpsKind[] = ['tunnel.open', 'tunnel.close', 'tunnel.extend'];

/** The worker answer text of an ops action that did not succeed. */
function actionProblem(a: OpsActionView): {
  status: PreviewResultPayload['status'];
  reason: string;
  detail: string;
} {
  switch (a.state) {
    case 'awaiting_approval':
      return {
        status: 'pending',
        reason: 'awaiting_approval',
        detail: `${a.policy.reason} A project admin decides on the Deploys page; the preview opens when approved.`,
      };
    case 'refused':
      return { status: 'refused', reason: 'refused', detail: a.policy.reason };
    default:
      return {
        status: 'failed',
        reason: a.state,
        detail: (a.error ?? `The preview is ${a.state}.`).slice(0, 500),
      };
  }
}

export class PreviewService implements OpsKindHandler {
  readonly kinds = TUNNEL_KINDS;
  readonly #box: SecretBox;
  readonly #baseConsoleHosts: readonly string[];

  constructor(private readonly deps: PreviewServiceDeps) {
    this.#box = new SecretBox(deps.box.deriveKey('preview-tunnels'));
    this.#baseConsoleHosts = [
      ...(deps.protectedHosts ?? []),
      ...(deps.consoleHost === null ? [] : [deps.consoleHost]),
    ];
  }

  get #consoleHosts(): ReadonlySet<string> {
    return new Set(
      [...this.#baseConsoleHosts, ...(this.deps.liveConsoleHosts?.() ?? [])].map((h) => h.toLowerCase()),
    );
  }

  // ===================================================================================== ops kind handler

  parse(kind: OpsKind, params: Record<string, unknown>): Record<string, unknown> {
    const schema =
      kind === 'tunnel.open'
        ? TunnelOpenParams
        : kind === 'tunnel.close'
          ? TunnelCloseParams
          : TunnelExtendParams;
    const p = schema.safeParse(params);
    if (!p.success) {
      throw new OpsError(
        400,
        'invalid_params',
        `Invalid parameters for ${kind}: ${p.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 500),
      );
    }
    return p.data;
  }

  /** Closing (and extending) works even after the project's deploy targets were removed. */
  allowWithoutTargets(kind: OpsKind): boolean {
    return kind === 'tunnel.close' || kind === 'tunnel.extend';
  }

  async plan(project: string, kind: OpsKind, p: Record<string, unknown>, t: DeployTargets): Promise<OpsPlan> {
    if (kind === 'tunnel.open') return this.#planOpen(project, p, t);
    const row = await this.#row(String(p.tunnelId));
    if (row?.project !== project) {
      return this.#refusedPlan(kind, t, 'This preview does not exist in this project.', {
        tunnelId: p.tunnelId,
      });
    }
    const target = { tunnelId: row.id, hostname: row.hostname, stable: row.stable, name: row.name };
    if (kind === 'tunnel.close') {
      const decision = tunnelDecision('tunnel.close', t.policy, { refusal: null });
      return {
        env: null,
        target,
        diff: { action: 'close preview', hostname: row.hostname, state: row.state },
        previous: null,
        refusal: null,
        key: sha(`close:${row.id}`),
        decision,
      };
    }
    // tunnel.extend
    const refusal = row.state === 'active' || row.state === 'idle' ? null : `The preview is ${row.state}.`;
    const now = this.deps.clock();
    const next = extendedExpiry(row.stable, row.expires_at, Number(p.minutes), now);
    return {
      env: null,
      target,
      diff: {
        action: row.stable ? 'renew stable preview' : 'extend preview',
        hostname: row.hostname,
        before: row.expires_at.toISOString(),
        after: next.toISOString(),
      },
      previous: { expiresAt: row.expires_at.toISOString() },
      refusal,
      key: sha(`extend:${row.id}:${row.state}`),
      decision: tunnelDecision('tunnel.extend', t.policy, { refusal, renewStable: row.stable }),
    };
  }

  #refusedPlan(kind: OpsKind, t: DeployTargets, reason: string, target: Record<string, unknown>): OpsPlan {
    return {
      env: null,
      target,
      diff: { action: kind },
      previous: null,
      refusal: reason,
      key: sha(`${kind}:refused:${reason}`),
      decision: { decision: 'refused', reason },
    };
  }

  async #planOpen(project: string, p: Record<string, unknown>, t: DeployTargets): Promise<OpsPlan> {
    const settings = t.previews;
    const jobId = String(p.jobId);
    const port = Number(p.port);
    const protect = p.protect as PreviewProtection;
    const stable = p.stable === true;
    const name = previewSlug(typeof p.name === 'string' ? p.name : undefined);
    const refuse = (reason: string): OpsPlan =>
      this.#refusedPlan('tunnel.open', t, reason, { jobId, port, name, stable, protection: protect });
    const live = await this.#liveAttempt(jobId);
    const avail = await this.#availability(settings, live);
    if (avail !== null) return refuse(avail);
    if (settings === null || settings.zone === null || live === null)
      return refuse('Previews are not available.');
    if (live.project !== project) return refuse('The job belongs to another project.');
    if (!protectionsOffered(settings).includes(protect)) {
      return refuse(
        'Access protection needs at least one allowed e-mail address (Project → Deploy → Preview links).',
      );
    }
    // Limits: open previews per project and per job (a re-attached stable tunnel counts once).
    const counts = await this.deps.pool.query<{ project_n: number; job_n: number }>(
      `SELECT count(*)::int AS project_n,
              count(*) FILTER (WHERE job_id::text = $2)::int AS job_n
         FROM preview_tunnels WHERE project = $1 AND state = ANY($3)`,
      [project, jobId, [...OPEN_STATES]],
    );
    const existingStable = stable
      ? ((
          await this.deps.pool.query<TunnelRow>(
            `SELECT ${COLS} FROM preview_tunnels t
              WHERE t.project = $1 AND t.name = $2 AND t.stable AND t.state = ANY($3)`,
            [project, name, [...OPEN_STATES]],
          )
        ).rows[0] ?? null)
      : null;
    const adds = existingStable === null ? 1 : 0;
    if ((counts.rows[0]?.project_n ?? 0) + adds > settings.maxActive) {
      return refuse(
        `This project already has ${String(counts.rows[0]?.project_n ?? 0)} open previews (limit ${String(settings.maxActive)}); close one first.`,
      );
    }
    if ((counts.rows[0]?.job_n ?? 0) + 1 > settings.maxPerJob) {
      return refuse(
        `This job already has ${String(counts.rows[0]?.job_n ?? 0)} previews (limit ${String(settings.maxPerJob)}).`,
      );
    }
    if (existingStable !== null) {
      if (existingStable.state !== 'active' && existingStable.state !== 'idle') {
        return refuse(`The stable preview "${name}" is ${existingStable.state}.`);
      }
      if (
        existingStable.job_id !== null &&
        existingStable.job_id !== jobId &&
        (await this.#liveAttempt(existingStable.job_id)) !== null
      ) {
        return refuse(`The stable preview "${name}" is served by another running job; close it there first.`);
      }
      if (existingStable.protection !== protect) {
        return refuse(
          `The stable preview "${name}" uses ${existingStable.protection} protection; close it to change that.`,
        );
      }
    }
    const zone = settings.zone;
    const hostname = existingStable?.hostname ?? previewHostname(zone.name, settings.prefix, name);
    // ADR-0028 §4 protections: never the console host, the control plane or a protected name of the project.
    const cf = await this.#cloudflare();
    const protection = await this.#protectionContext(cf, zone.id, zone.name, t);
    const content = '<tunnel id>.cfargotunnel.com';
    const hostReason =
      !nameInZone(hostname, zone.name) || hostname === zone.name
        ? `${hostname} is not a subdomain of ${zone.name}.`
        : protectedRecordReason({ name: hostname, type: 'CNAME', content }, protection);
    if (hostReason !== null) return refuse(hostReason);
    const existing = await this.#provider(() => cf.records(zone.id, hostname));
    const ours = existingStable?.dns_record_id ?? null;
    const foreign = existing.filter((r) => r.id !== ours);
    if (foreign.length > 0)
      return refuse(`A DNS record for ${hostname} already exists; nothing was changed.`);
    for (const r of existing) {
      const why = protectedRecordReason(r, protection);
      if (why !== null) return refuse(why);
    }
    const minutes = lifetimeMinutes(stable, typeof p.ttlMinutes === 'number' ? p.ttlMinutes : undefined);
    const newStable = stable && existingStable === null;
    return {
      env: null,
      target: {
        jobId,
        attemptId: live.attemptId,
        workerId: live.workerId,
        zone: zone.name,
        zoneId: zone.id,
        ...(existingStable === null ? {} : { tunnelId: existingStable.id }),
      },
      diff: {
        action:
          existingStable !== null
            ? 'attach stable preview'
            : stable
              ? 'reserve stable preview'
              : 'open preview',
        hostname,
        url: `https://${hostname}`,
        port,
        protection: protect,
        stable,
        name,
        lifetimeMinutes: existingStable === null ? minutes : null,
        dns: { type: 'CNAME', name: hostname, content, proxied: true },
        ...(protect === 'access' ? { accessEmails: settings.accessEmails.length } : {}),
      },
      previous: null,
      refusal: null,
      // Re-planned after an approval: the same job attempt, worker, port and stable reservation (not the random name).
      key: sha(
        JSON.stringify([
          jobId,
          live.attemptId,
          live.workerId,
          port,
          protect,
          stable,
          name,
          existingStable?.id ?? null,
        ]),
      ),
      decision: tunnelDecision('tunnel.open', t.policy, { refusal: null, newStable }),
    };
  }

  async run(
    action: OpsHandlerAction,
    plan: OpsPlan,
    actor: OpsActor,
  ): Promise<{ state: 'succeeded' | 'failed'; result: Record<string, unknown>; error?: string }> {
    switch (action.kind) {
      case 'tunnel.open':
        return this.#runOpen(action, plan);
      case 'tunnel.close': {
        const row = await this.#row(String(action.params.tunnelId));
        if (row === null) return { state: 'succeeded', result: { closed: false, reason: 'not found' } };
        const reason = typeof action.params.reason === 'string' ? action.params.reason : 'closed';
        const err = await this.#teardown(row, reason, actor);
        return err === null
          ? { state: 'succeeded', result: { tunnelId: row.id, hostname: row.hostname, closed: true, reason } }
          : {
              state: 'failed',
              result: { tunnelId: row.id, hostname: row.hostname, closed: false },
              error: `${err} The clean-up is retried automatically.`,
            };
      }
      case 'tunnel.extend': {
        const row = await this.#row(String(action.params.tunnelId));
        if (row === null) return { state: 'failed', result: {}, error: 'The preview no longer exists.' };
        const now = this.deps.clock();
        const next = extendedExpiry(row.stable, row.expires_at, Number(action.params.minutes), now);
        await this.deps.pool.query(
          'UPDATE preview_tunnels SET expires_at = $2, updated_at = $3 WHERE id = $1',
          [row.id, next, now],
        );
        const updated = await this.#row(row.id);
        if (updated?.state === 'active') await this.#sendStart(updated).catch(() => undefined);
        return { state: 'succeeded', result: { tunnelId: row.id, expiresAt: next.toISOString() } };
      }
      default:
        return { state: 'failed', result: {}, error: `Unknown preview action ${action.kind}.` };
    }
  }

  async #runOpen(
    action: OpsHandlerAction,
    plan: OpsPlan,
  ): Promise<{ state: 'succeeded' | 'failed'; result: Record<string, unknown>; error?: string }> {
    const p = action.params;
    const jobId = String(p.jobId);
    const live = await this.#liveAttempt(jobId);
    if (live === null || live.attemptId !== plan.target.attemptId) {
      return { state: 'failed', result: {}, error: 'The job attempt ended before the preview could open.' };
    }
    const t = (await this.#targets(action.project))?.previews ?? null;
    if (t?.zone == null) return { state: 'failed', result: {}, error: 'Preview links are no longer set up.' };
    const cf = await this.#cloudflare();
    const now = this.deps.clock();
    const port = Number(p.port);
    const protect = p.protect as PreviewProtection;
    const check = p.check === 'owned' ? 'owned' : 'declared';
    // The hostname the requester (or approver) saw in the diff — never a new random name.
    const hostname = String(action.diff.hostname);
    const name = String(action.diff.name);
    const reattach = typeof plan.target.tunnelId === 'string' ? await this.#row(plan.target.tunnelId) : null;
    if (reattach !== null) {
      try {
        if (reattach.cf_tunnel_id === null) throw new Error('the stable preview has no Cloudflare tunnel');
        // A new connector token for the new job: earlier holders are cut off.
        await cf.rotateTunnelSecret(reattach.cf_tunnel_id);
        await cf.cleanupTunnelConnections(reattach.cf_tunnel_id).catch(() => undefined);
        await cf.configureTunnel(reattach.cf_tunnel_id, reattach.hostname, port);
      } catch (err) {
        return { state: 'failed', result: { tunnelId: reattach.id }, error: this.#errText(err) };
      }
      await this.deps.pool.query(
        `UPDATE preview_tunnels SET state = 'active', job_id = $2, attempt_id = $3, epoch = $4, worker_id = $5,
           port = $6, port_check = $7, connector_state = NULL, connector_detail = NULL, connector_at = NULL,
           updated_at = $8
         WHERE id = $1`,
        [reattach.id, jobId, live.attemptId, live.epoch, live.workerId, port, check, now],
      );
      await this.#auditTunnel('preview.tunnel.attach', reattach.id, action, {
        hostname: reattach.hostname,
        port,
      });
      const row = await this.#row(reattach.id);
      if (row !== null) await this.#afterOpen(row, live);
      return { state: 'succeeded', result: this.#result(row ?? reattach) };
    }
    const minutes = lifetimeMinutes(
      p.stable === true,
      typeof p.ttlMinutes === 'number' ? p.ttlMinutes : undefined,
    );
    const id = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO preview_tunnels (id, project, name, stable, hostname, zone_id, zone_name, protection, state,
         job_id, attempt_id, epoch, worker_id, port, port_check, opened_by_type, opened_by_id, open_action_id,
         expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'opening', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)`,
      [
        id,
        action.project,
        name,
        p.stable === true,
        hostname,
        t.zone.id,
        t.zone.name,
        protect,
        jobId,
        live.attemptId,
        live.epoch,
        live.workerId,
        port,
        check,
        action.requestedBy.type,
        action.requestedBy.id,
        action.id,
        new Date(now.getTime() + minutes * 60_000),
        now,
      ],
    );
    try {
      const tunnel = await cf.createTunnel(`remyral-pv-${id.slice(0, 8)}-${name}`);
      await this.#set(id, { cf_tunnel_id: tunnel.id });
      await cf.configureTunnel(tunnel.id, hostname, port);
      const rec = await cf.createRecord(t.zone.id, {
        type: 'CNAME',
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        ttl: 1,
        proxied: true,
      });
      await this.#set(id, { dns_record_id: rec.id });
      if (protect === 'access') {
        const app = await cf.createAccessApp({
          name: `Remyral preview ${hostname}`,
          domain: hostname,
          policy: { kind: 'emails', emails: t.accessEmails },
          sessionDuration: '24h',
        });
        await this.#set(id, { access_app_id: app.id });
      } else if (protect === 'service-token') {
        const hours = Math.ceil(minutes / 60) + 24;
        const st = await cf.createServiceToken(`remyral-preview-${id.slice(0, 8)}`, `${String(hours)}h`);
        await this.deps.pool.query(
          `UPDATE preview_tunnels SET service_token_id = $2, service_token_client_id = $3, service_token_secret = $4
            WHERE id = $1`,
          [id, st.id, st.clientId, this.#box.encrypt(Buffer.from(st.clientSecret, 'utf8'), this.#aad(id))],
        );
        const app = await cf.createAccessApp({
          name: `Remyral preview ${hostname}`,
          domain: hostname,
          policy: { kind: 'service_token', tokenId: st.id },
          sessionDuration: '24h',
        });
        await this.#set(id, { access_app_id: app.id });
      }
      await this.deps.pool.query(
        `UPDATE preview_tunnels SET state = 'active', updated_at = $2 WHERE id = $1`,
        [id, this.deps.clock()],
      );
    } catch (err) {
      const msg = this.#errText(err);
      const row = await this.#row(id);
      if (row !== null) await this.#teardown(row, `failed: ${msg}`.slice(0, 300), null);
      return { state: 'failed', result: { tunnelId: id, hostname }, error: msg };
    }
    await this.#auditTunnel('preview.tunnel.open', id, action, {
      hostname,
      port,
      protection: protect,
      stable: p.stable === true,
    });
    const row = await this.#row(id);
    if (row !== null) await this.#afterOpen(row, live);
    return { state: 'succeeded', result: this.#result(row) };
  }

  #result(row: TunnelRow | null): Record<string, unknown> {
    if (row === null) return {};
    return {
      tunnelId: row.id,
      url: `https://${row.hostname}`,
      hostname: row.hostname,
      stable: row.stable,
      protection: row.protection,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** TUNNEL_START to the worker and the chat note (best effort: the sweep and reconnects re-send). */
  async #afterOpen(row: TunnelRow, live: LiveAttempt): Promise<void> {
    await this.#sendStart(row).catch((err: unknown) => {
      this.deps.log.warn({ tunnelId: row.id, err: this.#errText(err) }, 'preview: TUNNEL_START not sent');
    });
    await this.#chat(live.jobId, row).catch(() => undefined);
  }

  // ======================================================================================== worker side

  /**
   * TUNNEL_START with a fresh connector token (from Cloudflare; never stored). Only to the worker of the tunnel's
   * live attempt; a disconnected worker gets it on its next session.
   */
  async #sendStart(row: TunnelRow): Promise<boolean> {
    if (
      row.state !== 'active' ||
      row.cf_tunnel_id === null ||
      row.worker_id === null ||
      row.job_id === null
    ) {
      return false;
    }
    if (row.attempt_id === null || row.epoch === null || row.port === null) return false;
    const session = this.deps.session(row.worker_id);
    if (session === undefined) return false;
    const cf = await this.#cloudflare();
    const connectorToken = await cf.tunnelToken(row.cf_tunnel_id);
    const issuedAt = this.deps.clock().toISOString();
    const binding = {
      workerId: row.worker_id,
      tunnelId: row.id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      epoch: row.epoch,
      port: row.port,
      hostname: row.hostname,
      expiresAt: row.expires_at.toISOString(),
      check: row.port_check ?? 'declared',
      issuedAt,
      connectorToken,
    } as const;
    await session.send('TUNNEL_START', { ...binding, signature: this.deps.signer.signTunnelStart(binding) });
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET started_at = $2, updated_at = $2,
         connector_state = CASE WHEN connector_state IN ('running', 'starting') THEN connector_state ELSE 'starting' END,
         connector_at = CASE WHEN connector_state IN ('running', 'starting') THEN connector_at ELSE $2 END
       WHERE id = $1`,
      [row.id, this.deps.clock()],
    );
    return true;
  }

  async #sendStop(workerId: string, tunnelId: string, reason: string): Promise<void> {
    const session = this.deps.session(workerId);
    if (session === undefined) return;
    const issuedAt = this.deps.clock().toISOString();
    const b = { workerId, tunnelId, issuedAt };
    await session
      .send('TUNNEL_STOP', {
        tunnelId,
        reason: reason.slice(0, 200),
        issuedAt,
        signature: this.deps.signer.signTunnelStop(b),
      })
      .catch(() => undefined);
  }

  /** CAPABILITIES.previewTunnels: stored; running connectors reconciled with what the master wants. */
  async onReport(
    session: WorkerSession,
    payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
  ): Promise<void> {
    const raw = payload.previewTunnels;
    if (raw === undefined) return;
    const report = PreviewTunnelsReport.safeParse(raw);
    if (!report.success) return;
    const now = this.deps.clock();
    await this.deps.pool.query(
      'UPDATE workers SET preview_tunnels = $2, preview_tunnels_at = $3 WHERE id = $1',
      [session.workerId, report.data, now],
    );
    const running = new Map(report.data.connectors.map((c) => [c.tunnelId, c.state]));
    const { rows } = await this.deps.pool.query<TunnelRow>(
      `SELECT ${COLS} FROM preview_tunnels t WHERE t.worker_id = $1 AND t.state = 'active'`,
      [session.workerId],
    );
    const wanted = new Set<string>();
    for (const r of rows) {
      if (r.job_id === null || (await this.#liveAttempt(r.job_id))?.attemptId !== r.attempt_id) continue;
      wanted.add(r.id);
      const s = running.get(r.id);
      if (s !== 'running' && s !== 'starting') await this.#sendStart(r).catch(() => undefined);
    }
    for (const id of running.keys()) {
      if (!wanted.has(id)) await this.#sendStop(session.workerId, id, 'not an open preview of this machine');
    }
  }

  /** TUNNEL_STATUS: the connector state of one of this worker's tunnels. */
  async onStatus(session: WorkerSession, p: TunnelStatusPayload): Promise<void> {
    const row = await this.#row(p.tunnelId);
    if (row?.worker_id !== session.workerId || (row.state !== 'active' && row.state !== 'opening')) {
      // Not (or no longer) this worker's preview: make sure it stops.
      if (p.state === 'running' || p.state === 'starting') {
        await this.#sendStop(session.workerId, p.tunnelId, 'not an open preview of this machine');
      }
      return;
    }
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET connector_state = $2, connector_detail = $3, connector_at = $4, updated_at = $4
        WHERE id = $1`,
      [row.id, p.state, p.detail?.slice(0, 300) ?? null, now],
    );
    if (p.state === 'refused') {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'preview.tunnel.refused',
        target: `preview:${row.id}`,
        outcome: 'denied',
        metadata: { project: row.project, hostname: row.hostname, detail: p.detail ?? null },
      });
      // The worker will not serve it (port check, cloudflared missing, limit): a job-bound preview is closed.
      if (!row.stable)
        await this.#systemClose(row, `refused by the machine: ${p.detail ?? 'no reason given'}`);
    }
  }

  /**
   * PREVIEW_REQUEST from a job's agent tool or auto-open: fenced by the live lease (job, attempt, epoch, worker);
   * the job's creator is re-authorized (`previews.open`); every open / close is an ops action.
   */
  async onRequest(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'PREVIEW_REQUEST' }>,
  ): Promise<void> {
    const p = message.payload;
    const jobId = message.jobId;
    const base = { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId };
    const reply = async (
      r: Omit<PreviewResultPayload, 'attemptId' | 'epoch' | 'requestId'>,
    ): Promise<void> => {
      await session.send('PREVIEW_RESULT', { ...base, ...r }, { jobId }).catch((err: unknown) => {
        this.deps.log.warn({ err, jobId }, 'preview result not sent (worker disconnected)');
      });
    };
    const live = isUuid(jobId) ? await this.#liveAttempt(jobId) : null;
    if (
      live === null ||
      live.attemptId !== p.attemptId ||
      live.epoch !== p.epoch ||
      live.workerId !== session.workerId
    ) {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'preview.request',
        target: `job:${jobId}`,
        outcome: 'denied',
        metadata: { requestId: p.requestId, op: p.op.kind, reason: 'stale_lease' },
      });
      return reply({
        status: 'refused',
        reason: 'stale_lease',
        detail: 'This is not the live lease of the job.',
      });
    }
    try {
      switch (p.op.kind) {
        case 'list': {
          await reply({ status: 'ok', tunnels: await this.#jobInfos(jobId) });
          return;
        }
        case 'close': {
          const op = p.op;
          const rows = (await this.#jobRows(jobId)).filter(
            (r) =>
              OPEN_STATES.includes(r.state as (typeof OPEN_STATES)[number]) &&
              (op.tunnelId === undefined || r.id === op.tunnelId) &&
              (op.name === undefined || r.name === op.name),
          );
          if (rows.length === 0 || (op.tunnelId === undefined && op.name === undefined && rows.length > 1)) {
            await reply({
              status: 'refused',
              reason: 'not_found',
              detail:
                rows.length === 0
                  ? 'No open preview of this job matches.'
                  : 'This job has several previews: name the one to close (id or name).',
            });
            return;
          }
          const row = rows[0] as TunnelRow;
          const { action } = await this.#ops().request(
            this.#jobActor(jobId),
            {
              project: live.project,
              kind: 'tunnel.close',
              params: { tunnelId: row.id, reason: 'closed by the job' },
              idempotencyKey: `pvc-${p.requestId}`,
            },
            'job',
            { source: this.#jobSource(live), skipRateLimit: true },
          );
          if (action.state !== 'succeeded') {
            await reply({ ...actionProblem(action), actionId: action.id });
            return;
          }
          await reply({ status: 'ok', tunnels: await this.#jobInfos(jobId), actionId: action.id });
          return;
        }
        case 'publish': {
          // p10-publish-bundle (ADR-0038): recorded now, requested as ONE pages.publish when the job succeeds.
          const op = p.op;
          const dos = this.deps.deployOnSuccess?.() ?? null;
          if (dos === null) {
            await reply({
              status: 'refused',
              reason: 'unavailable',
              detail: 'Publishing is not available on this master.',
            });
            return;
          }
          const out = await dos.requestByAgent(
            {
              jobId,
              project: live.project,
              createdByType: live.createdByType,
              createdById: live.createdById,
              spec: live.spec,
            },
            {
              ...(op.env === undefined ? {} : { env: op.env }),
              ...(op.pagesProject === undefined ? {} : { pagesProject: op.pagesProject }),
              ...(op.createIfMissing === undefined ? {} : { createIfMissing: op.createIfMissing }),
              ...(op.domain === undefined ? {} : { domain: op.domain }),
              ...(op.dns === undefined ? {} : { dns: op.dns }),
              ...(op.directory === undefined ? {} : { directory: op.directory }),
            },
          );
          await this.deps.audit.record({
            actor: { type: 'worker', id: session.workerId },
            action: 'preview.request',
            target: `job:${jobId}`,
            outcome: out.status === 'ok' ? 'success' : 'denied',
            metadata: { requestId: p.requestId, op: 'publish', reason: out.reason.slice(0, 64) },
          });
          await reply({
            status: out.status === 'ok' ? 'ok' : 'refused',
            reason: out.reason.slice(0, 64),
            detail: out.detail,
          });
          return;
        }
        case 'deploy_status':
        case 'deploy_logs':
        case 'redeploy': {
          // p12-deploy-feedback (ADR-0048): read-only deploy tools / a redeploy request of the job's agent.
          const fb = this.deps.deployFeedback?.() ?? null;
          if (fb === null) {
            await reply({
              status: 'refused',
              reason: 'unavailable',
              detail: 'Deploy tools are not available on this master.',
            });
            return;
          }
          const job = {
            jobId,
            project: live.project,
            createdByType: live.createdByType,
            createdById: live.createdById,
            spec: live.spec,
          };
          const op = p.op;
          const out: { ok: boolean; text: string; reason?: string } =
            op.kind === 'deploy_status'
              ? await fb.agentStatus(job, { actionId: op.actionId })
              : op.kind === 'deploy_logs'
                ? await fb.agentLogs(job, {
                    actionId: op.actionId,
                    kind: op.logKind,
                    lines: op.lines,
                    sinceMinutes: op.sinceMinutes,
                    env: op.env,
                  })
                : await fb.agentRedeploy(job, { target: op.target, env: op.env });
          await reply({
            status: out.ok ? 'ok' : 'refused',
            ...(out.reason === undefined ? {} : { reason: out.reason.slice(0, 64) }),
            detail: out.text.slice(0, 16 * 1024),
          });
          return;
        }
        case 'open': {
          const op = p.op;
          const targets = (await this.#targets(live.project))?.previews ?? null;
          if (op.check === 'owned' && targets !== null && !targets.agentsMayOpen) {
            await reply({
              status: 'refused',
              reason: 'agents_disabled',
              detail:
                'This project does not let agents open previews; a person can open one from the job page.',
            });
            return;
          }
          if (op.check === 'declared' && live.spec?.previews?.autoOpen?.port !== op.port) {
            await reply({
              status: 'refused',
              reason: 'not_declared',
              detail:
                'Only the port declared when the job was created can be opened without the ownership check.',
            });
            return;
          }
          const who = await this.#creatorMayOpen(live);
          if (who !== null) {
            await reply({ status: 'refused', reason: 'creator_forbidden', detail: who });
            return;
          }
          // The same port of this job already has an open preview: hand it out (and restart its connector).
          const same = (await this.#jobRows(jobId)).find(
            (r) => r.state === 'active' && r.port === op.port && r.attempt_id === live.attemptId,
          );
          if (same !== undefined) {
            await this.#sendStart(same).catch(() => undefined);
            await reply({ status: 'ok', tunnels: [this.#info(same, true)] });
            return;
          }
          const { action } = await this.#ops().request(
            this.#jobActor(jobId),
            {
              project: live.project,
              kind: 'tunnel.open',
              params: {
                jobId,
                port: op.port,
                ...(op.name === undefined ? {} : { name: op.name }),
                protect: op.protect,
                ...(op.ttlMinutes === undefined ? {} : { ttlMinutes: op.ttlMinutes }),
                stable: op.stable,
                check: op.check,
              },
              idempotencyKey: `pv-${p.requestId}`,
            },
            'job',
            { source: this.#jobSource(live) },
          );
          if (action.state !== 'succeeded') {
            await reply({ ...actionProblem(action), actionId: action.id });
            return;
          }
          const id = typeof action.result?.tunnelId === 'string' ? action.result.tunnelId : '';
          const row = await this.#row(id);
          await reply({
            status: 'ok',
            tunnels: row === null ? [] : [this.#info(row, true)],
            actionId: action.id,
          });
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof OpsError ? err.message : 'The preview request failed.';
      if (!(err instanceof OpsError)) this.deps.log.error({ err, jobId }, 'preview request failed');
      return reply({
        status: 'failed',
        reason: err instanceof OpsError ? err.code : 'internal',
        detail: msg,
      });
    }
  }

  #jobActor(jobId: string): OpsActor {
    return { type: 'system', id: `job:${jobId}` };
  }

  #jobSource(live: LiveAttempt): Record<string, unknown> {
    return {
      jobId: live.jobId,
      attemptId: live.attemptId,
      createdBy: { type: live.createdByType, id: live.createdById },
    };
  }

  /** The job's creator may (still) open previews in the project, or why not. System-created jobs: the project decides. */
  async #creatorMayOpen(live: LiveAttempt): Promise<string | null> {
    if (live.createdByType !== 'user' || live.createdById === null) return null;
    const { rows } = await this.deps.pool.query<{
      id: string;
      role: 'owner' | 'admin' | 'operator' | 'viewer';
      disabled: boolean;
    }>('SELECT id, role, disabled_at IS NOT NULL AS disabled FROM users WHERE id::text = $1', [
      live.createdById,
    ]);
    const u = rows[0];
    if (u === undefined || u.disabled) return 'The person who started this job can no longer open previews.';
    const subject = await loadSubject(this.deps.pool, { id: u.id, role: u.role });
    return authorize(subject, 'previews.open', { project: live.project }).allow
      ? null
      : 'The person who started this job may not open previews in this project.';
  }

  // ============================================================================================ console

  async projectView(project: string): Promise<{
    settings: (PreviewSettings & { previewTunnel: string; stableTunnel: string }) | null;
    tunnels: TunnelView[];
  }> {
    const t = await this.#targets(project);
    const { rows } = await this.deps.pool.query<TunnelRow>(
      `SELECT ${COLS} FROM preview_tunnels t
        WHERE t.project = $1 AND (t.state <> 'closed' OR t.closed_at > $2)
        ORDER BY t.created_at DESC LIMIT 100`,
      [project, new Date(this.deps.clock().getTime() - 7 * 86_400_000)],
    );
    return {
      settings:
        t?.previews == null
          ? null
          : { ...t.previews, previewTunnel: t.policy.previewTunnel, stableTunnel: t.policy.stableTunnel },
      tunnels: rows.map((r) => this.#view(r)),
    };
  }

  async jobView(jobId: string): Promise<{
    tunnels: TunnelView[];
    available: { ok: boolean; reason: string | null };
    settings: { protections: PreviewProtection[]; defaultTtlMinutes: number; maxTtlMinutes: number } | null;
  }> {
    const project = await this.#projectOfJob(jobId);
    if (project === null) throw new OpsError(404, 'job_not_found', 'Job not found.');
    const t = (await this.#targets(project))?.previews ?? null;
    const live = await this.#liveAttempt(jobId);
    const reason = await this.#availability(t, live);
    return {
      tunnels: (await this.#jobRows(jobId)).map((r) => this.#view(r)),
      available: { ok: reason === null, reason },
      settings:
        t === null
          ? null
          : {
              protections: protectionsOffered(t),
              defaultTtlMinutes: PREVIEW_LIMITS.defaultTtlMinutes,
              maxTtlMinutes: PREVIEW_LIMITS.maxTtlMinutes,
            },
    };
  }

  /** A person opens a preview of a running job's port (job page). */
  async open(
    actor: OpsActor,
    jobId: string,
    input: {
      port: number;
      name?: string;
      protect?: PreviewProtection;
      ttlMinutes?: number;
      stable?: boolean;
      idempotencyKey: string;
    },
  ): Promise<{ action: OpsActionView; tunnel: TunnelView | null }> {
    const project = await this.#projectOfJob(jobId);
    if (project === null) throw new OpsError(404, 'job_not_found', 'Job not found.');
    const { action } = await this.#ops().request(
      actor,
      {
        project,
        kind: 'tunnel.open',
        params: {
          jobId,
          port: input.port,
          ...(input.name === undefined ? {} : { name: input.name }),
          protect: input.protect ?? 'none',
          ...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes }),
          stable: input.stable === true,
          check: 'declared',
        },
        idempotencyKey: input.idempotencyKey,
      },
      'api',
    );
    return { action, tunnel: await this.#tunnelOf(action) };
  }

  async close(
    actor: OpsActor,
    tunnelId: string,
    idempotencyKey: string,
  ): Promise<{ action: OpsActionView; tunnel: TunnelView | null }> {
    const row = await this.#row(tunnelId);
    if (row === null) throw new OpsError(404, 'preview_not_found', 'Preview not found.');
    const { action } = await this.#ops().request(
      actor,
      { project: row.project, kind: 'tunnel.close', params: { tunnelId, reason: 'closed' }, idempotencyKey },
      'api',
      { skipRateLimit: true },
    );
    const after = await this.#row(tunnelId);
    return { action, tunnel: after === null ? null : this.#view(after) };
  }

  async extend(
    actor: OpsActor,
    tunnelId: string,
    minutes: number,
    idempotencyKey: string,
  ): Promise<{ action: OpsActionView; tunnel: TunnelView | null }> {
    const row = await this.#row(tunnelId);
    if (row === null) throw new OpsError(404, 'preview_not_found', 'Preview not found.');
    const { action } = await this.#ops().request(
      actor,
      { project: row.project, kind: 'tunnel.extend', params: { tunnelId, minutes }, idempotencyKey },
      'api',
    );
    const after = await this.#row(tunnelId);
    return { action, tunnel: after === null ? null : this.#view(after) };
  }

  /** The service token of a `service-token` preview (project admin, always-fresh step-up — checked by the route). */
  async reveal(actor: OpsActor, tunnelId: string): Promise<{ clientId: string; clientSecret: string }> {
    const row = await this.#row(tunnelId);
    if (row === null) throw new OpsError(404, 'preview_not_found', 'Preview not found.');
    const secret = this.#secret(row);
    if (secret === null || row.service_token_client_id === null) {
      throw new OpsError(409, 'no_service_token', 'This preview has no service token.');
    }
    await this.deps.audit.record({
      actor: { type: actor.type, id: actor.id },
      action: 'preview.service_token.reveal',
      target: `preview:${row.id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { project: row.project, hostname: row.hostname, clientId: row.service_token_client_id },
    });
    return { clientId: row.service_token_client_id, clientSecret: secret };
  }

  async projectOfTunnel(id: string): Promise<string | null> {
    return (await this.#row(id))?.project ?? null;
  }

  async #tunnelOf(action: OpsActionView): Promise<TunnelView | null> {
    const id = action.result?.tunnelId;
    if (typeof id !== 'string') return null;
    const row = await this.#row(id);
    return row === null ? null : this.#view(row);
  }

  // ======================================================================================== assignment

  /** ASSIGN_JOB `execution.previews` for a job placed on `workerId` (null: no previews for this job). */
  async assignment(project: string, spec: JobSpec, workerId: string): Promise<AssignedPreviews | null> {
    if (spec.kind === 'machine-admin') return null;
    const targets = await this.#targets(project);
    const { rows } = await this.deps.pool.query<{ features: unknown }>(
      'SELECT features FROM workers WHERE id = $1',
      [workerId],
    );
    const features = rows[0]?.features;
    const has = (f: string): boolean => Array.isArray(features) && features.includes(f);
    // p10-publish-bundle (ADR-0038): `publish_site` for trusted jobs of projects with a Pages project, on workers that
    // offer it (any sandbox profile: the tool needs no local port).
    const publish =
      has(SITE_PUBLISH_FEATURE) &&
      spec.sourceTrust === 'trusted' &&
      targets !== null &&
      (targets.pages !== null || targets.pagesProjects.length > 0);
    // p12-deploy-feedback (ADR-0048): the deploy tools for trusted jobs of projects with a Coolify or Pages target, on
    // workers that offer them (every runtime with a tool channel, any sandbox profile).
    const deploy =
      has(DEPLOY_FEEDBACK_FEATURE) &&
      spec.sourceTrust === 'trusted' &&
      targets !== null &&
      (targets.pages !== null ||
        targets.pagesProjects.length > 0 ||
        [targets.coolify?.preview, targets.coolify?.production].some(
          (c) => c != null && (c.uuids.length > 0 || c.tags.length > 0),
        ));
    const extra = { ...(publish ? { publish: true } : {}), ...(deploy ? { deploy: true } : {}) };
    const previews = this.#previewAssignment(
      spec,
      targets?.previews ?? null,
      has(PREVIEW_TUNNELS_FEATURE),
      has(PREVIEW_CONTAINER_FEATURE),
    );
    if (previews === null) {
      return publish || deploy ? { tools: false, declaredPorts: [], protections: ['none'], ...extra } : null;
    }
    return { ...previews, ...extra };
  }

  /**
   * p8-preview-tunnels: the preview part of `execution.previews`. p22-previews-inputs: container-profile jobs only on
   * workers that publish container ports (`preview-container-v1`).
   */
  #previewAssignment(
    spec: JobSpec,
    t: PreviewSettings | null,
    feature: boolean,
    containerFeature: boolean,
  ): AssignedPreviews | null {
    if (spec.sandboxProfile === 'container' && !containerFeature) return null;
    if (t?.zone == null) return null;
    if (!feature) return null;
    const autoOpen = spec.previews?.autoOpen;
    const protections = protectionsOffered(t);
    const usable = autoOpen !== undefined && protections.includes(autoOpen.protect) ? autoOpen : undefined;
    if (!t.agentsMayOpen && usable === undefined) return null;
    return {
      tools: t.agentsMayOpen,
      declaredPorts: usable === undefined ? [] : [usable.port],
      ...(usable === undefined ? {} : { autoOpen: usable }),
      protections,
    };
  }

  // ============================================================================================= sweep

  /**
   * One pass (orchestrator tick step `preview-tunnels`): close expired and orphaned job-bound tunnels, detach stable
   * ones whose job ended, retry failed tear-downs, mark connectors of disconnected workers `down`.
   */
  async sweep(limit = 20): Promise<number> {
    const now = this.deps.clock();
    let n = 0;
    const { rows } = await this.deps.pool.query<TunnelRow>(
      `SELECT ${COLS} FROM preview_tunnels t WHERE t.state = ANY($1) ORDER BY t.updated_at LIMIT $2`,
      [[...OPEN_STATES], limit * 5],
    );
    for (const r of rows) {
      if (n >= limit) break;
      try {
        if (r.state === 'closing') {
          if ((await this.#teardown(r, r.close_reason ?? 'closed', null)) === null) n++;
          continue;
        }
        if (r.state === 'opening') {
          if (now.getTime() - r.updated_at.getTime() > (this.deps.openingTimeoutMs ?? 10 * 60_000)) {
            await this.#teardown(r, 'failed: the open did not finish', null);
            n++;
          }
          continue;
        }
        if (r.expires_at <= now) {
          await this.#systemClose(r, 'expired');
          n++;
          continue;
        }
        if (r.state === 'active' && r.job_id !== null) {
          const live = await this.#liveAttempt(r.job_id);
          if (live?.attemptId !== r.attempt_id) {
            if (r.stable) await this.#detach(r, 'job ended');
            else await this.#systemClose(r, 'job_ended');
            n++;
            continue;
          }
          if (
            r.worker_id !== null &&
            this.deps.session(r.worker_id) === undefined &&
            r.connector_state !== 'down'
          ) {
            await this.deps.pool.query(
              `UPDATE preview_tunnels SET connector_state = 'down', connector_detail = 'machine not connected',
                 connector_at = $2 WHERE id = $1`,
              [r.id, now],
            );
          }
        }
      } catch (err) {
        this.deps.log.warn({ tunnelId: r.id, err: this.#errText(err) }, 'preview sweep step failed');
      }
    }
    return n;
  }

  async #systemClose(row: TunnelRow, reason: string): Promise<void> {
    const ops = this.deps.ops();
    if (ops === null) return;
    await ops.request(
      { type: 'system', id: 'previews' },
      {
        project: row.project,
        kind: 'tunnel.close',
        params: { tunnelId: row.id, reason },
        idempotencyKey: `pv-close-${row.id}`,
        note: reason,
      },
      'api',
      { skipRateLimit: true },
    );
  }

  /** A stable tunnel whose job ended keeps its hostname; its connector stops. */
  async #detach(row: TunnelRow, reason: string): Promise<void> {
    if (row.worker_id !== null) await this.#sendStop(row.worker_id, row.id, reason);
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET state = 'idle', job_id = NULL, attempt_id = NULL, epoch = NULL, worker_id = NULL,
         port = NULL, port_check = NULL, connector_state = NULL, connector_detail = NULL, connector_at = NULL,
         updated_at = $2
       WHERE id = $1 AND state = 'active'`,
      [row.id, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: { type: 'system', id: 'previews' },
      action: 'preview.tunnel.detach',
      target: `preview:${row.id}`,
      outcome: 'success',
      metadata: { project: row.project, hostname: row.hostname, jobId: row.job_id, reason },
    });
  }

  /**
   * Stops the connector and deletes every Cloudflare resource of the preview (Access app, service token, DNS record,
   * connections, tunnel — deleting the tunnel revokes its token). Not-found answers count as deleted. Returns null
   * when everything is gone (state `closed`), else the error (state stays `closing`; the sweep retries).
   */
  async #teardown(row: TunnelRow, reason: string, actor: OpsActor | null): Promise<string | null> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET state = 'closing', close_reason = $2, updated_at = $3
        WHERE id = $1 AND state <> 'closed'`,
      [row.id, reason.slice(0, 300), now],
    );
    if (row.worker_id !== null) await this.#sendStop(row.worker_id, row.id, reason);
    let cf: CloudflareClient;
    try {
      cf = await this.#cloudflare();
    } catch (err) {
      return this.#errText(err);
    }
    const gone = async (
      what: string,
      fn: () => Promise<void>,
      clear: Record<string, null>,
    ): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        if (!(err instanceof ProviderCallError && err.code === 'not_found')) {
          throw new Error(`${what}: ${this.#errText(err)}`, { cause: err });
        }
      }
      await this.#set(row.id, clear);
    };
    try {
      if (row.access_app_id !== null) {
        const app = row.access_app_id;
        await gone('Access application', () => cf.deleteAccessApp(app), { access_app_id: null });
      }
      if (row.service_token_id !== null) {
        const st = row.service_token_id;
        await gone('service token', () => cf.deleteServiceToken(st), {});
        await this.deps.pool.query(
          'UPDATE preview_tunnels SET service_token_id = NULL, service_token_secret = NULL WHERE id = $1',
          [row.id],
        );
      }
      if (row.dns_record_id !== null) {
        const rec = row.dns_record_id;
        await gone('DNS record', () => cf.deleteRecord(row.zone_id, rec), { dns_record_id: null });
      }
      if (row.cf_tunnel_id !== null) {
        const tid = row.cf_tunnel_id;
        await cf.cleanupTunnelConnections(tid).catch(() => undefined);
        await gone('tunnel', () => cf.deleteTunnel(tid), { cf_tunnel_id: null });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'clean-up failed';
      this.deps.log.warn({ tunnelId: row.id, err: msg }, 'preview tear-down incomplete; retried later');
      return msg.slice(0, 500);
    }
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET state = 'closed', closed_at = $2, updated_at = $2, service_token_secret = NULL,
         connector_state = CASE WHEN connector_state IS NULL THEN NULL ELSE 'stopped' END
       WHERE id = $1 AND state <> 'closed'`,
      [row.id, this.deps.clock()],
    );
    await this.deps.audit.record({
      actor: actor === null ? { type: 'system', id: 'previews' } : { type: actor.type, id: actor.id },
      action: 'preview.tunnel.close',
      target: `preview:${row.id}`,
      outcome: 'success',
      metadata: { project: row.project, hostname: row.hostname, reason },
    });
    return null;
  }

  // ============================================================================================= p15-services

  /**
   * p15-services (ADR-0032 addendum): a named tunnel for a SERVICE (no job) — `hostname → http://localhost:<port>` of
   * the service's machine, under the project's preview zone, counted against the project's open-preview limit. The
   * project's `policy.previewTunnel` must be `auto` (a service tunnel opens with the service; approvals are for job
   * previews). The connector token is fetched per send ({@link serviceConnector}) and never stored. Audited.
   */
  async openForService(input: {
    readonly project: string;
    readonly serviceId: string;
    readonly port: number;
    readonly name?: string | undefined;
    readonly protect?: PreviewProtection | undefined;
    readonly expiresAt: Date;
    readonly actor: { readonly type: 'user' | 'system'; readonly id: string };
    /** The request comes from a job's agent: the project's "agents may open previews" switch applies. */
    readonly byAgent: boolean;
  }): Promise<{ ok: true; tunnelId: string; hostname: string } | { ok: false; reason: string }> {
    const t = await this.#targets(input.project);
    const settings = t?.previews ?? null;
    if (t === null || settings?.zone == null) {
      return {
        ok: false,
        reason: 'Preview links are not set up for this project (Project → Deploy → Preview links).',
      };
    }
    if (input.byAgent && !settings.agentsMayOpen) {
      return { ok: false, reason: 'This project does not let agents open preview links.' };
    }
    if (t.policy.previewTunnel !== 'auto') {
      return {
        ok: false,
        reason: 'Preview links of this project need an approval; use a quick tunnel instead.',
      };
    }
    const protect = input.protect ?? 'none';
    if (!protectionsOffered(settings).includes(protect)) {
      return { ok: false, reason: 'Access protection needs at least one allowed e-mail address.' };
    }
    const open = await this.deps.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM preview_tunnels WHERE project = $1 AND state = ANY($2)',
      [input.project, [...OPEN_STATES]],
    );
    if ((open.rows[0]?.n ?? 0) + 1 > settings.maxActive) {
      return {
        ok: false,
        reason: `This project already has ${String(open.rows[0]?.n ?? 0)} open preview links.`,
      };
    }
    const name = previewSlug(input.name);
    const zone = settings.zone;
    const hostname = previewHostname(zone.name, settings.prefix, name);
    let cf: CloudflareClient;
    try {
      cf = await this.#cloudflare();
      const protection = await this.#protectionContext(cf, zone.id, zone.name, t);
      const why =
        !nameInZone(hostname, zone.name) || hostname === zone.name
          ? `${hostname} is not a subdomain of ${zone.name}.`
          : protectedRecordReason(
              { name: hostname, type: 'CNAME', content: '<tunnel>.cfargotunnel.com' },
              protection,
            );
      if (why !== null) return { ok: false, reason: why };
      if ((await this.#provider(() => cf.records(zone.id, hostname))).length > 0) {
        return { ok: false, reason: `A DNS record for ${hostname} already exists.` };
      }
    } catch (err) {
      return { ok: false, reason: this.#errText(err) };
    }
    const id = randomUUID();
    const now = this.deps.clock();
    await this.deps.pool.query(
      `INSERT INTO preview_tunnels (id, project, name, stable, hostname, zone_id, zone_name, protection, state,
         port, port_check, opened_by_type, opened_by_id, expires_at, created_at, updated_at, service_id)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7, 'opening', $8, 'owned', $9, $10, $11, $12, $12, $13)`,
      [
        id,
        input.project,
        name,
        hostname,
        zone.id,
        zone.name,
        protect,
        input.port,
        input.actor.type,
        input.actor.id.slice(0, 128),
        input.expiresAt,
        now,
        input.serviceId,
      ],
    );
    try {
      const tunnel = await cf.createTunnel(`remyral-svc-${id.slice(0, 8)}-${name}`);
      await this.#set(id, { cf_tunnel_id: tunnel.id });
      await cf.configureTunnel(tunnel.id, hostname, input.port);
      const rec = await cf.createRecord(zone.id, {
        type: 'CNAME',
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        ttl: 1,
        proxied: true,
      });
      await this.#set(id, { dns_record_id: rec.id });
      if (protect === 'access') {
        const app = await cf.createAccessApp({
          name: `Remyral service ${hostname}`,
          domain: hostname,
          policy: { kind: 'emails', emails: settings.accessEmails },
          sessionDuration: '24h',
        });
        await this.#set(id, { access_app_id: app.id });
      } else if (protect === 'service-token') {
        const st = await cf.createServiceToken(`remyral-service-${id.slice(0, 8)}`, '8760h');
        await this.deps.pool.query(
          `UPDATE preview_tunnels SET service_token_id = $2, service_token_client_id = $3, service_token_secret = $4
            WHERE id = $1`,
          [id, st.id, st.clientId, this.#box.encrypt(Buffer.from(st.clientSecret, 'utf8'), this.#aad(id))],
        );
        const app = await cf.createAccessApp({
          name: `Remyral service ${hostname}`,
          domain: hostname,
          policy: { kind: 'service_token', tokenId: st.id },
          sessionDuration: '24h',
        });
        await this.#set(id, { access_app_id: app.id });
      }
      await this.deps.pool.query(
        `UPDATE preview_tunnels SET state = 'active', updated_at = $2 WHERE id = $1`,
        [id, this.deps.clock()],
      );
    } catch (err) {
      const msg = this.#errText(err);
      const row = await this.#row(id);
      if (row !== null) await this.#teardown(row, `failed: ${msg}`.slice(0, 300), null);
      return { ok: false, reason: msg };
    }
    await this.deps.audit.record({
      actor: input.actor,
      action: 'preview.tunnel.open',
      target: `preview:${id}`,
      outcome: 'success',
      metadata: {
        project: input.project,
        hostname,
        port: input.port,
        protection: protect,
        serviceId: input.serviceId,
      },
    });
    return { ok: true, tunnelId: id, hostname };
  }

  /**
   * p15-services: whether a job's agent may open a quick (public, no-account) tunnel for a service — yes unless the
   * project turned "agents may open previews" off.
   */
  async agentQuickTunnels(project: string): Promise<boolean> {
    const t = await this.#targets(project);
    return t?.previews?.agentsMayOpen !== false;
  }

  /** p15-services: whether agents of this project may ask for named service tunnels (preview links set up, auto). */
  async serviceTunnelsOffered(project: string): Promise<boolean> {
    const t = await this.#targets(project);
    return t?.previews?.zone != null && t.previews.agentsMayOpen && t.policy.previewTunnel === 'auto';
  }

  /** p15-services: what SERVICE_TUNNEL carries — a fresh connector token from Cloudflare (never stored). */
  async serviceConnector(
    tunnelId: string,
  ): Promise<{ hostname: string; port: number; expiresAt: Date; connectorToken: string } | null> {
    const row = await this.#row(tunnelId);
    if (row?.state !== 'active' || row.cf_tunnel_id === null || row.port === null) return null;
    const cf = await this.#cloudflare();
    return {
      hostname: row.hostname,
      port: row.port,
      expiresAt: row.expires_at,
      connectorToken: await cf.tunnelToken(row.cf_tunnel_id),
    };
  }

  /** p15-services: the service's lifetime changed (its tunnel follows). */
  async extendForService(tunnelId: string, expiresAt: Date): Promise<void> {
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET expires_at = $2, updated_at = $3 WHERE id = $1 AND state = 'active'`,
      [tunnelId, expiresAt, this.deps.clock()],
    );
  }

  /** p15-services: the service stopped / was removed — every Cloudflare resource of its tunnel is deleted. */
  async closeForService(tunnelId: string, reason: string): Promise<void> {
    const row = await this.#row(tunnelId);
    if (row === null || row.state === 'closed') return;
    await this.#teardown(row, reason, null);
  }

  // ============================================================================================= helpers

  #ops(): OpsService {
    const ops = this.deps.ops();
    if (ops === null) throw new OpsError(503, 'ops_unavailable', 'Ops actions are not available.');
    return ops;
  }

  async #cloudflare(): Promise<CloudflareClient> {
    const c = await this.deps.integrations.cloudflare();
    if (c === null) {
      throw new OpsError(
        409,
        'cloudflare_not_configured',
        'Cloudflare is not connected (Settings → Integrations).',
      );
    }
    return c.client;
  }

  async #provider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderCallError) {
        // p10-publish-bundle: 424, not 502 (a proxy in front of the console replaces 5xx bodies).
        throw new OpsError(
          err.code === 'rate_limited' ? 429 : 424,
          `${err.provider}_${err.code}`,
          providerText(err),
          err.retryAfterSec === null ? {} : { 'retry-after': String(err.retryAfterSec) },
        );
      }
      throw err;
    }
  }

  #errText(err: unknown): string {
    if (err instanceof ProviderCallError || err instanceof OpsError) return err.message.slice(0, 300);
    return err instanceof Error ? err.message.slice(0, 300) : 'error';
  }

  async #protectionContext(
    cf: CloudflareClient,
    zoneId: string,
    zoneName: string,
    t: DeployTargets,
  ): Promise<Parameters<typeof protectedRecordReason>[1]> {
    const targets = new Set(this.deps.controlPlaneAddresses.map((a) => a.toLowerCase()));
    for (const host of this.#consoleHosts) {
      if (!nameInZone(host, zoneName)) continue;
      for (const r of await this.#provider(() => cf.records(zoneId, host))) {
        targets.add(r.content.toLowerCase().replace(/\.$/, ''));
      }
    }
    return {
      consoleHosts: this.#consoleHosts,
      protectedNames: new Set(t.dns.protectedNames),
      controlPlaneTargets: targets,
    };
  }

  async #targets(project: string): Promise<DeployTargets | null> {
    return (await this.deps.ops()?.targets(project))?.targets ?? null;
  }

  async #availability(settings: PreviewSettings | null, live: LiveAttempt | null): Promise<string | null> {
    let feature = false;
    let containerFeature = false;
    let cloudflared = false;
    if (live !== null) {
      const { rows } = await this.deps.pool.query<{ features: unknown; preview_tunnels: unknown }>(
        'SELECT features, preview_tunnels FROM workers WHERE id = $1',
        [live.workerId],
      );
      const w = rows[0];
      feature = Array.isArray(w?.features) && w.features.includes(PREVIEW_TUNNELS_FEATURE);
      containerFeature = Array.isArray(w?.features) && w.features.includes(PREVIEW_CONTAINER_FEATURE);
      const rep = PreviewTunnelsReport.safeParse(w?.preview_tunnels);
      cloudflared = rep.success && rep.data.cloudflared !== null;
    }
    return previewAvailability({
      settings,
      jobActive: live !== null,
      sandboxProfile: live?.spec?.sandboxProfile ?? null,
      workerFeature: feature,
      cloudflared,
      workerConnected: live !== null && this.deps.session(live.workerId) !== undefined,
      containerFeature,
    });
  }

  /** The job's live attempt (unreleased, unexpired lease of the current epoch), or null. */
  async #liveAttempt(jobId: string, db: Queryable = this.deps.pool): Promise<LiveAttempt | null> {
    if (!isUuid(jobId)) return null;
    const { rows } = await db.query<{
      project: string;
      spec: unknown;
      attempt_id: string;
      epoch: number;
      worker_id: string;
      created_by_type: string;
      created_by_id: string | null;
    }>(
      `SELECT j.project, j.spec, l.attempt_id::text AS attempt_id, l.epoch, l.worker_id, j.created_by_type,
              j.created_by_id
         FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id = $1 AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $2 AND j.lease_epoch = l.epoch
          AND j.state::text IN ('RESERVED', 'STARTING', 'RUNNING', 'VERIFYING', 'AWAITING_APPROVAL')`,
      [jobId, this.deps.clock()],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const spec = JobSpec.safeParse(r.spec);
    return {
      jobId,
      project: r.project,
      attemptId: r.attempt_id,
      epoch: r.epoch,
      workerId: r.worker_id,
      spec: spec.success ? spec.data : null,
      createdByType: r.created_by_type,
      createdById: r.created_by_id,
    };
  }

  async #projectOfJob(jobId: string): Promise<string | null> {
    if (!isUuid(jobId)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0]?.project ?? null;
  }

  async #row(id: string): Promise<TunnelRow | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.deps.pool.query<TunnelRow>(
      `SELECT ${COLS} FROM preview_tunnels t WHERE t.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Tunnels a job opened or serves (newest first). */
  async #jobRows(jobId: string): Promise<TunnelRow[]> {
    const { rows } = await this.deps.pool.query<TunnelRow>(
      `SELECT ${COLS} FROM preview_tunnels t
        WHERE t.job_id = $1
           OR t.open_action_id IN (SELECT id FROM ops_actions WHERE kind = 'tunnel.open' AND params->>'jobId' = $1::text)
        ORDER BY t.created_at DESC LIMIT 50`,
      [jobId],
    );
    return rows;
  }

  async #jobInfos(jobId: string): Promise<PreviewTunnelInfo[]> {
    const rows = (await this.#jobRows(jobId)).filter((r) => r.state !== 'closed' && r.state !== 'failed');
    return rows.map((r) => this.#info(r, r.job_id === jobId));
  }

  /** What the job sees; the service token only for the job that serves the preview. */
  #info(row: TunnelRow, withSecret: boolean): PreviewTunnelInfo {
    const secret = withSecret ? this.#secret(row) : null;
    return {
      id: row.id,
      name: row.name,
      url: `https://${row.hostname}`,
      protection: row.protection,
      stable: row.stable,
      state: row.state,
      port: row.port,
      expiresAt: row.expires_at.toISOString(),
      ...(secret !== null && row.service_token_client_id !== null
        ? { serviceToken: { clientId: row.service_token_client_id, clientSecret: secret } }
        : {}),
    };
  }

  #aad(id: string): string {
    return `preview-service-token:${id}`;
  }

  #secret(row: TunnelRow): string | null {
    if (row.service_token_secret === null) return null;
    try {
      return this.#box.decrypt(row.service_token_secret, this.#aad(row.id)).toString('utf8');
    } catch (err) {
      if (err instanceof SecretBoxError) return null;
      throw err;
    }
  }

  async #set(id: string, values: Record<string, string | null>): Promise<void> {
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    const allowed = new Set(['cf_tunnel_id', 'dns_record_id', 'access_app_id']);
    const sets = keys.filter((k) => allowed.has(k));
    if (sets.length === 0) return;
    await this.deps.pool.query(
      `UPDATE preview_tunnels SET ${sets.map((k, i) => `${k} = $${String(i + 2)}`).join(', ')}, updated_at = $${String(sets.length + 2)}
        WHERE id = $1`,
      [id, ...sets.map((k) => values[k] ?? null), this.deps.clock()],
    );
  }

  async #auditTunnel(
    action: string,
    tunnelId: string,
    a: OpsHandlerAction,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: a.requestedBy.type, id: a.requestedBy.id },
      action,
      target: `preview:${tunnelId}`,
      outcome: 'success',
      metadata: { project: a.project, opsActionId: a.id, via: a.via, source: a.source, ...metadata },
    });
  }

  /** p6-chat-notify style: the conversation the job was drafted in gets the link. */
  async #chat(jobId: string, row: TunnelRow): Promise<void> {
    if (this.deps.chatNote === undefined) return;
    const { rows } = await this.deps.pool.query<{ thread_id: string }>(
      `SELECT thread_id::text AS thread_id FROM chat_drafts
        WHERE kind = 'job' AND state = 'confirmed' AND result->>'jobId' = $1 LIMIT 1`,
      [jobId],
    );
    const thread = rows[0]?.thread_id;
    if (thread === undefined) return;
    const url = `https://${row.hostname}`;
    const how =
      row.protection === 'none'
        ? 'public link — anyone with it can open it'
        : row.protection === 'access'
          ? 'protected by Cloudflare Access (allowed e-mails)'
          : 'protected by a service token (for an app backend)';
    await this.deps.chatNote(
      thread,
      `Preview ${row.stable ? `(stable "${row.name}") ` : ''}is open: ${url} — ${how}; until ${row.expires_at.toISOString()}.`,
      { kind: 'preview', url, tunnelId: row.id, jobId, protection: row.protection },
    );
  }

  #view(r: TunnelRow): TunnelView {
    return {
      id: r.id,
      project: r.project,
      name: r.name,
      hostname: r.hostname,
      url: `https://${r.hostname}`,
      protection: r.protection,
      stable: r.stable,
      state: r.state,
      connector:
        r.connector_state === null
          ? null
          : {
              state: r.connector_state,
              detail: r.connector_detail,
              since: (r.connector_at ?? r.updated_at).toISOString(),
            },
      jobId: r.job_id,
      workerId: r.worker_id,
      port: r.port,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      closedAt: r.closed_at?.toISOString() ?? null,
      closeReason: r.close_reason,
      openedBy: { type: r.opened_by_type, id: r.opened_by_id, username: r.opener },
      openActionId: r.open_action_id,
      serviceTokenClientId: r.service_token_client_id,
    };
  }
}
