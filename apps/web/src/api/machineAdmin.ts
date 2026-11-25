import { apiRequest, obj, type RequestOptions, ShapeError } from './client';
import type { Op } from './remoteOps';

/**
 * AI machine administration and the tool inventory of a worker (p5-machine-admin, ADR-0021;
 * apps/master/src/machine-admin). Reading machine administration is admin-only, the opt-in switch is owner-only
 * with always-fresh step-up, starting a machine task is admin + always-fresh. The tool inventory is fleet
 * information (viewer+); detecting, installing and inspecting are remote operations (admin + step-up).
 */

export const RECIPE_TOOLS = ['browser', 'git', 'python', 'ffmpeg', 'cloudflared'] as const;
export type RecipeTool = (typeof RECIPE_TOOLS)[number];

export interface ToolEntry {
  readonly name: string;
  readonly found: boolean;
  readonly version?: string;
  readonly path?: string;
  readonly source: 'system' | 'managed';
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ToolRecipe {
  readonly tool: RecipeTool;
  readonly version: string;
  readonly elevated: boolean;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  readonly installed: boolean;
  readonly sizeBytes?: number;
}

/** p13-fleet-tools: the install of a tool that jobs actually use (config path > worker-managed > system). */
export interface EffectiveTool {
  readonly name: string;
  readonly source: 'config' | 'managed' | 'system';
  readonly version?: string;
  readonly path?: string;
}

export interface ToolInventory {
  readonly detectedAt: string;
  readonly ttlSec: number;
  readonly tools: readonly ToolEntry[];
  /** p13-fleet-tools (newer workers): what jobs use per tool; absent → computed client-side. */
  readonly effective?: readonly EffectiveTool[];
  readonly recipes: readonly ToolRecipe[];
}

export interface WorkerTools {
  readonly workerId: string;
  readonly supported: boolean;
  readonly inventory: ToolInventory | null;
  readonly reportedAt: string | null;
  readonly machineAdminEnabled: boolean;
}

export const INSPECT_SECTIONS = ['software', 'services', 'disk', 'logs', 'tools'] as const;
export type InspectSection = (typeof INSPECT_SECTIONS)[number];

export interface MachineInspectReport {
  readonly collectedAt: string;
  readonly platform: string;
  readonly software?: readonly { readonly name: string; readonly version?: string }[];
  readonly services?: readonly {
    readonly name: string;
    readonly state?: string;
    readonly startType?: string;
  }[];
  readonly disk?: readonly {
    readonly mount: string;
    readonly freeBytes: number | null;
    readonly totalBytes: number | null;
  }[];
  readonly logs?: readonly string[];
  readonly tools?: ToolInventory;
  readonly problems?: readonly { readonly section: string; readonly message: string }[];
  readonly truncated: boolean;
}

export type CommandState =
  'requested' | 'pending' | 'granted' | 'denied' | 'succeeded' | 'failed' | 'refused';

export interface AdminCommand {
  readonly requestId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly kind: 'exec' | 'write_file' | 'read_file';
  readonly summary: string;
  /** p17-worker-1-1-1: the agent's stated purpose (unverified); absent / null from older masters and workers. */
  readonly purpose?: string | null;
  readonly state: CommandState;
  readonly reason: string | null;
  readonly autoApproved: boolean;
  readonly approvalId: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly file: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256Before: string | null;
    readonly sha256After: string | null;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminCommandDetail extends AdminCommand {
  readonly op: Readonly<Record<string, unknown>>;
  readonly output: string;
  readonly truncated: boolean;
}

export interface MachineMemory {
  readonly docId: string | null;
  readonly version: number;
  readonly content: string;
  readonly updatedAt: string | null;
}

export interface MachineAdminView {
  readonly workerId: string;
  readonly displayName: string;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly desired: { readonly enabled: boolean; readonly autoApprove: boolean; readonly generation: number };
  readonly reported: {
    readonly enabled: boolean;
    readonly autoApprove: boolean;
    readonly localVeto: boolean;
    readonly helper: 'available' | 'missing' | 'unknown';
    readonly helperDetail?: string;
    /** p17-worker-1-1-1: why the helper is not ready (closed code; translated in the console). */
    readonly helperReason?: string;
    readonly runtimes: readonly string[];
    readonly activeSession?: {
      readonly jobId: string;
      readonly attemptId: string;
      readonly sessionId: string;
      readonly since: string;
    };
  } | null;
  readonly reportedAt: string | null;
  readonly projectAutoApprove: boolean;
  readonly activeJob: { readonly jobId: string; readonly state: string; readonly title: string } | null;
  readonly commands: readonly AdminCommand[];
  readonly memory: MachineMemory;
}

type Opts = Omit<RequestOptions, 'body'>;
const wid = (id: string) => `/workers/${encodeURIComponent(id)}`;

function parseView(body: unknown): MachineAdminView {
  const o = obj(body);
  if (typeof o.supported !== 'boolean' || typeof o.desired !== 'object' || o.desired === null) {
    throw new ShapeError('machine admin');
  }
  return {
    ...(o as unknown as MachineAdminView),
    commands: Array.isArray(o.commands) ? (o.commands as AdminCommand[]) : [],
    memory:
      typeof o.memory === 'object' && o.memory !== null
        ? (o.memory as MachineMemory)
        : { docId: null, version: 0, content: '', updatedAt: null },
    projectAutoApprove: o.projectAutoApprove === true,
  };
}

function parseTools(body: unknown): WorkerTools {
  const o = obj(body);
  if (typeof o.supported !== 'boolean') throw new ShapeError('worker tools');
  return {
    workerId: typeof o.workerId === 'string' ? o.workerId : '',
    supported: o.supported,
    inventory:
      typeof o.inventory === 'object' && o.inventory !== null ? (o.inventory as ToolInventory) : null,
    reportedAt: typeof o.reportedAt === 'string' ? o.reportedAt : null,
    machineAdminEnabled: o.machineAdminEnabled === true,
  };
}

function parseOpEnvelope(body: unknown): Op {
  const o = obj(body);
  const op = typeof o.op === 'object' && o.op !== null ? obj(o.op) : o;
  if (typeof op.id !== 'string' || typeof op.state !== 'string') throw new ShapeError('op');
  return op as unknown as Op;
}

function parseMemory(body: unknown): MachineMemory {
  const o = obj(body);
  if (typeof o.content !== 'string' || typeof o.version !== 'number') throw new ShapeError('machine memory');
  return o as unknown as MachineMemory;
}

export function getMachineAdmin(workerId: string, opts: Opts = {}): Promise<MachineAdminView> {
  return apiRequest('GET', `${wid(workerId)}/machine-admin`, parseView, opts);
}

export function setMachineAdmin(
  workerId: string,
  body: { enabled: boolean; autoApprove: boolean; expectedGeneration: number; reason?: string },
  opts: Opts = {},
): Promise<MachineAdminView> {
  return apiRequest('PUT', `${wid(workerId)}/machine-admin`, parseView, { ...opts, body });
}

export interface MachineTaskInput {
  readonly title: string;
  readonly prompt: string;
  readonly approvalPolicy?: 'ask-all' | 'allow-all';
  readonly maxDurationSec?: number;
  readonly recipe?: { readonly tool: RecipeTool; readonly version?: string };
  /** p17-worker-managed: a fixed setup task of the release (rootless Docker for the worker user, Linux). */
  readonly setup?: 'rootless-docker';
}

export function startMachineTask(
  workerId: string,
  body: MachineTaskInput,
  opts: Opts = {},
): Promise<{ jobId: string; state: string }> {
  return apiRequest(
    'POST',
    `${wid(workerId)}/machine-admin/tasks`,
    (b) => {
      const o = obj(b);
      if (typeof o.jobId !== 'string') throw new ShapeError('machine task');
      return { jobId: o.jobId, state: typeof o.state === 'string' ? o.state : 'QUEUED' };
    },
    { ...opts, body },
  );
}

export function getAdminCommand(
  workerId: string,
  requestId: string,
  opts: Opts = {},
): Promise<AdminCommandDetail> {
  return apiRequest(
    'GET',
    `${wid(workerId)}/machine-admin/commands/${encodeURIComponent(requestId)}`,
    (b) => {
      const o = obj(b);
      if (typeof o.requestId !== 'string') throw new ShapeError('admin command');
      return {
        ...(o as unknown as AdminCommandDetail),
        op: typeof o.op === 'object' && o.op !== null ? (o.op as Record<string, unknown>) : {},
        output: typeof o.output === 'string' ? o.output : '',
        truncated: o.truncated === true,
      };
    },
    opts,
  );
}

export function saveMachineMemory(
  workerId: string,
  body: { content: string; expectedVersion: number },
  opts: Opts = {},
): Promise<MachineMemory> {
  return apiRequest('PUT', `${wid(workerId)}/machine-memory`, parseMemory, { ...opts, body });
}

export function getWorkerTools(workerId: string, opts: Opts = {}): Promise<WorkerTools> {
  return apiRequest('GET', `${wid(workerId)}/tools`, parseTools, opts);
}

const post = (path: string, body: unknown, opts: Opts) =>
  apiRequest('POST', path, parseOpEnvelope, { ...opts, body });

export function detectTools(workerId: string, opts: Opts = {}): Promise<Op> {
  return post(`${wid(workerId)}/tools/detect`, {}, opts);
}

export function installTool(workerId: string, tool: RecipeTool, version?: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/tools/${tool}/install`, version === undefined ? {} : { version }, opts);
}

export function removeTool(workerId: string, tool: RecipeTool, version: string, opts: Opts = {}) {
  return post(`${wid(workerId)}/tools/${tool}/remove`, { version }, opts);
}

/**
 * p17-worker-managed: install or remove the machine-admin helper's trigger through the privileged helper (owner,
 * always-fresh step-up).
 */
export function manageAdminHelper(
  workerId: string,
  action: 'install' | 'remove',
  opts: Opts = {},
): Promise<Op> {
  return post(`${wid(workerId)}/machine-admin/helper`, { action }, opts);
}

export function inspectMachine(
  workerId: string,
  sections: readonly InspectSection[],
  opts: Opts = {},
): Promise<Op> {
  return post(`${wid(workerId)}/inspect`, { sections }, opts);
}

/** The inspection report of a finished `machine.inspect` operation (null otherwise). */
export function inspectOf(op: Op | null): MachineInspectReport | null {
  const r = op?.result?.inspect;
  return r !== null && typeof r === 'object' ? (r as MachineInspectReport) : null;
}

/** The inventory carried by a finished tool operation (null otherwise). */
export function inventoryOf(op: Op | null): ToolInventory | null {
  const r = op?.result?.tools;
  return r !== null && typeof r === 'object' ? (r as ToolInventory) : null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${String(n)} B`;
}
