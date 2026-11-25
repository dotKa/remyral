import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { STEP_UP_ALWAYS_FRESH_MS } from '../auth/step-up.js';
import { stepUpFresh } from '../approvals/policy-store.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Role, type Subject } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import {
  DEFAULT_SITE_DIRECTORY,
  type DeployEnv,
  DeployOnSuccessRequest,
  type DeployTargets,
  HostName,
  OpsError,
  type OpsActionView,
  type PublishExtras,
  publishExtrasOf,
} from './model.js';
import { OUTBOX_TOPIC_DEPLOY_ON_SUCCESS } from './outbox.js';
import {
  type ApprovalLevel,
  nameInZone,
  onSuccessLevel,
  publishDecision,
  type PublishStepFacts,
} from './policy.js';
import type { OpsService } from './service.js';
import { GATE_HOLDS_SQL } from '../verify/model.js';

/**
 * p6-deploy-on-success (ADR-0030, docs/design/p6-deploy-on-success.md): a job created with "deploy when done".
 *
 * - **At creation** (`prepare` + `record`): the creator's submission is the approval. The level the deploy policy
 *   asks for now (preview auto / approval / approval + step-up; production only with the project switch) must be
 *   satisfied by the creator at that moment; a refusal creates no job. One pre-approval row per job, inserted in the
 *   job's own transaction, bound to the job, the target kind, the environment and the configured target.
 * - **On success** (`tick`, an orchestrator step): the master re-checks (creator still allowed, switch still on,
 *   target unchanged, the job's own unflagged site bundle), requests the ops action as the creator with the
 *   pre-approval, and follows it to its end; then tells the creator (chat thread, job page, notification).
 */

export type DeployOnSuccessState =
  'pending' | 'running' | 'requested' | 'succeeded' | 'failed' | 'refused' | 'skipped';
/** p10-publish-bundle: `job` — requested by the job's own agent (`publish_site`), not pre-approved. */
export type DeployOnSuccessVia = 'api' | 'chat' | 'automation' | 'job';
/** p10-publish-bundle: `none` — no pre-approval (an agent's request); the policy decides when the job succeeded. */
export type DeployOnSuccessCovers = ApprovalLevel | 'none';

export interface DeployOnSuccessView {
  readonly id: string;
  readonly jobId: string;
  readonly project: string;
  readonly target: 'pages' | 'coolify';
  readonly env: DeployEnv;
  readonly directory: string | null;
  readonly state: DeployOnSuccessState;
  readonly reason: string | null;
  readonly url: string | null;
  readonly opsActionId: string | null;
  readonly opsActionState: string | null;
  readonly covers: DeployOnSuccessCovers;
  /** p10-publish-bundle: the publish extras (null: a plain deploy). */
  readonly publish: PublishExtras | null;
  /** p10-publish-bundle: requested by the job's agent (covers `none`); approvedBy is then the job's creator. */
  readonly requestedByAgent: boolean;
  readonly approvedBy: { readonly id: string; readonly username: string | null };
  readonly approvedAt: string;
  readonly stepUp: boolean;
  readonly via: DeployOnSuccessVia;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  /** p10-verify-health (ADR-0035): a gate verification holds this pending deploy right now. */
  readonly heldByVerification: boolean;
}

/** The person creating the job (or saving the automation) and their session's step-up. */
export interface CreatorContext {
  readonly subject: Subject;
  readonly mfaAt: Date | null;
  readonly stepUpMaxAgeMs?: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** What `prepare` decided; `record` stores it with the job. */
export interface PreparedDeployOnSuccess {
  readonly project: string;
  readonly request: {
    readonly target: 'pages' | 'coolify';
    readonly env: DeployEnv;
    readonly directory: string | null;
    /** p10-publish-bundle: publish as a bundle (null: a plain deploy). */
    readonly publish?: PublishExtras | null;
  };
  readonly targetSnapshot: Record<string, unknown>;
  readonly covers: ApprovalLevel;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly stepUpAt: Date | null;
}

/** Stored on an automation's job target: the request plus the save-time approval (re-checked per run). */
export interface SavedDeployOnSuccess {
  readonly target: 'pages' | 'coolify';
  readonly env: DeployEnv;
  readonly directory: string | null;
  /** p10-publish-bundle (absent in rows saved before). */
  readonly publish?: PublishExtras | null;
  readonly covers: ApprovalLevel;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly stepUpAt: string | null;
}

export interface DeployOnSuccessDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly ops: () => OpsService | null;
  /** Posts an assistant message into a chat thread (the originating conversation). */
  readonly chatNote?: (threadId: string, text: string, meta: Record<string, unknown>) => Promise<void>;
}

/** How long a pre-approval waits for its job (the longest job is 7 days). */
export const PRE_APPROVAL_TTL_MS = 8 * 24 * 3600_000;
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;
const TERMINAL_OPS = new Set(['succeeded', 'failed', 'refused', 'denied', 'expired']);
const PREVIEW_BRANCH = 'remyral-preview';

interface Row {
  id: string;
  job_id: string;
  project: string;
  target: 'pages' | 'coolify';
  env: DeployEnv;
  directory: string | null;
  target_snapshot: Record<string, unknown>;
  covers: DeployOnSuccessCovers;
  publish: PublishExtras | null;
  approved_by: string;
  approver: string | null;
  approved_at: Date;
  step_up_at: Date | null;
  via: DeployOnSuccessVia;
  source: Record<string, unknown> | null;
  state: DeployOnSuccessState;
  reason: string | null;
  ops_action_id: string | null;
  ops_state: string | null;
  url: string | null;
  attempts: number;
  created_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  held: boolean;
}

const COLS = `d.id::text AS id, d.job_id::text AS job_id, d.project, d.target, d.env, d.directory, d.target_snapshot,
  d.covers, d.publish, d.approved_by::text AS approved_by, (SELECT username FROM users u WHERE u.id = d.approved_by) AS approver,
  d.approved_at, d.step_up_at, d.via, d.source, d.state, d.reason, d.ops_action_id::text AS ops_action_id,
  (SELECT o.state FROM ops_actions o WHERE o.id = d.ops_action_id) AS ops_state, d.url, d.attempts, d.created_at,
  d.expires_at, d.finished_at, (d.state = 'pending' AND ${GATE_HOLDS_SQL}) AS held`;

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

/**
 * The configured target a deploy on success would use (Pages project name / Coolify uuids + tags of the
 * environment), or the reason there is none. Pure.
 */
export function targetSnapshot(
  t: DeployTargets,
  target: 'pages' | 'coolify',
  env: DeployEnv,
  publish: PublishExtras | null = null,
): { readonly snapshot: Record<string, unknown> } | { readonly error: OpsError } {
  if (target === 'pages' && publish !== null) {
    // p10-publish-bundle: the Pages project the bundle uses and the allowed zone of its domain.
    const name = publish.pagesProject ?? t.pages?.projectName ?? null;
    if (name === null) {
      return {
        error: new OpsError(
          409,
          'no_pages_target',
          'No Cloudflare Pages project is configured for this project: name one (or a new one to create).',
        ),
      };
    }
    if (!pagesListed(t, name) && !publish.createIfMissing) {
      return {
        error: new OpsError(
          403,
          'pages_project_not_allowed',
          `${name} is not one of this project’s Cloudflare Pages projects (Project → Deploy); allow creating it if it is new.`,
        ),
      };
    }
    return {
      snapshot: {
        pagesProject: name,
        domain: publish.domain,
        zone: publish.domain === null ? null : (allowedZoneOf(t, publish.domain)?.id ?? null),
      },
    };
  }
  if (target === 'pages') {
    if (t.pages === null) {
      return {
        error: new OpsError(
          409,
          'no_pages_target',
          'No Cloudflare Pages project is configured for this project (Project → Deploy).',
        ),
      };
    }
    return { snapshot: { pagesProject: t.pages.projectName } };
  }
  const c = t.coolify?.[env] ?? null;
  if (c === null || (c.uuids.length === 0 && c.tags.length === 0)) {
    return {
      error: new OpsError(
        409,
        'no_coolify_target',
        `No Coolify ${env} target is configured for this project (Project → Deploy).`,
      ),
    };
  }
  // p13-multi-coolify: the connection is part of the target (a target moved to another Coolify is a change).
  return {
    snapshot: {
      coolify: {
        ...(c.connection === null ? {} : { connection: c.connection }),
        uuids: [...c.uuids].sort(),
        tags: [...c.tags].sort(),
      },
    },
  };
}

/** p10-publish-bundle: the name is the project's Pages target or one of its further Pages projects. */
function pagesListed(t: DeployTargets, name: string): boolean {
  return t.pages?.projectName === name || t.pagesProjects.includes(name);
}

/** p10-publish-bundle: the project's allowed DNS zone that contains `domain` (the longest), or null. */
export function allowedZoneOf(t: DeployTargets, domain: string): { id: string; name: string } | null {
  return (
    t.dns.zones.filter((z) => nameInZone(domain, z.name)).sort((a, b) => b.name.length - a.name.length)[0] ??
    null
  );
}

/**
 * The level a deploy on success needs now (pure): `onSuccessLevel` for a plain deploy; for a publish bundle
 * (p10-publish-bundle) the bundle's decision over its steps — create (when the project is not listed yet), deploy,
 * domain (+ CNAME when `dns` is auto: assumed, the zone is known only at run time).
 */
export function deployLevel(
  t: DeployTargets,
  env: DeployEnv,
  publish: PublishExtras | null,
): { readonly level: ApprovalLevel } | { readonly refused: string } {
  const lvl = onSuccessLevel(env, t.policy);
  if ('refused' in lvl || publish === null) return lvl;
  const name = publish.pagesProject ?? t.pages?.projectName ?? '';
  const steps: PublishStepFacts[] = [
    ...(pagesListed(t, name) ? [] : [{ step: 'create' as const }]),
    { step: 'deploy', env },
    ...(publish.domain === null ? [] : [{ step: 'domain' as const, withDns: publish.dns === 'auto' }]),
  ];
  return { level: publishDecision(steps, t.policy).decision as ApprovalLevel };
}

/**
 * The permissions a creator needs for `level` (pure): `deploy.request` always, `deploy.approve` above auto, and an
 * always-fresh step-up for `approval_step_up`. Returns the refusal or null.
 */
export function creatorRefusal(
  subject: Subject,
  project: string,
  env: DeployEnv,
  level: ApprovalLevel,
  stepUp: { readonly mfaAt: Date | null; readonly now: Date; readonly maxAgeMs?: number },
): OpsError | null {
  if (!authorize(subject, 'deploy.request', { project }).allow) {
    return new OpsError(403, 'deploy_forbidden', 'You may not request deploys in this project.');
  }
  if (level !== 'auto' && !authorize(subject, 'deploy.approve', { project }).allow) {
    return new OpsError(
      403,
      'deploy_approval_forbidden',
      `The deploy policy of this project needs an approval for ${env} deploys; only a project admin can approve it in advance when creating the job.`,
    );
  }
  if (level === 'approval_step_up') {
    const maxAge = Math.min(stepUp.maxAgeMs ?? STEP_UP_ALWAYS_FRESH_MS, STEP_UP_ALWAYS_FRESH_MS);
    if (!stepUpFresh(stepUp.mfaAt, stepUp.now, maxAge)) {
      return new OpsError(
        403,
        'step_up_required',
        `Confirm with a current authenticator code: a ${env} deploy on success is approved now, when the job is created.`,
      );
    }
  }
  return null;
}

/**
 * The job spec a deploy on success needs (pure): Pages implies `siteBundle` (the given directory, default `site`); a
 * spec that names its own site directory keeps it (a different `directory` is refused). Untrusted sources and
 * special job kinds never deploy.
 */
export function specForDeploy(
  spec: unknown,
  req: { readonly target: 'pages' | 'coolify'; readonly directory?: string | undefined },
): { readonly spec: Record<string, unknown>; readonly directory: string | null } {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new OpsError(400, 'invalid_job', 'Invalid job: spec:invalid_type');
  }
  const s = spec as Record<string, unknown>;
  if (s.kind !== undefined || s.machineAdmin !== undefined) {
    throw new OpsError(400, 'deploy_not_allowed', 'This kind of job cannot deploy on success.');
  }
  if (s.sourceTrust !== 'trusted') {
    throw new OpsError(
      400,
      'deploy_needs_trusted_source',
      'Deploy on success needs a trusted source (an untrusted repository or pull request never deploys).',
    );
  }
  if (req.target === 'coolify') {
    if (req.directory !== undefined) {
      throw new OpsError(400, 'invalid_deploy', 'A Coolify deploy on success takes no site directory.');
    }
    return { spec: s, directory: null };
  }
  const own = (s.siteBundle as { directory?: unknown } | undefined)?.directory;
  if (typeof own === 'string') {
    if (req.directory !== undefined && req.directory !== own) {
      throw new OpsError(
        400,
        'invalid_deploy',
        'The site directory differs from the job’s siteBundle directory.',
      );
    }
    return { spec: s, directory: own };
  }
  const directory = req.directory ?? DEFAULT_SITE_DIRECTORY;
  return { spec: { ...s, siteBundle: { directory } }, directory };
}

const TARGET_TEXT = { pages: 'Cloudflare Pages', coolify: 'Coolify' } as const;

/** p10-publish-bundle: what a job's agent may ask for with `publish_site` (strict; the master resolves the rest). */
const AgentPublishRequest = z.strictObject({
  env: z.enum(['preview', 'production']).default('preview'),
  pagesProject: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,57}$/)
    .optional(),
  createIfMissing: z.boolean().optional(),
  domain: HostName.optional(),
  dns: z.enum(['auto', 'skip']).optional(),
  directory: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
});

/** p12-deploy-feedback: what a job's agent may ask for with `request_redeploy`. */
const AgentRedeployRequest = z.strictObject({
  target: z.enum(['pages', 'coolify']).optional(),
  env: z.enum(['preview', 'production']).default('preview'),
});

export class DeployOnSuccessService {
  constructor(private readonly deps: DeployOnSuccessDeps) {}

  /** Parses a `deployOnSuccess` request body (400 on anything else). */
  parse(raw: unknown): DeployOnSuccessRequest {
    const p = DeployOnSuccessRequest.safeParse(raw);
    if (!p.success) {
      throw new OpsError(
        400,
        'invalid_deploy',
        `Invalid deployOnSuccess: ${p.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 500),
      );
    }
    return p.data;
  }

  /**
   * Validates a deploy on success for a job about to be created and returns the spec to create it with. Throws
   * OpsError (audited as denied) when the creator may not, the target is missing or production is not allowed.
   */
  async prepare(
    ctx: CreatorContext,
    project: string,
    raw: unknown,
    spec: unknown,
  ): Promise<{ readonly prepared: PreparedDeployOnSuccess; readonly spec: Record<string, unknown> }> {
    try {
      const req = this.parse(raw);
      const out = specForDeploy(spec, req);
      const ops = this.deps.ops();
      if (ops === null) throw new OpsError(503, 'ops_unavailable', 'Deploy integrations are not available.');
      const t = await ops.targets(project);
      if (t === null) {
        throw new OpsError(
          409,
          'no_deploy_targets',
          'This project has no deploy targets yet (Project → Deploy).',
        );
      }
      const publish = publishExtrasOf(req);
      const snap = targetSnapshot(t.targets, req.target, req.env, publish);
      if ('error' in snap) throw snap.error;
      const lvl = deployLevel(t.targets, req.env, publish);
      if ('refused' in lvl) throw new OpsError(409, 'production_auto_deploy_off', lvl.refused);
      const now = this.deps.clock();
      const refusal = creatorRefusal(ctx.subject, project, req.env, lvl.level, {
        mfaAt: ctx.mfaAt,
        now,
        ...(ctx.stepUpMaxAgeMs === undefined ? {} : { maxAgeMs: ctx.stepUpMaxAgeMs }),
      });
      if (refusal !== null) throw refusal;
      return {
        spec: out.spec,
        prepared: {
          project,
          request: { target: req.target, env: req.env, directory: out.directory, publish },
          targetSnapshot: snap.snapshot,
          covers: lvl.level,
          approvedBy: ctx.subject.userId,
          approvedAt: now,
          stepUpAt: lvl.level === 'approval_step_up' ? ctx.mfaAt : null,
        },
      };
    } catch (err) {
      if (err instanceof OpsError) {
        await this.deps.audit.record({
          actor: { type: 'user', id: ctx.subject.userId },
          action: 'ops.preapproval.create',
          target: `project:${project}`,
          outcome: 'denied',
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          metadata: { code: err.code, reason: err.message.slice(0, 300) },
        });
      }
      throw err;
    }
  }

  /**
   * For a chat draft / composer review: what `prepare` would decide, without the step-up (checked when the card is
   * confirmed) and without storing anything. Throws OpsError like `prepare`.
   */
  async preview(
    subject: Subject,
    project: string,
    raw: unknown,
    spec: unknown,
  ): Promise<{
    readonly spec: Record<string, unknown>;
    readonly request: {
      target: 'pages' | 'coolify';
      env: DeployEnv;
      directory: string | null;
      publish: PublishExtras | null;
    };
    readonly level: ApprovalLevel;
    readonly target: Record<string, unknown>;
  }> {
    const req = this.parse(raw);
    const out = specForDeploy(spec, req);
    const ops = this.deps.ops();
    if (ops === null) throw new OpsError(503, 'ops_unavailable', 'Deploy integrations are not available.');
    const t = await ops.targets(project);
    if (t === null) {
      throw new OpsError(
        409,
        'no_deploy_targets',
        'This project has no deploy targets yet (Project → Deploy).',
      );
    }
    const publish = publishExtrasOf(req);
    const snap = targetSnapshot(t.targets, req.target, req.env, publish);
    if ('error' in snap) throw snap.error;
    const lvl = deployLevel(t.targets, req.env, publish);
    if ('refused' in lvl) throw new OpsError(409, 'production_auto_deploy_off', lvl.refused);
    // The step-up is the confirmation's; everything else is checked now.
    const refusal = creatorRefusal(subject, project, req.env, lvl.level === 'auto' ? 'auto' : 'approval', {
      mfaAt: null,
      now: this.deps.clock(),
    });
    if (refusal !== null) throw refusal;
    return {
      spec: out.spec,
      request: { target: req.target, env: req.env, directory: out.directory, publish },
      level: lvl.level,
      target: snap.snapshot,
    };
  }

  /** For an automation: what to store with the job target (the save-time approval). */
  toSaved(p: PreparedDeployOnSuccess): SavedDeployOnSuccess {
    return {
      target: p.request.target,
      env: p.request.env,
      directory: p.request.directory,
      ...(p.request.publish == null ? {} : { publish: p.request.publish }),
      covers: p.covers,
      approvedBy: p.approvedBy,
      approvedAt: p.approvedAt.toISOString(),
      stepUpAt: p.stepUpAt?.toISOString() ?? null,
    };
  }

  /**
   * For an automation run: the stored approval re-checked for the run-as user now (still allowed; the level the
   * policy asks for now is covered). Throws OpsError when the run may not deploy.
   */
  async prepareForRun(
    runAs: string,
    project: string,
    saved: SavedDeployOnSuccess,
    spec: unknown,
  ): Promise<{ readonly prepared: PreparedDeployOnSuccess; readonly spec: Record<string, unknown> }> {
    const subject = await this.#activeSubject(runAs);
    if (subject === null) throw new OpsError(403, 'deploy_forbidden', 'The run-as user is not active.');
    const out = specForDeploy(spec, {
      target: saved.target,
      ...(saved.directory === null ? {} : { directory: saved.directory }),
    });
    const ops = this.deps.ops();
    if (ops === null) throw new OpsError(503, 'ops_unavailable', 'Deploy integrations are not available.');
    const t = await ops.targets(project);
    if (t === null) throw new OpsError(409, 'no_deploy_targets', 'This project has no deploy targets.');
    const publish = saved.publish ?? null;
    const snap = targetSnapshot(t.targets, saved.target, saved.env, publish);
    if ('error' in snap) throw snap.error;
    const lvl = deployLevel(t.targets, saved.env, publish);
    if ('refused' in lvl) throw new OpsError(409, 'production_auto_deploy_off', lvl.refused);
    if (rank(lvl.level) > rank(saved.covers)) {
      throw new OpsError(
        409,
        'preapproval_insufficient',
        'The deploy policy is stricter than when the automation was saved; save it again to approve.',
      );
    }
    const stepUpAt = saved.stepUpAt === null ? null : new Date(saved.stepUpAt);
    // The run-as user still holds what the covered level needs (the step-up was given at save time).
    const refusal = creatorRefusal(
      subject,
      project,
      saved.env,
      saved.covers === 'auto' ? 'auto' : 'approval',
      {
        mfaAt: stepUpAt,
        now: this.deps.clock(),
      },
    );
    if (refusal !== null) throw refusal;
    return {
      spec: out.spec,
      prepared: {
        project,
        request: { target: saved.target, env: saved.env, directory: out.directory, publish },
        targetSnapshot: snap.snapshot,
        covers: saved.covers,
        approvedBy: runAs,
        approvedAt: new Date(saved.approvedAt),
        stepUpAt,
      },
    };
  }

  /** Stores the pre-approval of a job (inside the job's creation transaction) and audits it. */
  async record(
    tx: Queryable,
    jobId: string,
    p: PreparedDeployOnSuccess,
    via: DeployOnSuccessVia,
    source: Record<string, unknown> | null,
    meta: { readonly ip?: string | null; readonly userAgent?: string | null } = {},
  ): Promise<string> {
    const now = this.deps.clock();
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO job_deploy_on_success (job_id, project, target, env, directory, target_snapshot, covers,
         approved_by, approved_at, step_up_at, via, source, state, created_at, updated_at, expires_at, publish)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $13, $14, $15)
       RETURNING id::text AS id`,
      [
        jobId,
        p.project,
        p.request.target,
        p.request.env,
        p.request.directory,
        p.targetSnapshot,
        p.covers,
        p.approvedBy,
        p.approvedAt,
        p.stepUpAt,
        via,
        source,
        now,
        new Date(now.getTime() + PRE_APPROVAL_TTL_MS),
        p.request.publish ?? null,
      ],
    );
    const id = rows[0]?.id ?? '';
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: p.approvedBy },
        action: 'ops.preapproval.create',
        target: `job:${jobId}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          id,
          project: p.project,
          target: p.request.target,
          env: p.request.env,
          directory: p.request.directory,
          publish: p.request.publish ?? null,
          snapshot: p.targetSnapshot,
          covers: p.covers,
          stepUp: p.stepUpAt !== null,
          via,
          source,
        },
      },
      tx,
    );
    return id;
  }

  /**
   * p10-publish-bundle (ADR-0038): the job's own agent asks (tool `publish_site`, over the job's live lease) to publish
   * the job's site when it succeeds. Recorded as the job's publish request without a pre-approval (`covers = none`,
   * `via = job`, requester = the job's creator, re-authorized now and when it runs); on success the master requests
   * the whole chain as ONE `pages.publish` and the policy decides (usually one approval). Never throws for a refusal.
   */
  async requestByAgent(
    job: {
      readonly jobId: string;
      readonly project: string;
      readonly createdByType: string;
      readonly createdById: string | null;
      readonly spec: unknown;
    },
    raw: unknown,
  ): Promise<{ readonly status: 'ok' | 'refused'; readonly reason: string; readonly detail: string }> {
    const refuse = async (reason: string, detail: string) => {
      await this.deps.audit.record({
        actor: { type: 'system', id: `job:${job.jobId}` },
        action: 'ops.publish.agent_request',
        target: `job:${job.jobId}`,
        outcome: 'denied',
        metadata: { project: job.project, reason, detail: detail.slice(0, 300) },
      });
      return { status: 'refused' as const, reason, detail };
    };
    const parsed = AgentPublishRequest.safeParse(raw);
    if (!parsed.success) {
      return refuse(
        'invalid',
        `Invalid publish request: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`.slice(0, 300),
      );
    }
    const a = parsed.data;
    if (job.createdByType !== 'user' || job.createdById === null) {
      return refuse('creator_not_person', 'Only jobs a person created can ask to publish their site.');
    }
    const spec = (typeof job.spec === 'object' && job.spec !== null ? job.spec : {}) as Record<
      string,
      unknown
    >;
    if (spec.kind !== undefined || spec.machineAdmin !== undefined || spec.sourceTrust !== 'trusted') {
      return refuse(
        'untrusted',
        'Publishing needs a job with a trusted source (an untrusted repository or pull request never publishes).',
      );
    }
    const existing = await this.forJob(job.jobId);
    if (existing !== null) {
      return refuse(
        'already_requested',
        existing.requestedByAgent
          ? 'This job already asked to publish its site; that request stands.'
          : `This job already deploys its result when it succeeds (set by its creator: ${existing.target}, ${existing.env}${existing.publish?.domain == null ? '' : `, ${existing.publish.domain}`}).`,
      );
    }
    const creator = await this.#activeSubject(job.createdById);
    if (creator === null || !authorize(creator, 'deploy.request', { project: job.project }).allow) {
      return refuse(
        'creator_forbidden',
        'The person who created this job may not request deploys in this project.',
      );
    }
    const ops = this.deps.ops();
    if (ops === null) return refuse('unavailable', 'Deploy integrations are not available.');
    const t = await ops.targets(job.project);
    if (t === null)
      return refuse('no_deploy_targets', 'This project has no deploy targets (Project → Deploy).');
    const publish: PublishExtras = {
      pagesProject: a.pagesProject ?? null,
      createIfMissing: a.createIfMissing === true,
      domain: a.domain ?? null,
      dns: a.dns ?? 'auto',
    };
    const snap = targetSnapshot(t.targets, 'pages', a.env, publish);
    if ('error' in snap) return refuse(snap.error.code, snap.error.message);
    const own = (spec.siteBundle as { directory?: unknown } | undefined)?.directory;
    const directory = typeof own === 'string' ? own : (a.directory ?? null);
    const name = String(snap.snapshot.pagesProject);
    const steps: PublishStepFacts[] = [
      ...(t.targets.pages?.projectName === name || t.targets.pagesProjects.includes(name)
        ? []
        : [{ step: 'create' as const }]),
      { step: 'deploy', env: a.env },
      ...(publish.domain === null ? [] : [{ step: 'domain' as const, withDns: publish.dns === 'auto' }]),
    ];
    const decision = publishDecision(steps, t.targets.policy);
    const now = this.deps.clock();
    let id: string;
    try {
      const { rows } = await this.deps.pool.query<{ id: string }>(
        `INSERT INTO job_deploy_on_success (job_id, project, target, env, directory, target_snapshot, covers,
           approved_by, approved_at, step_up_at, via, source, state, created_at, updated_at, expires_at, publish)
         VALUES ($1, $2, 'pages', $3, $4, $5, 'none', $6, $7, NULL, 'job', $8, 'pending', $7, $7, $9, $10)
         RETURNING id::text AS id`,
        [
          job.jobId,
          job.project,
          a.env,
          directory,
          snap.snapshot,
          job.createdById,
          now,
          { jobId: job.jobId, agentRequest: true },
          new Date(now.getTime() + PRE_APPROVAL_TTL_MS),
          publish,
        ],
      );
      id = rows[0]?.id ?? '';
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return refuse('already_requested', 'This job already has a publish request.');
      }
      throw err;
    }
    await this.deps.audit.record({
      actor: { type: 'system', id: `job:${job.jobId}` },
      action: 'ops.publish.agent_request',
      target: `job:${job.jobId}`,
      outcome: 'success',
      metadata: {
        id,
        project: job.project,
        env: a.env,
        directory,
        publish,
        snapshot: snap.snapshot,
        decisionNow: decision.decision,
        requester: job.createdById,
      },
    });
    const chain = [
      ...(steps[0]?.step === 'create' ? [`create the Pages project ${name}`] : []),
      `deploy the site to ${name} (${a.env})`,
      ...(publish.domain === null
        ? []
        : [
            `attach ${publish.domain}${publish.dns === 'auto' ? ' and write its CNAME (when the domain is in an allowed zone)' : ''}`,
          ]),
    ].join(', then ');
    const who =
      decision.decision === 'auto'
        ? 'The project’s policy runs every step at once, so it needs no approval.'
        : `It needs ONE approval by a project admin${decision.decision === 'approval_step_up' ? ' with a fresh authenticator code' : ''} after the job has finished.`;
    return {
      status: 'ok',
      reason: 'recorded',
      detail:
        `Recorded. When this job SUCCEEDS the master will ${chain} — as one request. ${who} Write the finished static site (index.html and its assets) into ${directory ?? DEFAULT_SITE_DIRECTORY}/ before you finish; nothing is published if the job fails.`.slice(
          0,
          2000,
        ),
    };
  }

  /**
   * p12-deploy-feedback: records a redeploy of a job's result WITHOUT a pre-approval (`covers = none`): it is
   * requested as `requestedBy` when the job SUCCEEDS and the project's deploy policy decides then (preview auto runs at
   * once; production always waits for an approval). Used by an agent's `request_redeploy` and by auto-fix jobs.
   * `db` may be the job's creation transaction. Throws OpsError when the target is not configured.
   */
  async recordUnapproved(
    db: Queryable,
    r: {
      readonly jobId: string;
      readonly project: string;
      readonly target: 'pages' | 'coolify';
      readonly env: DeployEnv;
      readonly directory: string | null;
      readonly publish: PublishExtras | null;
      readonly requestedBy: string;
      readonly source: Record<string, unknown>;
    },
  ): Promise<string> {
    const ops = this.deps.ops();
    if (ops === null) throw new OpsError(503, 'ops_unavailable', 'Deploy integrations are not available.');
    const t = await ops.targets(r.project);
    if (t === null) throw new OpsError(409, 'no_deploy_targets', 'This project has no deploy targets.');
    const snap = targetSnapshot(t.targets, r.target, r.env, r.publish);
    if ('error' in snap) throw snap.error;
    const now = this.deps.clock();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO job_deploy_on_success (job_id, project, target, env, directory, target_snapshot, covers,
         approved_by, approved_at, step_up_at, via, source, state, created_at, updated_at, expires_at, publish)
       VALUES ($1, $2, $3, $4, $5, $6, 'none', $7, $8, NULL, 'job', $9, 'pending', $8, $8, $10, $11)
       RETURNING id::text AS id`,
      [
        r.jobId,
        r.project,
        r.target,
        r.env,
        r.directory,
        snap.snapshot,
        r.requestedBy,
        now,
        r.source,
        new Date(now.getTime() + PRE_APPROVAL_TTL_MS),
        r.publish,
      ],
    );
    return rows[0]?.id ?? '';
  }

  /**
   * p12-deploy-feedback (ADR-0048): the job's own agent asks (`request_redeploy`) for its result to be deployed again
   * to the project's Coolify app or Pages project when the job SUCCEEDS — recorded without a pre-approval, requested as
   * the job's creator then, decided by the deploy policy. Same gates as `publish_site`: a person created the job, a
   * trusted source, the creator may request deploys, one deploy request per job. Never throws for a refusal.
   */
  async requestRedeployByAgent(
    job: {
      readonly jobId: string;
      readonly project: string;
      readonly createdByType: string;
      readonly createdById: string | null;
      readonly spec: unknown;
    },
    raw: unknown,
  ): Promise<{ readonly status: 'ok' | 'refused'; readonly reason: string; readonly detail: string }> {
    const refuse = async (reason: string, detail: string) => {
      await this.deps.audit.record({
        actor: { type: 'system', id: `job:${job.jobId}` },
        action: 'deploy.agent.redeploy_request',
        target: `job:${job.jobId}`,
        outcome: 'denied',
        metadata: { project: job.project, reason, detail: detail.slice(0, 300) },
      });
      return { status: 'refused' as const, reason, detail };
    };
    const parsed = AgentRedeployRequest.safeParse(raw);
    if (!parsed.success) return refuse('invalid', 'Invalid redeploy request (target pages|coolify, env).');
    const a = parsed.data;
    if (job.createdByType !== 'user' || job.createdById === null) {
      return refuse('creator_not_person', 'Only jobs a person created can ask for a redeploy.');
    }
    const spec = (typeof job.spec === 'object' && job.spec !== null ? job.spec : {}) as Record<
      string,
      unknown
    >;
    if (spec.kind !== undefined || spec.machineAdmin !== undefined || spec.sourceTrust !== 'trusted') {
      return refuse('untrusted', 'A redeploy needs a job with a trusted source.');
    }
    const existing = await this.forJob(job.jobId);
    if (existing !== null) {
      return refuse(
        'already_requested',
        `This job already deploys its result when it succeeds (${existing.target}, ${existing.env}${existing.requestedByAgent ? ', requested earlier by this job' : ', set by its creator'}); nothing else is needed.`,
      );
    }
    const creator = await this.#activeSubject(job.createdById);
    if (creator === null || !authorize(creator, 'deploy.request', { project: job.project }).allow) {
      return refuse(
        'creator_forbidden',
        'The person who created this job may not request deploys in this project.',
      );
    }
    const ops = this.deps.ops();
    if (ops === null) return refuse('unavailable', 'Deploy integrations are not available.');
    const t = await ops.targets(job.project);
    if (t === null)
      return refuse('no_deploy_targets', 'This project has no deploy targets (Project → Deploy).');
    const hasPages = t.targets.pages !== null;
    const hasCoolify = (() => {
      const c = t.targets.coolify?.[a.env] ?? null;
      return c !== null && (c.uuids.length > 0 || c.tags.length > 0);
    })();
    const target =
      a.target ?? (hasCoolify && !hasPages ? 'coolify' : hasPages && !hasCoolify ? 'pages' : null);
    if (target === null) {
      return refuse(
        'target_ambiguous',
        hasPages || hasCoolify
          ? 'This project deploys to both Coolify and Cloudflare Pages: say target "coolify" or "pages".'
          : `This project has no ${a.env} deploy target.`,
      );
    }
    const own = (spec.siteBundle as { directory?: unknown } | undefined)?.directory;
    try {
      await this.recordUnapproved(this.deps.pool, {
        jobId: job.jobId,
        project: job.project,
        target,
        env: a.env,
        directory: target === 'pages' && typeof own === 'string' ? own : null,
        publish: null,
        requestedBy: job.createdById,
        source: { jobId: job.jobId, agentRequest: true, redeploy: true },
      });
    } catch (err) {
      if (err instanceof OpsError) return refuse(err.code, err.message);
      if ((err as { code?: string }).code === '23505') {
        return refuse('already_requested', 'This job already has a deploy request.');
      }
      throw err;
    }
    const lvl = onSuccessLevel(a.env, t.targets.policy);
    const level = 'refused' in lvl ? 'approval_step_up' : lvl.level;
    await this.deps.audit.record({
      actor: { type: 'system', id: `job:${job.jobId}` },
      action: 'deploy.agent.redeploy_request',
      target: `job:${job.jobId}`,
      outcome: 'success',
      metadata: { project: job.project, target, env: a.env, requester: job.createdById, decisionNow: level },
    });
    const who =
      a.env === 'production' || level !== 'auto'
        ? `It then waits for an approval by a project admin${level === 'approval_step_up' || a.env === 'production' ? ' with a fresh authenticator code' : ''} (the project’s deploy policy).`
        : 'The project’s policy runs preview deploys at once, so it needs no approval.';
    return {
      status: 'ok',
      reason: 'recorded',
      detail: `Recorded. When this job SUCCEEDS the master will deploy its result to ${TARGET_TEXT[target]} (${a.env}) as the person who created the job. ${who} Nothing is deployed if the job fails.${target === 'coolify' ? ' Coolify builds what is on its configured branch: make sure your fix is committed (the platform pushes your branch when the job ends).' : ''}`,
    };
  }

  // ------------------------------------------------------------------------------------------ reads

  async forJob(jobId: string): Promise<DeployOnSuccessView | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM job_deploy_on_success d WHERE d.job_id = $1`,
      [jobId],
    );
    const r = rows[0];
    return r === undefined ? null : view(r);
  }

  // ---------------------------------------------------------------------------------------- the tick

  /** The orchestrator tick step. */
  step(): { name: string; run: () => Promise<number> } {
    return { name: 'deploy-on-success', run: () => this.tick() };
  }

  async tick(): Promise<number> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE job_deploy_on_success SET state = 'pending', claimed_at = NULL, updated_at = $1
        WHERE state = 'running' AND claimed_at < $2`,
      [now, new Date(now.getTime() - CLAIM_TIMEOUT_MS)],
    );
    const { rows } = await this.deps.pool.query<{ id: string; job_state: string }>(
      `WITH c AS (
         SELECT d.id FROM job_deploy_on_success d JOIN jobs j ON j.id = d.job_id
          WHERE d.state = 'pending'
            AND (j.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') OR d.expires_at <= $1)
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $1)
            -- p10-verify-health (ADR-0035): a succeeded job's deploy waits while its gate verification holds it.
            AND (j.state <> 'SUCCEEDED' OR d.expires_at <= $1 OR NOT ${GATE_HOLDS_SQL})
          ORDER BY d.created_at LIMIT 10 FOR UPDATE OF d SKIP LOCKED)
       UPDATE job_deploy_on_success d SET state = 'running', claimed_at = $1, updated_at = $1
         FROM c, jobs j WHERE d.id = c.id AND j.id = d.job_id
       RETURNING d.id::text AS id, j.state::text AS job_state`,
      [now],
    );
    let n = 0;
    for (const c of rows) {
      try {
        await this.#run(c.id, c.job_state);
        n++;
      } catch (err) {
        this.deps.log.error({ err, id: c.id }, 'deploy on success failed unexpectedly');
        await this.#finish(c.id, 'failed', 'The deploy could not be started (internal error).', {});
      }
    }
    // Requested actions that ended (the ops-deploying poller moves deployments on).
    const open = await this.deps.pool.query<{ id: string }>(
      `SELECT d.id::text AS id FROM job_deploy_on_success d JOIN ops_actions o ON o.id = d.ops_action_id
        WHERE d.state = 'requested' AND o.state IN ('succeeded', 'failed', 'refused', 'denied', 'expired')
        ORDER BY d.created_at LIMIT 50`,
    );
    for (const r of open.rows) {
      await this.#follow(r.id);
      n++;
    }
    return n;
  }

  async #row(id: string): Promise<Row | null> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM job_deploy_on_success d WHERE d.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async #activeSubject(userId: string): Promise<Subject | null> {
    const { rows } = await this.deps.pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
      'SELECT id::text AS id, role, disabled_at FROM users WHERE id::text = $1',
      [userId],
    );
    const u = rows[0];
    if (u === undefined || u.disabled_at !== null) return null;
    return loadSubject(this.deps.pool, { id: u.id, role: u.role });
  }

  async #run(id: string, jobState: string): Promise<void> {
    const r = await this.#row(id);
    if (r === null) return;
    if (jobState !== 'SUCCEEDED') {
      if (jobState === 'FAILED' || jobState === 'CANCELLED') {
        await this.#finish(
          id,
          'skipped',
          `The job ended ${jobState.toLowerCase()}; nothing was deployed.`,
          {},
        );
      } else {
        await this.#finish(
          id,
          'skipped',
          'The approval to deploy expired before the job finished (8 days); nothing was deployed.',
          {},
        );
      }
      return;
    }
    const ops = this.deps.ops();
    if (ops === null) {
      await this.#finish(id, 'failed', 'Deploy integrations are not available.', {});
      return;
    }
    // Re-checks: the creator, the switch, the target — any "no" and nothing runs.
    const refused = await this.#recheck(r, ops);
    if (refused !== null) {
      await this.#finish(id, 'refused', refused, {});
      return;
    }
    let params: Record<string, unknown>;
    let bundle: string | null = null;
    const agent = r.covers === 'none';
    try {
      if (r.target === 'pages') {
        const b = await this.#bundle(r.job_id);
        // p10-publish-bundle: an agent's request may publish the job's output files instead (the approval shows
        // them); a pre-approved deploy is bound to the job's own site bundle.
        if (b === null && !agent) {
          await this.#finish(
            id,
            'failed',
            `The job produced no site bundle in ${r.directory ?? DEFAULT_SITE_DIRECTORY}/ (a worker drops the whole bundle on a secret, an unsupported file or the size limit; the job result says why). Nothing was deployed.`,
            {},
          );
          return;
        }
        if (b?.flagged === true) {
          await this.#finish(
            id,
            'refused',
            'The site bundle looks like it contains a secret (master scan); it was not published.',
            { bundle_sha256: b.sha256 },
          );
          return;
        }
        if (b?.pruned === true) {
          await this.#finish(id, 'failed', 'The site bundle was removed by the storage retention.', {});
          return;
        }
        if (b != null) bundle = b.sha256;
        if (r.publish !== null) {
          // p10-publish-bundle: the whole chain as one pages.publish (create? → deploy → domain? + CNAME?).
          const name =
            typeof r.target_snapshot.pagesProject === 'string' ? r.target_snapshot.pagesProject : null;
          params = {
            jobId: r.job_id,
            env: r.env,
            ...(bundle === null
              ? r.directory === null
                ? {}
                : { directory: r.directory }
              : { bundleSha256: bundle }),
            ...(name === null ? {} : { pagesProject: name }),
            ...(r.publish.createIfMissing ? { createIfMissing: true } : {}),
            ...(r.publish.domain === null ? {} : { domain: r.publish.domain, dns: r.publish.dns }),
          };
        } else if (bundle !== null) {
          const branch = r.env === 'production' ? await ops.pagesProductionBranch(r.project) : PREVIEW_BRANCH;
          params = { jobId: r.job_id, branch, bundleSha256: bundle };
        } else {
          params = {
            jobId: r.job_id,
            env: r.env,
            ...(r.directory === null ? {} : { directory: r.directory }),
          };
        }
      } else {
        params = { env: r.env };
      }
      const out = await ops.request(
        { type: 'user', id: r.approved_by },
        {
          project: r.project,
          kind:
            r.target === 'coolify' ? 'coolify.deploy' : r.publish !== null ? 'pages.publish' : 'pages.deploy',
          params,
          idempotencyKey: `dos-${r.id}`,
          note: agent
            ? `Publish requested by the agent of job ${r.job_id}`
            : `Deploy on success of job ${r.job_id}`,
        },
        r.via,
        {
          source: { ...(r.source ?? {}), deployOnSuccess: r.id, jobId: r.job_id },
          ...(r.covers === 'none'
            ? {}
            : {
                preApproved: {
                  by: r.approved_by,
                  at: r.approved_at,
                  stepUpAt: r.step_up_at,
                  covers: r.covers,
                },
              }),
          expectEnv: r.env,
        },
      );
      await this.deps.pool.query(
        `UPDATE job_deploy_on_success SET state = 'requested', ops_action_id = $2, bundle_sha256 = $3,
                attempts = attempts + 1, updated_at = $4
          WHERE id = $1 AND state = 'running'`,
        [id, out.action.id, bundle, this.deps.clock()],
      );
      if (out.action.state === 'awaiting_approval') {
        await this.#chat(
          r,
          `The deploy of job [\`${r.job_id.slice(0, 8)}\`](/jobs/${r.job_id}) to ${TARGET_TEXT[r.target]} (${r.env}) waits for an approval: ${agent ? 'the job’s agent asked for it and the project’s policy needs one' : 'the project’s deploy policy is stricter than when the job was created'}. [Open the deploy](/deploys/${out.action.id})`,
          { state: 'awaiting_approval', opsActionId: out.action.id },
        );
      }
      if (TERMINAL_OPS.has(out.action.state)) await this.#follow(id, out.action);
    } catch (err) {
      const e = err instanceof OpsError ? err : null;
      // p10-publish-bundle: provider failures are 424 now; only an unreachable / failing provider is retried.
      const retryable =
        e !== null &&
        (e.status === 429 || (e.status === 424 && /_(unavailable|network)$/.test(e.code))) &&
        r.attempts + 1 < MAX_ATTEMPTS;
      if (retryable) {
        await this.deps.pool.query(
          `UPDATE job_deploy_on_success SET state = 'pending', claimed_at = NULL, attempts = attempts + 1,
                  next_attempt_at = $2, reason = $3, updated_at = $4 WHERE id = $1 AND state = 'running'`,
          [
            id,
            new Date(this.deps.clock().getTime() + RETRY_DELAY_MS),
            `Retrying: ${e.message}`.slice(0, 1000),
            this.deps.clock(),
          ],
        );
        return;
      }
      if (e === null) throw err;
      const refusal =
        e.code === 'artifacts_redacted' ||
        e.code === 'env_mismatch' ||
        e.code === 'refused' ||
        e.code === 'pages_project_not_allowed' ||
        e.code === 'zone_not_allowed';
      await this.#finish(id, refusal ? 'refused' : 'failed', `${e.message} Nothing was deployed.`, {
        ...(bundle === null ? {} : { bundle_sha256: bundle }),
      });
    }
  }

  async #recheck(r: Row, ops: OpsService): Promise<string | null> {
    const subject = await this.#activeSubject(r.approved_by);
    if (subject === null) return 'The person who created the job is no longer active; nothing was deployed.';
    if (!authorize(subject, 'deploy.request', { project: r.project }).allow) {
      return 'The person who created the job may no longer request deploys in this project; nothing was deployed.';
    }
    if (
      r.covers !== 'auto' &&
      r.covers !== 'none' &&
      !authorize(subject, 'deploy.approve', { project: r.project }).allow
    ) {
      return 'The person who created the job may no longer approve deploys in this project; nothing was deployed.';
    }
    const t = await ops.targets(r.project);
    if (t === null) return 'The project has no deploy targets any more; nothing was deployed.';
    // An agent's request (covers none) is approved after the job by a person; the switch is for automatic production.
    if (r.env === 'production' && r.covers !== 'none' && !t.targets.policy.autoDeployProductionOnSuccess) {
      return 'Auto-deploy to production on success was turned off for this project; nothing was deployed.';
    }
    const snap = targetSnapshot(t.targets, r.target, r.env, r.publish);
    if ('error' in snap) return `${snap.error.message} Nothing was deployed.`;
    if (stableJson(snap.snapshot) !== stableJson(r.target_snapshot)) {
      return 'The deploy target changed since the job was created; nothing was deployed (deploy it from the Deploys page).';
    }
    return null;
  }

  /** The site bundle of the job's final attempt (newest when the job never had an attempt row). */
  async #bundle(jobId: string): Promise<{ sha256: string; flagged: boolean; pruned: boolean } | null> {
    const { rows } = await this.deps.pool.query<{ sha256: string; redacted: boolean; pruned: boolean }>(
      `SELECT a.sha256, a.redacted, a.pruned_at IS NOT NULL AS pruned
         FROM job_artifacts a JOIN jobs j ON j.id = a.job_id
        WHERE a.job_id = $1 AND a.kind = 'site'
          AND (j.current_attempt_id IS NULL OR a.attempt_id = j.current_attempt_id)
        ORDER BY a.created_at DESC LIMIT 1`,
      [jobId],
    );
    const b = rows[0];
    return b === undefined ? null : { sha256: b.sha256, flagged: b.redacted, pruned: b.pruned };
  }

  /** A requested action reached its end: record the outcome (once) and tell the creator. */
  async #follow(id: string, known?: OpsActionView): Promise<void> {
    const r = await this.#row(id);
    const ops = this.deps.ops();
    if (r?.ops_action_id == null || ops === null) return;
    const a = known ?? (await ops.get(r.ops_action_id));
    if (!TERMINAL_OPS.has(a.state)) return;
    if (a.state === 'succeeded') {
      await this.#finish(id, 'succeeded', null, { url: liveUrl(a) });
      return;
    }
    const why =
      a.state === 'refused'
        ? `The deploy policy refused it: ${a.policy.reason}`
        : a.state === 'denied'
          ? 'An approver denied the deploy.'
          : a.state === 'expired'
            ? 'Nobody approved the deploy in time.'
            : `The deploy failed${a.error === null ? '.' : `: ${a.error.slice(0, 300)}`}`;
    await this.#finish(id, a.state === 'refused' ? 'refused' : 'failed', why, {});
  }

  /** Final state, exactly once (claim by state), then the chat message and the notification. */
  async #finish(
    id: string,
    state: 'succeeded' | 'failed' | 'refused' | 'skipped',
    reason: string | null,
    extra: { readonly url?: string | null; readonly bundle_sha256?: string },
  ): Promise<void> {
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE job_deploy_on_success SET state = $2, reason = $3, url = COALESCE($4, url),
              bundle_sha256 = COALESCE($5, bundle_sha256), finished_at = $6, notified_at = $6, updated_at = $6
        WHERE id = $1 AND state IN ('pending', 'running', 'requested') RETURNING id::text AS id`,
      [
        id,
        state,
        reason === null ? null : reason.slice(0, 1000),
        extra.url ?? null,
        extra.bundle_sha256 ?? null,
        now,
      ],
    );
    if (rows[0] === undefined) return; // another pass finished it
    const r = await this.#row(id);
    if (r === null) return;
    await this.deps.audit.record({
      actor: { type: 'system', id: 'deploy-on-success' },
      action: 'ops.preapproval.finish',
      target: `job:${r.job_id}`,
      outcome: state === 'succeeded' ? 'success' : state === 'refused' ? 'denied' : 'failure',
      metadata: {
        id,
        state,
        reason: reason?.slice(0, 300) ?? null,
        opsActionId: r.ops_action_id,
        bundleSha256: extra.bundle_sha256 ?? null,
        url: r.url,
      },
    });
    if (state !== 'skipped') {
      await this.deps.pool.query(
        'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
        [OUTBOX_TOPIC_DEPLOY_ON_SUCCESS, JSON.stringify({ id }), now],
      );
    }
    const job = `[\`${r.job_id.slice(0, 8)}\`](/jobs/${r.job_id})`;
    const where = `${TARGET_TEXT[r.target]} (${r.env})`;
    const domain =
      r.publish?.domain == null || state !== 'succeeded'
        ? ''
        : ` — custom domain https://${r.publish.domain} (live once Cloudflare has validated it)`;
    const text =
      state === 'succeeded'
        ? `Deployed the result of job ${job} to ${where}${r.url === null ? '.' : `: ${r.url}`}${domain}`
        : `The result of job ${job} was not deployed to ${where}: ${reason ?? state}${fixHint(r.ops_action_id, state)}`;
    await this.#chat(r, text, {
      state,
      ...(r.url === null ? {} : { url: r.url }),
      // p12-deploy-feedback: the console offers "Düzeltme işi taslakla" for this action.
      ...(state === 'failed' && r.ops_action_id !== null ? { fixActionId: r.ops_action_id } : {}),
    });
  }

  async #chat(r: Row, text: string, meta: Record<string, unknown>): Promise<void> {
    const thread = r.source?.chatThreadId;
    if (typeof thread !== 'string' || this.deps.chatNote === undefined) return;
    try {
      await this.deps.chatNote(thread, text, {
        notice: 'deploy-on-success',
        jobId: r.job_id,
        deployOnSuccessId: r.id,
        ...meta,
      });
    } catch (err) {
      // The conversation may have been deleted meanwhile; the job page and the notification still tell.
      this.deps.log.debug({ err, id: r.id }, 'deploy on success: chat note not posted');
    }
  }
}

/**
 * p12-deploy-feedback: the chat note's way on after a failed deploy — the logs on the Deploys page and a fix job the
 * assistant drafts when asked (`draft_deploy_fix`). Only for a deploy that ran (an ops action exists) and failed.
 */
export function fixHint(opsActionId: string | null, state: string): string {
  if (opsActionId === null || state !== 'failed') return '';
  return ` — [Logları gör](/deploys/${opsActionId}?logs=build) · [Düzeltme işi başlat](/deploys/${opsActionId}?fix=1), or ask me “düzeltme işi taslakla” and I draft a fix job with the logs.`;
}

function rank(l: ApprovalLevel): number {
  return l === 'auto' ? 0 : l === 'approval' ? 1 : 2;
}

/** The address the deploy is live at: the Pages deployment URL, else the first https fqdn of a Coolify resource. */
export function liveUrl(a: Pick<OpsActionView, 'result' | 'target'>): string | null {
  const u = a.result?.url;
  if (typeof u === 'string' && /^https:\/\/[^\s]{1,2000}$/.test(u)) return u;
  const resources = (a.target.resources ?? []) as { fqdn?: unknown }[];
  for (const res of resources) {
    if (typeof res.fqdn !== 'string') continue;
    for (const part of res.fqdn.split(',')) {
      const s = part.trim();
      if (/^https?:\/\/[^\s]{1,2000}$/.test(s)) return s;
    }
  }
  return null;
}

function view(r: Row): DeployOnSuccessView {
  return {
    id: r.id,
    jobId: r.job_id,
    project: r.project,
    target: r.target,
    env: r.env,
    directory: r.directory,
    state: r.state,
    reason: r.reason,
    url: r.url,
    opsActionId: r.ops_action_id,
    opsActionState: r.ops_state,
    covers: r.covers,
    publish: r.publish,
    requestedByAgent: r.covers === 'none',
    approvedBy: { id: r.approved_by, username: r.approver },
    approvedAt: r.approved_at.toISOString(),
    stepUp: r.step_up_at !== null,
    via: r.via,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    heldByVerification: r.held,
  };
}
