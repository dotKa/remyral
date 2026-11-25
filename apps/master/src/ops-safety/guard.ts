import type { RateLimiter } from '../auth/rate-limit.js';
import { HttpError } from '../http/errors.js';
import type { LimitSettings } from '../security-policy/model.js';
import type { CostBrakeService } from './cost-brake.js';

/**
 * p16-ops-safety §3–4: what a new assistant turn (a message, an edit, a regeneration) must pass first — the owner's
 * per-person chat message rate (security policy `limits.chatPerMinute / chatPerHour`, fixed windows shared by the
 * master replicas through Redis) and the model cost brake (block mode, a global ceiling reached, not lifted).
 */
export interface TurnGuardDeps {
  readonly limiter: RateLimiter;
  readonly limits: () => Promise<LimitSettings>;
  /** RATE_LIMIT_SCALE / test harnesses: multiplies the chat budgets like the request budgets. */
  readonly scale: number;
  readonly brake: () => CostBrakeService | null;
}

export class TurnGuard {
  constructor(private readonly deps: TurnGuardDeps) {}

  async chatTurn(userId: string): Promise<void> {
    const l = await this.deps.limits();
    const scaled = (n: number) => Math.max(1, Math.round(n * this.deps.scale));
    for (const [bucket, max, windowMs] of [
      ['chat-msg-min', scaled(l.chatPerMinute), 60_000],
      ['chat-msg-hour', scaled(l.chatPerHour), 3_600_000],
    ] as const) {
      const hit = await this.deps.limiter.hit(bucket, userId, max, windowMs);
      if (!hit.allowed) {
        throw new HttpError(
          429,
          'rate_limited',
          'Too many chat messages; try again in a few minutes.',
          { 'retry-after': String(Math.max(1, Math.ceil(hit.retryAfterMs / 1000))) },
          {},
          { reason: 'chat_messages' },
        );
      }
    }
    const blocked = await this.deps.brake()?.chatBlocked();
    if (blocked !== null && blocked !== undefined) {
      throw new HttpError(
        429,
        'cost_brake_active',
        `The model cost brake is on: the ${blocked.window === 'day' ? 'daily' : 'monthly'} spend ceiling is reached, so new assistant turns wait until ${blocked.windowEnd} or an owner lifts the brake.`,
        {},
        {},
        { reason: blocked.window, until: blocked.windowEnd },
      );
    }
  }
}
