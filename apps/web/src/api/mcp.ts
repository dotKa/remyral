import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';
import type { FleetAction } from './fleetTools';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2, §5.2): typed wrappers for the MCP catalog routes
 * (apps/master/src/mcp). Server text (titles, descriptions, tool descriptions) is untrusted and rendered as text.
 */

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpEffect = 'allow' | 'ask' | 'deny';
export const MCP_EFFECTS: readonly McpEffect[] = ['allow', 'ask', 'deny'];
/** Assignment / policy project meaning "every project". */
export const MCP_ALL_PROJECTS = '*';

export interface McpServerSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly archived: boolean;
  readonly latest: string | null;
  readonly transport: McpTransport | null;
  readonly url: string | null;
  readonly runtimes: readonly string[];
  readonly toolCounts: { readonly allow: number; readonly ask: number; readonly deny: number };
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

export interface McpVersion {
  readonly version: string;
  readonly transport: McpTransport;
  readonly url: string | null;
  readonly headers: readonly McpHeaderView[];
  readonly secretSlots: readonly { readonly slot: string; readonly why: string }[];
  readonly egressHosts: readonly string[];
  readonly runtimes: readonly string[];
  readonly limits: { readonly startupTimeoutSec: number; readonly toolTimeoutSec: number };
  readonly signer: 'offline' | 'panel';
  readonly keyId: string;
  readonly specSha256: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  /** p14-mcp-stdio: the package of a local (stdio) version; null for remote servers. */
  readonly package: McpPackageView | null;
}

export type McpPackageManager = 'npm' | 'pypi';

export interface McpPackageView {
  readonly manager: McpPackageManager;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: readonly McpHeaderView[];
}

export type McpInstallState = 'queued' | 'installing' | 'installed' | 'failed' | 'removed';

/** One machine's install of one version (p14-mcp-stdio). */
export interface McpInstall {
  readonly workerId: string;
  readonly name: string;
  readonly version: string;
  readonly state: McpInstallState;
  readonly digest: string | null;
  readonly error: string | null;
  readonly updatedAt: string;
  readonly connected: boolean;
}

/** The canary's lockfile of one version (every other machine installs exactly this). */
export interface McpLockfileView {
  readonly version: string;
  readonly manager: McpPackageManager;
  readonly sha256: string;
  readonly bytes: number;
  readonly producedOnWorker: string;
  readonly createdAt: string;
}

/** A fleet-tools bulk action of kind `mcp.install` / `mcp.remove` (same target state machine). */
export type McpInstallAction = Omit<FleetAction, 'kind'> & { readonly kind: 'mcp.install' | 'mcp.remove' };

/** An approved machine with `mcp-stdio-v1` (install / probe picker for stdio servers). */
export interface McpStdioWorker {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  readonly canary: boolean;
  readonly os: string;
  readonly arch: string;
}

export interface McpTool {
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly schemaSha256: string;
  readonly readOnlyHint: boolean | null;
  readonly suggestedAllow: boolean;
  readonly effect: McpEffect;
  readonly probedOnWorker: string;
  readonly probedAt: string;
}

export interface McpRule {
  readonly tool: string;
  readonly effect: McpEffect;
}

export interface McpPolicySet {
  readonly project: string;
  readonly rules: readonly McpRule[];
  readonly updatedAt: string | null;
}

export interface McpBinding {
  readonly project: string;
  readonly slot: string;
  /** Empty for viewers without `mcp.manage` (they get the name). */
  readonly credentialId: string;
  readonly credentialName: string | null;
  readonly updatedAt: string;
}

export interface McpAssignment {
  readonly id: string;
  readonly serverId: string;
  readonly project: string;
  readonly runtimes: readonly string[] | null;
  readonly version: string | null;
  readonly createdAt: string;
}

export interface McpProbe {
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
  readonly versions: readonly McpVersion[];
  readonly tools: readonly McpTool[];
  readonly policies: readonly McpPolicySet[];
  readonly secrets: readonly McpBinding[];
  readonly assignments: readonly McpAssignment[];
  readonly probes: readonly McpProbe[];
  readonly installs: readonly McpInstall[];
  readonly lockfiles: readonly McpLockfileView[];
  readonly installActions: readonly McpInstallAction[];
  readonly stdioWorkers: readonly McpStdioWorker[];
}

/** A machine a probe can run on (optional in the list response; the web falls back to the fleet list). */
export interface McpWorker {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
}

export interface McpServerList {
  readonly servers: readonly McpServerSummary[];
  readonly workersWithMcp: number;
  readonly mcpWorkers: readonly McpWorker[] | null;
}

type Opts = Omit<RequestOptions, 'body'>;

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ShapeError(`expected ${what}[]`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function transport(v: unknown): McpTransport {
  if (v === 'http' || v === 'sse' || v === 'stdio') return v;
  throw new ShapeError('expected transport');
}

function effect(v: unknown): McpEffect {
  if (v === 'allow' || v === 'ask' || v === 'deny') return v;
  throw new ShapeError('expected effect');
}

function optStrArray(o: Record<string, unknown>, key: string): string[] | null {
  return o[key] === null || o[key] === undefined ? null : strArray(o, key);
}

export function parseMcpSummary(v: unknown): McpServerSummary {
  const o = obj(v);
  const c = obj(o.toolCounts);
  return {
    id: str(o, 'id'),
    title: str(o, 'title'),
    description: typeof o.description === 'string' ? o.description : '',
    archived: bool(o, 'archived'),
    latest: nullableStr(o, 'latest'),
    transport: o.transport === null ? null : transport(o.transport),
    url: nullableStr(o, 'url'),
    runtimes: strArray(o, 'runtimes'),
    toolCounts: { allow: int(c, 'allow'), ask: int(c, 'ask'), deny: int(c, 'deny') },
    toolsKnown: int(o, 'toolsKnown'),
    assignments: int(o, 'assignments'),
    createdAt: str(o, 'createdAt'),
  };
}

function parseVersion(v: unknown): McpVersion {
  const o = obj(v);
  const l = obj(o.limits);
  return {
    version: str(o, 'version'),
    transport: transport(o.transport),
    url: nullableStr(o, 'url'),
    headers: arr(o.headers, 'headers').map(parseHeaderView),
    secretSlots: arr(o.secretSlots, 'secretSlots').map((s) => {
      const x = obj(s);
      return { slot: str(x, 'slot'), why: str(x, 'why') };
    }),
    egressHosts: strArray(o, 'egressHosts'),
    runtimes: strArray(o, 'runtimes'),
    limits: { startupTimeoutSec: int(l, 'startupTimeoutSec'), toolTimeoutSec: int(l, 'toolTimeoutSec') },
    signer: o.signer === 'offline' ? 'offline' : 'panel',
    keyId: str(o, 'keyId'),
    specSha256: str(o, 'specSha256'),
    createdAt: str(o, 'createdAt'),
    createdBy: o.createdBy === undefined ? null : nullableStr(o, 'createdBy'),
    package: o.package === undefined || o.package === null ? null : parsePackage(o.package),
  };
}

function parseHeaderView(h: unknown): McpHeaderView {
  const x = obj(h);
  return {
    name: str(x, 'name'),
    value: nullableStr(x, 'value'),
    secret: nullableStr(x, 'secret'),
    format: nullableStr(x, 'format'),
  };
}

function manager(v: unknown): McpPackageManager {
  if (v === 'npm' || v === 'pypi') return v;
  throw new ShapeError('expected package manager');
}

function parsePackage(v: unknown): McpPackageView {
  const o = obj(v);
  return {
    manager: manager(o.manager),
    name: str(o, 'name'),
    version: str(o, 'version'),
    integrity: str(o, 'integrity'),
    bin: str(o, 'bin'),
    args: Array.isArray(o.args) ? strArray(o, 'args') : [],
    env: Array.isArray(o.env) ? o.env.map(parseHeaderView) : [],
  };
}

const INSTALL_STATES: readonly McpInstallState[] = ['queued', 'installing', 'installed', 'failed', 'removed'];

function parseInstall(v: unknown): McpInstall {
  const o = obj(v);
  const st = INSTALL_STATES.find((x) => x === o.state);
  if (st === undefined) throw new ShapeError('expected install state');
  return {
    workerId: str(o, 'workerId'),
    name: typeof o.name === 'string' ? o.name : str(o, 'workerId'),
    version: str(o, 'version'),
    state: st,
    digest: o.digest === undefined ? null : nullableStr(o, 'digest'),
    error: o.error === undefined ? null : nullableStr(o, 'error'),
    updatedAt: str(o, 'updatedAt'),
    connected: o.connected === true,
  };
}

function parseLockfile(v: unknown): McpLockfileView {
  const o = obj(v);
  return {
    version: str(o, 'version'),
    manager: manager(o.manager),
    sha256: str(o, 'sha256'),
    bytes: int(o, 'bytes'),
    producedOnWorker: str(o, 'producedOnWorker'),
    createdAt: str(o, 'createdAt'),
  };
}

function parseAction(v: unknown): McpInstallAction {
  const o = obj(v);
  if (typeof o.id !== 'string' || !Array.isArray(o.targets)) throw new ShapeError('expected install action');
  if (o.kind !== 'mcp.install' && o.kind !== 'mcp.remove') throw new ShapeError('expected mcp action kind');
  return o as unknown as McpInstallAction;
}

function parseStdioWorker(v: unknown): McpStdioWorker {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    name: typeof o.name === 'string' ? o.name : str(o, 'id'),
    connected: o.connected === true,
    canary: o.canary === true,
    os: typeof o.os === 'string' ? o.os : '',
    arch: typeof o.arch === 'string' ? o.arch : '',
  };
}

/** Optional arrays of the P4 detail (an older master leaves them out). */
function optArr<T>(v: unknown, parse: (x: unknown) => T): T[] {
  return Array.isArray(v) ? v.map(parse) : [];
}

function parseTool(v: unknown): McpTool {
  const o = obj(v);
  return {
    version: str(o, 'version'),
    name: str(o, 'name'),
    description: typeof o.description === 'string' ? o.description : '',
    schemaSha256: str(o, 'schemaSha256'),
    readOnlyHint: typeof o.readOnlyHint === 'boolean' ? o.readOnlyHint : null,
    suggestedAllow: o.suggestedAllow === true,
    effect: effect(o.effect),
    probedOnWorker: str(o, 'probedOnWorker'),
    probedAt: str(o, 'probedAt'),
  };
}

function parsePolicy(v: unknown): McpPolicySet {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    rules: arr(o.rules, 'rules').map((r) => {
      const x = obj(r);
      return { tool: str(x, 'tool'), effect: effect(x.effect) };
    }),
    updatedAt: o.updatedAt === undefined ? null : nullableStr(o, 'updatedAt'),
  };
}

function parseBinding(v: unknown): McpBinding {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    slot: str(o, 'slot'),
    credentialId: str(o, 'credentialId'),
    credentialName: o.credentialName === undefined ? null : nullableStr(o, 'credentialName'),
    updatedAt: str(o, 'updatedAt'),
  };
}

export function parseMcpAssignment(v: unknown): McpAssignment {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    serverId: str(o, 'serverId'),
    project: str(o, 'project'),
    runtimes: optStrArray(o, 'runtimes'),
    version: o.version === undefined ? null : nullableStr(o, 'version'),
    createdAt: str(o, 'createdAt'),
  };
}

function parseProbe(v: unknown): McpProbe {
  const o = obj(v);
  const s = o.state;
  return {
    opId: str(o, 'opId'),
    workerId: str(o, 'workerId'),
    version: str(o, 'version'),
    state: s === 'running' || s === 'succeeded' || s === 'failed' ? s : 'pending',
    error: o.error === undefined ? null : nullableStr(o, 'error'),
    toolCount: typeof o.toolCount === 'number' ? o.toolCount : null,
    at: str(o, 'at'),
  };
}

export function listMcpServers(opts: Opts = {}): Promise<McpServerList> {
  return apiRequest(
    'GET',
    '/mcp/servers',
    (v) => {
      const o = obj(v);
      const f = typeof o.features === 'object' && o.features !== null ? obj(o.features) : {};
      return {
        servers: arr(o.servers, 'servers').map(parseMcpSummary),
        workersWithMcp: typeof f.workersWithMcp === 'number' ? f.workersWithMcp : 0,
        mcpWorkers: Array.isArray(o.mcpWorkers)
          ? o.mcpWorkers.map((w) => {
              const x = obj(w);
              return { id: str(x, 'id'), name: str(x, 'name'), connected: x.connected === true };
            })
          : null,
      };
    },
    opts,
  );
}

export function getMcpServer(id: string, opts: Opts = {}): Promise<McpServerDetail> {
  return apiRequest(
    'GET',
    `/mcp/servers/${encodeURIComponent(id)}`,
    (v) => {
      const o = obj(v);
      return {
        server: parseMcpSummary(o.server),
        versions: arr(o.versions, 'versions').map(parseVersion),
        tools: arr(o.tools, 'tools').map(parseTool),
        policies: arr(o.policies, 'policies').map(parsePolicy),
        secrets: arr(o.secrets, 'secrets').map(parseBinding),
        assignments: arr(o.assignments, 'assignments').map(parseMcpAssignment),
        probes: arr(o.probes, 'probes').map(parseProbe),
        installs: optArr(o.installs, parseInstall),
        lockfiles: optArr(o.lockfiles, parseLockfile),
        installActions: optArr(o.installActions, parseAction),
        stdioWorkers: optArr(o.stdioWorkers, parseStdioWorker),
      };
    },
    opts,
  );
}

export type McpHeaderInput = string | { readonly secret: string; readonly format?: string };

export interface McpPublishInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly version: string;
  readonly transport: 'http' | 'sse' | 'stdio';
  /** Remote servers only (absent for `stdio`). */
  readonly url?: string;
  readonly headers?: Readonly<Record<string, McpHeaderInput>>;
  /** p14-mcp-stdio: the package of a local server (only with `transport: 'stdio'`). */
  readonly package?: McpPackageInput;
  readonly secrets?: readonly { readonly slot: string; readonly why: string }[];
  readonly egressHosts?: readonly string[];
  readonly runtimes: readonly string[];
  readonly limits?: { readonly startupTimeoutSec?: number; readonly toolTimeoutSec?: number };
}

export function publishMcpServer(
  input: McpPublishInput,
  opts: Opts = {},
): Promise<{ server: McpServerSummary; version: McpVersion }> {
  return apiRequest(
    'POST',
    '/mcp/servers',
    (v) => {
      const o = obj(v);
      return { server: parseMcpSummary(o.server), version: parseVersion(o.version) };
    },
    { ...opts, body: input },
  );
}

export interface McpPackageInput {
  readonly manager: McpPackageManager;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bin: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, McpHeaderInput>>;
}

export interface McpPackageLookup {
  readonly manager: McpPackageManager;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly bins: readonly string[];
  readonly file: string | null;
  readonly license: string | null;
  readonly description: string | null;
}

/** p14-mcp-stdio: the registry's integrity and bin names of an exact package version (read by the master). */
export function lookupMcpPackage(
  input: { readonly manager: McpPackageManager; readonly name: string; readonly version: string },
  opts: Opts = {},
): Promise<McpPackageLookup> {
  return apiRequest(
    'POST',
    '/mcp/packages/lookup',
    (v) => {
      const o = obj(v);
      return {
        manager: manager(o.manager),
        name: str(o, 'name'),
        version: str(o, 'version'),
        integrity: str(o, 'integrity'),
        bins: Array.isArray(o.bins) ? strArray(o, 'bins') : [],
        file: o.file === undefined ? null : nullableStr(o, 'file'),
        license: o.license === undefined ? null : nullableStr(o, 'license'),
        description: o.description === undefined ? null : nullableStr(o, 'description'),
      };
    },
    { ...opts, body: input },
  );
}

function versionPath(id: string, version: string, verb: string): string {
  return `/mcp/servers/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/${verb}`;
}

/** Installs a stdio version on machines (canary first; always-fresh step-up). */
export function installMcpVersion(
  id: string,
  version: string,
  input: { readonly workers: readonly string[] | 'all'; readonly rollout?: 'canary-first' | 'all' },
  opts: Opts = {},
): Promise<McpInstallAction> {
  return apiRequest('POST', versionPath(id, version, 'install'), parseAction, { ...opts, body: input });
}

/** Removes a stdio version from machines (standard step-up). */
export function removeMcpVersion(
  id: string,
  version: string,
  workers: readonly string[] | 'all',
  opts: Opts = {},
): Promise<McpInstallAction> {
  return apiRequest('POST', versionPath(id, version, 'remove'), parseAction, { ...opts, body: { workers } });
}

/** Canary succeeded: install on the held machines (always-fresh step-up). */
export function continueMcpInstall(actionId: string, opts: Opts = {}): Promise<McpInstallAction> {
  return apiRequest('POST', `/mcp/install-actions/${encodeURIComponent(actionId)}/continue`, parseAction, {
    ...opts,
    body: {},
  });
}

export function retryMcpInstall(
  actionId: string,
  workers?: readonly string[],
  opts: Opts = {},
): Promise<McpInstallAction> {
  return apiRequest('POST', `/mcp/install-actions/${encodeURIComponent(actionId)}/retry`, parseAction, {
    ...opts,
    body: workers === undefined ? {} : { workers },
  });
}

export function archiveMcpServer(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/mcp/servers/${encodeURIComponent(id)}`, () => undefined, opts);
}

export function bindMcpSecrets(
  id: string,
  project: string,
  bindings: readonly { readonly slot: string; readonly credentialId: string }[],
  opts: Opts = {},
): Promise<McpBinding[]> {
  return apiRequest(
    'PUT',
    `/mcp/servers/${encodeURIComponent(id)}/secrets`,
    (v) => arr(obj(v).secrets, 'secrets').map(parseBinding),
    { ...opts, body: { project, bindings } },
  );
}

export function saveMcpToolPolicy(
  id: string,
  project: string,
  rules: readonly McpRule[],
  opts: Opts = {},
): Promise<McpPolicySet[]> {
  return apiRequest(
    'PUT',
    `/mcp/servers/${encodeURIComponent(id)}/tool-policy`,
    (v) => arr(obj(v).policies, 'policies').map(parsePolicy),
    { ...opts, body: { project, rules } },
  );
}

export function probeMcpServer(
  id: string,
  version: string,
  workerId: string,
  opts: Opts = {},
): Promise<{ opId: string }> {
  return apiRequest(
    'POST',
    `/mcp/servers/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/probe`,
    (v) => ({ opId: str(obj(v), 'opId') }),
    { ...opts, body: { workerId } },
  );
}

export function assignMcpServer(
  input: {
    readonly serverId: string;
    readonly project: string;
    readonly runtimes: readonly string[] | null;
    readonly version: string | null;
  },
  opts: Opts = {},
): Promise<McpAssignment> {
  return apiRequest('PUT', '/mcp/assignments', (v) => parseMcpAssignment(obj(v).assignment), {
    ...opts,
    body: input,
  });
}

export function unassignMcpServer(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/mcp/assignments/${encodeURIComponent(id)}`, () => undefined, opts);
}

export interface ProjectMcp {
  readonly allowed: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly assignments: readonly (McpAssignment & { readonly title: string })[];
}

function parseProjectMcp(v: unknown): ProjectMcp {
  const o = obj(v);
  return {
    allowed: bool(o, 'allowed'),
    updatedAt: o.updatedAt === undefined ? null : nullableStr(o, 'updatedAt'),
    updatedBy: o.updatedBy === undefined ? null : nullableStr(o, 'updatedBy'),
    assignments: arr(o.assignments, 'assignments').map((a) => ({
      ...parseMcpAssignment(a),
      title: typeof obj(a).title === 'string' ? (obj(a).title as string) : str(obj(a), 'serverId'),
    })),
  };
}

export function getProjectMcp(project: string, opts: Opts = {}): Promise<ProjectMcp> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/mcp`, parseProjectMcp, opts);
}

export function setProjectMcp(project: string, allowed: boolean, opts: Opts = {}): Promise<ProjectMcp> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/mcp`, parseProjectMcp, {
    ...opts,
    body: { allowed },
  });
}

export interface JobMcpServer {
  readonly id: string;
  readonly version: string;
  readonly specSha256: string;
  readonly policySha256: string;
  readonly transport: McpTransport;
  readonly url: string | null;
  readonly egressHosts: readonly string[];
}

export interface JobMcpCall {
  readonly attemptId: string;
  readonly seq: number;
  readonly server: string;
  readonly tool: string;
  readonly decision: McpEffect;
  readonly outcome: 'ok' | 'error' | 'timeout' | 'denied';
  readonly durationMs: number;
  readonly argsBytes: number;
  readonly resultBytes: number;
  readonly at: string;
}

export interface JobMcp {
  readonly setHash: string | null;
  readonly skipped: string | null;
  readonly servers: readonly JobMcpServer[];
  readonly calls: readonly JobMcpCall[];
}

export function getJobMcp(jobId: string, opts: Opts = {}): Promise<JobMcp> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/mcp`,
    (v) => {
      const o = obj(v);
      return {
        setHash: nullableStr(o, 'setHash'),
        skipped: o.skipped === undefined ? null : nullableStr(o, 'skipped'),
        servers: arr(o.servers, 'servers').map((s) => {
          const x = obj(s);
          return {
            id: str(x, 'id'),
            version: str(x, 'version'),
            specSha256: str(x, 'specSha256'),
            policySha256: str(x, 'policySha256'),
            transport: transport(x.transport),
            url: nullableStr(x, 'url'),
            egressHosts: strArray(x, 'egressHosts'),
          };
        }),
        calls: arr(o.calls, 'calls').map((c) => {
          const x = obj(c);
          const out = x.outcome;
          return {
            attemptId: str(x, 'attemptId'),
            seq: int(x, 'seq'),
            server: str(x, 'server'),
            tool: str(x, 'tool'),
            decision: effect(x.decision),
            outcome: out === 'error' || out === 'timeout' || out === 'denied' ? out : 'ok',
            durationMs: int(x, 'durationMs'),
            argsBytes: int(x, 'argsBytes'),
            resultBytes: int(x, 'resultBytes'),
            at: str(x, 'at'),
          };
        }),
      };
    },
    opts,
  );
}

// ------------------------------------------------------------------------------- client-side checks (mirror protocol)

/** `^[a-z][a-z0-9-]{1,31}$`, not reserved for platform tools. */
export const MCP_SERVER_ID = /^[a-z][a-z0-9-]{1,31}$/;
export function mcpIdReserved(id: string): boolean {
  return /^(remyral|subtask)/.test(id) || id === 'admin' || id === 'preview' || id === 'deploy';
}
export const MCP_SLOT = /^[a-z][a-z0-9_]{0,31}$/;
export const MCP_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const MCP_VERSION = /^\d+\.\d+\.\d+$/;
const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::\d{1,5})?$/;
export function mcpHostOk(h: string): boolean {
  return HOST.test(h) && !/\.(localhost|local|internal|home\.arpa)(:\d+)?$/.test(h);
}
export function mcpUrlOk(u: string): boolean {
  try {
    const url = new URL(u);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      mcpHostOk(url.port === '' ? url.hostname : `${url.hostname}:${url.port}`)
    );
  } catch {
    return false;
  }
}
/** The `{}` format around a secret: exactly one `{}`, safe characters around it. */
export function mcpFormatOk(f: string): boolean {
  const parts = f.split('{}');
  return parts.length === 2 && parts.every((p) => /^[A-Za-z0-9 ._:/=+-]{0,64}$/.test(p));
}
/** A literal header value: printable ASCII without quotes, backslashes, `$ { } \``, not starting with `!`. */
export function mcpLiteralOk(v: string): boolean {
  return (
    v.length > 0 && /^[\x20-\x7e]+$/.test(v) && !/["\\${}`]/.test(v) && !v.startsWith('!') && v.trim() === v
  );
}
/** Tool glob: `[A-Za-z0-9_./-]` plus `*` and `?`. */
export const MCP_TOOL_GLOB = /^[A-Za-z0-9_.*?/-]{1,128}$/;

// ------------------------------------------------------------------------------------------ p14-mcp-stdio checks

export const MCP_NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const MCP_PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
export const MCP_PACKAGE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
export const MCP_BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MCP_ARG = /^[A-Za-z0-9 _@%+=:,./-]{0,256}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV =
  /^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|NODE_OPTIONS|NODE_PATH|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|(LD|DYLD)_[A-Z0-9_]*|REMYRAL_[A-Z0-9_]*|UV_[A-Z0-9_]*|NPM_CONFIG_[A-Z0-9_]*)$/;

export function mcpPackageNameOk(m: McpPackageManager, name: string): boolean {
  return name.length <= 214 && (m === 'npm' ? MCP_NPM_NAME : MCP_PYPI_NAME).test(name);
}

export function mcpIntegrityOk(m: McpPackageManager, v: string): boolean {
  return m === 'npm'
    ? /^sha512-[A-Za-z0-9+/]+=*$/.test(v) && v.length <= 200
    : /^sha256:[a-f0-9]{64}$/.test(v);
}

/** A stdio env name: `[A-Z][A-Z0-9_]*`, not one the platform sets itself. */
export function mcpEnvNameOk(n: string): boolean {
  return ENV_NAME.test(n) && !RESERVED_ENV.test(n);
}

// ------------------------------------------------------------------------------------------ p14-mcp-chat (P5)

/**
 * p14-mcp-chat (ADR-0054 P5, design §4, §15): Yetenekler → Keşfet for MCP servers and the install previews the chat
 * card shares. Every name, description and value below is registry text (untrusted) — rendered as text only.
 */
export type McpDiscoverySource = 'registry' | 'npm' | 'pypi';
export const MCP_DISCOVERY_SOURCES: readonly McpDiscoverySource[] = ['registry', 'npm', 'pypi'];

export interface McpWarning {
  readonly code: string;
  readonly similarTo: string | null;
  readonly days: number | null;
  readonly weekly: number | null;
  readonly status: string | null;
}

export interface McpFinding {
  readonly code: string;
  readonly name: string | null;
  readonly detail: string | null;
}

export interface McpSearchResult {
  readonly source: McpDiscoverySource;
  readonly ref: string;
  readonly name: string;
  readonly title: string | null;
  readonly version: string | null;
  readonly description: string;
  readonly transport: McpTransport | null;
  readonly packages: readonly {
    readonly manager: McpPackageManager;
    readonly name: string;
    readonly version: string;
  }[];
  readonly remoteUrl: string | null;
  readonly repository: string | null;
  readonly publishedAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly warnings: readonly McpWarning[];
}

export interface McpSearchOutput {
  readonly sources: readonly { readonly source: McpDiscoverySource; readonly error: string | null }[];
  readonly results: readonly McpSearchResult[];
}

type ValueInput = string | { readonly secret: string; readonly format?: string };

/** The facts a confirmation signs — the chat card payload's shape (`proposalCard`), also built from a preview. */
export interface McpProposalFacts {
  readonly previewId: string;
  readonly proposalSha256: string;
  readonly sourceKind: string;
  readonly ref: string;
  readonly pinnedVersion: string | null;
  readonly serverId: string;
  readonly version: string;
  readonly reuse: boolean;
  readonly latest: string | null;
  readonly title: string;
  readonly description: string;
  readonly transport: McpTransport;
  readonly url: string | null;
  readonly package: {
    readonly manager: McpPackageManager;
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
    readonly bin: string;
    readonly env: Readonly<Record<string, ValueInput>>;
  } | null;
  readonly headers: Readonly<Record<string, ValueInput>>;
  readonly secrets: readonly { readonly slot: string; readonly why: string }[];
  readonly egressHosts: readonly string[];
  readonly egressSuggested: readonly string[];
  readonly runtimes: readonly string[];
  readonly license: string | null;
  readonly repository: string | null;
  readonly publishedAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly warnings: readonly McpWarning[];
  readonly findings: readonly McpFinding[];
  readonly install: {
    readonly needed: boolean;
    readonly machines: readonly {
      readonly id: string;
      readonly name: string;
      readonly canary: boolean;
      readonly connected: boolean;
    }[];
  };
  /** The card's target project (chat), null otherwise. */
  readonly project: string | null;
}

export type McpPreviewState = 'previewed' | 'published' | 'discarded' | 'expired';

export interface McpPublished {
  readonly by: string | null;
  readonly at: string;
  readonly serverId: string;
  readonly version: string;
  readonly project: string | null;
  readonly actionId: string | null;
  readonly probeOpId: string | null;
  readonly probeSkipped: string | null;
}

export interface McpPreview {
  readonly id: string;
  readonly state: McpPreviewState;
  readonly via: 'chat' | 'panel';
  readonly facts: McpProposalFacts;
  readonly proposalSha256: string;
  readonly expiresAt: string;
  readonly published: McpPublished | null;
}

export interface McpPublishResult {
  readonly previewId: string;
  readonly serverId: string;
  readonly version: string;
  readonly reused: boolean;
  readonly project: string | null;
  readonly assigned: boolean;
  readonly assignError: string | null;
  readonly projectEnabled: boolean;
  readonly actionId: string | null;
  readonly installError: string | null;
}

export interface McpPreviewProgress {
  readonly preview: McpPreview;
  readonly action: McpInstallAction | null;
  readonly installs: readonly McpInstall[];
  readonly probes: readonly McpProbe[];
  readonly tools: readonly McpTool[];
  readonly rules: readonly McpRule[];
  readonly secretSlots: readonly { readonly slot: string; readonly why: string }[];
  readonly boundSlots: readonly string[];
}

function optStr(o: Record<string, unknown>, key: string): string | null {
  return typeof o[key] === 'string' ? o[key] : null;
}

function optNum(o: Record<string, unknown>, key: string): number | null {
  return typeof o[key] === 'number' ? o[key] : null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseWarning(v: unknown): McpWarning {
  const o = obj(v);
  return {
    code: str(o, 'code'),
    similarTo: optStr(o, 'similarTo'),
    days: optNum(o, 'days'),
    weekly: optNum(o, 'weekly'),
    status: optStr(o, 'status'),
  };
}

function parseFinding(v: unknown): McpFinding {
  const o = obj(v);
  return { code: str(o, 'code'), name: optStr(o, 'name'), detail: optStr(o, 'detail') };
}

function parseValues(v: unknown): Record<string, ValueInput> {
  const out: Record<string, ValueInput> = {};
  for (const [k, x] of Object.entries(rec(v))) {
    if (typeof x === 'string') out[k] = x;
    else {
      const s = rec(x);
      if (typeof s.secret === 'string')
        out[k] = typeof s.format === 'string' ? { secret: s.secret, format: s.format } : { secret: s.secret };
    }
  }
  return out;
}

function parseSlots(v: unknown): { slot: string; why: string }[] {
  return Array.isArray(v)
    ? v.map((s) => {
        const x = obj(s);
        return { slot: str(x, 'slot'), why: typeof x.why === 'string' ? x.why : '' };
      })
    : [];
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The flat card facts (the `mcp_install` draft payload, `proposalCard` on the master). */
export function parseMcpProposalFacts(v: unknown): McpProposalFacts {
  const o = obj(v);
  const pkg = o.package === null || o.package === undefined ? null : obj(o.package);
  const install = rec(o.install);
  return {
    previewId: str(o, 'previewId'),
    proposalSha256: str(o, 'proposalSha256'),
    sourceKind: typeof o.sourceKind === 'string' ? o.sourceKind : '',
    ref: typeof o.ref === 'string' ? o.ref : '',
    pinnedVersion: optStr(o, 'pinnedVersion'),
    serverId: str(o, 'serverId'),
    version: str(o, 'version'),
    reuse: o.reuse === true,
    latest: optStr(o, 'latest'),
    title: typeof o.title === 'string' ? o.title : str(o, 'serverId'),
    description: typeof o.description === 'string' ? o.description : '',
    transport: transport(o.transport),
    url: optStr(o, 'url'),
    package:
      pkg === null
        ? null
        : {
            manager: manager(pkg.manager),
            name: str(pkg, 'name'),
            version: str(pkg, 'version'),
            integrity: str(pkg, 'integrity'),
            bin: str(pkg, 'bin'),
            env: parseValues(pkg.env),
          },
    headers: parseValues(o.headers),
    secrets: parseSlots(o.secrets),
    egressHosts: strList(o.egressHosts),
    egressSuggested: strList(o.egressSuggested),
    runtimes: strList(o.runtimes),
    license: optStr(o, 'license'),
    repository: optStr(o, 'repository'),
    publishedAt: optStr(o, 'publishedAt'),
    downloadsWeekly: optNum(o, 'downloadsWeekly'),
    warnings: Array.isArray(o.warnings) ? o.warnings.map(parseWarning) : [],
    findings: Array.isArray(o.findings) ? o.findings.map(parseFinding) : [],
    install: {
      needed: install.needed === true,
      machines: Array.isArray(install.machines)
        ? install.machines.map((m) => {
            const x = obj(m);
            return {
              id: str(x, 'id'),
              name: typeof x.name === 'string' ? x.name : str(x, 'id'),
              canary: x.canary === true,
              connected: x.connected === true,
            };
          })
        : [],
    },
    project: optStr(o, 'project'),
  };
}

function parsePublished(v: unknown): McpPublished | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    by: optStr(o, 'by'),
    at: str(o, 'at'),
    serverId: str(o, 'serverId'),
    version: str(o, 'version'),
    project: optStr(o, 'project'),
    actionId: optStr(o, 'actionId'),
    probeOpId: optStr(o, 'probeOpId'),
    probeSkipped: optStr(o, 'probeSkipped'),
  };
}

const PREVIEW_STATES: readonly McpPreviewState[] = ['previewed', 'published', 'discarded', 'expired'];

/** A preview as `GET /mcp/previews/:id` answers it; its proposal is turned into the card facts. */
export function parseMcpPreview(v: unknown): McpPreview {
  const o = obj(v);
  const p = obj(o.proposal);
  const pub = obj(p.publish);
  const source = rec(o.source);
  const state = PREVIEW_STATES.find((s) => s === o.state);
  if (state === undefined) throw new ShapeError('expected preview state');
  const facts = parseMcpProposalFacts({
    previewId: o.id,
    proposalSha256: o.proposalSha256,
    sourceKind: o.sourceKind,
    ref: source.ref,
    pinnedVersion: source.version ?? p.pinnedVersion ?? null,
    serverId: p.serverId,
    version: p.version,
    reuse: p.reuse,
    latest: p.latest,
    title: pub.title,
    description: pub.description,
    transport: pub.transport,
    url: pub.url ?? null,
    package: pub.package ?? null,
    headers: pub.headers ?? {},
    secrets: pub.secrets,
    egressHosts: pub.egressHosts,
    egressSuggested: p.egressSuggested,
    runtimes: pub.runtimes,
    license: p.license,
    repository: p.repository,
    publishedAt: p.publishedAt,
    downloadsWeekly: p.downloadsWeekly,
    warnings: p.warnings,
    findings: p.findings,
    install: p.install,
    project: null,
  });
  return {
    id: str(o, 'id'),
    state,
    via: o.via === 'chat' ? 'chat' : 'panel',
    facts,
    proposalSha256: str(o, 'proposalSha256'),
    expiresAt: str(o, 'expiresAt'),
    published: parsePublished(o.published),
  };
}

function parseSearchResult(v: unknown): McpSearchResult {
  const o = obj(v);
  const s = o.source;
  if (s !== 'registry' && s !== 'npm' && s !== 'pypi') throw new ShapeError('expected discovery source');
  return {
    source: s,
    ref: str(o, 'ref'),
    name: str(o, 'name'),
    title: optStr(o, 'title'),
    version: optStr(o, 'version'),
    description: typeof o.description === 'string' ? o.description : '',
    transport: o.transport === null || o.transport === undefined ? null : transport(o.transport),
    packages: Array.isArray(o.packages)
      ? o.packages.map((p) => {
          const x = obj(p);
          return { manager: manager(x.manager), name: str(x, 'name'), version: str(x, 'version') };
        })
      : [],
    remoteUrl: optStr(o, 'remoteUrl'),
    repository: optStr(o, 'repository'),
    publishedAt: optStr(o, 'publishedAt'),
    downloadsWeekly: optNum(o, 'downloadsWeekly'),
    warnings: Array.isArray(o.warnings) ? o.warnings.map(parseWarning) : [],
  };
}

export function searchMcpCatalog(
  query: { readonly q: string; readonly source?: McpDiscoverySource | '' },
  opts: Opts = {},
): Promise<McpSearchOutput> {
  const qs = new URLSearchParams({ q: query.q });
  if (query.source !== undefined && query.source !== '') qs.set('source', query.source);
  return apiRequest(
    'GET',
    `/mcp/catalog?${qs.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        sources: arr(o.sources, 'sources').map((s) => {
          const x = obj(s);
          const src = MCP_DISCOVERY_SOURCES.find((k) => k === x.source) ?? 'registry';
          return { source: src, error: optStr(x, 'error') };
        }),
        results: arr(o.results, 'results').map(parseSearchResult),
      };
    },
    opts,
  );
}

export interface McpPreviewInput {
  readonly source: McpDiscoverySource | 'url';
  readonly ref: string;
  readonly version?: string;
  readonly serverId?: string;
  readonly bin?: string;
  readonly egressHosts?: readonly string[];
  readonly runtimes?: readonly string[];
}

/** Resolve one reference into a pinned preview (standard step-up; nothing is signed or installed). */
export function createMcpPreview(input: McpPreviewInput, opts: Opts = {}): Promise<McpPreview> {
  return apiRequest('POST', '/mcp/previews', parseMcpPreview, { ...opts, body: input });
}

export function getMcpPreview(id: string, opts: Opts = {}): Promise<McpPreview> {
  return apiRequest('GET', `/mcp/previews/${encodeURIComponent(id)}`, parseMcpPreview, opts);
}

export function discardMcpPreview(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/mcp/previews/${encodeURIComponent(id)}`, () => undefined, opts);
}

/** Confirm a preview exactly as shown (always-fresh step-up): sign, assign, install canary first, discover tools. */
export function publishMcpPreview(
  id: string,
  input: {
    readonly proposalSha256: string;
    readonly project?: string | null;
    readonly enableProject?: boolean;
    readonly workers?: 'all' | readonly string[];
  },
  opts: Opts = {},
): Promise<McpPublishResult> {
  return apiRequest(
    'POST',
    `/mcp/previews/${encodeURIComponent(id)}/publish`,
    (v) => {
      const o = obj(v);
      return {
        previewId: str(o, 'previewId'),
        serverId: str(o, 'serverId'),
        version: str(o, 'version'),
        reused: o.reused === true,
        project: optStr(o, 'project'),
        assigned: o.assigned === true,
        assignError: optStr(o, 'assignError'),
        projectEnabled: o.projectEnabled === true,
        actionId: optStr(o, 'actionId'),
        installError: optStr(o, 'installError'),
      };
    },
    { ...opts, body: input },
  );
}

export function getMcpPreviewProgress(id: string, opts: Opts = {}): Promise<McpPreviewProgress> {
  return apiRequest(
    'GET',
    `/mcp/previews/${encodeURIComponent(id)}/progress`,
    (v) => {
      const o = obj(v);
      return {
        preview: parseMcpPreview(o.preview),
        action: o.action === null || o.action === undefined ? null : parseAction(o.action),
        installs: optArr(o.installs, parseInstall),
        probes: optArr(o.probes, parseProbe),
        tools: optArr(o.tools, parseTool),
        rules: optArr(o.rules, (r) => {
          const x = obj(r);
          return { tool: str(x, 'tool'), effect: effect(x.effect) };
        }),
        secretSlots: parseSlots(o.secretSlots),
        boundSlots: strList(o.boundSlots),
      };
    },
    opts,
  );
}
