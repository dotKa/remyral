import { useEffect, useState } from 'react';
import { getLoginOptions, type LoginOptions } from '../api/auth';

const NONE: LoginOptions = { rememberMe: null, trustedDevice: null };

/**
 * p5-remember-device: which of "Remember me" / "Trust this device" the master offers. Until the answer
 * arrives, and if the request fails, both are hidden (the master ignores the flags when a feature is off).
 */
export function useLoginOptions(): LoginOptions {
  const [options, setOptions] = useState<LoginOptions>(NONE);
  useEffect(() => {
    let cancelled = false;
    getLoginOptions().then(
      (o) => {
        if (!cancelled) setOptions(o);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}
