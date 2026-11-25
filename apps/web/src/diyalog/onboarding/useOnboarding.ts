import { useCallback, useEffect, useState } from 'react';
import { getOnboarding, type Onboarding } from '../../api/selfhost';
import { useOptionalAuth } from '../../auth/AuthProvider';

/**
 * p16-selfhost-onboarding §5: the setup wizard's state for the signed-in OWNER (null for everyone else, and while
 * loading or when the read failed — the hints then simply do not show). The home card, the empty-state hints and the
 * wizard screen read it; `set` takes the master's answer after a change.
 */
export function useIsOwner(): boolean {
  const auth = useOptionalAuth();
  return auth?.state.kind === 'signedIn' && auth.state.user.role === 'owner';
}

export function useOnboarding(): {
  readonly data: Onboarding | null;
  readonly set: (o: Onboarding) => void;
  readonly reload: () => void;
} {
  const owner = useIsOwner();
  const [data, setData] = useState<Onboarding | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!owner) return;
    const ac = new AbortController();
    getOnboarding({ signal: ac.signal, noSessionRetry: true }).then(setData, () => undefined);
    return () => {
      ac.abort();
    };
  }, [owner, tick]);
  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  return { data: owner ? data : null, set: setData, reload };
}
