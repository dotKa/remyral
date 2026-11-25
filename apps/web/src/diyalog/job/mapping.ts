import { type Locale, type Messages, messagesFor } from '@remyral/i18n';
import type { ApprovalModeChange } from '../../api/approvalMode';
import { type JobDetail, type Transition, transitionReasonParams } from '../../api/jobs';
import type { EventItem } from '../../api/live';
import { describeReason } from '../../lib/reasons';
import { foldTimeline } from '../../screens/job/timeline';
import type { IconName } from '../icons';

/**
 * p12-diyalog Faz 2: a job's life as one thread (docs/design/p12-diyalog.md §10). Pure — every input is data the job
 * page already reads (`GET /jobs/:id`, the live events of the job stream, the approval-mode history); the output is
 * the ordered list of thread items:
 *
 *   prompt     the job's prompt as the creator's message
 *   agent      the agent's narration (assistant `message` events) with the tool calls that followed it folded under it
 *   said       a follow-up message a person sent to the running agent (a later `user` message event)
 *   context    what the runtime was actually given (the first `user` message of an attempt: prompt + context), folded
 *   line       a system line: queued, assigned, started, paused / resumed with its cause, finished, errors, notices…
 *   approval   an approval request of this job (the in-thread approval card)
 *   card       a job-level card (verification, integration, deploy, outputs, …): placed by the page, not by time
 *
 * Every string here comes from runtimes, workers, repositories or people: rendered as text only, never as HTML.
 */

export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly at: string;
}

export interface ToolCall {
  readonly key: string;
  readonly callId: string;
  readonly name: string;
  readonly input: string;
  readonly at: string;
  readonly result: ToolResult | null;
}

export interface LineSpec {
  readonly text: string;
  readonly tone: 'neutral' | 'warn';
  readonly icon: IconName;
}

export type JobThreadItem =
  | { readonly kind: 'prompt'; readonly key: string; readonly at: string; readonly text: string }
  | {
      readonly kind: 'agent';
      readonly key: string;
      readonly at: string;
      /** Null: tool calls the agent made before (or without) saying anything. */
      readonly text: string | null;
      readonly tools: readonly ToolCall[];
      readonly attemptNo: number;
    }
  | { readonly kind: 'said'; readonly key: string; readonly at: string; readonly text: string }
  | { readonly kind: 'context'; readonly key: string; readonly at: string; readonly text: string }
  | ({ readonly kind: 'line'; readonly key: string; readonly at: string } & LineSpec)
  | {
      readonly kind: 'approval';
      readonly key: string;
      readonly at: string;
      /** Null while the master has not registered the request yet (the event arrived first). */
      readonly requestId: string | null;
      readonly action: string;
      readonly description: string;
    };

export interface ThreadInput {
  readonly detail: JobDetail;
  readonly events: readonly EventItem[];
  /** Approval mode changes of this job (p6-approval-mode-switch), oldest first. */
  readonly modeChanges?: readonly ApprovalModeChange[] | undefined;
  /** Machine id → name. */
  readonly names?: ReadonlyMap<string, string> | undefined;
  /** The UI language's catalog and locale (Turkish by default). */
  readonly messages?: Messages | undefined;
  readonly locale?: Locale | undefined;
}

const TR = messagesFor('tr');

function s(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

const ARG_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The short argument shown on a folded tool row: the command, path, pattern or URL of the call when its input is
 * JSON (most runtimes), else its first line. At most 120 characters.
 */
export function toolArgs(inputSummary: string): string {
  const raw = inputSummary.trim();
  if (raw.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        for (const k of ARG_KEYS) {
          const x = o[k];
          if (typeof x === 'string' && x.trim() !== '') return clip(x, 120);
          if (Array.isArray(x) && x.every((y) => typeof y === 'string')) return clip(x.join(' '), 120);
        }
        const first = Object.values(o).find((x) => typeof x === 'string' && x.trim() !== '');
        if (typeof first === 'string') return clip(first, 120);
        return '';
      }
    } catch {
      // A summary cut mid-JSON: show its beginning.
    }
  }
  const line = raw.split('\n').find((l) => l.trim() !== '') ?? '';
  return clip(line, 120);
}

/** The result column of a folded tool row: "çalışıyor", "hata", "84 satır" or the result's short first line. */
export function toolStatus(
  call: Pick<ToolCall, 'result'>,
  m: Messages = TR,
): { text: string; tone: 'muted' | 'ok' | 'red' } {
  const w = m.job.tool;
  const r = call.result;
  if (r === null) return { text: w.running, tone: 'muted' };
  if (!r.ok) return { text: w.error, tone: 'red' };
  const lines = r.output.split('\n').filter((l) => l.trim() !== '');
  if (lines.length > 1) return { text: w.lines({ n: lines.length }), tone: 'ok' };
  const one = lines[0]?.trim() ?? '';
  return { text: one === '' ? w.ok : clip(one, 48), tone: 'ok' };
}

// ------------------------------------------------------------------------------------------------ transitions

export type PauseCause = 'approval' | 'usage_limit' | 'worker_restart' | 'account_switch';

/**
 * p13-runtime-accounts: an automatic or manual account switch in a transition reason, in Turkish — "Kişisel Max
 * hesabı limitte → Şirket Team hesabıyla sürdü", "Hesap elle değiştirildi → Şirket Team". Null when the reason is not
 * about an account switch.
 */
export function accountSwitchText(reason: string | null, m: Messages = TR): string | null {
  if (reason === null) return null;
  const auto =
    /usage limit on [^(]*\(account (.+?) on [^)]+\); continuing with account (.+?)(?: on (\S+) as a new attempt| in the same workspace|$)/.exec(
      reason,
    );
  if (auto !== null) {
    return m.job.thread.autoSwitch({ from: auto[1] ?? '', to: auto[2] ?? '', machine: auto[3] ?? null });
  }
  const manual =
    /account switch by a person: continuing with account (.+?)(?: on (\S+)| in the same workspace|$)/.exec(
      reason,
    );
  if (manual !== null) return m.job.thread.manualSwitch({ to: manual[1] ?? '' });
  return null;
}

/** Why a job paused: the episode's own cause when it is this pause, else read from the transition reason. */
export function pauseCause(t: Transition, detail: JobDetail): PauseCause {
  const p = detail.pause;
  if (p !== null && Date.parse(t.occurredAt) >= Date.parse(p.requestedAt) - 1000) return p.cause;
  const r = (t.reason ?? '').toLowerCase();
  if (/usage[_ ]?limit|rate limit/.test(r)) return 'usage_limit';
  if (/restart/.test(r)) return 'worker_restart';
  return 'approval';
}

function machineOf(t: Transition, detail: JobDetail, names: ReadonlyMap<string, string>): string | null {
  let id: string | null = null;
  if (t.actor.type === 'worker' && t.actor.id !== null) id = t.actor.id;
  else if (t.epoch !== null) id = detail.leases.find((l) => l.epoch === t.epoch)?.workerId ?? null;
  if (id === null) return null;
  return names.get(id) ?? id;
}

function reasonText(t: Transition, detail: JobDetail, runtime: string | null, locale: Locale): string {
  if (t.reason === null || t.reason.trim() === '') return '';
  // p14-i18n-reasons: in the UI language, like the line around it.
  const info = describeReason(t.reason, { runtime }, { locale, params: transitionReasonParams(detail, t) });
  return info.known ? info.sentence : info.raw.trim();
}

/**
 * One system line for a state change, or null for a step the thread does not show (DRAFT). `m` / `locale`: the UI
 * language (Turkish by default).
 */
export function transitionLine(
  t: Transition,
  detail: JobDetail,
  names: ReadonlyMap<string, string> = new Map(),
  m: Messages = TR,
  locale: Locale = 'tr',
): LineSpec | null {
  const w = m.job.thread;
  const machine = machineOf(t, detail, names);
  const runtime = typeof detail.job.spec.runtime === 'string' ? detail.job.spec.runtime : null;
  const reason = (): string => reasonText(t, detail, runtime, locale);
  const switched = accountSwitchText(t.reason, m);
  if (switched !== null) return { text: switched, tone: 'neutral', icon: 'key' };
  switch (t.to) {
    case 'DRAFT':
      return null;
    case 'QUEUED':
      if (t.from === 'PAUSED') return { text: w.restarted, tone: 'neutral', icon: 'retry' };
      return t.from === 'RETRY_WAIT' || t.from === 'LOST'
        ? { text: w.requeued, tone: 'neutral', icon: 'retry' }
        : { text: w.queued, tone: 'neutral', icon: 'clock' };
    case 'RESERVED':
      if (t.from === 'PAUSED') return { text: w.resumed({ machine }), tone: 'neutral', icon: 'retry' };
      return {
        text: w.assigned({ machine }),
        tone: 'neutral',
        icon: 'cpu',
      };
    case 'STARTING':
      return { text: w.starting({ machine }), tone: 'neutral', icon: 'cpu' };
    case 'RUNNING':
      return { text: w.started({ machine }), tone: 'neutral', icon: 'retry' };
    case 'VERIFYING':
      return { text: w.verifying, tone: 'neutral', icon: 'checkc' };
    case 'AWAITING_APPROVAL':
      return { text: w.awaiting, tone: 'neutral', icon: 'shield' };
    case 'SUCCEEDED':
      return {
        text: t.from === 'AWAITING_APPROVAL' ? w.accepted : w.succeeded,
        tone: 'neutral',
        icon: 'checkc',
      };
    case 'RETRY_WAIT':
      return {
        text: w.retryWait({ reason: reason() }),
        tone: 'neutral',
        icon: 'clock',
      };
    case 'FAILED':
      return { text: w.failed({ reason: reason() }), tone: 'warn', icon: 'xc' };
    case 'CANCELLING':
      return { text: w.cancelRequested, tone: 'neutral', icon: 'xc' };
    case 'CANCELLED':
      return { text: w.cancelled, tone: 'neutral', icon: 'xc' };
    case 'BLOCKED':
      return {
        text: w.blocked({ reason: reason() }),
        tone: 'warn',
        icon: 'pause',
      };
    case 'LOST':
      return {
        text: w.lost({ machine }),
        tone: 'warn',
        icon: 'cpu',
      };
    case 'PAUSED':
      if (t.from === 'RESERVED' || t.from === 'LOST')
        return { text: w.pausedAgain, tone: 'neutral', icon: 'pause' };
      return {
        text: w.paused({ cause: w.cause[pauseCause(t, detail)] }),
        tone: 'neutral',
        icon: 'pause',
      };
    default:
      return { text: t.to, tone: 'neutral', icon: 'clock' };
  }
}

// ------------------------------------------------------------------------------------------------ merge

interface Timed {
  readonly at: string;
  /** Tie-break between sources at the same instant: state changes before what happened in them. */
  readonly rank: number;
}

/**
 * Merges lists that are each already in order (transitions by time, events by stream sequence) by time, keeping each
 * list's own order — a worker clock a little ahead of the master never reorders the agent's own events.
 */
export function mergeByTime<T extends Timed>(lists: readonly (readonly T[])[]): T[] {
  const idx = lists.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let best = -1;
    let bestAt = Infinity;
    let bestRank = Infinity;
    lists.forEach((l, i) => {
      const x = l[idx[i] ?? 0];
      if (x === undefined) return;
      const at = Date.parse(x.at);
      const t = Number.isNaN(at) ? 0 : at;
      if (t < bestAt || (t === bestAt && x.rank < bestRank)) {
        best = i;
        bestAt = t;
        bestRank = x.rank;
      }
    });
    if (best < 0) return out;
    const list = lists[best];
    const i = idx[best] ?? 0;
    const x = list?.[i];
    if (x !== undefined) out.push(x);
    idx[best] = i + 1;
  }
}

type Piece =
  | (Timed & { readonly p: 'line'; readonly key: string; readonly line: LineSpec })
  | (Timed & { readonly p: 'event'; readonly e: EventItem })
  | (Timed & {
      readonly p: 'approval';
      readonly key: string;
      readonly requestId: string;
      readonly action: string;
      readonly description: string;
    });

const MODE_KEY: Readonly<Record<string, keyof Messages['job']['thread']['modes']>> = {
  'ask-sensitive': 'askSensitive',
  'ask-all': 'askAll',
  'deny-sensitive': 'denySensitive',
  'allow-all': 'allowAll',
};

function modeLine(c: ApprovalModeChange, m: Messages): LineSpec {
  const word = (mode: string): string => {
    const k = MODE_KEY[mode];
    return k === undefined ? mode : m.job.thread.modes[k];
  };
  return {
    text: m.job.thread.modeChanged({
      who: c.actor.username,
      from: word(c.from),
      to: word(c.to),
      refused: c.application === 'refused',
    }),
    tone: c.application === 'refused' ? 'warn' : 'neutral',
    icon: 'shield',
  };
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; // i18n-ignore: unit symbol (output kept as before)
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; // i18n-ignore: unit symbol
}

/** A system line for an event that is neither narration, a tool call nor an approval; null to leave it out. */
export function eventLine(e: EventItem, m: Messages = TR): LineSpec | null {
  const w = m.job.thread;
  const p = e.payload;
  switch (e.kind) {
    case 'error': {
      // Job secret references that were not injected: `<names> — <why>`; said in the user's language by code.
      const code = s(p, 'code');
      if (code === 'secret_refs_withheld' || code === 'secret_refs_not_exposed') {
        const names = clip(s(p, 'message').split(' — ')[0] ?? '', 300);
        return {
          text:
            code === 'secret_refs_withheld'
              ? w.secretRefsWithheld({ names })
              : w.secretRefsNotExposed({ names }),
          tone: 'warn',
          icon: 'xc',
        };
      }
      return {
        text: w.error({ code, message: clip(s(p, 'message'), 400) }),
        tone: 'warn',
        icon: 'xc',
      };
    }
    case 'notice':
      return { text: clip(s(p, 'message'), 400), tone: 'neutral', icon: 'bubble' };
    case 'memory':
      return { text: w.memory({ title: clip(s(p, 'title'), 200) }), tone: 'neutral', icon: 'file' };
    case 'artifact': {
      const size = typeof p.sizeBytes === 'number' ? sizeText(p.sizeBytes) : null;
      return { text: w.artifact({ name: clip(s(p, 'name'), 200), size }), tone: 'neutral', icon: 'tray' };
    }
    case 'message':
      // `system` messages (follow-up bookkeeping, runtime notes).
      return s(p, 'role') === 'system'
        ? { text: clip(s(p, 'text'), 400), tone: 'neutral', icon: 'bubble' }
        : null;
    default:
      // status (the transitions say it in words), usage (in the header / Details), unknown kinds.
      return null;
  }
}

/**
 * The thread of one job. Order: the prompt first, then state changes, approval-mode changes and the agent's events
 * merged by time. Consecutive tool calls fold under the narration before them; a tool result folds into its call.
 */
export function buildJobThread(input: ThreadInput): JobThreadItem[] {
  const { detail, events } = input;
  const names = input.names ?? new Map<string, string>();
  const m = input.messages ?? TR;
  const locale = input.locale ?? 'tr';
  const job = detail.job;
  const prompt = typeof job.spec.prompt === 'string' ? job.spec.prompt : '';

  // Transitions (repeats of a retry loop folded into one line).
  const lines: Piece[] = [];
  for (const row of foldTimeline(detail.transitions)) {
    if (row.kind === 'folded') {
      lines.push({
        p: 'line',
        key: `t:${row.id}`,
        at: row.last.occurredAt,
        rank: 0,
        line: {
          text: m.job.thread.folded({ n: row.times }),
          tone: 'neutral',
          icon: 'retry',
        },
      });
      continue;
    }
    const line = transitionLine(row.t, detail, names, m, locale);
    if (line !== null) lines.push({ p: 'line', key: `t:${row.t.id}`, at: row.t.occurredAt, rank: 0, line });
  }
  const modes: Piece[] = (input.modeChanges ?? []).map((c) => ({
    p: 'line',
    key: `mode:${c.id}`,
    at: c.createdAt,
    rank: 1,
    line: modeLine(c, m),
  }));

  // Approvals the job has that no event announced (gate approvals: merge / accept requests, older workers).
  const announced = new Set(
    events
      .filter((e) => e.kind === 'approval_request' && e.approval !== null)
      .map((e) => e.approval?.requestId),
  );
  const gate: Piece[] = detail.approvals
    .filter((a) => !announced.has(a.id))
    .map((a) => ({
      p: 'approval' as const,
      key: `approval:${a.id}`,
      at: a.createdAt,
      rank: 3,
      requestId: a.id,
      action: a.action,
      description: a.summary,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Results pair with their calls (same attempt + callId); results without a call stay lines.
  const results = new Map<string, EventItem>();
  const calls = new Set<string>();
  for (const e of events) {
    const k = `${e.attemptId}:${s(e.payload, 'callId')}`;
    if (e.kind === 'tool_result') results.set(k, e);
    if (e.kind === 'tool_call') calls.add(k);
  }
  const evs: Piece[] = events.map((e) => ({ p: 'event', e, at: e.ts, rank: 2 }));

  const out: JobThreadItem[] = [];
  if (prompt.trim() !== '') out.push({ kind: 'prompt', key: 'prompt', at: job.createdAt, text: prompt });

  const seenUserInAttempt = new Set<string>();
  // The agent turn tool calls attach to while nothing else came between.
  let turn: { idx: number } | null = null;
  const attach = (call: ToolCall, e: EventItem): void => {
    const cur = turn === null ? undefined : out[turn.idx];
    if (cur?.kind === 'agent' && cur.attemptNo === e.attemptNo) {
      out[turn?.idx ?? 0] = { ...cur, tools: [...cur.tools, call] };
      return;
    }
    out.push({
      kind: 'agent',
      key: `ev:${String(e.seq)}`,
      at: e.ts,
      text: null,
      tools: [call],
      attemptNo: e.attemptNo,
    });
    turn = { idx: out.length - 1 };
  };

  for (const piece of mergeByTime<Piece>([lines, modes, evs, gate])) {
    if (piece.p === 'line') {
      out.push({ kind: 'line', key: piece.key, at: piece.at, ...piece.line });
      turn = null;
      continue;
    }
    if (piece.p === 'approval') {
      out.push({
        kind: 'approval',
        key: piece.key,
        at: piece.at,
        requestId: piece.requestId,
        action: piece.action,
        description: piece.description,
      });
      turn = null;
      continue;
    }
    const e = piece.e;
    const p = e.payload;
    switch (e.kind) {
      case 'message': {
        const role = s(p, 'role');
        if (role === 'assistant') {
          const text = s(p, 'text');
          if (text.trim() === '') break;
          out.push({
            kind: 'agent',
            key: `ev:${String(e.seq)}`,
            at: e.ts,
            text,
            tools: [],
            attemptNo: e.attemptNo,
          });
          turn = { idx: out.length - 1 };
          break;
        }
        if (role === 'user') {
          // The first user message of an attempt is the prompt as the runtime got it (with its context).
          if (!seenUserInAttempt.has(e.attemptId)) {
            seenUserInAttempt.add(e.attemptId);
            out.push({ kind: 'context', key: `ev:${String(e.seq)}`, at: e.ts, text: s(p, 'text') });
          } else out.push({ kind: 'said', key: `ev:${String(e.seq)}`, at: e.ts, text: s(p, 'text') });
          turn = null;
          break;
        }
        const line = eventLine(e, m);
        if (line !== null) {
          out.push({ kind: 'line', key: `ev:${String(e.seq)}`, at: e.ts, ...line });
          turn = null;
        }
        break;
      }
      case 'tool_call': {
        const k = `${e.attemptId}:${s(p, 'callId')}`;
        const r = results.get(k);
        attach(
          {
            key: `ev:${String(e.seq)}`,
            callId: s(p, 'callId'),
            name: s(p, 'toolName') || m.job.thread.tool,
            input: s(p, 'inputSummary'),
            at: e.ts,
            result:
              r === undefined
                ? null
                : { ok: r.payload.ok === true, output: s(r.payload, 'outputSummary'), at: r.ts },
          },
          e,
        );
        break;
      }
      case 'tool_result': {
        if (calls.has(`${e.attemptId}:${s(p, 'callId')}`)) break;
        out.push({
          kind: 'line',
          key: `ev:${String(e.seq)}`,
          at: e.ts,
          text: m.job.thread.toolResult({ ok: p.ok === true, output: clip(s(p, 'outputSummary'), 200) }),
          tone: p.ok === true ? 'neutral' : 'warn',
          icon: 'term',
        });
        turn = null;
        break;
      }
      case 'approval_request': {
        const requestId = e.approval?.requestId ?? null;
        out.push({
          kind: 'approval',
          key: requestId === null ? `ev:${String(e.seq)}` : `approval:${requestId}`,
          at: e.ts,
          requestId,
          action: s(p, 'action'),
          description: s(p, 'description'),
        });
        turn = null;
        break;
      }
      default: {
        const line = eventLine(e, m);
        if (line !== null) {
          out.push({ kind: 'line', key: `ev:${String(e.seq)}`, at: e.ts, ...line });
          turn = null;
        }
      }
    }
  }
  // One item per key (an approval announced twice — retried event — stays one card).
  const seen = new Set<string>();
  return out.filter((x) => {
    if (seen.has(x.key)) return false;
    seen.add(x.key);
    return true;
  });
}
