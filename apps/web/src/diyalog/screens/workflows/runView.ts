import type { Formatter, Messages } from '@remyral/i18n';
import type { RunEdge, WorkflowNode } from '../../../api/workflows';
import type { Tone } from '../../tone';
import type { IconName } from '../../icons';
import { nodeTypeText } from './nodeCatalog';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.5): the run view's words for engine-2 nodes — a
 * typed node's name, a wait ("23:00'te devam edecek"), the ports a run's links use. Light (no graph library): the
 * eager run page and the lazy run graph both use it.
 */

export interface V2Look {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
}

/** A typed node's display name (its catalog label), or the AI role. */
export function nodeName(n: WorkflowNode, t: Messages): string {
  if (n.type === 'ai.step' || n.type === '') return n.role;
  return nodeTypeText(t.workflows, n.type)?.label ?? n.type;
}

/** The engine-2 look of a waiting / retrying node run, or null (the engine-1 look applies). */
export function v2Look(n: WorkflowNode, t: Messages, fmt: Formatter): V2Look | null {
  const r = t.workflows.run;
  if (n.nodeRunState === 'waiting' && n.waitKind === 'timer')
    return {
      label:
        n.dueAt === null || n.dueAt === undefined ? r.waiting : r.resumesAt({ time: fmt.dateTime(n.dueAt) }),
      tone: 'violet',
      icon: 'clock',
    };
  if (n.nodeRunState === 'waiting' && n.waitKind === 'child_run')
    return { label: r.waitingChild, tone: 'violet', icon: 'branch' };
  // 14.2: webhook waits (until their timeout) and master integrations waiting for their result.
  if (n.nodeRunState === 'waiting' && n.waitKind === 'webhook')
    return {
      label:
        n.dueAt === null || n.dueAt === undefined
          ? r.waitingWebhook
          : r.waitingWebhookUntil({ time: fmt.dateTime(n.dueAt) }),
      tone: 'violet',
      icon: 'globe',
    };
  if (n.nodeRunState === 'waiting' && n.type !== 'ai.step' && n.waitKind === 'side_effect')
    return { label: r.waitingSideEffect, tone: 'teal', icon: 'retry' };
  if (n.nodeRunState === 'waiting' && n.waitKind === 'ops_action')
    return { label: r.waitingOps, tone: 'amber', icon: 'send' };
  if (n.nodeRunState === 'waiting' && n.waitKind === 'job')
    return { label: r.waitingJob, tone: 'teal', icon: 'jobs' };
  if (n.nodeRunState === 'retry_wait')
    return {
      label: n.dueAt === null || n.dueAt === undefined ? r.retrying : r.retryAt({ time: fmt.time(n.dueAt) }),
      tone: 'amber',
      icon: 'retry',
    };
  if (n.nodeRunState === 'running' && n.type !== 'ai.step')
    return { label: r.running, tone: 'teal', icon: 'retry' };
  return null;
}

/** Ports of each node as a run's links use them (engine 2), for the run graph's handles. */
export function runPorts(
  nodes: readonly WorkflowNode[],
  edges: readonly RunEdge[],
): Map<string, { in: string[]; out: string[] }> | null {
  if (!edges.some((e) => e.fromPort !== undefined || e.toPort !== undefined)) return null;
  const m = new Map(nodes.map((n) => [n.id, { in: [] as string[], out: [] as string[] }]));
  for (const e of edges) {
    const a = m.get(e.from);
    const b = m.get(e.to);
    const fp = e.fromPort ?? 'out';
    const tp = e.toPort ?? 'in';
    if (a !== undefined && !a.out.includes(fp)) a.out.push(fp);
    if (b !== undefined && !b.in.includes(tp)) b.in.push(tp);
  }
  for (const v of m.values()) {
    if (v.in.length === 0) v.in.push('in');
    if (v.out.length === 0) v.out.push('out');
  }
  return m;
}
