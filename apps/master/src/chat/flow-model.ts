import { createHash } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { loadValue, redactValue } from '../workflows/v2/values.js';

/**
 * p17-chat-flow (docs/design/p17-chat-flow.md): pure parts and small reads shared by the chat flow service and the
 * chat watches — what a finished workflow run's result card says (state, steps done / total, duration, a bounded
 * summary of the last step's output), and the approval facts of a waiting workflow step.
 */

export const RESULT_SUMMARY_MAX = 300;
export const APPROVAL_TITLE_MAX = 200;
export const APPROVAL_DETAILS_MAX = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of plain text: control characters folded to spaces, clipped to `max` characters. */
export function plainLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const folded = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  const flat = folded.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/**
 * A short, secret-free summary of a step's output: an AI step's own `summary`, a string as it is, a single-port value
 * unwrapped, else compact JSON — redacted again (values are redacted when stored; this is defence in depth) and
 * clipped. Null when there is nothing to say (no output, pruned data).
 */
export function outputSummary(value: unknown, max = RESULT_SUMMARY_MAX): string | null {
  if (value === undefined || value === null) return null;
  let v: unknown = redactValue(value);
  if (isObj(v) && v.$pruned === true) return null;
  if (isObj(v) && typeof v.summary === 'string') v = v.summary;
  else if (isObj(v) && isObj(v.ports)) {
    const ports = Object.values(v.ports);
    v = ports.length === 1 ? ports[0] : v.ports;
  }
  if (v === undefined || v === null) return null;
  if (isObj(v) && v.$pruned === true) return null;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  const line = plainLine(text, max);
  return line === '' ? null : line;
}

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface RunResult {
  readonly runId: string;
  readonly workflow: string;
  readonly project: string;
  readonly version: number;
  readonly state: RunOutcome;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly durationMs: number | null;
  /** Bounded, redacted, plain text (null: nothing to show). Rendered as text, never Markdown. */
  readonly summary: string | null;
  /** The run's failure reason (failed runs), clipped. */
  readonly reason: string | null;
  /**
   * p22-run-attention: a succeeded run whose steps could not (fully) do their work — what to look at (empty: nothing).
   * Notes are agent text: plain, bounded, rendered as text.
   */
  readonly attention: readonly AttentionItem[];
}

export interface AttentionItem {
  readonly node: string;
  readonly kind: 'partial' | 'none' | 'input_cut';
  readonly note: string;
}

/** `workflow_runs.attention` as stored, validated and bounded (untrusted agent text in the notes). */
export function attentionOf(v: unknown): AttentionItem[] {
  if (!Array.isArray(v)) return [];
  const out: AttentionItem[] = [];
  for (const a of v.slice(0, 10)) {
    if (typeof a !== 'object' || a === null) continue;
    const o = a as Record<string, unknown>;
    const kind = o.kind;
    if (kind !== 'partial' && kind !== 'none' && kind !== 'input_cut') continue;
    if (typeof o.node !== 'string') continue;
    out.push({
      node: plainLine(o.node, 100),
      kind,
      note: typeof o.note === 'string' ? plainLine(o.note, 300) : '',
    });
  }
  return out;
}

/**
 * The facts of a finished run's result card, read now (null: unknown run or not finished). Steps are the run's
 * top-level nodes: done = succeeded, total = every node that did not end on a dead path (skipped).
 */
export async function workflowRunResult(db: Queryable, runId: string): Promise<RunResult | null> {
  if (!isUuid(runId)) return null;
  const { rows } = await db.query<{
    id: string;
    name: string;
    project: string;
    version: number;
    state: string;
    engine: number;
    created_at: Date;
    activated_at: Date | null;
    ended_at: Date | null;
    reason: string | null;
    outputs: unknown;
    attention: unknown;
  }>(
    `SELECT id::text AS id, name, project, version, state, engine, created_at, activated_at, ended_at, reason, outputs,
            attention
       FROM workflow_runs WHERE id = $1`,
    [runId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  if (r.state !== 'succeeded' && r.state !== 'failed' && r.state !== 'cancelled') return null;
  let done = 0;
  let total = 0;
  let summary: string | null;
  if (r.engine === 2) {
    const { rows: nodes } = await db.query<{ node_id: string; state: string; output: unknown }>(
      `SELECT DISTINCT ON (node_id) node_id, state, output FROM workflow_node_runs
        WHERE run_id = $1 AND scope = ''
        ORDER BY node_id, attempt DESC`,
      [runId],
    );
    for (const n of nodes) {
      if (n.state === 'skipped') continue;
      total++;
      if (n.state === 'succeeded') done++;
    }
    // The run's outputs are its sinks' values by node id: one sink is shown as its own value.
    const outputs = await loadValue(db, runId, r.outputs);
    const sinks = isObj(outputs) ? Object.values(outputs) : [];
    summary = outputSummary(isObj(outputs) && sinks.length === 1 ? sinks[0] : outputs);
    if (summary === null) {
      const { rows: last } = await db.query<{ output: unknown }>(
        `SELECT output FROM workflow_node_runs
          WHERE run_id = $1 AND scope = '' AND state = 'succeeded' AND output IS NOT NULL
          ORDER BY ended_at DESC NULLS LAST, updated_at DESC LIMIT 1`,
        [runId],
      );
      const out = last[0]?.output;
      if (isObj(out) && isObj(out.ports)) {
        const ports: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(out.ports)) ports[k] = await loadValue(db, runId, v);
        summary = outputSummary({ ports });
      } else summary = outputSummary(out);
    }
  } else {
    const { rows: nodes } = await db.query<{ state: string; summary: string | null }>(
      `SELECT state, outputs->>'summary' AS summary FROM workflow_nodes WHERE run_id = $1
        ORDER BY updated_at DESC`,
      [runId],
    );
    for (const n of nodes) {
      if (n.state === 'skipped') continue;
      total++;
      if (n.state === 'succeeded') done++;
    }
    const last = nodes.find((n) => n.state === 'succeeded' && n.summary !== null);
    summary = last?.summary == null ? null : outputSummary(last.summary);
  }
  const start = r.activated_at ?? r.created_at;
  return {
    runId: r.id,
    workflow: r.name,
    project: r.project,
    version: r.version,
    state: r.state,
    stepsDone: done,
    stepsTotal: total,
    durationMs: r.ended_at === null ? null : Math.max(0, r.ended_at.getTime() - start.getTime()),
    summary,
    reason: r.state === 'failed' && r.reason !== null ? plainLine(r.reason, 300) : null,
    attention: r.state === 'succeeded' ? attentionOf(r.attention) : [],
  };
}

/** The result as message meta (`meta.workflowResult`): what the console's result card draws. */
export function resultMeta(r: RunResult): Record<string, unknown> {
  return {
    runId: r.runId,
    workflow: r.workflow,
    project: r.project,
    version: r.version,
    state: r.state,
    stepsDone: r.stepsDone,
    stepsTotal: r.stepsTotal,
    durationMs: r.durationMs,
    summary: r.summary,
    reason: r.reason,
    ...(r.attention.length === 0 ? {} : { attention: r.attention }),
  };
}

/** p22-run-attention: the attention items in one plain line (notes, notifications, the assistant's turn). */
export function attentionLine(items: readonly AttentionItem[], lang: 'tr' | 'en'): string {
  const word = (k: AttentionItem['kind']): string =>
    lang === 'tr'
      ? k === 'none'
        ? 'hiçbir şey yapamadı'
        : k === 'partial'
          ? 'işin bir kısmını yapamadı'
          : 'girdisi kesik ulaştı'
      : k === 'none'
        ? 'could do nothing'
        : k === 'partial'
          ? 'left part of the work undone'
          : 'got a cut-off input';
  return items.map((a) => `${a.node} ${word(a.kind)}${a.note === '' ? '' : ` (${a.note})`}`).join('; ');
}

/** The title / details of an approval step from its stored config (both plain text, bounded). */
export function approvalTexts(config: unknown): { title: string | null; details: string | null } {
  if (!isObj(config)) return { title: null, details: null };
  const title = typeof config.title === 'string' ? plainLine(config.title, APPROVAL_TITLE_MAX) : '';
  const raw = config.details;
  const details =
    typeof raw === 'string'
      ? raw.trim().slice(0, APPROVAL_DETAILS_MAX)
      : raw === undefined || raw === null
        ? ''
        : JSON.stringify(raw).slice(0, APPROVAL_DETAILS_MAX);
  return { title: title === '' ? null : title, details: details === '' ? null : details };
}

/** `approval:<id>` / `result:<id>` / `question:<id>` — the once-only key of an announced occurrence. */
export function eventKey(
  kind: 'approval' | 'result' | 'question' | 'decided' | 'sched' | 'reply' | 'jobwait',
  id: string,
): string {
  return `${kind}:${id.toLowerCase()}`;
}

/** p18-outputs-delivery: `job:<job id>:<terminal transition id>` — one result card per job outcome. */
export function jobEventKey(jobId: string, transitionId: string | number): string {
  return `job:${jobId.toLowerCase()}:${String(transitionId)}`;
}

/**
 * p18-last-gaps: an engine-1 gate (`workflow_nodes` row in `awaiting_approval` with a `gate_role`) has no node-run id.
 * Every surface that names an approval step by a node-run id (the chat card's meta, the `flow` stream event, "Senden
 * bekleyen", the assistant's describe_workflow_run / draft_workflow_approval_decision) names an engine-1 gate by this
 * stable UUID instead: SHA-256 of run + node, laid out as an RFC 9562 version-8 UUID. Engine-2 node runs are
 * `gen_random_uuid()` (version 4), so the version nibble tells the two apart; the run id is always checked with it.
 */
export function gateId(runId: string, nodeId: string): string {
  const h = createHash('sha256').update(`remyral:gate1:${runId.toLowerCase()}:${nodeId}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Whether a step id is an engine-1 gate id ({@link gateId}: version 8, RFC variant). */
export function isGateId(id: unknown): id is string {
  return isUuid(id) && id[14] === '8' && /^[89ab]$/i.test(id[19] ?? '');
}

/** The node ids engine 1 accepts (migration 0017's check). */
export const V1_NODE_ID = /^[a-z][a-z0-9_-]{0,47}(\.[a-z][a-z0-9_-]{0,31})?$/;

/**
 * p18-last-gaps: `gate:<run id>:<node id>` (an engine-1 gate announced) / `gatedone:<run id>:<node id>` (its decision or
 * closing told to the conversations showing its card) — the once-only keys of `chat_flow_events` (migration 0188).
 */
export function gateEventKey(kind: 'gate' | 'gatedone', runId: string, nodeId: string): string {
  return `${kind}:${runId.toLowerCase()}:${nodeId}`;
}

/**
 * The title / details of an engine-1 gate: the step's own title (kept on its job spec; the stored node definition may
 * not carry it) and its prompt as the author wrote it (bounded).
 */
export function gateTexts(
  def: unknown,
  stepTitle: string | null = null,
): { title: string | null; details: string | null } {
  if (!isObj(def)) return { title: null, details: null };
  const raw = typeof def.title === 'string' ? def.title : (stepTitle ?? '');
  const title = plainLine(raw, APPROVAL_TITLE_MAX);
  const details = typeof def.prompt === 'string' ? def.prompt.trim().slice(0, APPROVAL_DETAILS_MAX) : '';
  return { title: title === '' ? null : title, details: details === '' ? null : details };
}
