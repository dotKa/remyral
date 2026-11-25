import type { SwaggerTransform } from '@fastify/swagger';
import { scopeForAction, TOKEN_SCOPES } from '../api-tokens/scopes.js';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §10): the public OpenAPI document. The route schemas are the routes'
 * own Zod schemas (converted by `@fastify/type-provider-zod`'s transform); this module adds what is the same for every
 * operation — security (cookie session + CSRF, and bearer tokens where the route's action has a token scope),
 * `x-token-scope`, an `operationId` — documentation-only answers for routes whose body is a file or a stream, examples
 * of the main flows, and the list of routes that are not part of the public REST API.
 */

/** Routes left out of the document on purpose (not the public REST API). Exact `METHOD /url` or a URL prefix. */
export const OPENAPI_HIDDEN_PREFIXES: readonly string[] = [
  // The worker socket, signed downloads, installer kits and lease keys: device / installer protocol (ADR-0005).
  '/v1/worker',
  // Inbound webhooks (signature-authenticated by GitHub / automations), not called by API clients.
  '/v1/hooks/',
  // OIDC provider and the Coolify forward-auth gate (protocol endpoints of p5-coolify-sso).
  '/oidc/',
  '/forward-auth/',
  '/coolify-sso/ticket',
  '/coolify-sso/callback',
  // p17-object-storage: time-limited share links opened by anyone holding one (a download, not the REST API).
  '/share/f/',
  // p19-ide W2: the IDE origin (ide.<domain>) — the ticket entry and the proxied VS Code workbench, not the REST API.
  '/_ide/',
  '/w/',
];
export const OPENAPI_HIDDEN_ROUTES: ReadonlySet<string> = new Set([
  // The document itself.
  'GET /openapi.json',
  // An HTML form the browser posts to GitHub (App manifest flow), not JSON.
  'GET /integrations/github/manifest/form',
]);

export function hiddenFromOpenApi(method: string, url: string): boolean {
  if (method === 'HEAD') return true;
  if (OPENAPI_HIDDEN_ROUTES.has(`${method} ${url}`)) return true;
  return OPENAPI_HIDDEN_PREFIXES.some((p) => url === p || url.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** The tag list with descriptions (order = the docs page's order). */
export const OPENAPI_TAGS: readonly { name: string; description: string }[] = [
  {
    name: 'jobs',
    description: 'Create, list, read, cancel and steer agent jobs; their changes, files and exports.',
  },
  { name: 'workflows', description: 'Workflow definitions, runs and approval gates.' },
  { name: 'approvals', description: 'Approval requests of running jobs and their decisions.' },
  {
    name: 'deploy',
    description: 'Deploy targets, ops actions (deploys, Pages, DNS), deploy health and Coolify apps.',
  },
  { name: 'projects', description: 'Projects, members, repository and workspace settings.' },
  { name: 'automations', description: 'Cron, webhook, GitHub and chained automations.' },
  { name: 'schedules', description: 'Scheduled job submissions and workflow runs.' },
  { name: 'templates', description: 'Parameterised job templates.' },
  { name: 'outputs', description: 'Live sites, job output files, notes and folders.' },
  { name: 'workfiles', description: 'Kept working directories of workspace jobs.' },
  { name: 'code', description: 'Code viewer, diff review and review comments (p19-ide W1).' },
  { name: 'services', description: 'Long-running services machines keep for a project.' },
  {
    name: 'ide',
    description: 'Tam IDE: openvscode-server workspaces on Linux machines, opened on the IDE origin.',
  },
  { name: 'previews', description: 'Preview links of running jobs.' },
  { name: 'uptime', description: 'Monitors of deployed sites and services.' },
  { name: 'context', description: 'Context documents, memory, search and retention.' },
  { name: 'usage', description: 'Usage summaries, records and the price table.' },
  { name: 'budgets', description: 'Budgets and overrides.' },
  { name: 'quotas', description: 'Quota enforcement, usage-limit windows and the kill switch.' },
  { name: 'reports', description: 'Cost and efficiency reports.' },
  { name: 'workers', description: 'Machines (workers): state, approval, draining, updates.' },
  { name: 'fleet', description: 'Fleet-wide tools and runtime versions.' },
  { name: 'worker-config', description: 'Panel-managed machine configuration.' },
  { name: 'remote-ops', description: 'Remote operations on machines: runtimes, logins, logs, diagnostics.' },
  { name: 'runtime-policy', description: 'Runtime policies: versions, canaries, rollouts.' },
  { name: 'runtime-accounts', description: 'Runtime accounts per machine.' },
  { name: 'models', description: 'Model profiles and defaults.' },
  { name: 'releases', description: 'Signed worker releases and channels.' },
  { name: 'installers', description: 'Installer kits for adding a machine.' },
  { name: 'skills', description: 'Signed skills and their assignments.' },
  { name: 'mcp', description: 'External MCP servers for jobs.' },
  { name: 'vault', description: 'Credential vault metadata (values are sealed in the browser).' },
  { name: 'integrations', description: 'GitHub, Coolify, Cloudflare and Bedrock connections.' },
  {
    name: 'webhooks',
    description:
      'Outgoing webhooks: subscriptions, the event catalog, delivery log, redelivery and secret rotation (the payloads are in `webhooks`).',
  },
  {
    name: 'doctor',
    description:
      'Diagnostics (doctor) of the master and the machines, and the redacted support report (preview, download, e-mail).',
  },
  { name: 'integration', description: 'Merge pipeline and integration queue.' },
  { name: 'git', description: 'Git identity and central git settings.' },
  { name: 'audit', description: 'The audit log: search, verify, export.' },
  { name: 'backups', description: 'Backup and restore-drill status.' },
  { name: 'system', description: 'System status, recent traces and the master log search (read-only).' },
  { name: 'security', description: 'The security policy.' },
  {
    name: 'api-tokens',
    description: 'Personal API tokens and service accounts (console only; never with a token).',
  },
  { name: 'users', description: 'User accounts (owner).' },
  { name: 'auth', description: 'Sign-in, session, step-up, devices (browser only).' },
  { name: 'notifications', description: 'In-app notifications, preferences and push (browser only).' },
  { name: 'chat', description: 'The ops chat (browser only).' },
  { name: 'ops-thread', description: 'The home thread of the console (browser only).' },
  { name: 'interactive', description: 'Retired interactive sessions (410 Gone).' },
  { name: 'settings', description: 'Workspace settings.' },
  { name: 'sso', description: 'Coolify single sign-on (browser only).' },
  { name: 'health', description: 'Health and status probes.' },
];

type Media = Record<string, { schema: Record<string, unknown> }>;
const binary = (type: string, description: string): { description: string; content: Media } => ({
  description,
  content: { [type]: { schema: { type: 'string', format: 'binary' } } },
});
const text = (type: string, description: string): { description: string; content: Media } => ({
  description,
  content: { [type]: { schema: { type: 'string' } } },
});
const gone = {
  description: 'Retired (ADR-0023).',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        },
        required: ['error', 'message'],
      },
    },
  },
};

/**
 * Answers of routes that send a file, CSV, JSON Lines or an event stream (a Zod response schema would make Fastify
 * serialize them as JSON): documented here only, keyed `METHOD /url`.
 */
export const DOC_ONLY_RESPONSES: Readonly<Record<string, Record<string, unknown>>> = {
  'GET /audit/export': {
    200: text('application/x-ndjson', 'Audit events as JSON Lines (or CSV with format=csv).'),
  },
  'GET /context/export': {
    200: text('application/x-ndjson', 'The project context as JSON Lines with a manifest.'),
  },
  'GET /jobs/:id/export': { 200: text('application/x-ndjson', 'The task record as JSON Lines (or CSV).') },
  'GET /installers/:version/:os/kit': {
    200: binary('application/octet-stream', 'A signed installer kit (zip / tar.gz).'),
  },
  'GET /usage/export/breakdown.csv': { 200: text('text/csv', 'Usage breakdown as CSV.') },
  'GET /usage/export/jobs.csv': { 200: text('text/csv', 'Usage per job as CSV.') },
  'GET /jobs/:id/artifacts/:artifactId': { 200: binary('application/octet-stream', 'The artifact file.') },
  'GET /jobs/:id/artifacts/all.zip': {
    200: binary(
      'application/zip',
      'Every file of the latest attempt as one zip, the overflow zip unpacked in place (p17-output-limits, p18-outputs-delivery).',
    ),
  },
  'GET /jobs/:id/inputs/:inputId': { 200: binary('application/octet-stream', 'The input file.') },
  // p17-object-storage: a 302 to a short-lived presigned GET (object storage) or the file itself (local disk).
  'GET /jobs/:id/artifacts/:artifactId/download': {
    200: binary('application/octet-stream', 'The output file (local disk).'),
    302: { description: 'Redirect to a short-lived presigned download link of the object storage.' },
  },
  'GET /jobs/:id/workfiles/file': {
    200: binary('application/octet-stream', 'One file of the kept working directory.'),
  },
  'GET /jobs/:id/workfiles/zip': { 200: binary('application/zip', 'The kept working directory as a zip.') },
  'POST /outputs/zip': { 200: binary('application/zip', 'The chosen output files as a zip.') },
  // p16-doctor: the redacted support bundle.
  'GET /support/reports/:id/download': {
    200: binary('application/zip', 'The redacted support report bundle.'),
  },
  'GET /jobs/:id/site-bundle/file': {
    200: binary('application/octet-stream', 'One file of the job’s site bundle.'),
  },
  'GET /jobs/:id/stream': {
    200: text('text/event-stream', 'Server-sent events of the job (browser session only).'),
  },
  'GET /chat/threads/:id/stream': {
    200: text('text/event-stream', 'Server-sent events of the thread (browser only).'),
  },
  'GET /chat/attachments/:id/content': {
    200: binary('application/octet-stream', 'The attachment (browser only).'),
  },
  'GET /interactive/sessions': { 410: gone },
  'GET /interactive/config': { 410: gone },
  'POST /interactive/sessions': { 410: gone },
  'GET /coolify-sso/config': {
    200: {
      description: 'Whether Coolify single sign-on is available, its launch URL and the connections to open.',
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        url: { type: ['string', 'null'] },
        connections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              isDefault: { type: 'boolean' },
              sso: { type: 'boolean' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

const JOB_ID = '6f1c2a4e-8b3d-4f7a-9c21-0d5e7b9a1c3f';

/** Examples of the main flows (request body and/or answer), keyed `METHOD /url`. */
export const OPENAPI_EXAMPLES: Readonly<
  Record<string, { readonly request?: Record<string, unknown>; readonly response?: Record<string, unknown> }>
> = {
  'POST /jobs': {
    request: {
      fixBug: {
        summary: 'Create a job in a repository project',
        value: {
          project: 'web-shop',
          spec: {
            runtime: 'claude-code',
            title: 'Fix the checkout total rounding',
            prompt:
              'The cart total is off by one cent for 3 items at 0.10 €. Fix the rounding and add a test.',
            repository: {
              url: 'https://github.com/acme/web-shop.git',
              baseRef: 'main',
              workBranch: 'fix/rounding',
            },
            sandboxProfile: 'container',
            sourceTrust: 'trusted',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
          priorityClass: 'normal',
        },
      },
    },
  },
  'GET /jobs/:id': {
    response: {
      running: {
        summary: 'A running job (abridged)',
        value: {
          job: { id: JOB_ID, project: 'web-shop', state: 'RUNNING', runtime: 'claude-code' },
          transitions: [
            { from: 'QUEUED', to: 'RESERVED', at: '2026-10-23T09:00:02.000Z' },
            { from: 'RESERVED', to: 'RUNNING', at: '2026-10-23T09:00:09.000Z' },
          ],
        },
      },
    },
  },
  'GET /jobs': {
    response: {
      page: {
        summary: 'First page of running jobs (?state=RUNNING&limit=2)',
        value: {
          items: [{ id: JOB_ID, project: 'web-shop', state: 'RUNNING', runtime: 'claude-code' }],
          nextCursor: null,
        },
      },
    },
  },
  'POST /jobs/:id/cancel': {
    request: { cancel: { summary: 'Cancel with a reason', value: { reason: 'Superseded by a newer fix' } } },
  },
  'POST /workflows/:id/runs': {
    request: {
      run: {
        summary: 'Run a workflow with its inputs',
        value: { inputs: { branch: 'main', environment: 'preview' } },
      },
    },
    response: {
      started: { summary: 'The run id', value: { runId: '0b8f4c3e-2a71-4d2b-8e8e-5a1f9e3c7d20' } },
    },
  },
  'GET /deploy/actions/:id': {
    response: {
      succeeded: {
        summary: 'A finished Coolify deploy (abridged)',
        value: {
          id: '3d2a7f10-5c8e-4b9a-a1d2-7e6f5c4b3a21',
          project: 'web-shop',
          kind: 'coolify.deploy',
          env: 'production',
          state: 'succeeded',
        },
      },
    },
  },
};

/** `operationId`: method + path words in camelCase (`POST /jobs/:id/cancel` → `postJobsIdCancel`). */
export function operationIdFor(method: string, url: string): string {
  const words = url
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return `${method.toLowerCase()}${words.join('')}`;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

interface RouteLike {
  readonly method: string | string[];
  readonly url: string;
  readonly config?: { auth?: string; authz?: { action?: string }; rateClass?: string };
}

/**
 * The swagger transform: the Zod conversion (`base`), then hidden routes, security, token scope, operation id,
 * documentation-only answers and examples.
 */
export function openApiTransform(base: SwaggerTransform): SwaggerTransform {
  return (doc) => {
    const route = doc.route as unknown as RouteLike;
    const method = (Array.isArray(route.method) ? route.method[0] : route.method) ?? 'GET';
    const url = doc.url;
    if (hiddenFromOpenApi(method, route.url)) return { schema: { hide: true }, url };
    const out = base(doc);
    const schema = { ...(out.schema as Record<string, unknown>) };
    if (schema.hide === true) return out;
    const key = `${method} ${route.url}`;
    const auth = route.config?.auth ?? 'full';
    const action = route.config?.authz?.action;
    const scope = auth === 'full' && route.config?.rateClass !== 'stream' ? scopeForAction(action) : null;
    if (auth === 'public') schema.security = [];
    else if (auth !== 'full') schema.security = [{ session: [] }];
    else {
      const cookie = SAFE.has(method) ? { session: [] } : { session: [], csrf: [] };
      schema.security = scope === null ? [cookie] : [cookie, { bearerAuth: [] }];
    }
    schema['x-token-scope'] = scope ?? 'none';
    schema.operationId = operationIdFor(method, route.url);
    const docOnly = DOC_ONLY_RESPONSES[key];
    if (docOnly !== undefined) {
      const current = schema.response as Record<string, unknown> | undefined;
      schema.response = { ...(current ?? {}), ...docOnly };
    }
    const ex = OPENAPI_EXAMPLES[key];
    if (ex?.request !== undefined && schema.body !== undefined) {
      schema.body = { ...(schema.body as Record<string, unknown>), 'x-examples': ex.request };
    }
    if (ex?.response !== undefined && schema.response !== undefined) {
      const responses = { ...(schema.response as Record<string, Record<string, unknown>>) };
      const ok = Object.keys(responses).find((s) => /^2\d\d$/.test(s));
      if (ok !== undefined) responses[ok] = { ...responses[ok], 'x-examples': ex.response };
      schema.response = responses;
    }
    return { schema, url: out.url };
  };
}

/** Security schemes of the document. */
export const OPENAPI_SECURITY_SCHEMES = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'ryl_pat_… / ryl_sa_…',
    description: `An API token (Ayarlar → API anahtarları / Servis hesapları). A token reaches an operation when the operation's x-token-scope is one of its scopes (${TOKEN_SCOPES.join(', ')}) and its account's role allows it; x-token-scope "none" = console only. No CSRF header with a token. Actions that ask for an authenticator code under the security policy are refused for tokens (403 token_step_up_refused).`,
  },
  session: {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-ras',
    description: 'Console session (password + TOTP).',
  },
  csrf: {
    type: 'apiKey',
    in: 'header',
    name: 'x-csrf-token',
    description: 'Double-submit CSRF token of a console session (state-changing requests with a cookie).',
  },
} as const;
