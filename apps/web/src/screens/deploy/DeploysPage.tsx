import { type OpsAction } from '../../api/deploy';
import { show } from './diffText';

/** p6-deploy-pipeline: a link to the automation / workflow run that requested the action (null: none). */
export function sourceLink(
  a: Pick<OpsAction, 'source'>,
): { readonly href: string; readonly label: string } | null {
  const s = a.source;
  if (s === null) return null;
  if (typeof s.automationId === 'string' && /^[0-9a-f-]{36}$/i.test(s.automationId)) {
    return { href: `/automations/${s.automationId}?tab=runs`, label: 'Open the automation' };
  }
  if (typeof s.workflowRunId === 'string' && /^[0-9a-f-]{36}$/i.test(s.workflowRunId)) {
    const node = typeof s.nodeId === 'string' ? ` (step ${s.nodeId})` : '';
    return { href: `/jobs/workflows/${s.workflowRunId}`, label: `Open the workflow run${node}` };
  }
  if (typeof s.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(s.jobId)) {
    return { href: `/jobs/${s.jobId}`, label: 'Open the job' };
  }
  return null;
}

export function targetText(a: Pick<OpsAction, 'target'>): string {
  const t = a.target;
  if (Array.isArray(t.resources)) {
    return t.resources
      .map((r) => {
        const o = r as Record<string, unknown>;
        return show(o.name ?? o.uuid);
      })
      .join(', ');
  }
  // p8-preview-tunnels: tunnel.open / close / extend name the preview's host.
  if (typeof t.hostname === 'string') return `Preview ${t.hostname}`;
  if (typeof t.name === 'string') return `${show(t.type)} ${t.name}`;
  if (typeof t.project === 'string')
    return `Pages ${t.project}${typeof t.branch === 'string' ? ` (${t.branch})` : ''}`;
  return '—';
}
