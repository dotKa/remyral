import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p14-workflow-engine 14.5 (ADR-0055, docs/design/p14-workflow-engine.md §20): ready-made workflow templates. The
 * master lists them (graph, placeholders, the permissions their nodes need) and instantiates one into a project: the
 * placeholders (hosts, vault credential ids, addresses, schedule, runtime) are filled in, the document is validated
 * like any definition (`dryRun` only reports) and saved as version 1. Names and descriptions come from the i18n
 * catalog (`workflowTemplates.items[id]`), never from the master.
 */

export type TemplateCategory = 'marketing' | 'content' | 'video';
export type PlaceholderKind =
  | 'origin'
  | 'path'
  | 'credential'
  | 'email'
  | 'text'
  | 'cron'
  | 'smtpProvider'
  | 'runtime'
  | 'number'
  | 'choice';

export interface TemplatePlaceholder {
  readonly key: string;
  readonly kind: PlaceholderKind;
  readonly required: boolean;
  readonly default: string | null;
  readonly credentialKind: 'http-auth' | 'smtp' | null;
  /** The placeholder whose host a credential must be bound to (origin, or the SMTP provider). */
  readonly hostFrom: string | null;
  readonly options: readonly string[] | null;
  readonly min: number | null;
  readonly max: number | null;
}

export interface TemplateNode {
  readonly id: string;
  readonly type: string;
  readonly role: string | null;
  readonly parent: string | null;
}

export interface TemplateEdge {
  readonly from: string;
  readonly to: string;
  readonly fromPort: string | null;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly category: TemplateCategory;
  readonly nodes: readonly TemplateNode[];
  readonly edges: readonly TemplateEdge[];
  readonly placeholders: readonly TemplatePlaceholder[];
  readonly inputs: readonly { readonly name: string; readonly required: boolean }[];
  /** Define actions beyond `workflows.define` (network, code, deploy). */
  readonly requires: readonly string[];
  readonly workerFeatures: readonly string[];
  readonly triggers: readonly string[];
}

export interface TemplateList {
  readonly engineV2: boolean;
  readonly templates: readonly WorkflowTemplate[];
}

export interface TemplateIssue {
  readonly path: string;
  readonly code: string;
}

export interface TemplateDryRun {
  readonly valid: boolean;
  readonly issues: readonly TemplateIssue[];
  readonly definition: unknown;
  readonly privileged: readonly string[];
}

type Opts = Pick<RequestOptions, 'signal'>;

const CATEGORIES: readonly TemplateCategory[] = ['marketing', 'content', 'video'];
const KINDS: readonly PlaceholderKind[] = [
  'origin',
  'path',
  'credential',
  'email',
  'text',
  'cron',
  'smtpProvider',
  'runtime',
  'number',
  'choice',
];

/** The four runtimes (`runtime` placeholders; the master checks the value against the protocol). */
export const TEMPLATE_RUNTIMES: readonly string[] = ['claude-code', 'codex', 'pi', 'opencode'];

/**
 * The e-mail node's SMTP provider presets and their servers (mirrors `SMTP_PRESETS` of `@remyral/workflow-nodes`; the
 * master refuses any other value) — the options of an `smtpProvider` placeholder and the host its credential needs.
 */
export const SMTP_PRESET_HOSTS: Readonly<Record<string, string>> = {
  gmail: 'smtp.gmail.com',
  outlook: 'smtp-mail.outlook.com',
  office365: 'smtp.office365.com',
  sendgrid: 'smtp.sendgrid.net',
  mailgun: 'smtp.mailgun.org',
  'ses-eu-west-1': 'email-smtp.eu-west-1.amazonaws.com',
  'ses-us-east-1': 'email-smtp.us-east-1.amazonaws.com',
  postmark: 'smtp.postmarkapp.com',
  brevo: 'smtp-relay.brevo.com',
  yandex: 'smtp.yandex.com',
};

function arr(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function nullableNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number|null at ${key}`);
  return v;
}

/** Optional-or-null string (older shapes may omit a nullable field). */
function optStr(o: Record<string, unknown>, key: string): string | null {
  return o[key] === undefined ? null : nullableStr(o, key);
}

function parsePlaceholder(v: unknown): TemplatePlaceholder {
  const p = obj(v);
  const kind = str(p, 'kind');
  if (!(KINDS as readonly string[]).includes(kind)) throw new ShapeError('unexpected placeholder kind');
  const ck = optStr(p, 'credentialKind');
  if (ck !== null && ck !== 'http-auth' && ck !== 'smtp') throw new ShapeError('unexpected credential kind');
  const options = p.options === undefined || p.options === null ? null : strArray(p, 'options');
  return {
    key: str(p, 'key'),
    kind: kind as PlaceholderKind,
    required: bool(p, 'required'),
    default: optStr(p, 'default'),
    credentialKind: ck,
    hostFrom: optStr(p, 'hostFrom'),
    options,
    min: nullableNum(p, 'min'),
    max: nullableNum(p, 'max'),
  };
}

export function parseTemplate(v: unknown): WorkflowTemplate {
  const t = obj(v);
  const category = str(t, 'category');
  if (!(CATEGORIES as readonly string[]).includes(category))
    throw new ShapeError('unexpected template category');
  return {
    id: str(t, 'id'),
    category: category as TemplateCategory,
    nodes: arr(t, 'nodes').map((x) => {
      const n = obj(x);
      return { id: str(n, 'id'), type: str(n, 'type'), role: optStr(n, 'role'), parent: optStr(n, 'parent') };
    }),
    edges: arr(t, 'edges').map((x) => {
      const e = obj(x);
      return { from: str(e, 'from'), to: str(e, 'to'), fromPort: optStr(e, 'fromPort') };
    }),
    placeholders: arr(t, 'placeholders').map(parsePlaceholder),
    inputs: arr(t, 'inputs').map((x) => {
      const i = obj(x);
      return { name: str(i, 'name'), required: bool(i, 'required') };
    }),
    requires: strArray(t, 'requires'),
    workerFeatures: strArray(t, 'workerFeatures'),
    triggers: strArray(t, 'triggers'),
  };
}

export function parseTemplateList(body: unknown): TemplateList {
  const b = obj(body);
  return { engineV2: bool(b, 'engineV2'), templates: arr(b, 'templates').map(parseTemplate) };
}

function parseIssues(o: Record<string, unknown>): TemplateIssue[] {
  return arr(o, 'issues').map((x) => {
    const i = obj(x);
    return { path: str(i, 'path'), code: str(i, 'code') };
  });
}

export function parseDryRun(body: unknown): TemplateDryRun {
  const b = obj(body);
  return {
    valid: bool(b, 'valid'),
    issues: parseIssues(b),
    definition: b.definition ?? null,
    privileged: strArray(b, 'privileged'),
  };
}

export function listWorkflowTemplates(opts: Opts = {}): Promise<TemplateList> {
  return apiRequest('GET', '/workflows/templates', parseTemplateList, opts);
}

export interface InstantiateBody {
  readonly project: string;
  readonly name: string;
  readonly values: Readonly<Record<string, string>>;
  readonly locale?: 'tr' | 'en';
}

export function dryRunTemplate(id: string, body: InstantiateBody, opts: Opts = {}): Promise<TemplateDryRun> {
  return apiRequest('POST', `/workflows/templates/${encodeURIComponent(id)}/instantiate`, parseDryRun, {
    ...opts,
    body: { ...body, values: { ...body.values }, dryRun: true },
  });
}

/** p18-multi-project W4: what "Kullan" did in the other selected projects (offered + attached, or why not). */
export interface InstantiateResult {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly attached: readonly {
    readonly project: string;
    readonly attachmentId: string;
    readonly state: string;
  }[];
  readonly refused: readonly { readonly project: string; readonly code: string; readonly message: string }[];
}

export function instantiateTemplate(
  id: string,
  body: InstantiateBody & {
    /** p18-multi-project W4: also offer the new workflow to these projects and attach it there. */
    readonly attachTo?: readonly string[];
  },
  opts: Opts = {},
): Promise<InstantiateResult> {
  return apiRequest(
    'POST',
    `/workflows/templates/${encodeURIComponent(id)}/instantiate`,
    (v) => {
      const o = obj(v);
      const version = o.version;
      if (typeof version !== 'number' || !Number.isInteger(version)) throw new ShapeError('expected version');
      const list = (k: string): Record<string, unknown>[] =>
        Array.isArray(o[k]) ? (o[k] as unknown[]).map((x) => obj(x)) : [];
      return {
        id: str(o, 'id'),
        name: str(o, 'name'),
        version,
        attached: list('attached').map((a) => ({
          project: str(a, 'project'),
          attachmentId: str(a, 'attachmentId'),
          state: str(a, 'state'),
        })),
        refused: list('refused').map((r) => ({
          project: str(r, 'project'),
          code: str(r, 'code'),
          message: str(r, 'message'),
        })),
      };
    },
    { ...opts, body: { ...body, values: { ...body.values } } },
  );
}

/** The host of an origin value (`https://api.example.com:8443` → `api.example.com:8443`), or null. */
export function originHost(value: string): { host: string; port: number | null } | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { host: u.hostname.toLowerCase(), port: u.port === '' ? null : Number(u.port) };
  } catch {
    return null;
  }
}

/** Whether a host-bound credential's `allowedHosts` covers a host (`host` or `host:port`). */
export function credentialCovers(
  allowed: readonly string[] | null,
  target: { host: string; port: number | null },
): boolean {
  if (allowed === null) return false;
  return allowed.some(
    (a) => a === target.host || (target.port !== null && a === `${target.host}:${String(target.port)}`),
  );
}
