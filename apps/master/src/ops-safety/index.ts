import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import type { RolloutBreaker } from '../releases/breaker.js';
import type { CostBrakeService } from './cost-brake.js';
import type { ExpiryService } from './expiry.js';

export { CostBrakeService } from './cost-brake.js';
export { ExpiryService } from './expiry.js';
export { opsSafetyRoutes } from './routes.js';
export { readServedCertificate } from './tls.js';
export { TurnGuard } from './guard.js';

/**
 * p16-ops-safety: the assistant's read (`ops_safety_status`) over the same services as the console, with the caller's
 * permissions: expiry needs `security.read` (administrators), the breaker `releases.read`, the brake `quotas.read`
 * (project ceilings of visible projects only).
 */
export class OpsSafetyReader {
  constructor(
    private readonly deps: {
      readonly expiry: ExpiryService;
      readonly brake: CostBrakeService;
      readonly breaker: () => RolloutBreaker | null;
    },
  ) {}

  async status(
    subject: Subject,
    part: 'all' | 'expiry' | 'rollout' | 'cost',
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const allowed = (action: string) => authorize(subject, action).allow;
    if (part === 'all' || part === 'expiry') {
      if (allowed('security.read')) {
        const e = await this.deps.expiry.list();
        out.expiry = {
          summary: e.summary,
          lastOutsideCheck: e.checkedAt,
          items: e.items.slice(0, 120).map((i) => ({
            id: i.id,
            what: i.label,
            name: i.name,
            basis: i.basis,
            dueAt: i.dueAt,
            daysLeft: i.daysLeft,
            ageDays: i.ageDays,
            rotateEveryDays: i.rotateEveryDays,
            rotatedAt: i.rotatedAt,
            state: i.state,
            detail: i.detail,
            runbook: i.runbook,
          })),
          where: 'Ayarlar → Operasyon güvenliği → Anahtarlar ve süreler',
        };
      } else out.expiry = 'not visible (administrators only)';
    }
    if (part === 'all' || part === 'rollout') {
      const b = this.deps.breaker();
      if (!allowed('releases.read')) out.rollout = 'not visible';
      else if (b === null) out.rollout = 'worker releases are not available';
      else {
        const s = await b.status();
        out.rollout = {
          thresholds: s.settings,
          channels: s.channels.map((c) => ({
            channel: c.channel,
            version: c.version,
            rolloutPercent: c.rolloutPercent,
            held: c.hold !== null,
            hold: c.hold,
            judgedMachines: c.verdict.judged,
            failingMachines: c.verdict.failing,
            pendingMachines: c.verdict.pending,
            failurePercent: c.verdict.failurePercent,
            jobFailurePercent: c.verdict.jobFailurePercent,
            machines: c.machines.filter((m) => m.verdict !== 'ok').slice(0, 30),
          })),
          recentHolds: s.recent.slice(0, 10),
          where: 'Ayarlar → Worker sürümleri (resume / roll back buttons, administrators)',
        };
      }
    }
    if (part === 'all' || part === 'cost') {
      if (!allowed('quotas.read')) out.cost = 'not visible';
      else {
        const st = await this.deps.brake.current();
        const projects = visibleProjects(subject);
        const ok = (scope: string) => scope === 'global' || projects === null || projects.includes(scope);
        out.cost = {
          mode: st.mode,
          warnPercent: st.warnPercent,
          blocking: st.blocking,
          ceilings: st.ceilings.filter((c) => ok(c.scope)),
          engaged: st.engaged.filter((c) => ok(c.scope)),
          lifts: st.lifts.filter((l) => ok(l.scope)),
          note: 'Spend counts API-billed model usage only (jobs + the assistant); subscription runs have no per-run cost.',
          where: 'Ayarlar → Operasyon güvenliği → Maliyet freni (owners lift it)',
        };
      }
    }
    return out;
  }
}
