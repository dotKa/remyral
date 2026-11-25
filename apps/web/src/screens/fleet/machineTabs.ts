import { type WorkerOverview } from '../../api/fleet';
import { type QuotaPause } from '../../api/quotas';
import { type WorkerDetail, type WorkerSummary } from '../../api/workers';
import { type ReasonContext, type ReasonParams, runtimeName } from '../../lib/reasons';
import { type MachineTab } from './machineLinks';

/** Which tabs a machine in this state has (a pending or archived machine has nothing to operate). */
export function machineTabs(w: WorkerDetail, isAdmin: boolean): MachineTab[] {
  if (w.archivedAt !== null) return ['overview', 'admin', 'activity'];
  if (w.state === 'pending') return ['overview', 'activity'];
  if (w.state === 'quarantined') return ['overview', 'runtimes', 'admin', 'activity'];
  const out: MachineTab[] = ['overview', 'runtimes', 'tools', 'sandbox'];
  if (isAdmin) out.push('configuration');
  out.push('admin', 'activity');
  return out;
}

interface MachineReason {
  readonly key: string;
  readonly reason: string;
  readonly context: ReasonContext;
  /** p14-i18n-reasons: the reason's params (a compatibility cell's cause). */
  readonly params?: ReasonParams | undefined;
  readonly tone: 'attention' | 'danger' | 'neutral';
  /** A fix on this page (a tab), used when the mapping has none or points back at the machine. */
  readonly tab?: MachineTab;
  /**
   * p17-ui-review: a reason the page itself derives (no reported code): the screen says it from its catalog
   * (`machines.page.local`); `reason` then only keeps the English text for the details line.
   */
  readonly local?: LocalReason;
}

export type LocalReason =
  | { readonly kind: 'policy' }
  | {
      readonly kind: 'release';
      readonly toVersion: string;
      readonly rolledBack: boolean;
      readonly cause: string | null;
      readonly detail: string | null;
    };

/** p17-ui-review: one card per reason, or one card for runtimes reporting the same status (`pin_mismatch` ×3). */
export type MachineReasonCard =
  | { readonly kind: 'one'; readonly item: MachineReason }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly status: string;
      readonly tone: MachineReason['tone'];
      readonly items: readonly MachineReason[];
    };

/**
 * Groups the runtime reasons of one status (two or more runtimes with the same problem) into one card, at the place
 * of the first; everything else stays one card per reason, in order.
 */
export function groupMachineReasons(reasons: readonly MachineReason[]): MachineReasonCard[] {
  const byStatus = new Map<string, MachineReason[]>();
  for (const r of reasons) {
    if (!r.key.startsWith('rt-')) continue;
    const status = statusOf(r);
    byStatus.set(status, [...(byStatus.get(status) ?? []), r]);
  }
  const out: MachineReasonCard[] = [];
  const done = new Set<string>();
  for (const r of reasons) {
    const group = r.key.startsWith('rt-') ? (byStatus.get(statusOf(r)) ?? []) : [];
    if (group.length < 2) {
      out.push({ kind: 'one', item: r });
      continue;
    }
    const status = statusOf(r);
    if (done.has(status)) continue;
    done.add(status);
    out.push({ kind: 'group', key: `rt-group-${status}`, status, tone: r.tone, items: group });
  }
  return out;
}

function statusOf(r: MachineReason): string {
  const i = r.reason.indexOf(':');
  return i < 0 ? r.reason : r.reason.slice(0, i);
}

const FIXABLE = new Set(['not_authenticated', 'pin_mismatch', 'unverified', 'not_allowed', 'degraded']);

/** Why the machine cannot (fully) run work, most important first; empty when it is healthy. */
export function machineReasons(
  w: WorkerSummary,
  o: WorkerOverview | undefined,
  pauses: readonly QuotaPause[],
): MachineReason[] {
  const ctx: ReasonContext = { workerId: w.id, workerName: w.name };
  const out: MachineReason[] = [];
  if (w.archivedAt !== null || w.state === 'pending') return out;
  if (w.state === 'quarantined') {
    out.push({
      key: 'state',
      reason: `quarantined${w.quarantineReason ? `: ${w.quarantineReason}` : ''}`,
      context: ctx,
      tone: 'danger',
    });
    return out;
  }
  if (!w.connected) out.push({ key: 'state', reason: 'offline', context: ctx, tone: 'attention' });
  else if (w.state === 'draining' || w.drainRequestedAt !== null)
    out.push({ key: 'state', reason: 'draining', context: ctx, tone: 'neutral' });
  else if (w.state === 'updating')
    out.push({ key: 'state', reason: 'updating', context: ctx, tone: 'neutral' });
  if (o === undefined) return out;
  if (o.capabilitiesAt === null && w.connected) {
    out.push({ key: 'caps', reason: 'capabilities_unknown', context: ctx, tone: 'attention' });
  }
  let specific = 0;
  for (const c of o.compatibility) {
    if (!FIXABLE.has(c.status)) continue;
    specific += 1;
    out.push({
      key: `rt-${c.runtime}`,
      reason: `${c.status}: ${c.reason}`,
      context: { ...ctx, runtime: c.runtime },
      params: c.params,
      // Degraded = allowed on purpose (runtime policy): information, not something to fix.
      tone: c.status === 'degraded' ? 'neutral' : 'attention',
    });
  }
  const ready = o.compatibility.some((c) => c.status === 'ready' || c.status === 'degraded');
  if (!ready && specific === 0 && o.capabilitiesAt !== null) {
    out.push({ key: 'no-ready', reason: 'no_ready_runtime', context: ctx, tone: 'attention' });
  }
  for (const p of pauses) {
    out.push({
      key: `pause-${p.id}`,
      reason: `provider_paused: ${runtimeName(p.runtime)} usage limit reached — resets at ${new Date(p.resumeAt).toLocaleString()}`,
      context: { ...ctx, runtime: p.runtime },
      tone: 'neutral',
    });
  }
  if (!o.runtimePolicy.inSync && w.connected) {
    out.push({
      key: 'policy',
      reason: 'The machine has not applied its runtime policy yet.',
      context: ctx,
      tone: 'neutral',
      tab: 'sandbox',
      local: { kind: 'policy' },
    });
  }
  const last = o.release.lastAttempt;
  if (last !== null && (last.status === 'failed' || last.status === 'rolled_back')) {
    out.push({
      key: 'release',
      reason: `The update to ${last.toVersion} ${last.status === 'rolled_back' ? 'was rolled back' : 'failed'}${
        last.reason === null ? '' : ` (${last.reason.replaceAll('_', ' ')})`
      }.${last.detail == null || last.detail === '' ? '' : ` ${last.detail}`}`,
      context: ctx,
      // p17-worker-managed: a rollback is something to look at (and fix on the Admin tab: retry, pin, roll back).
      tone: 'attention',
      tab: 'admin',
      local: {
        kind: 'release',
        toVersion: last.toVersion,
        rolledBack: last.status === 'rolled_back',
        cause: last.reason,
        detail: last.detail == null || last.detail === '' ? null : last.detail,
      },
    });
  }
  return out;
}
