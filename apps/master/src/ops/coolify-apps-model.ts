import { isIP } from 'node:net';
import { z } from 'zod';
import { DeployEnv, HostName } from './model.js';

/**
 * p15-coolify-create (ADR-0057, docs/design/p15-coolify-create.md §3): the inputs of "new Coolify application",
 * "set environment variables" and "set domains" — shared by the console routes and the assistant's coolify_* tools.
 * Every field maps to a documented Coolify API field (docs/compat/coolify.md); nothing else is sent.
 */

export const CoolifyUuid = z.string().regex(/^[A-Za-z0-9]{6,64}$/, 'Coolify uuid');
const ConnectionId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'connection id');
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'idempotency key');
const Branch = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'branch');
/** A path inside the repository (`/`, `/apps/web`, `/Dockerfile`). */
const RepoPath = z
  .string()
  .max(300)
  .regex(/^\/[A-Za-z0-9._@+/-]*$/, 'path inside the repository (starts with /)')
  .refine((p) => !p.split('/').includes('..'), 'no ..');
/** A build / install / start command for Coolify's build (admin-set, never run by Remyral). */
const Command = z
  .string()
  .max(1000)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  .refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s), 'no control characters');
export const Ports = z.string().regex(/^\d{1,5}(,\d{1,5}){0,9}$/, 'ports: 3000 or 3000,8080');
const AppName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/, 'name: letters, digits, space . _ -');
const ImageName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/:-]{0,254}$/, 'image name (registry/owner/name, lower-case)')
  .refine((s) => !s.includes('@'), 'no digest in the name');
const ImageTag = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$|^sha256:[0-9a-f]{64}$/, 'image tag');

/** p17-coolify-full: Docker resource limits as Coolify takes them (`512m`, `1g`, `0` = unlimited; CPUs `0.5`). */
export const LimitsMemory = z.string().regex(/^\d{1,6}(\.\d{1,3})?[bkmgBKMG]?$/, 'memory: 512m, 1g or 0');
export const LimitsCpus = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/, 'CPUs: 1 or 0.5 (0 = no limit)');

/** Environment variable key (Coolify normalises keys to this form). */
export const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'variable name: A-Z, 0-9, _');
/** A Coolify shared-variable reference without braces: `project.DATABASE_URL`. */
export const SharedRef = z
  .string()
  .regex(
    /^(team|project|environment|server)\.[A-Za-z_][A-Za-z0-9_]{0,127}$/,
    'team|project|environment|server.NAME',
  );

/**
 * One variable to set. The value is one of:
 * - `value` — typed in by the administrator; sent to Coolify in the same request and **never stored, logged or
 *   audited by Remyral** (only the key is);
 * - `shared` — a Coolify shared variable (`{{project.NAME}}`): the value lives in Coolify's own store, Remyral never
 *   sees it.
 */
export const CoolifyEnvSet = z
  .strictObject({
    key: EnvKey,
    value: z
      .string()
      .max(32 * 1024)
      .optional(),
    shared: SharedRef.optional(),
    /** Coolify `is_preview`: the variable of preview (pull request) deployments. Default false. */
    preview: z.boolean().optional(),
    /** build-time and run-time (default), only one of them. */
    scope: z.enum(['both', 'runtime', 'buildtime']).optional(),
    literal: z.boolean().optional(),
    multiline: z.boolean().optional(),
  })
  .refine((e) => (e.value === undefined) !== (e.shared === undefined), {
    message: 'exactly one of value or shared',
  });
export type CoolifyEnvSet = z.infer<typeof CoolifyEnvSet>;

export const CoolifyEnvRemove = z.strictObject({
  key: EnvKey,
  remove: z.literal(true),
  preview: z.boolean().optional(),
});
export const CoolifyEnvChange = z.union([CoolifyEnvRemove, CoolifyEnvSet]);
export type CoolifyEnvChange = z.infer<typeof CoolifyEnvChange>;

/** An application URL as Coolify takes it: `https://host[:port][/path]` (no credentials, query or fragment). */
export const DomainUrl = z
  .string()
  .max(300)
  .transform((raw, ctx) => {
    const v = raw.trim();
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a URL' });
      return z.NEVER;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      ctx.addIssue({ code: 'custom', message: 'http:// or https:// only' });
      return z.NEVER;
    }
    if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
      ctx.addIssue({ code: 'custom', message: 'no credentials, query or fragment' });
      return z.NEVER;
    }
    const host = HostName.safeParse(u.hostname);
    if (!host.success || isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) {
      ctx.addIssue({ code: 'custom', message: 'a DNS host name (no IP address, no wildcard)' });
      return z.NEVER;
    }
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host.data}${u.port === '' ? '' : `:${u.port}`}${path}`;
  });

export const HealthCheck = z.strictObject({
  enabled: z.boolean(),
  path: z
    .string()
    .regex(/^\/[\x21-\x7e]{0,299}$/, 'path starting with /')
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  method: z.enum(['GET', 'POST', 'HEAD']).optional(),
  scheme: z.enum(['http', 'https']).optional(),
  returnCode: z.number().int().min(100).max(599).optional(),
  interval: z.number().int().min(1).max(3600).optional(),
  timeout: z.number().int().min(1).max(600).optional(),
  retries: z.number().int().min(1).max(100).optional(),
  startPeriod: z.number().int().min(0).max(3600).optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const BUILD_PACKS = ['nixpacks', 'railpack', 'static', 'dockerfile', 'dockercompose'] as const;

export const CoolifyAppSource = z.discriminatedUnion('type', [
  /** The project's repository (Projeler → Depo) and a branch (default: its base branch). */
  z.strictObject({
    type: z.literal('repository'),
    /** public (no credentials), github_app (a Coolify GitHub App source), deploy_key (a Coolify private key). */
    access: z.enum(['public', 'github_app', 'deploy_key']).default('public'),
    githubApp: CoolifyUuid.optional(),
    privateKey: CoolifyUuid.optional(),
    branch: Branch.optional(),
  }),
  /** A Dockerfile without a repository (Coolify builds it as given). */
  z.strictObject({
    type: z.literal('dockerfile'),
    dockerfile: z
      .string()
      .min(1)
      .max(64 * 1024),
  }),
  /** A ready image from a registry. */
  z.strictObject({ type: z.literal('image'), image: ImageName, tag: ImageTag.optional() }),
]);
export type CoolifyAppSource = z.infer<typeof CoolifyAppSource>;

export const CoolifyCreateAppInput = z.strictObject({
  /** Which deploy target of the project the new application belongs to (and is linked to). */
  env: DeployEnv,
  /** The Coolify connection (null / absent: the env target's, else the default). */
  connection: ConnectionId.nullable().optional(),
  server: CoolifyUuid,
  coolifyProject: CoolifyUuid,
  /** The Coolify environment's name (e.g. `production`). */
  environment: z.string().trim().min(1).max(100),
  destination: CoolifyUuid.optional(),
  name: AppName.optional(),
  description: z.string().max(500).optional(),
  source: CoolifyAppSource,
  buildPack: z.enum(BUILD_PACKS).optional(),
  ports: Ports.optional(),
  isStatic: z.boolean().optional(),
  baseDirectory: RepoPath.optional(),
  publishDirectory: RepoPath.optional(),
  dockerfileLocation: RepoPath.optional(),
  composeLocation: RepoPath.optional(),
  installCommand: Command.optional(),
  buildCommand: Command.optional(),
  startCommand: Command.optional(),
  domains: z.array(DomainUrl).max(10).default([]),
  healthCheck: HealthCheck.optional(),
  envs: z.array(CoolifyEnvSet).max(100).default([]),
  /** add (default): add the new uuid to the env target; replace: the target becomes just this app; none. */
  link: z.enum(['add', 'replace', 'none']).default('add'),
  /** Request the first deploy (the project's deploy policy decides whether it runs at once). */
  deploy: z.boolean().default(false),
  idempotencyKey: IdempotencyKey,
  /**
   * p15-coolify-dedupe: create it even though an application for the same repository + branch (or with the same name)
   * already exists in that Coolify environment. Only when the user explicitly asked for a second application.
   */
  allowDuplicate: z.boolean().default(false),
});
export type CoolifyCreateAppInput = z.infer<typeof CoolifyCreateAppInput>;

export const CoolifySetEnvsInput = z.strictObject({
  changes: z.array(CoolifyEnvChange).min(1).max(100),
  /** Redeploy the application afterwards (variables take effect on the next deploy). */
  deploy: z.boolean().default(false),
});
export type CoolifySetEnvsInput = z.infer<typeof CoolifySetEnvsInput>;

export const CoolifySetDomainsInput = z.strictObject({
  domains: z.array(DomainUrl).max(10),
  /** Docker Compose applications: the service that serves these domains (optional when there is only one). */
  service: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/)
    .optional(),
  deploy: z.boolean().default(false),
});
export type CoolifySetDomainsInput = z.infer<typeof CoolifySetDomainsInput>;

/**
 * p15-coolify-dedupe: the build / run settings of a linked application that a fix needs (`PATCH /applications/{uuid}`,
 * documented fields only). At least one field; `deploy` redeploys that application afterwards.
 */
export const CoolifyUpdateAppInput = z
  .strictObject({
    name: AppName.optional(),
    branch: Branch.optional(),
    buildPack: z.enum(BUILD_PACKS).optional(),
    baseDirectory: RepoPath.optional(),
    publishDirectory: RepoPath.optional(),
    dockerfileLocation: RepoPath.optional(),
    composeLocation: RepoPath.optional(),
    ports: Ports.optional(),
    isStatic: z.boolean().optional(),
    installCommand: Command.optional(),
    buildCommand: Command.optional(),
    startCommand: Command.optional(),
    /** Coolify Watch Paths: one pattern per entry (`*`, `**`, `?`, `!`; last match wins); [] clears them. */
    watchPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\n\r\0]+$/),
      )
      .max(50)
      .optional(),
    healthCheck: HealthCheck.optional(),
    /** p17-coolify-full: resource limits (`limits_memory` e.g. `512m` / `1g`, `0` = none; `limits_cpus` e.g. `1.5`). */
    limitsMemory: LimitsMemory.optional(),
    limitsCpus: LimitsCpus.optional(),
    deploy: z.boolean().default(false),
  })
  .refine((u) => Object.keys(u).some((k) => k !== 'deploy'), { message: 'nothing to change' });
export type CoolifyUpdateAppInput = z.infer<typeof CoolifyUpdateAppInput>;

/**
 * p15-coolify-dedupe: deleting an application of the project (`DELETE /applications/{uuid}` with Coolify's documented
 * flags). Volumes are kept unless asked for (data); configurations, the docker cleanup and the connected networks
 * follow Coolify's defaults.
 */
export const CoolifyDeleteAppInput = z.strictObject({
  deleteVolumes: z.boolean().default(false),
  deleteConfigurations: z.boolean().default(true),
  dockerCleanup: z.boolean().default(true),
  deleteConnectedNetworks: z.boolean().default(true),
  /** p17-coolify-full: the application's name as the user typed it (the panel always sends it; must match). */
  confirm: z.string().trim().min(1).max(300).optional(),
});
export type CoolifyDeleteAppInput = z.infer<typeof CoolifyDeleteAppInput>;

/** p15-coolify-dedupe: which logs of an application to read (bounded). */
export const CoolifyAppLogsQuery = z.strictObject({
  kind: z.enum(['deployment', 'runtime', 'both']).default('both'),
  lines: z.number().int().min(10).max(2000).default(200),
});
export type CoolifyAppLogsQuery = z.infer<typeof CoolifyAppLogsQuery>;

/** zod issues as one bounded line (`path message; …`). */
export function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
    .join('; ')
    .slice(0, 500);
}
