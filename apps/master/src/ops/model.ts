import {
  PREVIEW_LIMITS,
  PreviewName,
  PreviewPort,
  PreviewProtection,
  SiteBundleRequest,
} from '@remyral/protocol';
import { z } from 'zod';

/**
 * p6-deploy-integrations (ADR-0028): shapes of deploy targets, ops action requests and their records.
 * Every input from a person, the chat or (phase 2) an automation is parsed with these schemas.
 */

export const OPS_KINDS = [
  'coolify.deploy',
  'coolify.restart',
  'coolify.rollback',
  'pages.deploy',
  'pages.rollback',
  'dns.upsert',
  'dns.delete',
  'pages.create_project',
  'pages.add_domain',
  'tunnel.open',
  'tunnel.close',
  'tunnel.extend',
  'pages.publish',
] as const;
export type OpsKind = (typeof OPS_KINDS)[number];
/**
 * Kinds a caller may request directly through `/deploy/actions`; the rollback kinds are created only by "Roll back",
 * the `tunnel.*` kinds only by the previews service (job page / job tools, `/jobs/:id/previews`, `/previews/*`).
 */
export const REQUESTABLE_KINDS = [
  'coolify.deploy',
  'coolify.restart',
  'pages.deploy',
  'dns.upsert',
  'dns.delete',
  'pages.create_project',
  'pages.add_domain',
  'pages.publish',
] as const;
export type RequestableKind = (typeof REQUESTABLE_KINDS)[number];

export const DeployEnv = z.enum(['preview', 'production']);
export type DeployEnv = z.infer<typeof DeployEnv>;

/** Coolify resource uuids (cuid-like) and tag names. */
const CoolifyUuid = z.string().regex(/^[A-Za-z0-9]{6,64}$/, 'Coolify uuid');
const CoolifyTag = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Coolify tag');
/** DNS host name (lower-case, punycode), at most 253 characters; `@`-style shortcuts are not accepted. */
export const HostName = z
  .string()
  .max(253)
  .transform((s) => s.trim().toLowerCase().replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .regex(
        /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
        'host name',
      ),
  );
const ZoneId = z.string().regex(/^[0-9a-f]{32}$/, 'zone id');
const PagesProjectName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,57}$/, 'Pages project name');
/**
 * p6-pages-create: the name of a NEW Pages project. Cloudflare (API reference, `project_name`): "must begin with a
 * lowercase letter or digit and contain only lowercase letters, digits, and hyphens". Remyral adds: 1–58 characters
 * (the limit ADR-0028's PagesProjectName already uses; not stated in the fetched reference — UNVERIFIED-LIVE) and no
 * trailing hyphen (the name becomes the DNS label `<name>.pages.dev`).
 */
export const PagesNewProjectName = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/,
    'Pages project name: 1–58 lowercase letters, digits and hyphens; starts and ends with a letter or digit',
  );
/** A branch label (the Pages production branch; also the `branch` of a Direct Upload deployment). */
const BranchLabel = z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/, 'branch name');

export const CoolifyEnvTarget = z.strictObject({
  /**
   * p13-multi-coolify (ADR-0050): the Coolify connection of this environment (null: the default connection — the
   * master stores the resolved id when the targets are saved).
   */
  connection: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'connection id')
    .nullable()
    .default(null),
  uuids: z.array(CoolifyUuid).max(20).default([]),
  tags: z.array(CoolifyTag).max(10).default([]),
});
export type CoolifyEnvTarget = z.infer<typeof CoolifyEnvTarget>;

export const DeployDecisionRule = z.enum(['auto', 'approval', 'approval_step_up']);
export type DeployDecisionRule = z.infer<typeof DeployDecisionRule>;

export const DeployPolicy = z.strictObject({
  /** Preview deploy / restart (Coolify preview env, Pages non-production branch). Default: auto. */
  previewDeploy: DeployDecisionRule.default('auto'),
  /** Production deploy / restart / rollback. Never auto. Default: approval + step-up. */
  productionDeploy: z.enum(['approval', 'approval_step_up']).default('approval_step_up'),
  /**
   * DNS create/update. Default: approval. (Delete is always approval + step-up.) p10-publish-bundle: `auto` ("Run at
   * once") covers only creates/updates of CNAME records pointing at the `pages.dev` name of one of this project's own
   * Pages projects inside its allowed zones; every other record still needs approval.
   */
  dnsChange: z.enum(['auto', 'approval', 'approval_step_up']).default('approval'),
  /**
   * p6-deploy-on-success (ADR-0030): a job may be created with "deploy to production when it succeeds" (the creator
   * then needs `deploy.approve` and the step-up `productionDeploy` names, at creation). Default off.
   */
  autoDeployProductionOnSuccess: z.boolean().default(false),
  /**
   * p6-pages-create: creating / adopting a Cloudflare Pages project and attaching a custom domain to the project's
   * Pages target. Not destructive; default approval. (Attaching with a DNS change also needs the `dnsChange` level.)
   */
  pagesProject: DeployDecisionRule.default('approval'),
  /**
   * p8-preview-tunnels (ADR-0032): opening a job-bound preview tunnel (and re-attaching a stable one that was approved
   * before). Default auto — by design, preview links are open by default, within the project's limits.
   */
  previewTunnel: DeployDecisionRule.default('auto'),
  /** p8-preview-tunnels: reserving a new stable tunnel (fixed hostname, ≤ 30 days) or renewing one. Default approval. */
  stableTunnel: DeployDecisionRule.default('approval'),
});
export type DeployPolicy = z.infer<typeof DeployPolicy>;

/** An e-mail address for the Access allowlist (lower-cased). */
const AccessEmail = z
  .string()
  .max(254)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.email());

/**
 * p8-preview-tunnels (ADR-0032): Project → Deploy → Preview links. The zone must be a zone the stored Cloudflare token
 * can see (checked on save); hostnames are `[<prefix>-]<name>-<random>.<zone>` (one label: Universal SSL covers only
 * first-level subdomains).
 */
export const PreviewSettings = z.strictObject({
  zone: z.strictObject({ id: ZoneId, name: HostName }).nullable().default(null),
  prefix: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/, 'prefix: 1–20 lower-case letters, digits, hyphens')
    .nullable()
    .default(null),
  /** The job's agent may open previews itself (tools); humans can always open them from the job page. */
  agentsMayOpen: z.boolean().default(true),
  /** Who may pass a Cloudflare Access (e-mail one-time PIN) protected preview. Empty: `access` is not offered. */
  accessEmails: z.array(AccessEmail).max(50).default([]),
  /** Open previews per project (job-bound + stable) and per job. */
  maxActive: z.number().int().min(1).max(20).default(5),
  maxPerJob: z.number().int().min(1).max(5).default(3),
});
export type PreviewSettings = z.infer<typeof PreviewSettings>;

export const DeployTargets = z.strictObject({
  coolify: z
    .strictObject({
      preview: CoolifyEnvTarget.nullable().default(null),
      production: CoolifyEnvTarget.nullable().default(null),
    })
    .nullable()
    .default(null),
  pages: z.strictObject({ projectName: PagesProjectName }).nullable().default(null),
  /**
   * p10-site-upload: further Cloudflare Pages projects of this project besides the default target `pages` — those
   * the master created for it ("Create a new Pages project" without "use as target") or that a project admin
   * adopted / listed. `pages.deploy`, `pages.add_domain` and `pages.rollback` may name one of them
   * (`pagesProject`); any other name is refused.
   */
  pagesProjects: z.array(PagesProjectName).max(20).default([]),
  dns: z
    .strictObject({
      zones: z
        .array(z.strictObject({ id: ZoneId, name: HostName }))
        .max(20)
        .default([]),
      /** Extra names (exact host names) that must never be changed by an ops action. */
      protectedNames: z.array(HostName).max(100).default([]),
    })
    .default({ zones: [], protectedNames: [] }),
  /** p8-preview-tunnels: null = no preview links for this project. */
  previews: PreviewSettings.nullable().default(null),
  policy: DeployPolicy.default({
    previewDeploy: 'auto',
    productionDeploy: 'approval_step_up',
    dnsChange: 'approval',
    autoDeployProductionOnSuccess: false,
    pagesProject: 'approval',
    previewTunnel: 'auto',
    stableTunnel: 'approval',
  }),
});
export type DeployTargets = z.infer<typeof DeployTargets>;

export const DnsRecordType = z.enum(['A', 'AAAA', 'CNAME', 'TXT']);

const Note = z.string().max(200);

export const CoolifyDeployParams = z.strictObject({
  env: DeployEnv,
  force: z.boolean().default(false),
  /** Free text shown on the record (e.g. a commit or ref the requester has in mind); never sent to Coolify. */
  ref: Note.optional(),
  /**
   * p15-coolify-create: deploy only these resources of the target (each must be part of it) — the first deploy of an
   * application Remyral just created and linked, without redeploying the target's other applications.
   */
  only: z.array(CoolifyUuid).min(1).max(20).optional(),
});
export const CoolifyRestartParams = z.strictObject({ env: DeployEnv });
export const PagesDeployParams = z
  .strictObject({
    /** The finished job whose site bundle (else committed output artifacts, its `out/` files) form the site. */
    jobId: z.uuid().optional(),
    /** p10-site-upload: a ready site uploaded through Project → Deploy (`/projects/:id/site-uploads`). */
    uploadId: z.uuid().optional(),
    /** Branch label of the deployment; the project's production branch → production. Default: preview. */
    branch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,100}$/)
      .optional(),
    /**
     * p10-site-upload: instead of a branch — `production` deploys to the Pages project's production branch,
     * `preview` to the preview label `remyral-preview`.
     */
    env: DeployEnv.optional(),
    /** Only artifacts under this directory (e.g. `dist`), which becomes the site root (job output files only). */
    directory: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    /**
     * p6-deploy-on-success (ADR-0030): publish exactly this site bundle (SHA-256 of `site-bundle.json`) — no other
     * bundle and no output-file fallback. Set by the master for pre-approved deploys.
     */
    bundleSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * p10-site-upload: the Pages project to deploy to — the project's target (default) or one of its
     * `pagesProjects`. Never a free name.
     */
    pagesProject: PagesProjectName.optional(),
  })
  .refine((p) => (p.jobId === undefined) !== (p.uploadId === undefined), {
    message: 'exactly one of jobId and uploadId',
    path: ['jobId'],
  })
  .refine((p) => p.branch === undefined || p.env === undefined, {
    message: 'branch and env cannot both be set',
    path: ['env'],
  })
  .refine((p) => p.uploadId === undefined || (p.directory === undefined && p.bundleSha256 === undefined), {
    message: 'directory and bundleSha256 belong to job deploys',
    path: ['uploadId'],
  });
export const DnsUpsertParams = z.strictObject({
  zone: HostName,
  type: DnsRecordType,
  name: HostName,
  content: z.string().min(1).max(2048),
  /** 1 = automatic; else 60..86400 (Cloudflare). */
  ttl: z
    .number()
    .int()
    .refine((t) => t === 1 || (t >= 60 && t <= 86_400), 'ttl 1 or 60..86400')
    .default(1),
  proxied: z.boolean().default(false),
});
export const DnsDeleteParams = z.strictObject({ zone: HostName, type: DnsRecordType, name: HostName });

/**
 * p6-pages-create: create a Direct Upload Pages project (no source repository — Remyral deploys bundles) in the
 * connected Cloudflare account. `ifExists: adopt` uses an existing project of that name instead. `useAsTarget` makes
 * it this project's Pages target; without it (p10-site-upload) the new project is added to `pagesProjects`, so it can
 * be deployed to without replacing the target. Adopting and `useAsTarget` need the right to change deploy targets
 * (project admin + step-up).
 */
export const PagesCreateProjectParams = z.strictObject({
  name: PagesNewProjectName,
  productionBranch: BranchLabel.default('main'),
  /**
   * `adopt` uses an existing project of that name: as the target with `useAsTarget`, otherwise (p10-site-upload)
   * as one of this project's further Pages projects. Either way a deploy-target change (project admin + step-up).
   */
  ifExists: z.enum(['refuse', 'adopt']).default('refuse'),
  useAsTarget: z.boolean().default(false),
});
/**
 * p6-pages-create: attach a custom domain to the project's configured Pages target. `dns: auto` also creates /
 * updates the CNAME `<domain> → <project subdomain>` when the domain lies in one of the project's allowed zones
 * (policy-checked like `dns.upsert`); otherwise the plan says which record to add by hand.
 */
export const PagesAddDomainParams = z.strictObject({
  domain: HostName,
  dns: z.enum(['auto', 'skip']).default('auto'),
  /** p10-site-upload: the project's target (default) or one of its `pagesProjects`. */
  pagesProject: PagesProjectName.optional(),
});

/**
 * p10-publish-bundle (ADR-0038): the publish bundle — one action for the chain "create the Pages project if missing →
 * deploy a job's result or an uploaded site → attach a custom domain → write its CNAME". Approved once; each step runs
 * as its own child action pre-approved by the bundle and re-checked at execution.
 */
export const PagesPublishParams = z
  .strictObject({
    jobId: z.uuid().optional(),
    uploadId: z.uuid().optional(),
    env: DeployEnv.default('preview'),
    /** The target, one of `pagesProjects`, or (with `createIfMissing`) a name that is new in the account. */
    pagesProject: PagesProjectName.optional(),
    createIfMissing: z.boolean().default(false),
    /** Only for a project created by the bundle. */
    productionBranch: BranchLabel.default('main'),
    domain: HostName.optional(),
    dns: z.enum(['auto', 'skip']).default('auto'),
    /** Job output files only (as `pages.deploy`). */
    directory: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    /** Job deploys only: publish exactly this site bundle (set by the master for deploy on success). */
    bundleSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((p) => (p.jobId === undefined) !== (p.uploadId === undefined), {
    message: 'exactly one of jobId and uploadId',
    path: ['jobId'],
  })
  .refine((p) => p.uploadId === undefined || (p.directory === undefined && p.bundleSha256 === undefined), {
    message: 'directory and bundleSha256 belong to job deploys',
    path: ['uploadId'],
  });
export type PagesPublishParams = z.infer<typeof PagesPublishParams>;

/**
 * p8-preview-tunnels (ADR-0032): open a preview of `port` on the worker that runs `jobId`'s live attempt. `stable`
 * keeps the hostname (by `name`) across jobs. `check` is how the port was vouched for (set by the master: `owned`
 * from a job's own request after the worker's process-tree check, `declared` for a human).
 */
export const TunnelOpenParams = z.strictObject({
  jobId: z.uuid(),
  port: PreviewPort,
  name: PreviewName.optional(),
  protect: PreviewProtection.default('none'),
  ttlMinutes: z.number().int().min(5).max(PREVIEW_LIMITS.stableMaxMinutes).optional(),
  stable: z.boolean().default(false),
  check: z.enum(['owned', 'declared']).default('declared'),
});
export const TunnelCloseParams = z.strictObject({
  tunnelId: z.uuid(),
  /** Why (shown on the record): `closed` by a person or job, `job_ended`, `expired`, `failed`. */
  reason: z.string().max(200).optional(),
});
export const TunnelExtendParams = z.strictObject({
  tunnelId: z.uuid(),
  minutes: z.number().int().min(5).max(PREVIEW_LIMITS.stableMaxMinutes),
});

export const PARAMS_OF = {
  'coolify.deploy': CoolifyDeployParams,
  'coolify.restart': CoolifyRestartParams,
  'pages.deploy': PagesDeployParams,
  'dns.upsert': DnsUpsertParams,
  'dns.delete': DnsDeleteParams,
  'pages.create_project': PagesCreateProjectParams,
  'pages.add_domain': PagesAddDomainParams,
  'pages.publish': PagesPublishParams,
  'tunnel.open': TunnelOpenParams,
  'tunnel.close': TunnelCloseParams,
  'tunnel.extend': TunnelExtendParams,
} as const;

export const OpsActionRequest = z.strictObject({
  project: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  kind: z.enum(REQUESTABLE_KINDS),
  params: z.record(z.string(), z.unknown()),
  /** Client-chosen; the same key with the same parameters returns the first record. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
  note: z.string().max(500).optional(),
});
export type OpsActionRequest = z.infer<typeof OpsActionRequest>;

/**
 * p6-deploy-on-success (ADR-0030): "deploy this job's result when it succeeds" — the creator names only the kind of
 * target and the environment; the master resolves the real target from the project's deploy targets.
 */
export const DeployOnSuccessRequest = z
  .strictObject({
    target: z.enum(['pages', 'coolify']),
    env: DeployEnv.default('preview'),
    /** Pages: the directory of the built site (JobSpec.siteBundle.directory); default `site`. */
    directory: SiteBundleRequest.shape.directory.optional(),
    /**
     * p10-publish-bundle (ADR-0038), Pages only: publish as a bundle — to this Pages project (the target, a further
     * one, or with `createIfMissing` a new one), optionally attaching `domain` and writing its CNAME (`dns: auto`).
     */
    pagesProject: PagesProjectName.optional(),
    createIfMissing: z.boolean().optional(),
    domain: HostName.optional(),
    dns: z.enum(['auto', 'skip']).optional(),
  })
  .refine(
    (r) =>
      r.target === 'pages' ||
      (r.pagesProject === undefined &&
        r.createIfMissing === undefined &&
        r.domain === undefined &&
        r.dns === undefined),
    { message: 'pagesProject, createIfMissing, domain and dns belong to Pages deploys', path: ['target'] },
  )
  .refine((r) => r.createIfMissing !== true || r.pagesProject !== undefined, {
    message: 'createIfMissing needs the pagesProject name',
    path: ['createIfMissing'],
  });
export type DeployOnSuccessRequest = z.infer<typeof DeployOnSuccessRequest>;

/** p10-publish-bundle: the publish extras of a deploy on success (null: a plain deploy as before). */
export interface PublishExtras {
  readonly pagesProject: string | null;
  readonly createIfMissing: boolean;
  readonly domain: string | null;
  readonly dns: 'auto' | 'skip';
}

export function publishExtrasOf(r: {
  readonly target: string;
  readonly pagesProject?: string | undefined;
  readonly createIfMissing?: boolean | undefined;
  readonly domain?: string | undefined;
  readonly dns?: 'auto' | 'skip' | undefined;
}): PublishExtras | null {
  if (r.target !== 'pages') return null;
  if (r.pagesProject === undefined && r.createIfMissing !== true && r.domain === undefined) return null;
  return {
    pagesProject: r.pagesProject ?? null,
    createIfMissing: r.createIfMissing === true,
    domain: r.domain ?? null,
    dns: r.dns ?? 'auto',
  };
}
export const DEFAULT_SITE_DIRECTORY = 'site';

export type OpsState =
  'awaiting_approval' | 'refused' | 'denied' | 'expired' | 'executing' | 'deploying' | 'succeeded' | 'failed';
export const OPS_STATES: readonly OpsState[] = [
  'awaiting_approval',
  'refused',
  'denied',
  'expired',
  'executing',
  'deploying',
  'succeeded',
  'failed',
];

/** p8-preview-tunnels: `job` — a job's agent tool / auto-open (system `job:<id>`, the creator re-authorized). */
export type OpsVia = 'api' | 'chat' | 'automation' | 'workflow' | 'job';

export type PolicyOutcome = 'auto' | 'approval' | 'approval_step_up' | 'refused';

export interface OpsActionView {
  readonly id: string;
  readonly project: string;
  readonly kind: OpsKind;
  readonly env: DeployEnv | null;
  readonly params: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly diff: Record<string, unknown>;
  readonly policy: { readonly decision: PolicyOutcome; readonly reason: string };
  readonly state: OpsState;
  readonly requestedBy: {
    readonly type: 'user' | 'system';
    readonly id: string;
    readonly username: string | null;
  };
  readonly via: OpsVia;
  /** p6-deploy-pipeline: {automationId, runId} or {workflowRunId, nodeId}. */
  readonly source: Record<string, unknown> | null;
  readonly note: string | null;
  readonly rollbackOf: string | null;
  readonly rollbackAvailable: boolean;
  readonly decidedBy: { readonly id: string; readonly username: string | null } | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly finishedAt: string | null;
}

export class OpsError extends Error {
  override name = 'OpsError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}
