import type { Messages } from '@remyral/i18n';
import { type DecisionRule, kindText, type OpsAction } from '../../../../api/deploy';
import type { Tone } from '../../../tone';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy: the wording of the classic deploy texts (`api/deploy.ts`
 * `decisionText` / `opsStatusText` / `kindText`). Same meaning, same cases; the master's own refusal reason is shown
 * as it phrased it. p14-i18n-screens-c: the words come from `projectTabs.deployText` (the "…Tr" helpers are gone).
 */

export type DeployWords = Messages['projectTabs']['deployText'];

export function ruleText(t: DeployWords, r: DecisionRule): string {
  return t.rule[r];
}

export function ruleOptions(t: DeployWords): readonly (readonly [string, string])[] {
  return (['auto', 'approval', 'approval_step_up'] as const).map((r) => [r, t.rule[r]] as const);
}

const KIND_KEY: Readonly<Record<string, keyof DeployWords['kind']>> = {
  'coolify.deploy': 'coolifyDeploy',
  'coolify.restart': 'coolifyRestart',
  'coolify.rollback': 'coolifyRollback',
  'pages.deploy': 'pagesDeploy',
  'pages.rollback': 'pagesRollback',
  'dns.upsert': 'dnsUpsert',
  'dns.delete': 'dnsDelete',
  'pages.create_project': 'pagesCreateProject',
  'pages.add_domain': 'pagesAddDomain',
  'pages.publish': 'pagesPublish',
  'tunnel.open': 'tunnelOpen',
  'tunnel.close': 'tunnelClose',
  'tunnel.extend': 'tunnelExtend',
};

/** The name of an ops action kind (the classic English name for a kind the catalog does not know). */
export function kindLabel(t: DeployWords, kind: string): string {
  const key = KIND_KEY[kind];
  return key === undefined ? kindText(kind) : t.kind[key];
}

/** How the policy decision reads (classic `decisionText`). */
export function decisionLabel(t: DeployWords, decision: string, reason?: string): string {
  switch (decision) {
    case 'auto':
    case 'approval':
    case 'approval_step_up':
      return t.decision[decision];
    case 'refused':
      return t.refused({ reason: reason ?? '' });
    default:
      return decision;
  }
}

/** The status line of an ops action (classic `opsStatusText`): the decision while it waits, then what happened. */
export function statusLabel(t: DeployWords, state: string, decision: string, reason?: string): string {
  switch (state) {
    case 'awaiting_approval':
      return decisionLabel(t, decision, reason);
    case 'executing':
    case 'deploying':
    case 'succeeded':
    case 'failed':
    case 'denied':
    case 'expired':
      return t.state[state];
    case 'refused':
      return t.refused({ reason: reason ?? '' });
    default:
      return state;
  }
}

/** Tone of a requested action's result (red only when refused / failed, as classic). */
export function resultTone(a: OpsAction): Tone {
  if (a.state === 'refused' || a.state === 'failed') return 'red';
  if (a.state === 'awaiting_approval') return 'amber';
  return 'green';
}

/** Bytes as B / KB / MB (binary units, the classic `bytesText`; the unit symbols read the same in both languages). */
export function bytesText(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n))
    return typeof n === 'string' ? n : n === null || n === undefined ? '—' : JSON.stringify(n);
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
