import {
  RESPOND_BODY_MAX_BYTES,
  RESPOND_CONTENT_TYPES,
  RESPOND_HEADERS,
  schemaVersionOf,
  type StoredDefinition,
  type WorkflowDefinitionV2,
} from '@remyral/workflow-nodes';
import type { Pool } from '../../db/pool.js';
import { loadValue } from './values.js';

/**
 * p14-workflow-engine 14.4 (design §20.5): "respond to webhook". A `trigger.webhook` with `responseMode: wait` holds
 * the `POST /v1/hooks/:id` request (after the signature checks and the automation enqueue) until the run's first
 * top-level `control.respond` node run succeeds, bounded by `responseTimeoutSec` (≤ 30 s) and a connection cap; the
 * request is answered with the node's status / allowlisted headers / body. Everything else (no answer in time, the
 * run finishing without one, a skipped automation run) gets the normal 202.
 */

/** The answer a `control.respond` node run recorded (stored on its output, redacted like every value). */
export interface RespondAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Default and upper bound of the hold (seconds); the request timeout of the server is 30 s. */
export const RESPOND_TIMEOUT_DEFAULT_SEC = 25;
export const RESPOND_TIMEOUT_MAX_SEC = 30;
const POLL_MS = 200;

/** Builds the answer from a respond node's resolved config (refusals are node failures without retry). */
export function respondAnswer(
  config: Readonly<Record<string, unknown>>,
): RespondAnswer | { readonly code: string; readonly message: string } {
  const status = typeof config.status === 'number' ? config.status : 200;
  if (!Number.isInteger(status) || status < 200 || status > 599)
    return { code: 'respond_invalid', message: 'the status must be 200–599' };
  const headers: Record<string, string> = {};
  const raw = (config.headers ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (!RESPOND_HEADERS.includes(key))
      return { code: 'respond_header_invalid', message: `header ${key.slice(0, 64)} is not allowed` };
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    // eslint-disable-next-line no-control-regex
    if (text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text))
      return { code: 'respond_header_invalid', message: `header ${key} has an invalid value` };
    headers[key] = text;
  }
  const body = config.body;
  let type = headers['content-type'];
  if (type === undefined) type = typeof body === 'string' ? 'text/plain' : 'application/json';
  const base = type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  // Only inert content: the answer is served from the console's origin (no HTML / XML / SVG).
  if (!RESPOND_CONTENT_TYPES.includes(base))
    return {
      code: 'respond_content_type',
      message: 'the content type must be application/json or text/plain',
    };
  headers['content-type'] = `${base}; charset=utf-8`;
  const text =
    body === undefined
      ? ''
      : base === 'text/plain' && typeof body === 'string'
        ? body
        : ((JSON.stringify(body) as string | undefined) ?? 'null');
  if (Buffer.byteLength(text, 'utf8') > RESPOND_BODY_MAX_BYTES)
    return { code: 'respond_body_too_large', message: 'the body is larger than 64 KiB' };
  return { status, headers, body: text };
}

/** What the held request answers. */
export type HeldAnswer =
  | { readonly kind: 'answer'; readonly answer: RespondAnswer }
  /** The run failed or was cancelled before it answered. */
  | { readonly kind: 'failed' };

/**
 * The hold of an automation webhook call: null when the automation is not bound to a `responseMode: wait` trigger
 * (answer at once), else how long to wait.
 */
export async function holdOf(pool: Pool, automationId: string): Promise<{ timeoutSec: number } | null> {
  const { rows } = await pool.query<{
    project: string;
    name: string;
    trigger_node_id: string;
    pinned_version: number | null;
  }>(
    `SELECT b.project, b.name, b.trigger_node_id, b.pinned_version FROM workflow_trigger_bindings b
      WHERE b.automation_id = $1 AND b.enabled`,
    [automationId],
  );
  const b = rows[0];
  if (b === undefined) return null;
  // p18-multi-project: a binding of a project that attached the workflow follows the attachment's version.
  const { rows: defs } = await pool.query<{ definition: StoredDefinition }>(
    `SELECT d.definition FROM workflow_definitions d
       LEFT JOIN workflow_attachments a ON a.project = $1 AND a.name = $2 AND a.state <> 'detached'
      WHERE d.project = coalesce(a.owner_project, $1) AND d.name = $2
        AND (CASE WHEN a.id IS NOT NULL THEN d.version = a.version
                  ELSE ($3::int IS NULL OR d.version = $3) END)
      ORDER BY d.version DESC LIMIT 1`,
    [b.project, b.name, b.pinned_version],
  );
  const def = defs[0]?.definition;
  if (def === undefined || schemaVersionOf(def) !== 2) return null;
  const node = (def as WorkflowDefinitionV2).nodes.find((n) => n.id === b.trigger_node_id);
  const cfg = (node as { config?: { responseMode?: unknown; responseTimeoutSec?: unknown } } | undefined)
    ?.config;
  if (cfg?.responseMode !== 'wait') return null;
  const t = typeof cfg.responseTimeoutSec === 'number' ? cfg.responseTimeoutSec : RESPOND_TIMEOUT_DEFAULT_SEC;
  return { timeoutSec: Math.max(1, Math.min(RESPOND_TIMEOUT_MAX_SEC, t)) };
}

/**
 * Waits (polling Postgres, the source of truth) for the answer of the workflow run an automation run starts: null on
 * timeout, abort, a skipped / failed automation run, or a run that finished without answering.
 */
export async function awaitAnswer(
  pool: Pool,
  automationRunId: string,
  timeoutMs: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
): Promise<HeldAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const { rows } = await pool.query<{
      state: string;
      workflow_run_id: string | null;
      run_state: string | null;
      output: { response?: unknown } | null;
    }>(
      `SELECT ar.state, ar.workflow_run_id, r.state AS run_state,
              (SELECT nr.output FROM workflow_node_runs nr
                WHERE nr.run_id = ar.workflow_run_id AND nr.node_type = 'control.respond' AND nr.scope = ''
                  AND nr.state = 'succeeded'
                ORDER BY nr.ended_at, nr.id LIMIT 1) AS output
         FROM automation_runs ar LEFT JOIN workflow_runs r ON r.id = ar.workflow_run_id
        WHERE ar.id = $1`,
      [automationRunId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    if (r.workflow_run_id !== null && r.output?.response !== undefined) {
      const answer = (await loadValue(pool, r.workflow_run_id, r.output.response)) as RespondAnswer | null;
      if (answer !== null && typeof answer === 'object' && typeof answer.status === 'number')
        return { kind: 'answer', answer };
      return null;
    }
    if (r.run_state === 'failed' || r.run_state === 'cancelled') return { kind: 'failed' };
    if (r.run_state === 'succeeded') return null;
    if (
      r.workflow_run_id === null &&
      ['skipped', 'error', 'failed', 'cancelled', 'succeeded'].includes(r.state)
    )
      return null;
    await sleep(POLL_MS);
  }
  return null;
}
