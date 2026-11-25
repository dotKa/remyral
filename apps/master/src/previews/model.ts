import { randomBytes } from 'node:crypto';
import { PREVIEW_LIMITS, type PreviewProtection, type PreviewTunnelState } from '@remyral/protocol';
import type { DeployPolicy, PolicyOutcome, PreviewSettings } from '../ops/model.js';

/**
 * p8-preview-tunnels (ADR-0032, docs/design/p8-preview-tunnels.md §3–§5): pure rules — hostnames, lifetimes, the
 * policy decision of the `tunnel.*` ops actions and the limits. No I/O.
 */

export type ConnectorView = 'starting' | 'running' | 'stopped' | 'failed' | 'refused' | 'down';

export interface TunnelView {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly hostname: string;
  readonly url: string;
  readonly protection: PreviewProtection;
  readonly stable: boolean;
  readonly state: PreviewTunnelState;
  readonly connector: {
    readonly state: ConnectorView;
    readonly detail: string | null;
    readonly since: string;
  } | null;
  readonly jobId: string | null;
  readonly workerId: string | null;
  readonly port: number | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly openedBy: {
    readonly type: 'user' | 'system';
    readonly id: string;
    readonly username: string | null;
  };
  readonly openActionId: string | null;
  readonly serviceTokenClientId: string | null;
}

/** Crockford-style base32 without ambiguous letters (lower case: DNS labels are case-insensitive). */
const ALPHABET = 'abcdefghjkmnpqrstvwxyz0123456789';

/** `n` random characters (5 bits each): 10 characters = 50 bits — not guessable, not enumerable. */
export function randomLabel(n = 10, rnd: (size: number) => Buffer = randomBytes): string {
  const bytes = rnd(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET.charAt((bytes[i] ?? 0) & 31);
  return out;
}

/** Lower-case slug of a free name, or `preview`. */
export function previewSlug(name: string | undefined): string {
  const s = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, PREVIEW_LIMITS.nameMaxChars)
    .replace(/-$/, '');
  return s === '' ? 'preview' : s;
}

/**
 * The hostname of a new preview: ONE label under the zone — `[<prefix>-]<name>-<random>` — because Cloudflare's
 * Universal SSL certificate covers the apex and first-level subdomains only (a nested name would have no
 * certificate without Advanced Certificate Manager).
 */
export function previewHostname(
  zone: string,
  prefix: string | null,
  name: string,
  random: string = randomLabel(),
): string {
  const parts = [...(prefix === null ? [] : [prefix]), name, random];
  let label = parts.join('-');
  if (label.length > 63) {
    // Shorten the name, never the random part.
    const room = 63 - random.length - 1 - (prefix === null ? 0 : prefix.length + 1);
    label = [
      ...(prefix === null ? [] : [prefix]),
      name.slice(0, Math.max(1, room)).replace(/-$/, ''),
      random,
    ].join('-');
  }
  return `${label}.${zone.toLowerCase()}`;
}

/** Lifetime of a new preview (minutes), clamped to the kind's maximum. */
export function lifetimeMinutes(stable: boolean, requested: number | undefined): number {
  if (stable) return Math.min(requested ?? PREVIEW_LIMITS.stableMaxMinutes, PREVIEW_LIMITS.stableMaxMinutes);
  return Math.min(requested ?? PREVIEW_LIMITS.defaultTtlMinutes, PREVIEW_LIMITS.maxTtlMinutes);
}

/** New expiry of an extension: job-bound ≤ 24 h from now, stable ≤ 30 days from now; never earlier than today's. */
export function extendedExpiry(stable: boolean, current: Date, minutes: number, now: Date): Date {
  const cap = (stable ? PREVIEW_LIMITS.stableMaxMinutes : PREVIEW_LIMITS.maxTtlMinutes) * 60_000;
  const base = Math.max(current.getTime(), now.getTime());
  const wanted = base + minutes * 60_000;
  return new Date(Math.max(current.getTime(), Math.min(wanted, now.getTime() + cap)));
}

/** Protections a project offers: `access` only with an e-mail allowlist. */
export function protectionsOffered(s: PreviewSettings): PreviewProtection[] {
  return ['none', ...(s.accessEmails.length > 0 ? (['access'] as const) : []), 'service-token'];
}

export interface TunnelDecisionFacts {
  /** A refusal found while planning (limits, settings, job, worker, hostname protection), or null. */
  readonly refusal: string | null;
  /** `tunnel.open` of a NEW stable reservation (not a re-attach of an approved one). */
  readonly newStable?: boolean;
  /** `tunnel.extend` of a stable tunnel (a renewal). */
  readonly renewStable?: boolean;
}

/**
 * Policy of the `tunnel.*` kinds (ADR-0032 §3):
 *
 * | kind                                            | decision                                     |
 * | tunnel.open (job-bound, or re-attach of stable) | policy.previewTunnel (default auto)          |
 * | tunnel.open of a new stable reservation         | policy.stableTunnel (default approval)       |
 * | tunnel.extend (job-bound, within 24 h)          | policy.previewTunnel                         |
 * | tunnel.extend of a stable tunnel (renewal)      | policy.stableTunnel                          |
 * | tunnel.close                                    | auto, always (less exposure)                 |
 * | refusal (limits, settings, protected names, …)  | refused                                      |
 */
export function tunnelDecision(
  kind: 'tunnel.open' | 'tunnel.close' | 'tunnel.extend',
  policy: DeployPolicy,
  facts: TunnelDecisionFacts,
): { readonly decision: PolicyOutcome; readonly reason: string } {
  if (facts.refusal !== null) return { decision: 'refused', reason: facts.refusal };
  if (kind === 'tunnel.close') return { decision: 'auto', reason: 'Closing a preview never needs approval.' };
  const stable = kind === 'tunnel.open' ? facts.newStable === true : facts.renewStable === true;
  const rule = stable ? policy.stableTunnel : policy.previewTunnel;
  const what =
    kind === 'tunnel.open'
      ? stable
        ? 'Reserving a stable preview address'
        : 'Opening a preview link'
      : stable
        ? 'Renewing a stable preview address'
        : 'Extending a preview link';
  switch (rule) {
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

/** Why a job attempt cannot get a preview on its worker (master-side facts), or null. */
export function previewAvailability(f: {
  readonly settings: PreviewSettings | null;
  readonly jobActive: boolean;
  readonly sandboxProfile: string | null;
  readonly workerFeature: boolean;
  readonly cloudflared: boolean;
  readonly workerConnected: boolean;
  /** p22-previews-inputs: the job's worker publishes container ports for previews (`preview-container-v1`). */
  readonly containerFeature?: boolean;
}): string | null {
  if (f.settings?.zone == null) {
    return 'Preview links are not set up for this project (Project → Deploy → Preview links: choose a zone).';
  }
  if (!f.jobActive) return 'The job is not running: a preview needs the job’s live attempt on a machine.';
  if (f.sandboxProfile === 'container' && f.containerFeature !== true) {
    return 'The job’s machine runs a worker release without container previews (the dev server runs inside the container); update it first.';
  }
  if (!f.workerFeature)
    return 'The job’s machine runs a worker release without preview tunnels; update it first.';
  if (!f.cloudflared) {
    return 'cloudflared is not installed on the job’s machine (Machines → Tools → install cloudflared).';
  }
  if (!f.workerConnected) return 'The job’s machine is not connected right now.';
  return null;
}
