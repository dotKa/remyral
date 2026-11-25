import type { ApprovalRequest } from '../../api/approvals';
import type { Automation } from '../../api/automations';
import { kindText, type OpsAction } from '../../api/deploy';
import type { WorkerOverview } from '../../api/fleet';
import type { JobSummary } from '../../api/jobs';
import type { PendingQuestion } from '../../api/questionsPending';
import { type MemoryRecord, recordHref, TYPE_LABEL } from '../../api/memoryRecords';
import type { WorkerSummary } from '../../api/workers';
import type { PendingBackupChange } from '../../api/hostActions';
import type { RecoveryRequest } from '../../api/panelSettings';
import { machineHref, type ReasonContext, type ReasonParams } from '../../lib/reasons';

/**
 * p6-ui-refactor Home "Needs you": everything that waits for a person, each as one sentence plus one fix.
 * Built only from data the existing APIs return (pending approvals, jobs, workers, the fleet overview);
 * pure so it is tested without rendering.
 */
export type NeedsYouItem =
  | {
      readonly kind:
        | 'approval'
        | 'pairing'
        | 'failed'
        | 'failed-more'
        | 'blocked'
        | 'automation'
        | 'deploy'
        | 'memory-review'
        | 'backup-change'
        | 'recovery';
      readonly key: string;
      readonly tone: 'attention' | 'danger';
      readonly sentence: string;
      readonly action: { readonly label: string; readonly href: string };
      /** p17-panel-settings Part 0: the waiting backup change (the summary words it in the user's language). */
      readonly backupChange?: PendingBackupChange;
      /** p17-panel-settings Part 4: the account recovery waiting for this owner's approval. */
      readonly recovery?: RecoveryRequest;
    }
  | {
      /** p14-ask-user: an agent / the assistant waits for this person's answer (the card has the question). */
      readonly kind: 'question';
      readonly key: string;
      readonly tone: 'attention';
      readonly sentence: string;
      readonly action: { readonly label: string; readonly href: string };
      readonly question: PendingQuestion;
    }
  | {
      /** A machine or runtime that cannot run work: rendered through ReasonNotice (reasons.ts). */
      readonly kind: 'reason';
      readonly key: string;
      readonly tone: 'attention' | 'danger';
      readonly reason: string;
      readonly context: ReasonContext;
      /** p14-i18n-reasons: the reason's params (a compatibility cell's cause). */
      readonly params?: ReasonParams | undefined;
    };

export interface HomeData {
  readonly approvals: readonly ApprovalRequest[] | null;
  readonly failed: readonly JobSummary[] | null;
  readonly blocked: readonly JobSummary[] | null;
  readonly workers: readonly WorkerSummary[] | null;
  readonly overview: readonly WorkerOverview[] | null;
  /** Jobs that succeeded or are running: a failure re-run since then (same project + title) no longer needs you. */
  readonly later?: readonly JobSummary[] | null;
  /** p6-automations: automations whose last run failed, or that stopped. */
  readonly automations?: readonly Automation[] | null;
  /** p6-deploy-integrations: ops actions waiting for an approval. */
  readonly opsActions?: readonly OpsAction[] | null;
  /** p11-memory-layers: memory records whose review date has come (`GET /memory-records/review-due`). */
  readonly memoryReviews?: readonly MemoryRecord[] | null;
  /** p14-ask-user: open questions this person may answer (`GET /questions/pending`). */
  readonly questions?: readonly PendingQuestion[] | null;
  /** p17-panel-settings Part 0: backup changes waiting for the host time lock (owners; `GET /backups/pending-changes`). */
  readonly backupChanges?: readonly PendingBackupChange[] | null;
  /** p17-panel-settings Part 4: recoveries of an owner waiting for a second owner (owners; `GET /users/recovery-requests`). */
  readonly recoveries?: readonly RecoveryRequest[] | null;
  /** Item keys this viewer dismissed (per-browser convenience). */
  readonly dismissed?: ReadonlySet<string>;
}

/** At most this many failed jobs are listed one by one; the rest collapse into one "N more" item. */
export const FAILED_LISTED = 3;

function normTitle(t: string): string {
  return t.replace(/\s+/g, ' ').trim();
}

/** Failures in the window that were not re-run successfully (or are not being re-run) afterwards. */
export function openFailures(data: HomeData, now: number): JobSummary[] {
  const later = data.later ?? [];
  return (data.failed ?? [])
    .filter((j) => now - Date.parse(j.stateChangedAt) <= FAILED_WINDOW_MS)
    .filter((j) => !(data.dismissed?.has(`failed:${j.id}`) ?? false))
    .filter(
      (j) =>
        !later.some(
          (l) =>
            l.id !== j.id &&
            l.project === j.project &&
            normTitle(l.title) === normTitle(j.title) &&
            Date.parse(l.createdAt) > Date.parse(j.createdAt),
        ),
    )
    .sort((a, b) => Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt));
}

export const FAILED_WINDOW_MS = 24 * 3600_000;

/**
 * Compatibility statuses of an installed runtime that a person can fix (not "not installed": that is a choice;
 * not "degraded": that is an unproven runtime the owner allowed on purpose).
 */
const FIXABLE_RUNTIME = new Set(['not_authenticated', 'unverified', 'pin_mismatch']);

/** Machines that are part of the fleet and expected to work (not pending, revoked or archived). */
export function isActiveMachine(w: WorkerSummary): boolean {
  return !w.archivedAt && w.state !== 'pending' && w.state !== 'revoked';
}

function quote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** p6-automation-defaults: an unattended automation run paused on a human approval. */
function automationWaiting(a: Automation): NeedsYouItem | null {
  const w = a.waiting;
  if (w === null) return null;
  const cancels =
    w.cancelsAt === null
      ? ''
      : ` It is cancelled at ${new Date(w.cancelsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} without a decision.`;
  return {
    kind: 'automation',
    key: `automation-waiting:${w.runId}`,
    tone: 'attention',
    sentence: `Automation “${quote(a.name)}” in ${a.project} is paused: its run waits for approval (${w.action}).${cancels}`,
    action: { label: 'Review', href: `/approvals/${encodeURIComponent(w.approvalId)}` },
  };
}

export function buildNeedsYou(data: HomeData, now: number): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  // p6-automation-defaults: a pending approval of an automation run is shown as the automation waiting (once).
  const waitingBy = new Map(
    (data.automations ?? []).flatMap((a) => (a.waiting === null ? [] : [[a.waiting.approvalId, a] as const])),
  );

  for (const a of data.approvals ?? []) {
    if (a.status !== 'pending') continue;
    const auto = waitingBy.get(a.id);
    if (auto !== undefined) {
      const item = automationWaiting(auto);
      if (item !== null) out.push(item);
      waitingBy.delete(a.id);
      continue;
    }
    out.push({
      kind: 'approval',
      key: `approval:${a.id}`,
      tone: 'attention',
      sentence:
        a.kind === 'gate'
          ? `A ${a.action === 'git.merge' ? 'merge' : 'protected step'} in ${a.project} waits for your approval: “${quote(a.headline.text)}”.`
          : `A job in ${a.project} asks before it continues: “${quote(a.headline.text)}”.`,
      action: { label: 'Review', href: `/approvals/${encodeURIComponent(a.id)}` },
    });
  }

  // Waiting runs whose approval this viewer's approval list does not show (or could not load).
  for (const a of waitingBy.values()) {
    const item = automationWaiting(a);
    if (item !== null) out.push(item);
  }

  // p14-ask-user: an agent (or the assistant) waits for this person's answer.
  for (const q of data.questions ?? []) {
    const job = q.source === 'job' && q.jobId !== null;
    out.push({
      kind: 'question',
      key: `question:${q.id}`,
      tone: 'attention',
      sentence: job
        ? `The agent of “${quote(q.jobTitle ?? '')}” in ${q.project ?? ''} asks a question.`
        : `The assistant asked a question in “${quote(q.threadTitle ?? '')}”.`,
      action: {
        label: 'Answer',
        href: job ? `/jobs/${encodeURIComponent(q.jobId)}` : `/chat/${encodeURIComponent(q.threadId ?? '')}`,
      },
      question: q,
    });
  }

  // p17-panel-settings Part 0: a new backup encryption key / off-site target waits on the host — the owner confirms it
  // was theirs or cancels it (never dismissible).
  for (const c of data.backupChanges ?? []) {
    out.push({
      kind: 'backup-change',
      key: `backup-change:${c.change}:${c.since}`,
      tone: 'danger',
      sentence:
        c.change === 'recipients'
          ? `A new backup encryption key takes effect on ${c.until.slice(0, 16).replace('T', ' ')} UTC. Not yours? Cancel it.`
          : `Off-site backups move to ${c.target} on ${c.until.slice(0, 16).replace('T', ' ')} UTC. Not yours? Cancel it.`,
      action: { label: 'Review', href: '/settings/backups' },
      backupChange: c,
    });
  }

  // p17-panel-settings Part 4: a recovery of an owner account waits for a second owner (the requester sees it too;
  // the master refuses their own approval).
  for (const r of data.recoveries ?? []) {
    out.push({
      kind: 'recovery',
      key: `recovery:${r.id}`,
      tone: 'attention',
      sentence: `${r.requestedBy ?? 'An owner'} asks for an ${r.action} of the owner account ${r.target.username}.`,
      action: { label: 'Review', href: '/settings/users' },
      recovery: r,
    });
  }

  // p6-deploy-integrations: deploys and DNS changes waiting for a decision.
  for (const a of data.opsActions ?? []) {
    if (a.state !== 'awaiting_approval') continue;
    out.push({
      kind: 'deploy',
      key: `deploy:${a.id}`,
      tone: 'attention',
      sentence: `${kindText(a.kind)}${a.env === null ? '' : ` (${a.env})`} in ${a.project} waits for your approval.`,
      action: { label: 'Review', href: `/deploys/${encodeURIComponent(a.id)}` },
    });
  }

  const failures = openFailures(data, now);
  const listed = failures.length > FAILED_LISTED ? failures.slice(0, FAILED_LISTED - 1) : failures;
  for (const j of listed) {
    out.push({
      kind: 'failed',
      key: `failed:${j.id}`,
      tone: 'danger',
      sentence: `“${quote(j.title)}” failed in ${j.project}.`,
      action: { label: 'Open job', href: `/jobs/${encodeURIComponent(j.id)}` },
    });
  }
  if (failures.length > listed.length) {
    const more = failures.length - listed.length;
    out.push({
      kind: 'failed-more',
      key: 'failed-more',
      tone: 'danger',
      sentence: `${String(more)} more ${more === 1 ? 'job' : 'jobs'} failed in the last 24 hours.`,
      action: { label: 'See failed jobs', href: '/jobs?state=FAILED' },
    });
  }

  for (const a of data.automations ?? []) {
    const lastState = a.lastRun?.state ?? null;
    const lastFailed = lastState === 'failed' || lastState === 'error';
    if (a.state === 'failed') {
      out.push({
        kind: 'automation',
        key: `automation:${a.id}`,
        tone: 'danger',
        sentence: `Automation “${quote(a.name)}” in ${a.project} stopped: the user it runs as may no longer start it.`,
        action: { label: 'Open', href: `/automations/${encodeURIComponent(a.id)}?tab=settings` },
      });
    } else if (a.state === 'active' && lastFailed) {
      out.push({
        kind: 'automation',
        key: `automation:${a.id}`,
        tone: 'danger',
        sentence: `Automation “${quote(a.name)}” in ${a.project}: its last run ${lastState === 'error' ? 'could not start' : 'failed'}.`,
        action: { label: 'Open', href: `/automations/${encodeURIComponent(a.id)}?tab=runs` },
      });
    }
  }

  for (const j of data.blocked ?? []) {
    out.push({
      kind: 'blocked',
      key: `blocked:${j.id}`,
      tone: 'attention',
      sentence: `“${quote(j.title)}” cannot start: no machine can run it yet.`,
      action: { label: 'See why', href: `/jobs/${encodeURIComponent(j.id)}` },
    });
  }

  const workers = data.workers ?? [];
  for (const w of workers) {
    if (w.state !== 'pending' || w.pairingExpired || w.archivedAt) continue;
    out.push({
      kind: 'pairing',
      key: `pairing:${w.id}`,
      tone: 'attention',
      sentence: `${w.name} wants to join. Pair it with the code it shows.`,
      action: { label: 'Pair machine', href: machineHref(w.id) },
    });
  }

  // p11-memory-layers: rules, facts, decisions and lessons someone should look at again.
  for (const r of data.memoryReviews ?? []) {
    if (r.status !== 'active') continue;
    const where = r.scope.startsWith('user:')
      ? ' (personal rule)'
      : r.project !== null
        ? ` (project ${r.project})`
        : ' (global)';
    out.push({
      kind: 'memory-review',
      key: `memory-review:${r.id}`,
      tone: 'attention',
      sentence: `Review this ${TYPE_LABEL[r.type].toLowerCase()}: “${quote(r.title)}”${where}.`,
      action: { label: 'Review', href: recordHref(r) },
    });
  }

  const byId = new Map(workers.map((w) => [w.id, w] as const));
  for (const o of data.overview ?? []) {
    const w = byId.get(o.id);
    if (w === undefined || !isActiveMachine(w)) continue;
    const ctx = { workerId: w.id, workerName: w.name };
    if (w.state === 'quarantined') {
      out.push({
        kind: 'reason',
        key: `machine:${w.id}`,
        tone: 'danger',
        reason: `quarantined${w.quarantineReason ? `: ${w.quarantineReason}` : ''}`,
        context: ctx,
      });
      continue;
    }
    // Only machines that have reported what they can run; offline machines show under "Machines".
    if (o.capabilitiesAt === null || !w.connected) continue;
    let specific = 0;
    for (const c of o.compatibility) {
      if (!FIXABLE_RUNTIME.has(c.status)) continue;
      specific += 1;
      out.push({
        kind: 'reason',
        key: `runtime:${w.id}:${c.runtime}`,
        tone: 'attention',
        reason: `${c.status}: ${c.reason}`,
        context: { ...ctx, runtime: c.runtime },
        params: c.params,
      });
    }
    const ready = o.compatibility.some((c) => c.status === 'ready' || c.status === 'degraded');
    if (!ready && specific === 0) {
      out.push({
        kind: 'reason',
        key: `machine:${w.id}`,
        tone: 'attention',
        reason: 'no_ready_runtime',
        context: ctx,
      });
    }
  }

  // Status rows the viewer chose to ignore (per browser, they come back after the dismissal expires).
  // A waiting backup change (p17-panel-settings Part 0) is never hidden.
  return out.filter(
    (i) =>
      i.key.startsWith('failed:') || i.kind === 'backup-change' || !(data.dismissed?.has(i.key) ?? false),
  );
}
