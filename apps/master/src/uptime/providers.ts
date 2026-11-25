import { ProviderCallError } from '../ops/coolify.js';
import type { OpsIntegrations } from '../ops/integrations.js';
import type { CheckResult, CoolifyConfig, PagesConfig } from './model.js';

/**
 * p8-uptime (docs/design/p8-uptime.md §4.3): provider status checks with the master-held Cloudflare / Coolify tokens
 * (the same OpsIntegrations clients the deploy pipeline uses; nothing new is stored). Only identifiers go in; only a
 * fixed status word comes back into the check row (`detail`), never provider error text.
 *
 * - Cloudflare Pages: the newest deployment of the project in the environment — latest stage `deploy` with status
 *   `success` → up; `failure` / `canceled` at any stage → down; still building (`active` / `idle`) → undecided.
 * - Coolify: the application's status — `running` / `running:healthy` / `running:unknown` → up; `restarting`,
 *   `starting` → undecided; anything else (`exited`, `running:unhealthy`, `degraded:*`) → down.
 * - Not configured, unauthorised, rate limited or unreachable → undecided (`ok: null`): the uptime of the site is
 *   not the provider API's uptime; a revoked token shows as `provider_auth` on the monitor.
 */

export interface ProviderChecks {
  pages(cfg: PagesConfig): Promise<CheckResult>;
  /** p13-multi-coolify: through `cfg.connection` (else the default), only when `project` may use it. */
  coolify(cfg: CoolifyConfig, project: string): Promise<CheckResult>;
}

const undecided = (error: string, detail: string): CheckResult => ({
  ok: null,
  latencyMs: null,
  statusCode: null,
  error,
  detail,
  tlsExpiresAt: null,
});

function providerFailure(err: unknown): CheckResult {
  if (err instanceof ProviderCallError) {
    if (err.code === 'not_found') {
      return { ...undecided('provider_not_found', 'not found at the provider'), ok: false };
    }
    if (err.code === 'unauthorized' || err.code === 'forbidden') {
      return undecided('provider_auth', 'the stored token was refused');
    }
    if (err.code === 'rate_limited') return undecided('provider_rate_limited', 'provider rate limit');
    return undecided('provider_unavailable', 'the provider did not answer');
  }
  return undecided('provider_unavailable', 'the provider did not answer');
}

/** Pages stage words → result. Exported for the unit tests. */
export function pagesOutcome(stage: string, status: string): { ok: boolean | null; detail: string } {
  const s = status.toLowerCase();
  const word = `${stage || 'deploy'}: ${s || 'unknown'}`;
  if (s === 'failure' || s === 'canceled' || s === 'cancelled') return { ok: false, detail: word };
  if (s === 'success' && (stage === 'deploy' || stage === '')) return { ok: true, detail: 'healthy' };
  return { ok: null, detail: word };
}

/** Coolify application status → result. Exported for the unit tests. */
export function coolifyOutcome(status: string): { ok: boolean | null; detail: string } {
  const s = status.toLowerCase().trim();
  const detail = s === '' ? 'unknown' : s.slice(0, 60);
  if (s === 'running' || s === 'running:healthy' || s === 'running:unknown') return { ok: true, detail };
  if (s.startsWith('restarting') || s.startsWith('starting')) return { ok: null, detail };
  return { ok: false, detail };
}

export function createProviderChecks(integrations: OpsIntegrations, now: () => number): ProviderChecks {
  return {
    async pages(cfg) {
      const cf = await integrations.cloudflare().catch(() => null);
      if (cf === null) return undecided('provider_not_configured', 'Cloudflare is not connected');
      const start = now();
      try {
        const list = await cf.client.pagesDeployments(cfg.project, cfg.env);
        const latencyMs = Math.max(0, Math.round(now() - start));
        const d = list[0];
        if (d === undefined) {
          return {
            ok: false,
            latencyMs,
            statusCode: null,
            error: 'provider_down',
            detail: 'no deployment',
            tlsExpiresAt: null,
          };
        }
        const o = pagesOutcome(d.stage, d.stageStatus);
        return {
          ok: o.ok,
          latencyMs,
          statusCode: null,
          error: o.ok === true ? null : o.ok === false ? 'provider_down' : 'provider_pending',
          detail: o.detail,
          tlsExpiresAt: null,
        };
      } catch (err) {
        return providerFailure(err);
      }
    },
    async coolify(cfg, project) {
      const c = await integrations.coolifyConnections
        .forAction(project, cfg.connection ?? null)
        .catch(() => null);
      if (c === null) return undecided('provider_not_configured', 'Coolify is not connected');
      const start = now();
      try {
        const app = await c.client.application(cfg.uuid);
        const latencyMs = Math.max(0, Math.round(now() - start));
        const o = coolifyOutcome(app.status);
        return {
          ok: o.ok,
          latencyMs,
          statusCode: null,
          error: o.ok === true ? null : o.ok === false ? 'provider_down' : 'provider_pending',
          detail: o.detail,
          tlsExpiresAt: null,
        };
      } catch (err) {
        return providerFailure(err);
      }
    },
  };
}
