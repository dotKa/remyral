import type { DeployEnv, DeployPolicy, OpsKind, PolicyOutcome } from './model.js';

/**
 * p6-deploy-integrations (ADR-0028 §Policy): pure decisions — who/what may run without a human, which records and
 * resources are never touched. No I/O; the service gathers the facts and calls these.
 */

export interface PolicyDecision {
  readonly decision: PolicyOutcome;
  readonly reason: string;
}

export interface PolicyFacts {
  /** Why the target is protected / on the deny-list (refused regardless of configuration), or null. */
  readonly refusal: string | null;
}

/**
 * The decision matrix:
 *
 * | kind                                      | preview                 | production                 |
 * | coolify.deploy / restart / rollback, pages | policy.previewDeploy (auto default) | policy.productionDeploy (never auto; step-up default) |
 * | dns.upsert / dns rollback                  | policy.dnsChange (never auto; approval default)               |
 * | dns.delete                                 | approval + step-up, always                                    |
 * | pages.create_project / pages.add_domain    | policy.pagesProject (approval default); with a DNS change: stricter of it and dnsChange |
 * | protected record / control-plane resource  | refused, always                                               |
 */
export function decide(
  kind: OpsKind,
  env: DeployEnv | null,
  policy: DeployPolicy,
  facts: PolicyFacts,
  opts: {
    readonly rollbackOfDelete?: boolean;
    readonly withDns?: boolean;
    /**
     * p10-publish-bundle: the DNS change creates/updates a CNAME whose content is the `pages.dev` name of one of the
     * project's own Pages projects (inside an allowed zone) — the only DNS change "Run at once" covers.
     */
    readonly ownPagesCname?: boolean;
  } = {},
): PolicyDecision {
  if (facts.refusal !== null) return { decision: 'refused', reason: facts.refusal };
  if (kind === 'pages.create_project' || kind === 'pages.add_domain') {
    return pagesProjectDecision(kind, policy, opts.withDns === true);
  }
  if (kind === 'dns.delete') {
    return {
      decision: 'approval_step_up',
      reason: 'Deleting a DNS record always needs approval with step-up.',
    };
  }
  if (kind === 'dns.upsert') {
    if (opts.rollbackOfDelete === true) {
      return { decision: 'approval', reason: 'Restoring a deleted DNS record needs approval.' };
    }
    if (policy.dnsChange === 'auto') {
      return opts.ownPagesCname === true
        ? {
            decision: 'auto',
            reason:
              'A CNAME to one of this project’s own Pages projects runs at once (project policy: DNS changes run at once).',
          }
        : {
            decision: 'approval',
            reason:
              'Only CNAME records pointing at this project’s own Pages projects run at once; this DNS change needs approval.',
          };
    }
    return policy.dnsChange === 'approval_step_up'
      ? { decision: 'approval_step_up', reason: 'DNS changes need approval with step-up (project policy).' }
      : { decision: 'approval', reason: 'DNS changes need approval (project policy).' };
  }
  if (env === 'production') {
    return policy.productionDeploy === 'approval'
      ? { decision: 'approval', reason: 'Production deploys need approval (project policy).' }
      : { decision: 'approval_step_up', reason: 'Production deploys need approval with step-up.' };
  }
  switch (policy.previewDeploy) {
    case 'auto':
      return { decision: 'auto', reason: 'Preview deploys run without approval (project policy).' };
    case 'approval':
      return { decision: 'approval', reason: 'Preview deploys need approval (project policy).' };
    default:
      return {
        decision: 'approval_step_up',
        reason: 'Preview deploys need approval with step-up (project policy).',
      };
  }
}

/**
 * p6-pages-create: creating / adopting a Pages project or attaching a domain follows `policy.pagesProject` (default
 * approval; a project may choose auto). Attaching a domain that also writes its CNAME needs at least the DNS level —
 * the stricter of the two, never auto.
 */
function pagesProjectDecision(
  kind: 'pages.create_project' | 'pages.add_domain',
  policy: DeployPolicy,
  withDns: boolean,
): PolicyDecision {
  const what = kind === 'pages.create_project' ? 'Creating a Pages project' : 'Attaching a Pages domain';
  const own = policy.pagesProject;
  if (withDns) {
    // The CNAME of an attached domain always points at the project's own pages.dev name, so DNS "Run at once"
    // (p10-publish-bundle) applies to it.
    const level: ApprovalLevel =
      PRE_APPROVAL_RANK[own] > PRE_APPROVAL_RANK[policy.dnsChange] ? own : policy.dnsChange;
    switch (level) {
      case 'auto':
        return {
          decision: 'auto',
          reason: `${what} with its CNAME runs without approval (project policy).`,
        };
      case 'approval':
        return { decision: 'approval', reason: `${what} with a DNS change needs approval.` };
      default:
        return {
          decision: 'approval_step_up',
          reason: `${what} with a DNS change needs approval with step-up (project policy).`,
        };
    }
  }
  switch (own) {
    case 'auto':
      return { decision: 'auto', reason: `${what} runs without approval (project policy).` };
    case 'approval':
      return { decision: 'approval', reason: `${what} needs approval (project policy).` };
    default:
      return {
        decision: 'approval_step_up',
        reason: `${what} needs approval with step-up (project policy).`,
      };
  }
}

/** `name` is the zone apex or below it. */
export function nameInZone(name: string, zone: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  const z = zone.toLowerCase().replace(/\.$/, '');
  return n === z || n.endsWith(`.${z}`);
}

export interface ProtectionContext {
  /** Console host(s): the PUBLIC_ORIGIN host, the saved console address(es) and OPS_PROTECTED_HOSTS. */
  readonly consoleHosts: ReadonlySet<string>;
  /** The project's extra protected names. */
  readonly protectedNames: ReadonlySet<string>;
  /** Control-plane addresses (OPS_CONTROL_PLANE_ADDRESSES + the console host's own record contents). */
  readonly controlPlaneTargets: ReadonlySet<string>;
}

/**
 * Why a DNS record (existing or wanted) must not be changed by an ops action, or null. Checked for the requested
 * record *and* for every record it would replace or delete.
 */
export function protectedRecordReason(
  rec: { readonly name: string; readonly type: string; readonly content?: string },
  ctx: ProtectionContext,
): string | null {
  const name = rec.name.toLowerCase().replace(/\.$/, '');
  const type = rec.type.toUpperCase();
  const content = (rec.content ?? '').trim();
  const lc = content.toLowerCase().replace(/^"|"$/g, '').replace(/\.$/, '');
  if (ctx.consoleHosts.has(name)) return `${name} is the console host (protected).`;
  if (ctx.protectedNames.has(name)) return `${name} is a protected record of this project.`;
  if (type === 'MX') return 'MX records are protected (mail).';
  if (name.startsWith('_dmarc.') || lc.startsWith('v=dmarc1')) return 'DMARC records are protected (mail).';
  if (name.includes('._domainkey.') || lc.includes('v=dkim1')) return 'DKIM records are protected (mail).';
  if (type === 'TXT' && lc.startsWith('v=spf1')) return 'SPF records are protected (mail).';
  if (type === 'SPF') return 'SPF records are protected (mail).';
  if (lc !== '' && (ctx.consoleHosts.has(lc) || ctx.controlPlaneTargets.has(lc))) {
    return `${name} points at the control plane (protected).`;
  }
  return null;
}

/** Host names in a Coolify `fqdn` field (comma-separated URLs). */
export function hostsOfFqdn(fqdn: string): string[] {
  return fqdn
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return new URL(s.includes('://') ? s : `https://${s}`).hostname.toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    });
}

/** Why a Coolify application must never be deployed/restarted by an ops action (control plane), or null. */
export function coolifyDenyReason(
  app: { readonly uuid: string; readonly fqdn: string },
  ctx: { readonly denyUuids: ReadonlySet<string>; readonly consoleHosts: ReadonlySet<string> },
): string | null {
  if (ctx.denyUuids.has(app.uuid))
    return `Coolify resource ${app.uuid} is part of the Remyral control plane.`;
  const hit = hostsOfFqdn(app.fqdn).find((h) => ctx.consoleHosts.has(h));
  if (hit !== undefined)
    return `Coolify resource ${app.uuid} serves the console host ${hit} (control plane).`;
  return null;
}

// ------------------------------------------------------------------------------- p6-deploy-on-success

/** Policy levels a human can satisfy, in increasing strictness (ADR-0030). */
export type ApprovalLevel = 'auto' | 'approval' | 'approval_step_up';
export const PRE_APPROVAL_RANK: Readonly<Record<ApprovalLevel, number>> = {
  auto: 0,
  approval: 1,
  approval_step_up: 2,
};
export const PRE_APPROVAL_REASON = 'Pre-approved at job creation (deploy on success).';
/** p10-publish-bundle: the decision reason of a step run under its bundle's approval. */
export const BUNDLE_APPROVAL_REASON = 'Approved with its publish bundle.';

/** An approval given in advance (at job creation) by the requesting user. */
export interface PreApproval {
  readonly by: string;
  readonly at: Date;
  /** The always-fresh TOTP time of the approval, when the covered level needed one. */
  readonly stepUpAt: Date | null;
  readonly covers: ApprovalLevel;
}

/**
 * Whether an approval given in advance covers today's policy decision: never a refusal, never `auto` (nothing to
 * approve), only up to the level covered, and `approval_step_up` only with a recorded step-up.
 */
export function preApprovalCovers(decision: PolicyOutcome, pre: PreApproval): boolean {
  if (decision !== 'approval' && decision !== 'approval_step_up') return false;
  if (PRE_APPROVAL_RANK[decision] > PRE_APPROVAL_RANK[pre.covers]) return false;
  return decision !== 'approval_step_up' || pre.stepUpAt !== null;
}

/**
 * The level the deploy policy asks for a deploy of `env` (what the creator must satisfy at job creation), or a
 * refusal reason: production auto-deploy on success needs the project switch.
 */
export function onSuccessLevel(
  env: DeployEnv,
  policy: DeployPolicy,
): { readonly level: ApprovalLevel } | { readonly refused: string } {
  if (env === 'production') {
    if (!policy.autoDeployProductionOnSuccess) {
      return {
        refused:
          'Auto-deploy to production on success is off for this project (Project → Deploy, project admin).',
      };
    }
    return { level: policy.productionDeploy };
  }
  return { level: policy.previewDeploy };
}

// --------------------------------------------------------------------------------- p10-publish-bundle

export type PublishStep = 'create' | 'deploy' | 'domain';

export interface PublishStepFacts {
  readonly step: PublishStep;
  /** deploy: the environment. */
  readonly env?: DeployEnv;
  /** domain: the CNAME is written (zone of the account allowed for the project, `dns: auto`). */
  readonly withDns?: boolean;
  /** Why the step is refused (protected name, …), or null. */
  readonly refusal?: string | null;
}

const LEVEL_TEXT: Readonly<Record<ApprovalLevel, string>> = {
  auto: 'runs at once',
  approval: 'needs approval',
  approval_step_up: 'needs approval with step-up',
};

/** The decision of one bundle step, by the same rules as its own action kind. */
export function publishStepDecision(f: PublishStepFacts, policy: DeployPolicy): PolicyDecision {
  if (f.refusal != null) return { decision: 'refused', reason: f.refusal };
  switch (f.step) {
    case 'create':
      return decide('pages.create_project', null, policy, { refusal: null });
    case 'deploy':
      return decide('pages.deploy', f.env ?? 'preview', policy, { refusal: null });
    default:
      return decide('pages.add_domain', null, policy, { refusal: null }, { withDns: f.withDns === true });
  }
}

/**
 * p10-publish-bundle (ADR-0038): the decision of a whole bundle — the strictest step; refused when a step is; and
 * approval **with step-up** whenever an approval is needed at all and production or a DNS write is involved (one
 * approval stands for every step, so it carries the strictest proof). Every step at "run at once" → auto (never with
 * production: `productionDeploy` has no auto).
 */
export function publishDecision(
  steps: readonly PublishStepFacts[],
  policy: DeployPolicy,
): PolicyDecision & { readonly steps: readonly PolicyDecision[] } {
  const each = steps.map((s) => publishStepDecision(s, policy));
  const refused = each.find((d) => d.decision === 'refused');
  if (refused !== undefined) return { ...refused, steps: each };
  let level: ApprovalLevel = 'auto';
  for (const d of each) {
    const l = d.decision as ApprovalLevel;
    if (PRE_APPROVAL_RANK[l] > PRE_APPROVAL_RANK[level]) level = l;
  }
  const sensitive = steps.some((s) => (s.step === 'deploy' && s.env === 'production') || s.withDns === true);
  if (level === 'approval' && sensitive) level = 'approval_step_up';
  const parts = steps.map(
    (s, i) => `${s.step} ${LEVEL_TEXT[(each[i]?.decision ?? 'approval') as ApprovalLevel]}`,
  );
  const reason =
    level === 'auto'
      ? `Every step runs at once (project policy): ${parts.join(', ')}.`
      : `One approval${level === 'approval_step_up' ? ' with a fresh authenticator code' : ''} for the whole chain (${parts.join(', ')})${sensitive && level === 'approval_step_up' ? '; production or DNS is involved' : ''}.`;
  return { decision: level, reason: reason.slice(0, 500), steps: each };
}
