import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import type { JobDetail } from '../../api/jobs';
import { HH_MM, TR_FORMAT } from '../common/time';

/**
 * p12-diyalog panels (direction change 2026-10-19, docs/design/p12-diyalog.md §10): the job's step progress bar.
 * Pure — from the job record (transitions, approvals, pause) and the facts its side panels already read
 * (verification, integration / merge, deploy-on-success), so the bar adds no request of its own.
 *
 *   Taslak → Kuyruk → Başladı → (Onay) → Doğrulama → Birleştirme / PR → Yayın → Bitti
 *
 * Steps that do not apply to this job are left out (no draft, no approval, no verification, no integration, no
 * deploy). Every step has a status (done · current · needs a person · paused · failed · not yet · skipped) and a short
 * note (when it was reached, why it waits); the bar pairs each status with an icon and a word.
 */

export type StepKey = 'draft' | 'queue' | 'start' | 'approval' | 'verify' | 'merge' | 'deploy' | 'done';
export type StepStatus = 'done' | 'current' | 'needs' | 'paused' | 'failed' | 'todo' | 'skipped';

export interface JobStep {
  readonly key: StepKey;
  readonly label: string;
  readonly status: StepStatus;
  readonly note: string | null;
}

/** What the side panels learned (undefined: not read yet / unknown; null: the job has none). */
export interface JobFacts {
  readonly verification?: string | null | undefined;
  readonly integration?: { readonly state: string; readonly pr: boolean } | null | undefined;
  readonly deploy?: { readonly state: string; readonly waiting: boolean } | null | undefined;
}

const ORDER: readonly StepKey[] = [
  'draft',
  'queue',
  'start',
  'approval',
  'verify',
  'merge',
  'deploy',
  'done',
];

const VERIFY_DONE = new Set(['passed', 'warned', 'skipped']);
const VERIFY_FAILED = new Set(['failed', 'error']);
const MERGE_RUNNING = new Set(['merging', 'resolving', 'verifying', 'fixing', 'publishing']);
const MERGE_NEEDS = new Set(['ready', 'needs_human']);

const TR = messagesFor('tr');

function hhmm(iso: string | undefined, f: Formatter): string | null {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return f.dateWith(t, HH_MM);
}

function pauseNote(cause: string, w: Messages['job']['steps']): string {
  if (cause === 'approval' || cause === 'usage_limit' || cause === 'worker_restart') return w.pause[cause];
  return w.pause.other;
}

/** The phase a state belongs to (where a failure happened). */
function phaseOf(state: string | null | undefined): StepKey {
  switch (state) {
    case 'DRAFT':
      return 'draft';
    case 'QUEUED':
    case 'RETRY_WAIT':
    case 'RESERVED':
    case 'BLOCKED':
      return 'queue';
    case 'VERIFYING':
      return 'verify';
    case 'AWAITING_APPROVAL':
      return 'approval';
    default:
      return 'start';
  }
}

/** The steps of a job; `m` / `f`: the catalog and formatters of the UI language (Turkish by default). */
export function jobSteps(
  detail: JobDetail,
  state: string,
  facts: JobFacts = {},
  m: Messages = TR,
  f: Formatter = TR_FORMAT,
): JobStep[] {
  const w = m.job.steps;
  const n = w.note;
  const tr = detail.transitions;
  const reachedAt = (to: string): string | undefined => tr.find((t) => t.to === to)?.occurredAt;
  const tos = new Set(tr.map((t) => t.to));
  const pending = detail.approvals.some((a) => a.status === 'pending');
  const decided = detail.approvals.filter((a) => a.status !== 'pending');
  const pause = detail.pause;
  const integ = facts.integration ?? null;
  const dep = facts.deploy ?? null;
  const ver = facts.verification ?? null;

  const has: Record<StepKey, boolean> = {
    draft: tos.has('DRAFT') || state === 'DRAFT',
    queue: true,
    start: true,
    approval:
      detail.approvals.length > 0 ||
      tos.has('AWAITING_APPROVAL') ||
      state === 'AWAITING_APPROVAL' ||
      (pause !== null && pause.cause === 'approval'),
    verify: tos.has('VERIFYING') || state === 'VERIFYING' || ver !== null,
    merge: integ !== null,
    deploy: dep !== null,
    done: true,
  };
  const keys = ORDER.filter((k) => has[k]);

  // Where the job is now, and how.
  let current: StepKey;
  let status: StepStatus = 'current';
  let note: string | null = null;
  switch (state) {
    case 'DRAFT':
      current = 'draft';
      note = n.notApproved;
      break;
    case 'QUEUED':
    case 'RETRY_WAIT':
      current = 'queue';
      note = state === 'RETRY_WAIT' ? n.retry : n.waitingMachine;
      break;
    case 'RESERVED':
      current = 'queue';
      note = n.assigned;
      break;
    case 'BLOCKED':
      current = 'queue';
      status = 'paused';
      note = n.blocked;
      break;
    case 'STARTING':
      current = 'start';
      note = n.preparing;
      break;
    case 'RUNNING':
      if (pending) {
        current = 'approval';
        status = 'needs';
        note = n.decision;
      } else {
        current = 'start';
        note = n.running;
      }
      break;
    case 'PAUSED': {
      const cause = pause?.cause ?? 'approval';
      current = cause === 'approval' && has.approval ? 'approval' : 'start';
      status = 'paused';
      note = pauseNote(cause, w);
      break;
    }
    case 'VERIFYING':
      current = 'verify';
      note = n.checking;
      break;
    case 'AWAITING_APPROVAL':
      if (integ !== null && integ.state !== 'merged') {
        current = 'merge';
        note = n.mergeDecision;
      } else {
        current = 'approval';
        note = n.acceptance;
      }
      status = 'needs';
      break;
    case 'CANCELLING':
      current = phaseOf(tr.at(-1)?.from);
      note = n.cancelling;
      break;
    case 'SUCCEEDED':
      current = 'done';
      status = 'done';
      note = hhmm(reachedAt('SUCCEEDED'), f);
      break;
    case 'FAILED':
    case 'LOST': {
      const last = [...tr].reverse().find((t) => t.to === state);
      current = phaseOf(last?.from);
      if (!keys.includes(current)) current = 'start';
      status = 'failed';
      note = state === 'LOST' ? n.lost : n.failed;
      break;
    }
    case 'CANCELLED': {
      const last = [...tr].reverse().find((t) => t.to === 'CANCELLED');
      current = phaseOf(last?.from === 'CANCELLING' ? tr.at(-2)?.from : last?.from);
      if (!keys.includes(current)) current = 'queue';
      status = 'skipped';
      note = n.cancelled;
      break;
    }
    default:
      current = 'start';
      note = state;
  }
  const at = keys.indexOf(current);

  const reachedNote: Partial<Record<StepKey, string | null>> = {
    draft: hhmm(reachedAt('DRAFT') ?? detail.job.createdAt, f),
    queue: hhmm(reachedAt('QUEUED'), f),
    start: hhmm(reachedAt('RUNNING') ?? reachedAt('STARTING'), f),
    approval:
      decided.length === 0
        ? null
        : decided.some((a) => a.status === 'denied' || a.status === 'rejected')
          ? n.denied
          : n.approved,
    verify: hhmm(reachedAt('VERIFYING'), f),
  };

  const steps = keys.map((key, i): JobStep => {
    const label =
      key === 'merge'
        ? integ?.pr === true
          ? 'PR'
          : w.label.merge
        : key === 'done'
          ? state === 'FAILED' || state === 'LOST'
            ? w.failed
            : state === 'CANCELLED'
              ? w.cancelled
              : w.label.done
          : w.label[key];
    if (i === at) return { key, label, status, note };
    if (i < at) return { key, label, status: 'done', note: reachedNote[key] ?? null };
    // After the current step. A terminal job never gets there, except the after-run steps below.
    const terminalBad = state === 'FAILED' || state === 'LOST' || state === 'CANCELLED';
    if (key === 'done' && terminalBad)
      return { key, label, status: state === 'CANCELLED' ? 'skipped' : 'failed', note: null };
    return { key, label, status: terminalBad ? 'skipped' : 'todo', note: null };
  });

  // The steps the panels know better than the state machine (they run after or beside it).
  return steps.map((s) => {
    if (s.key === 'verify' && ver !== null) {
      if (VERIFY_FAILED.has(ver)) return { ...s, status: 'failed', note: n.verifyFailed };
      if (VERIFY_DONE.has(ver) && s.status !== 'current')
        return {
          ...s,
          status: 'done',
          note: ver === 'warned' ? n.verifyWarned : ver === 'skipped' ? n.verifySkipped : n.verifyPassed,
        };
      if ((ver === 'checking' || ver === 'verifying') && s.status !== 'failed')
        return { ...s, status: 'current', note: n.checking };
    }
    if (s.key === 'merge' && integ !== null) {
      if (integ.state === 'merged') return { ...s, status: 'done', note: n.merged };
      if (integ.state === 'failed') return { ...s, status: 'failed', note: n.failed };
      if (integ.state === 'cancelled') return { ...s, status: 'skipped', note: n.cancelled };
      if (MERGE_NEEDS.has(integ.state))
        return {
          ...s,
          status: 'needs',
          note: integ.state === 'ready' ? n.mergeDecision : n.needsYou,
        };
      if (MERGE_RUNNING.has(integ.state)) return { ...s, status: 'current', note: n.ongoing };
    }
    if (s.key === 'deploy' && dep !== null) {
      if (dep.state === 'succeeded') return { ...s, status: 'done', note: n.deployed };
      if (dep.state === 'failed' || dep.state === 'refused')
        return { ...s, status: 'failed', note: dep.state === 'refused' ? n.denied : n.failed };
      if (dep.state === 'skipped') return { ...s, status: 'skipped', note: n.notDeployed };
      if (dep.waiting) return { ...s, status: 'needs', note: n.waitingApproval };
      if (state === 'SUCCEEDED') return { ...s, status: 'current', note: n.deploying };
    }
    return s;
  });
}
