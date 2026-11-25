import type { DecisionRule, PreviewTargets } from '../../api/deploy';

/**
 * p8-preview-tunnels (ADR-0032): Project → Deploy → Preview links. The preview zone (one the Cloudflare token can
 * see), an optional label prefix, whether job agents may open previews, the e-mail allowlist for Access-protected
 * previews, limits and the policy for job-bound and stable previews. Saved with the deploy targets.
 */

export interface PreviewForm {
  zoneId: string;
  prefix: string;
  agentsMayOpen: boolean;
  accessEmails: string;
  maxActive: string;
  maxPerJob: string;
  previewTunnel: DecisionRule;
  stableTunnel: DecisionRule;
}

export function toPreviewForm(
  p: PreviewTargets | null,
  policy: { readonly previewTunnel: DecisionRule; readonly stableTunnel: DecisionRule },
): PreviewForm {
  return {
    zoneId: p?.zone?.id ?? '',
    prefix: p?.prefix ?? '',
    agentsMayOpen: p?.agentsMayOpen ?? true,
    accessEmails: (p?.accessEmails ?? []).join(', '),
    maxActive: String(p?.maxActive ?? 5),
    maxPerJob: String(p?.maxPerJob ?? 3),
    previewTunnel: policy.previewTunnel,
    stableTunnel: policy.stableTunnel,
  };
}

function bounded(s: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** null when no preview zone is chosen (previews off). */
export function fromPreviewForm(
  f: PreviewForm,
  zones: readonly { readonly id: string; readonly name: string }[],
): PreviewTargets | null {
  const zone = zones.find((z) => z.id === f.zoneId);
  if (zone === undefined) return null;
  const prefix = f.prefix.trim().toLowerCase();
  return {
    zone: { id: zone.id, name: zone.name },
    prefix: prefix === '' ? null : prefix,
    agentsMayOpen: f.agentsMayOpen,
    accessEmails: [
      ...new Set(
        f.accessEmails
          .split(/[\s,;]+/)
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e !== ''),
      ),
    ],
    maxActive: bounded(f.maxActive, 1, 20, 5),
    maxPerJob: bounded(f.maxPerJob, 1, 5, 3),
  };
}
