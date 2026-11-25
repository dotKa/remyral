import type { MasterToWorker } from '@remyral/protocol';
import type { Logger } from '@remyral/observability';
import type { RuntimePolicyStore } from './store.js';

type UpdatePolicyPayload = Extract<MasterToWorker, { type: 'UPDATE_POLICY' }>['payload'];

/**
 * Daemon hook for UPDATE_POLICY (p3-runtime-policy): apply the delivery to the store and log the outcome.
 * Resolves true when the applied runtime policy changed. A refused delivery keeps the previous policy (the
 * worker's CAPABILITIES keep reporting it, so the master sees the drift); nothing is installed here — the
 * owner installs runtime versions (docs/design/p3-runtime-policy.md §7).
 */
export function runtimePolicyHooks(
  store: RuntimePolicyStore,
  logger: Logger,
): { onUpdatePolicy(payload: UpdatePolicyPayload): Promise<boolean> } {
  const log = logger.child({ component: 'runtime-policy' });
  return {
    async onUpdatePolicy(payload) {
      const outcome = await store.apply(payload);
      switch (outcome.status) {
        case 'stale':
          log.info('older runtime policy delivery ignored', {
            received: payload.policyVersion,
            current: outcome.generation,
          });
          return false;
        case 'rejected':
          log.error('runtime policy delivery refused; keeping the previous policy', {
            reason: outcome.reason,
          });
          return false;
        case 'applied':
          log.info('runtime policy applied', {
            policy: outcome.policy?.name ?? null,
            version: outcome.policy?.version ?? null,
            stage: outcome.policy?.stage ?? null,
            generation: payload.policyVersion,
            changed: outcome.changed,
          });
          return outcome.changed;
      }
    },
  };
}
