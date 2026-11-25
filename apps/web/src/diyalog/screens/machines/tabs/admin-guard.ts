import { useCallback } from 'react';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';

/**
 * Runs a privileged call through step-up and resolves its result, or null when the code dialog was cancelled (not an
 * error) — the classic `useGuarded` of the machine admin / remote-ops panels.
 */
export function useGuardedValue(): <T>(fn: () => Promise<T>, why: string) => Promise<T | null> {
  const stepUp = useStepUp();
  return useCallback(
    async <T>(fn: () => Promise<T>, why: string): Promise<T | null> => {
      try {
        return await stepUp.run(fn, why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return null;
        throw err;
      }
    },
    [stepUp],
  );
}
