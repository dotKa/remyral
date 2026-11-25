import { createHash } from 'node:crypto';
import type { Messages } from '@remyral/i18n';
import {
  FUNCTION_HTTP_PORTS,
  FUNCTION_LIMITS,
  type FunctionEgress,
  type FunctionSpec,
  POLLED_WATCH_KINDS,
  WATCH_CHECK_LIMITS,
  type WatchCheckCondition,
  type WatchHttpExpect,
} from '@remyral/protocol';
import { isForbiddenHost, originPort } from '@remyral/workflow-nodes';
import { egressAllows } from '../workflows/egress.js';

/**
 * p15-watches (docs/design/p15-watches.md): the pure rules of a check watch — its subject (what the triggers notify),
 * the polling backoff, the function specs of remote checks, how an HTTP / probe answer is judged and how a condition
 * reads in a language. No I/O except the injected JSONata evaluator.
 */

export type WatchLang = 'tr' | 'en';
export type WatchTexts = Messages['watches'];

/** A remote check cannot be built or was refused for good: the watch can never be met. */
export class WatchCheckRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WatchCheckRefusal';
  }
}

/** `chk_<16 hex>`: the same condition asked again in the same conversation updates the same watch. */
export function conditionRef(spec: WatchCheckCondition): string {
  return `chk_${createHash('sha256').update(stableJson(spec)).digest('hex').slice(0, 16)}`;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/** What the database triggers notify for this condition (null: purely polled). Ids are already resolved. */
export function subjectOf(spec: WatchCheckCondition): string | null {
  switch (spec.kind) {
    case 'job_state':
      return `job:${spec.jobId}`;
    case 'job_event':
      return `jobev:${spec.jobId}`;
    case 'job_output':
      return `jobout:${spec.jobId}`;
    case 'preview_up':
      if (spec.tunnelId !== undefined) return `tunnel:${spec.tunnelId}`;
      if (spec.jobId !== undefined) return `pvjob:${spec.jobId}`;
      return `pvname:${String(spec.project)}:${String(spec.name)}`;
    case 'machine':
      return `worker:${spec.workerId}`;
    case 'workflow_run':
      return `run:${spec.runId}`;
    case 'service_url':
      return `service:${spec.serviceId}`;
    case 'http':
    case 'worker_probe':
      return null;
  }
}

/** Checked by a worker on a schedule (from the start). */
export function isPolled(spec: WatchCheckCondition): boolean {
  return POLLED_WATCH_KINDS.includes(spec.kind);
}

/** An event condition that, once its rows say "up", still needs an HTTP check from a worker. */
export function hasHttpPhase(spec: WatchCheckCondition): boolean {
  return (spec.kind === 'preview_up' || spec.kind === 'service_url') && spec.http === true;
}

/** Seconds until the next poll after `streak` unmet checks: every × 1.5^streak, at most 15 min. */
export function nextDelaySec(everySec: number, streak: number): number {
  const base = Math.min(Math.max(everySec, WATCH_CHECK_LIMITS.minEverySec), WATCH_CHECK_LIMITS.maxEverySec);
  const d = base * WATCH_CHECK_LIMITS.backoffFactor ** Math.max(0, Math.min(streak, 40));
  return Math.round(Math.min(d, WATCH_CHECK_LIMITS.maxEverySec));
}

/** A `*` glob as a LIKE pattern (`%`, `_` and `\` escaped; ESCAPE '\'). */
export function globToLike(glob: string): string {
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%');
}

/** A short line of untrusted text, one line, bounded. */
export function oneLine(s: string, n = 300): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : flat;
}

/** A deliverable link: only absolute http(s) URLs without spaces. */
export function safeUrl(u: unknown): string | null {
  return typeof u === 'string' && /^https?:\/\/[^\s<>()[\]`]{1,2000}$/.test(u) ? u : null;
}

// ------------------------------------------------------------------------------------------------ remote checks

/** The HTTP function spec of a check (the same rules as the workflow http.request node: public hosts, egress K1). */
export function httpCheckSpec(input: {
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  readonly key: string;
  readonly egress: FunctionEgress;
}): Extract<FunctionSpec, { type: 'http' }> {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    throw new WatchCheckRefusal('invalid_url', 'not an absolute http(s) URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new WatchCheckRefusal('invalid_url', 'only http and https URLs can be checked');
  if (u.username !== '' || u.password !== '')
    throw new WatchCheckRefusal('invalid_url', 'URLs with a user name or password are not checked');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = originPort(u.origin);
  if (isForbiddenHost(host))
    throw new WatchCheckRefusal(
      'egress_refused',
      `${host} is a LAN, private, loopback or metadata address; check a port on a machine with worker_probe instead`,
    );
  if (!egressAllows(input.egress, host, port, FUNCTION_HTTP_PORTS))
    throw new WatchCheckRefusal(
      'egress_not_allowed',
      input.egress.mode === 'allowlist'
        ? `${host}:${String(port)} is not on the project's HTTP allowlist`
        : `port ${String(port)} of ${host} needs a ${host}:${String(port)} entry in the project's HTTP list`,
    );
  u.hash = '';
  return {
    type: 'http',
    idempotencyKey: input.key,
    request: {
      method: input.method,
      url: u.toString(),
      headers: { 'User-Agent': 'Remyral-Watch/1.0' },
      timeoutSec: 15,
      maxResponseBytes: 256 * 1024,
      followRedirects: 3,
      responseType: 'json',
    },
    egress: input.egress,
  };
}

export function probeCheckSpec(
  probe: Extract<WatchCheckCondition, { kind: 'worker_probe' }>['probe'],
  key: string,
): Extract<FunctionSpec, { type: 'probe' }> {
  return {
    type: 'probe',
    idempotencyKey: key,
    probe:
      probe.type === 'tcp'
        ? { kind: 'tcp', port: probe.port, timeoutSec: 5 }
        : {
            kind: 'http',
            port: probe.port,
            path: probe.path ?? '/',
            method: probe.method ?? 'GET',
            timeoutSec: 15,
            maxResponseBytes: FUNCTION_LIMITS.maxProbeResponseBytes,
          },
  };
}

/** The JobSpec of a check's function job (no repository, workspace, runtime, model or secrets). */
export function checkJobSpec(input: {
  readonly project: string;
  readonly watchId: string;
  readonly fn: FunctionSpec;
  readonly workerId?: string | null;
}): Record<string, unknown> {
  const timeout =
    input.fn.type === 'http'
      ? input.fn.request.timeoutSec * (1 + input.fn.request.followRedirects)
      : input.fn.type === 'probe'
        ? input.fn.probe.timeoutSec
        : 60;
  return {
    kind: 'function',
    function: input.fn,
    projectId: input.project,
    runtime: 'claude-code',
    prompt: `Watch check (no agent): ${input.fn.type} for watch ${input.watchId}.`,
    sandboxProfile: 'container',
    approvalPolicy: 'deny-sensitive',
    sourceTrust: 'untrusted',
    limits: { maxDurationSec: Math.min(Math.max(timeout + 60, 30), 600) },
    role: 'chore',
    ...(input.workerId === undefined || input.workerId === null
      ? {}
      : { requirements: { workers: [input.workerId] } }),
  };
}

// ------------------------------------------------------------------------------------------------ judging answers

export interface HttpAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly durationMs: number;
}

export type JsonataEval = (
  source: string,
  input: unknown,
) => Promise<{ ok: true; value: unknown } | { ok: false; code: string }>;

export type Judged =
  | { readonly met: true; readonly value: unknown; readonly say: (t: WatchTexts) => string }
  | {
      readonly met: false;
      readonly say: (t: WatchTexts) => string;
      /** The expression itself is broken (syntax): the watch can never be met. */
      readonly refused?: string;
    };

const textOf = (body: unknown): string =>
  typeof body === 'string' ? body : body === undefined || body === null ? '' : JSON.stringify(body);

/** Whether an answer meets `expect` (status default 200–399; every given part must hold). */
export async function judgeHttp(
  expect: WatchHttpExpect | undefined,
  a: HttpAnswer,
  jsonata: JsonataEval,
): Promise<Judged> {
  const okStatus =
    expect?.status !== undefined ? expect.status.includes(a.status) : a.status >= 200 && a.status <= 399;
  if (!okStatus) return { met: false, say: (t) => t.summary.httpStatus({ status: a.status }) };
  const contains = expect?.bodyContains;
  if (contains !== undefined && !textOf(a.body).toLowerCase().includes(contains.toLowerCase()))
    return { met: false, say: (t) => t.summary.bodyMissing({ text: oneLine(contains, 80) }) };
  const src = expect?.jsonata;
  if (src !== undefined) {
    const r = await jsonata(src, { status: a.status, headers: a.headers, body: a.body ?? null });
    if (!r.ok) {
      const refused = /syntax|too_long|not_allowed/.test(r.code) ? r.code : undefined;
      return {
        met: false,
        say: (t) => t.summary.jsonataError({ code: r.code }),
        ...(refused === undefined ? {} : { refused }),
      };
    }
    const truthy =
      r.value !== null &&
      r.value !== undefined &&
      r.value !== false &&
      r.value !== 0 &&
      r.value !== '' &&
      !(Array.isArray(r.value) && r.value.length === 0);
    if (!truthy) return { met: false, say: (t) => t.summary.jsonataFalse({ status: a.status }) };
    return {
      met: true,
      value: boundValue(r.value),
      say: (t) => t.summary.httpMet({ status: a.status, ms: a.durationMs }),
    };
  }
  return {
    met: true,
    value: { status: a.status },
    say: (t) => t.summary.httpMet({ status: a.status, ms: a.durationMs }),
  };
}

/** A captured value as stored and shown: JSON, at most 2 KiB (strings cut). */
export function boundValue(v: unknown): unknown {
  if (v === undefined) return null;
  const json = JSON.stringify(v) as string | undefined;
  if (json === undefined) return null;
  if (json.length <= 2048) return JSON.parse(json) as unknown;
  return oneLine(typeof v === 'string' ? v : json, 2000);
}

/** A captured value as one line of text for a note. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return oneLine(v, 300);
  return oneLine(JSON.stringify(v), 300);
}

// ------------------------------------------------------------------------------------------------ reading

const short = (id: string): string => id.slice(0, 8);

/** The condition as one sentence in a language (machine / run labels resolved by the caller). */
export function conditionText(
  t: WatchTexts,
  spec: WatchCheckCondition,
  names: { readonly machine?: string } = {},
): string {
  const c = t.condition;
  const states = (xs: readonly string[]): string =>
    xs.map((x) => (c.states as Record<string, string>)[x] ?? x).join(c.or);
  switch (spec.kind) {
    case 'job_state':
      return c.jobState({ job: short(spec.jobId), states: states(spec.states) });
    case 'job_event':
      return c.jobEvent({ job: short(spec.jobId), text: oneLine(spec.contains, 80) });
    case 'job_output':
      return c.jobOutput({ job: short(spec.jobId), name: spec.name ?? c.anyOutput });
    case 'preview_up': {
      const head =
        spec.jobId !== undefined
          ? c.previewJob({ job: short(spec.jobId) })
          : spec.tunnelId !== undefined
            ? c.previewTunnel({ id: short(spec.tunnelId) })
            : c.previewName({ project: String(spec.project), name: String(spec.name) });
      return spec.http === true ? `${head}${c.alsoHttp}` : head;
    }
    case 'http':
      return c.http({ method: spec.method ?? 'GET', url: oneLine(spec.url, 200) });
    case 'worker_probe':
      return spec.probe.type === 'tcp'
        ? c.probeTcp({ machine: names.machine ?? spec.workerId, port: spec.probe.port })
        : c.probeHttp({
            machine: names.machine ?? spec.workerId,
            port: spec.probe.port,
            path: spec.probe.path ?? '/',
          });
    case 'machine': {
      const machine = names.machine ?? spec.workerId;
      if (spec.state === 'runtime_ready') return c.runtimeReady({ machine, runtime: String(spec.runtime) });
      return spec.state === 'online' ? c.machineOnline({ machine }) : c.machineOffline({ machine });
    }
    case 'workflow_run':
      return spec.nodeId === undefined
        ? c.run({ run: short(spec.runId), states: states(spec.states) })
        : c.runNode({ run: short(spec.runId), node: spec.nodeId, states: states(spec.states) });
    case 'service_url': {
      if (spec.exited === true) return c.serviceExit({ id: spec.serviceId });
      const head = c.service({ id: spec.serviceId });
      return spec.http === true ? `${head}${c.alsoHttp}` : head;
    }
  }
}
