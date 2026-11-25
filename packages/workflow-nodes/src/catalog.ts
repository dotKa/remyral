import { JobSpec } from '@remyral/protocol';
import { z } from 'zod';
import { type DataSchema, DataSchemaZ } from './data-schema.js';
import {
  CredentialRef,
  DENIED_HEADERS,
  expr,
  ExprText,
  ExprValue,
  HEADER_NAME,
  HttpOrigin,
  MAIL_ADDRESS,
  PublicHost,
  type FieldMode,
} from './fields.js';
import { Repository } from './v1.js';

/**
 * The node catalog (p14-workflow-engine §3, ADR-0055): every node type with its category, where it runs, its config
 * schema (strict zod: unknown keys refused), which config fields are static vs expression-capable, its ports, whether
 * it has side effects, the permission needed to add it and the phase that delivers its executor. The catalog is pure
 * data: the master validates and executes from it, the web builds its palette and forms from it.
 *
 * Design decisions reflected here: K1 — `http.request` egress is open to any public address by default,
 * the project allowlist is optional (enforced only when the project turns it on); LAN / private / link-local /
 * loopback / metadata addresses are always refused and the request always leaves from a worker. K2 — trigger nodes on
 * the canvas, bound to automations on "Etkinleştir". K3 — JS / Python code nodes only on workers with a container
 * engine. K4 — a built-in `email.send` node: SMTP (host, port, TLS mode, username; password in the vault) with
 * provider presets, sent by a worker function job; recipients and content may be expressions, the SMTP server and
 * credential are static.
 */

/** Where a node runs (§5.1). */
export type Placement =
  /** master, pure: deterministic, no I/O, bounded (control flow, data, timers, approvals). */
  | 'master'
  /** master, existing integrations to admin-configured provider hosts (notifications, ops actions, GitHub, probe). */
  | 'integration'
  /** worker function job (`kind: "function"`): HTTP, e-mail, code — never on the master. */
  | 'worker'
  /** worker AI job (the five roles on the four runtimes). */
  | 'worker-ai'
  /** a declaration bound to an automation (the trigger runtime, ADR-0024). */
  | 'trigger';

export type Category = 'trigger' | 'ai' | 'control' | 'data' | 'integration' | 'code';
export type DeliveryPhase = '14.0' | '14.1' | '14.2' | '14.3' | '14.4';
/** The permission a definition needs to add or change a node of the type (§8.5; actions registered with their phase). */
export type DefineAction =
  'workflows.define' | 'workflows.define.network' | 'workflows.define.code' | 'workflows.define.deploy';
/** Worker features a function node needs (placement refuses other workers, as for `integration-v1`). */
export type WorkerFeature = 'function-v1' | 'function-code-v1';

export interface PortSpec {
  readonly name: string;
  readonly direction: 'in' | 'out';
  /** `inner`: a group's port towards its body (`item`); default `outer`. */
  readonly side?: 'outer' | 'inner';
  readonly schema?: DataSchema;
  /** Input: must receive a value (or a skip) before the node may run. */
  readonly required?: boolean;
  /** Input: accepts several edges (merge / join). */
  readonly many?: boolean;
  /** Ports generated from the config. */
  readonly dynamic?: 'cases';
}

/**
 * A node type. Its user-facing label and one-line description live in the i18n catalog (ADR-0053,
 * `@remyral/i18n` → `workflows.nodeTypes[<type>]`, TR + EN), not here.
 */
export interface NodeTypeSpec {
  readonly type: string;
  readonly category: Category;
  readonly placement: Placement;
  /** The phase whose engine executes the type (the schema is accepted for validation from 14.0). */
  readonly phase: DeliveryPhase;
  readonly icon: string;
  /** Config schema (`ai.step` keeps its fields at node level: its schema is the empty object). */
  readonly config: z.ZodType;
  /** Mode of every top-level config field (static ⇒ no `{{ }}` / `$expr` anywhere inside). */
  readonly fields: Readonly<Record<string, FieldMode>>;
  readonly ports: (config: unknown) => readonly PortSpec[];
  /** A group (forEach / loop): child nodes carry `parent: <id>`. */
  readonly group?: boolean;
  /** Has an effect outside the run (side-effect ledger, step-up on privileged delta). */
  readonly sideEffect: boolean;
  readonly requires: DefineAction;
  readonly workerFeature?: WorkerFeature;
  /** Its output is untrusted data (remote responses, event payloads, model output). */
  readonly untrustedOutput?: boolean;
  /** `http.request` / `email.send`: K1 egress semantics (§8.4). */
  readonly egress?: { readonly default: 'public'; readonly allowlist: 'optional' };
}

// ------------------------------------------------------------------------------------- shared shapes

const ERROR_SCHEMA: DataSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    node: { type: 'string' },
    attempt: { type: 'integer' },
  },
  required: ['code', 'message'],
};

const IN: PortSpec = { name: 'in', direction: 'in', required: true };
const IN_MANY: PortSpec = { name: 'in', direction: 'in', required: true, many: true };
const OUT: PortSpec = { name: 'out', direction: 'out' };
const ERROR: PortSpec = { name: 'error', direction: 'out', schema: ERROR_SCHEMA };
const out = (name: string, schema?: DataSchema): PortSpec => ({
  name,
  direction: 'out',
  ...(schema === undefined ? {} : { schema }),
});
const fixed =
  (...ports: PortSpec[]) =>
  (): readonly PortSpec[] =>
    ports;

const Duration = z.union([
  z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 3600),
  z.string().regex(/^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/),
]);
const PORT_NAME_Z = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const WorkflowRef = z.strictObject({
  project: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .optional(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
});
const ApproverRole = z.enum(['operator', 'admin', 'owner']);
const TIMEZONE = z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/);
const MAX_TEXT = 16 * 1024;
const JsonLiteral = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

// ------------------------------------------------------------------------------------- triggers (§3.1, K2)

const TriggerManual = z.strictObject({});
/**
 * p16-workflow-quality: `cron` (5 fields) or `at` (ISO time; without an offset it is read in the zone) on the wall
 * clock of an IANA zone — `timezone`, or its alias `timeZone` (one of them; default UTC). Activating the workflow binds
 * it to an automation that fires it (one scheduler for every master replica).
 */
const TriggerSchedule = z
  .strictObject({
    cron: z.string().min(9).max(120).optional(),
    at: z.union([z.iso.datetime({ offset: true }), z.iso.datetime({ local: true })]).optional(),
    timezone: TIMEZONE.optional(),
    timeZone: TIMEZONE.optional(),
    catchUp: z.enum(['skip', 'once', 'all']).default('skip'),
  })
  .refine((c) => (c.cron === undefined) !== (c.at === undefined), { message: 'cron_or_at' })
  .refine((c) => c.timezone === undefined || c.timeZone === undefined, { message: 'timezone_twice' });
const TriggerWebhook = z.strictObject({
  ipAllowlist: z
    .array(z.string().regex(/^[0-9a-fA-F:.]{2,39}(\/\d{1,3})?$/))
    .max(20)
    .optional(),
  responseMode: z.enum(['ack', 'wait']).default('ack'),
  /** 14.4 `responseMode: wait`: how long the request is held for a `control.respond` (≤ 30 s, the request bound). */
  responseTimeoutSec: z.number().int().min(1).max(30).optional(),
  bodySchema: DataSchemaZ.optional(),
});
const TriggerGithub = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  events: z
    .array(z.enum(['pull_request', 'push', 'issues', 'issue_comment']))
    .min(1)
    .max(4),
  actions: z
    .array(z.string().regex(/^[a-z_]{1,40}$/))
    .min(1)
    .max(12)
    .optional(),
  /** Base branch of a pull request, branch of a push (globs as in automations: `*` in a segment, `**` across). */
  branches: z
    .array(z.string().regex(/^[A-Za-z0-9_.\-/*]{1,255}$/))
    .min(1)
    .max(20)
    .optional(),
  labels: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  command: z
    .string()
    .regex(/^\/[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  allowUntrusted: z.boolean().default(false),
});
const TriggerWorkflow = z.strictObject({
  workflow: WorkflowRef,
  outcomes: z
    .array(z.enum(['succeeded', 'failed', 'cancelled']))
    .min(1)
    .max(3),
});
const TriggerChat = z.strictObject({});
/** 14.4: the run is the error workflow of a failed run (`settings.onFailure`); `$trigger` is the failure context. */
const TriggerError = z.strictObject({});

// ------------------------------------------------------------------------------------- control (§3.3)

const If = z.strictObject({ condition: expr(z.union([z.boolean(), z.string().max(MAX_TEXT)])) });
const SwitchCase = z.strictObject({
  name: PORT_NAME_Z,
  equals: JsonLiteral.optional(),
  match: ExprValue.optional(),
});
const Switch = z
  .strictObject({
    value: expr(z.union([JsonLiteral, z.string().max(MAX_TEXT)])),
    mode: z.enum(['first', 'all']).default('first'),
    cases: z.array(SwitchCase).min(1).max(20),
  })
  .superRefine((c, ctx) => {
    const names = new Set<string>();
    c.cases.forEach((k, i) => {
      if (names.has(k.name) || k.name === 'default' || k.name === 'error' || k.name === 'in')
        ctx.addIssue({ code: 'custom', path: ['cases', i, 'name'], message: 'duplicate_or_reserved' });
      names.add(k.name);
      if ((k.equals === undefined) === (k.match === undefined))
        ctx.addIssue({ code: 'custom', path: ['cases', i], message: 'equals_or_match' });
    });
  });
const Join = z.union([
  z.enum(['all', 'any', 'first']),
  z.strictObject({ atLeast: z.number().int().min(1).max(20) }),
]);
const Merge = z.strictObject({
  join: Join.default('all'),
  combine: z.enum(['array', 'object']).default('array'),
});
const ForEach = z.strictObject({
  items: ExprValue,
  concurrency: z.number().int().min(1).max(20).default(4),
  onItemError: z.enum(['fail', 'continue', 'collect']).default('fail'),
});
const Loop = z.strictObject({
  while: ExprValue,
  maxIterations: z.number().int().min(1).max(100),
});
const Delay = z.strictObject({ duration: expr(Duration) });
const WaitUntil = z.strictObject({
  at: expr(z.iso.datetime({ offset: true })),
  late: z.enum(['run', 'skip']).default('run'),
});
const Approval = z.strictObject({
  approverRole: ApproverRole.default('admin'),
  title: ExprText(200),
  details: ExprText(4000).optional(),
  timeoutSec: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600)
    .optional(),
});
const WaitWebhook = z.strictObject({
  timeoutSec: z
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600),
  mode: z.enum(['signed', 'token']).default('signed'),
  bodySchema: DataSchemaZ.optional(),
});
const SubWorkflow = z.strictObject({
  workflow: WorkflowRef,
  version: z.union([z.literal('latest'), z.number().int().min(1)]).default('latest'),
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), expr(z.string().max(8 * 1024))).default({}),
  wait: z.boolean().default(true),
});
const Stop = z.strictObject({ outputs: ExprValue.optional() });
const Fail = z.strictObject({ reason: ExprText(1000) });
const Return = z.strictObject({ value: ExprValue.optional() });
/**
 * 14.4: the response headers a `control.respond` may set (names static; values expressions). Content types are limited
 * to inert ones (the answer is served from the console origin): see RESPOND_CONTENT_TYPES.
 */
export const RESPOND_HEADERS: readonly string[] = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'retry-after',
  'content-language',
  'x-request-id',
  'x-correlation-id',
];
export const RESPOND_CONTENT_TYPES: readonly string[] = ['application/json', 'text/plain'];
/** Bytes of a `control.respond` body (JSON text or plain text). */
export const RESPOND_BODY_MAX_BYTES = 64 * 1024;
const Respond = z.strictObject({
  status: z.number().int().min(200).max(599).default(200),
  body: expr(z.unknown()).optional(),
  headers: z.partialRecord(z.enum(RESPOND_HEADERS as [string, ...string[]]), ExprText(1000)).optional(),
});

// ------------------------------------------------------------------------------------- data (§3.4)

const FIELD_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const DataSet = z.strictObject({
  fields: z
    .record(FIELD_NAME, expr(z.unknown()))
    .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 100, { message: 'count' }),
  keepInput: z.boolean().default(false),
});
const DataTransform = z.strictObject({ expression: ExprValue });
const DataFilter = z.strictObject({ items: ExprValue, keep: ExprValue });
const DataAggregate = z.strictObject({
  items: ExprValue,
  groupBy: ExprValue.optional(),
  operations: z
    .array(
      z.strictObject({
        name: FIELD_NAME,
        op: z.enum(['count', 'sum', 'min', 'max', 'avg', 'concat', 'first', 'last']),
        field: ExprValue.optional(),
      }),
    )
    .min(1)
    .max(20),
});
const DataSplit = z.strictObject({
  mode: z.enum(['array', 'string']),
  value: ExprValue,
  separator: z.string().min(1).max(16).optional(),
});
const DataTemplate = z.strictObject({ template: ExprText(MAX_TEXT) });
const DataParse = z.strictObject({
  format: z.enum(['json', 'csv', 'yaml', 'form']),
  value: ExprValue,
  csv: z
    .strictObject({
      header: z.boolean().default(true),
      delimiter: z.enum([',', ';', '\t', '|']).default(','),
    })
    .optional(),
});
const DataValidate = z.strictObject({ schema: DataSchemaZ, value: ExprValue });
const DataDateTime = z.strictObject({
  operation: z.enum(['parse', 'format', 'add', 'diff', 'now']),
  value: ExprValue.optional(),
  other: ExprValue.optional(),
  amount: expr(z.number()).optional(),
  unit: z.enum(['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years']).optional(),
  format: z.string().max(64).optional(),
  timezone: TIMEZONE.optional(),
});

// ------------------------------------------------------------------------------------- integrations (§3.5)

const NotifyUsers = z
  .strictObject({
    recipients: z.strictObject({
      creator: z.boolean().default(false),
      role: z.enum(['viewer', 'operator', 'admin', 'owner']).optional(),
      users: z.array(z.uuid()).max(20).optional(),
    }),
    title: ExprText(200),
    body: ExprText(2000).optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
  })
  .refine(
    (c) => c.recipients.creator || c.recipients.role !== undefined || (c.recipients.users ?? []).length > 0,
    {
      message: 'no_recipients',
    },
  );
const ChatMessage = z.strictObject({
  thread: z.union([z.literal('creator-ops'), z.strictObject({ threadId: z.uuid() })]).default('creator-ops'),
  text: ExprText(8000),
});
const JobsCreate = z.strictObject({
  spec: z.strictObject({
    runtime: JobSpec.shape.runtime,
    model: JobSpec.shape.model,
    sandboxProfile: JobSpec.shape.sandboxProfile,
    approvalPolicy: JobSpec.shape.approvalPolicy,
    limits: z.strictObject({
      maxDurationSec: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 3600),
    }),
    repository: Repository.optional(),
  }),
  prompt: ExprText(16 * 1024),
  wait: z.boolean().default(true),
});
const TARGET_ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const BRANCH = z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/);
/** 14.2: the Coolify resource comes from the project's deploy targets for `env` (ADR-0028), never from the node. */
const DeployCoolify = z.strictObject({
  action: z.enum(['deploy', 'restart']).default('deploy'),
  env: z.enum(['preview', 'production']),
  force: z.boolean().optional(),
});
const DeployPages = z.strictObject({
  /** The Pages project: the project's target (default) or one of its further Pages projects (ADR-0028 / p10). */
  target: TARGET_ID.optional(),
  branch: BRANCH.optional(),
  /** The upstream `ai.step` whose site bundle is published. */
  fromNode: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
});
const DnsChange = z.strictObject({
  operation: z.enum(['upsert', 'delete']),
  /** The DNS zone (one of the project's zones); default: the project's only zone containing the record name. */
  target: TARGET_ID.optional(),
  record: z.strictObject({
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT']),
    name: z.string().regex(/^[A-Za-z0-9*._-]{1,253}$/),
    content: z.string().max(2048).optional(),
    ttl: z.number().int().min(60).max(86_400).optional(),
    proxied: z.boolean().optional(),
  }),
});
const GithubComment = z.strictObject({
  number: expr(z.number().int().min(1)),
  body: ExprText(60_000),
});
const GithubPullRequest = z.strictObject({
  fromNode: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  base: BRANCH.optional(),
  title: ExprText(256),
  body: ExprText(60_000).optional(),
  draft: z.boolean().default(true),
});
const UptimeCheck = z.union([
  z.strictObject({
    kind: z.literal('http'),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .refine((u) => !/@/.test(new URL(u).host), { message: 'credentials_in_url' }),
    timeoutSec: z.number().int().min(1).max(30).default(10),
  }),
  z.strictObject({
    kind: z.literal('tcp'),
    host: PublicHost,
    port: z.number().int().min(1).max(65_535),
    timeoutSec: z.number().int().min(1).max(30).default(10),
  }),
]);

/**
 * K1: an HTTP request from a worker. The origin (scheme, host, port) and the credential are static; path, query,
 * header values and body may be expressions. Egress: any public address by default; when the project turns its
 * allowlist on, only listed hosts. Private / LAN / loopback / link-local / metadata addresses are always refused
 * (statically here, and by the worker for every resolved address and redirect).
 */
const HttpRequest = z
  .strictObject({
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    origin: HttpOrigin,
    path: ExprText(2048).default('/'),
    query: z
      .record(z.string().regex(/^[A-Za-z0-9_.~-]{1,64}$/), expr(z.string().max(2048)))
      .refine((r) => Object.keys(r).length <= 50, { message: 'too_many' })
      .optional(),
    headers: z
      .record(z.string().regex(HEADER_NAME), expr(z.string().max(4096)))
      .refine((r) => Object.keys(r).length <= 30, { message: 'too_many' })
      .refine((r) => Object.keys(r).every((k) => !DENIED_HEADERS.has(k.toLowerCase())), {
        message: 'header_not_allowed',
      })
      .optional(),
    body: z.strictObject({ type: z.enum(['json', 'form', 'text']), value: expr(z.unknown()) }).optional(),
    auth: z
      .strictObject({
        credential: CredentialRef,
        placement: z.enum(['header', 'bearer', 'basic', 'query']).default('bearer'),
        name: z.string().regex(HEADER_NAME).optional(),
      })
      .optional(),
    timeoutSec: z.number().int().min(1).max(120).default(30),
    responseType: z.enum(['json', 'text', 'binary']).default('json'),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .default(1024 * 1024),
    followRedirects: z.number().int().min(0).max(3).default(3),
    successStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
  })
  .refine((c) => !(c.body !== undefined && (c.method === 'GET' || c.method === 'HEAD')), {
    message: 'body_not_allowed',
    path: ['body'],
  });

/** K4 SMTP provider presets (host, port, TLS mode); `custom` names its own server. */
export const SMTP_PRESETS: Readonly<
  Record<string, { readonly host: string; readonly port: number; readonly tls: 'tls' | 'starttls' }>
> = {
  gmail: { host: 'smtp.gmail.com', port: 465, tls: 'tls' },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' },
  office365: { host: 'smtp.office365.com', port: 587, tls: 'starttls' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 465, tls: 'tls' },
  mailgun: { host: 'smtp.mailgun.org', port: 465, tls: 'tls' },
  'ses-eu-west-1': { host: 'email-smtp.eu-west-1.amazonaws.com', port: 465, tls: 'tls' },
  'ses-us-east-1': { host: 'email-smtp.us-east-1.amazonaws.com', port: 465, tls: 'tls' },
  postmark: { host: 'smtp.postmarkapp.com', port: 587, tls: 'starttls' },
  brevo: { host: 'smtp-relay.brevo.com', port: 587, tls: 'starttls' },
  yandex: { host: 'smtp.yandex.com', port: 465, tls: 'tls' },
};
export const SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];

const Recipients = expr(
  z.union([z.string().regex(MAIL_ADDRESS), z.array(z.string().regex(MAIL_ADDRESS)).min(1).max(50)]),
);

/**
 * K4: a built-in e-mail node. SMTP server (provider preset or custom host / port / TLS mode), username and the vault
 * credential holding the password are static; recipients, subject and bodies may be expressions. Sent by a worker
 * function job (never from the master): the worker connects only to the static host (public address, re-checked at
 * connect), attaches the password only for that host (the credential's `allowed_hosts`), and never sends without TLS.
 */
const EmailSend = z
  .strictObject({
    smtp: z.strictObject({
      provider: z.enum(['custom', ...Object.keys(SMTP_PRESETS)] as [string, ...string[]]).default('custom'),
      host: PublicHost.optional(),
      port: z
        .number()
        .int()
        .refine((p) => SMTP_PORTS.includes(p), { message: 'port_not_allowed' })
        .optional(),
      tls: z.enum(['tls', 'starttls']).optional(),
      username: z.string().min(1).max(256),
      credential: CredentialRef,
    }),
    from: z.strictObject({
      address: z.string().regex(MAIL_ADDRESS),
      name: z
        .string()
        .max(100)
        .regex(/^[^\r\n<>"]*$/)
        .optional(),
    }),
    to: Recipients,
    cc: Recipients.optional(),
    bcc: Recipients.optional(),
    replyTo: expr(z.string().regex(MAIL_ADDRESS)).optional(),
    subject: ExprText(998),
    text: ExprText(256 * 1024).optional(),
    html: ExprText(256 * 1024).optional(),
    /** Upper bound of to + cc + bcc after evaluation (a data-driven list cannot turn the node into a mass mailer). */
    maxRecipients: z.number().int().min(1).max(50).default(10),
  })
  .superRefine((c, ctx) => {
    if (
      c.smtp.provider === 'custom' &&
      (c.smtp.host === undefined || c.smtp.port === undefined || c.smtp.tls === undefined)
    )
      ctx.addIssue({ code: 'custom', path: ['smtp'], message: 'custom_needs_host_port_tls' });
    if (c.text === undefined && c.html === undefined)
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'body_required' });
  });

/** The SMTP server an `email.send` config resolves to (preset or custom). */
export function smtpServer(config: z.infer<typeof EmailSend>): {
  host: string;
  port: number;
  tls: 'tls' | 'starttls';
} {
  const preset = SMTP_PRESETS[config.smtp.provider];
  return {
    host: config.smtp.host ?? preset?.host ?? '',
    port: config.smtp.port ?? preset?.port ?? 465,
    tls: config.smtp.tls ?? preset?.tls ?? 'tls',
  };
}

// ------------------------------------------------------------------------------------- code (§3.6, K3)

const Code = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(64 * 1024),
  input: expr(z.unknown()).optional(),
  timeoutSec: z.number().int().min(1).max(60).default(10),
  memoryMb: z.number().int().min(32).max(256).default(256),
});

// ------------------------------------------------------------------------------------- the catalog

const AI_OUT: DataSchema = {
  type: 'object',
  properties: {
    summary: { type: 'text' },
    branch: { type: 'string' },
    commits: { type: 'array' },
    files: { type: 'files' },
    data: { type: 'any' },
  },
  required: ['summary'],
};

const allStatic = (...names: string[]): Record<string, FieldMode> =>
  Object.fromEntries(names.map((n) => [n, 'static' as const]));
const modes = (m: Record<string, FieldMode>): Record<string, FieldMode> => m;

function entry(e: NodeTypeSpec): NodeTypeSpec {
  return e;
}

export const NODE_TYPES: readonly NodeTypeSpec[] = [
  // ---------------------------------------------------------------- triggers
  entry({
    type: 'trigger.manual',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.1',
    icon: 'play',
    config: TriggerManual,
    fields: {},
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'trigger.schedule',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.2',
    icon: 'clock',
    config: TriggerSchedule,
    fields: allStatic('cron', 'at', 'timezone', 'timeZone', 'catchUp'),
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'trigger.webhook',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.2',
    icon: 'webhook',
    config: TriggerWebhook,
    fields: allStatic('ipAllowlist', 'responseMode', 'responseTimeoutSec', 'bodySchema'),
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  entry({
    type: 'trigger.github',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.2',
    icon: 'github',
    config: TriggerGithub,
    fields: allStatic('repository', 'events', 'actions', 'branches', 'labels', 'command', 'allowUntrusted'),
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  entry({
    type: 'trigger.workflow',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.2',
    icon: 'link',
    config: TriggerWorkflow,
    fields: allStatic('workflow', 'outcomes'),
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  entry({
    type: 'trigger.chat',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.2',
    icon: 'chat',
    config: TriggerChat,
    fields: {},
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  entry({
    type: 'trigger.error',
    category: 'trigger',
    placement: 'trigger',
    phase: '14.4',
    icon: 'alert',
    config: TriggerError,
    fields: {},
    ports: fixed(OUT),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  // ---------------------------------------------------------------- AI
  entry({
    type: 'ai.step',
    category: 'ai',
    placement: 'worker-ai',
    phase: '14.0',
    icon: 'sparkles',
    config: z.strictObject({}),
    fields: {},
    ports: fixed(IN_MANY, { name: 'context', direction: 'in', required: false }, out('out', AI_OUT), ERROR),
    sideEffect: true,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  // ---------------------------------------------------------------- control flow (master, pure)
  entry({
    type: 'control.if',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'branch',
    config: If,
    fields: modes({ condition: 'expr' }),
    ports: fixed(IN, out('true'), out('false'), ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.switch',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'switch',
    config: Switch,
    // `cases`: names and `equals` literals are checked by the schema (a port name cannot hold an expression);
    // `match` is an expression evaluated per case at run time.
    fields: modes({ value: 'expr', mode: 'static', cases: 'expr' }),
    ports: (c) => [
      IN,
      ...((c as z.infer<typeof Switch> | undefined)?.cases ?? []).map((k) => ({
        ...out(k.name),
        dynamic: 'cases' as const,
      })),
      out('default'),
      ERROR,
    ],
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.merge',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'merge',
    config: Merge,
    fields: allStatic('join', 'combine'),
    ports: fixed(IN_MANY, OUT, ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.forEach',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'repeat',
    config: ForEach,
    fields: modes({ items: 'expr', concurrency: 'static', onItemError: 'static' }),
    ports: fixed(
      IN,
      { name: 'item', direction: 'out', side: 'inner' },
      out('results', { type: 'array' }),
      out('done'),
      ERROR,
    ),
    group: true,
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.loop',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'loop',
    config: Loop,
    fields: modes({ while: 'expr', maxIterations: 'static' }),
    ports: fixed(
      IN,
      { name: 'item', direction: 'out', side: 'inner' },
      out('results', { type: 'array' }),
      out('done'),
      ERROR,
    ),
    group: true,
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.delay',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'hourglass',
    config: Delay,
    fields: modes({ duration: 'expr' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.waitUntil',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'calendar',
    config: WaitUntil,
    fields: modes({ at: 'expr', late: 'static' }),
    ports: fixed(IN, OUT, out('timeout'), ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.approval',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'shield',
    config: Approval,
    fields: modes({ approverRole: 'static', title: 'expr', details: 'expr', timeoutSec: 'static' }),
    ports: fixed(IN, out('approved'), out('denied'), out('timeout'), ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.waitWebhook',
    category: 'control',
    placement: 'master',
    phase: '14.2',
    icon: 'webhook',
    config: WaitWebhook,
    fields: allStatic('timeoutSec', 'mode', 'bodySchema'),
    ports: fixed(IN, out('received'), out('timeout'), ERROR),
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: true,
  }),
  entry({
    type: 'control.subWorkflow',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'workflow',
    config: SubWorkflow,
    fields: modes({ workflow: 'static', version: 'static', inputs: 'expr', wait: 'static' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.stop',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'stop',
    config: Stop,
    fields: modes({ outputs: 'expr' }),
    ports: fixed(IN),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.fail',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'x',
    config: Fail,
    fields: modes({ reason: 'expr' }),
    ports: fixed(IN),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.return',
    category: 'control',
    placement: 'master',
    phase: '14.1',
    icon: 'return',
    config: Return,
    fields: modes({ value: 'expr' }),
    ports: fixed(IN),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  entry({
    type: 'control.respond',
    category: 'control',
    placement: 'master',
    // 14.4 (design §20.5): answers the webhook request a `responseMode: wait` trigger holds; the input passes on.
    phase: '14.4',
    icon: 'reply',
    config: Respond,
    fields: modes({ status: 'static', body: 'expr', headers: 'expr' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: false,
    requires: 'workflows.define',
  }),
  // ---------------------------------------------------------------- data (master, pure)
  ...(
    [
      ['data.set', DataSet, modes({ fields: 'expr', keepInput: 'static' }), [IN, OUT, ERROR]],
      ['data.transform', DataTransform, modes({ expression: 'expr' }), [IN, OUT, ERROR]],
      [
        'data.filter',
        DataFilter,
        modes({ items: 'expr', keep: 'expr' }),
        [IN, out('kept', { type: 'array' }), out('dropped', { type: 'array' }), ERROR],
      ],
      [
        'data.aggregate',
        DataAggregate,
        modes({ items: 'expr', groupBy: 'expr', operations: 'expr' }),
        [IN, OUT, ERROR],
      ],
      [
        'data.split',
        DataSplit,
        modes({ mode: 'static', value: 'expr', separator: 'static' }),
        [IN, out('items', { type: 'array' }), ERROR],
      ],
      ['data.template', DataTemplate, modes({ template: 'expr' }), [IN, out('out', { type: 'text' }), ERROR]],
      ['data.parse', DataParse, modes({ format: 'static', value: 'expr', csv: 'static' }), [IN, OUT, ERROR]],
      [
        'data.validate',
        DataValidate,
        modes({ schema: 'static', value: 'expr' }),
        [IN, out('valid'), out('invalid'), ERROR],
      ],
      [
        'data.dateTime',
        DataDateTime,
        modes({
          operation: 'static',
          value: 'expr',
          other: 'expr',
          amount: 'expr',
          unit: 'static',
          format: 'static',
          timezone: 'static',
        }),
        [IN, OUT, ERROR],
      ],
    ] as const
  ).map(([type, config, fields, ports]) =>
    entry({
      type,
      category: 'data',
      placement: 'master',
      phase: '14.1',
      icon: 'data',
      config,
      fields,
      ports: fixed(...ports),
      sideEffect: false,
      requires: 'workflows.define',
    }),
  ),
  // ---------------------------------------------------------------- integrations
  entry({
    type: 'notify.users',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'bell',
    config: NotifyUsers,
    fields: modes({ recipients: 'static', title: 'expr', body: 'expr', severity: 'static' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define',
  }),
  entry({
    type: 'chat.message',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'chat',
    config: ChatMessage,
    fields: modes({ thread: 'static', text: 'expr' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define',
  }),
  entry({
    type: 'jobs.create',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'job',
    config: JobsCreate,
    fields: modes({ spec: 'static', prompt: 'expr', wait: 'static' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define',
  }),
  entry({
    type: 'deploy.coolify',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'rocket',
    config: DeployCoolify,
    fields: allStatic('action', 'env', 'force'),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define.deploy',
  }),
  entry({
    type: 'deploy.pages',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'globe',
    config: DeployPages,
    fields: allStatic('target', 'branch', 'fromNode'),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define.deploy',
  }),
  entry({
    type: 'dns.change',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'dns',
    config: DnsChange,
    fields: allStatic('operation', 'target', 'record'),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define.deploy',
  }),
  entry({
    type: 'github.comment',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'github',
    config: GithubComment,
    fields: modes({ number: 'expr', body: 'expr' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define.network',
  }),
  entry({
    type: 'github.pullRequest',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'github',
    config: GithubPullRequest,
    fields: modes({ fromNode: 'static', base: 'static', title: 'expr', body: 'expr', draft: 'static' }),
    ports: fixed(IN, OUT, ERROR),
    sideEffect: true,
    requires: 'workflows.define.network',
  }),
  entry({
    type: 'uptime.check',
    category: 'integration',
    placement: 'integration',
    phase: '14.2',
    icon: 'pulse',
    config: UptimeCheck,
    fields: allStatic('kind', 'url', 'host', 'port', 'timeoutSec'),
    ports: fixed(
      IN,
      out('out', {
        type: 'object',
        properties: { up: { type: 'boolean' }, status: { type: 'integer' }, latencyMs: { type: 'integer' } },
      }),
      ERROR,
    ),
    sideEffect: false,
    requires: 'workflows.define.network',
  }),
  entry({
    type: 'http.request',
    category: 'integration',
    placement: 'worker',
    phase: '14.3',
    icon: 'http',
    config: HttpRequest,
    fields: modes({
      method: 'static',
      origin: 'static',
      path: 'expr',
      query: 'expr',
      headers: 'expr',
      body: 'expr',
      auth: 'static',
      timeoutSec: 'static',
      responseType: 'static',
      maxResponseBytes: 'static',
      followRedirects: 'static',
      successStatus: 'static',
    }),
    ports: fixed(
      IN,
      out('out', {
        type: 'object',
        properties: { status: { type: 'integer' }, headers: { type: 'object' }, body: { type: 'any' } },
        required: ['status'],
      }),
      ERROR,
    ),
    sideEffect: true,
    requires: 'workflows.define.network',
    workerFeature: 'function-v1',
    untrustedOutput: true,
    egress: { default: 'public', allowlist: 'optional' },
  }),
  entry({
    type: 'email.send',
    category: 'integration',
    placement: 'worker',
    phase: '14.3',
    icon: 'mail',
    config: EmailSend,
    fields: modes({
      smtp: 'static',
      from: 'static',
      to: 'expr',
      cc: 'expr',
      bcc: 'expr',
      replyTo: 'expr',
      subject: 'expr',
      text: 'expr',
      html: 'expr',
      maxRecipients: 'static',
    }),
    ports: fixed(
      IN,
      out('out', {
        type: 'object',
        properties: { messageId: { type: 'string' }, accepted: { type: 'array' } },
      }),
      ERROR,
    ),
    sideEffect: true,
    requires: 'workflows.define.network',
    workerFeature: 'function-v1',
    egress: { default: 'public', allowlist: 'optional' },
  }),
  // ---------------------------------------------------------------- code (K3)
  ...(['code.js', 'code.python'] as const).map((type) =>
    entry({
      type,
      category: 'code',
      placement: 'worker',
      phase: '14.3',
      icon: 'code',
      config: Code,
      fields: modes({ source: 'static', input: 'expr', timeoutSec: 'static', memoryMb: 'static' }),
      ports: fixed(IN, OUT, ERROR),
      sideEffect: false,
      requires: 'workflows.define.code',
      workerFeature: 'function-code-v1',
    }),
  ),
];

export const NODE_TYPE_NAMES: readonly string[] = NODE_TYPES.map((t) => t.type);
const BY_TYPE = new Map(NODE_TYPES.map((t) => [t.type, t]));

export function nodeType(type: string): NodeTypeSpec | undefined {
  return BY_TYPE.get(type);
}

/** Types whose executor exists in a delivery phase (inclusive). */
export function typesDeliveredBy(phase: DeliveryPhase): ReadonlySet<string> {
  return new Set(NODE_TYPES.filter((t) => t.phase <= phase).map((t) => t.type));
}

export type HttpRequestConfig = z.infer<typeof HttpRequest>;
export type EmailSendConfig = z.infer<typeof EmailSend>;
