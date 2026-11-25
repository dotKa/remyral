import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * p12-diyalog Faz 2: one secondary read of a job card (verification, deploy, previews, …). Loads when `key` changes
 * (the job id and its state: a state change re-reads it), polls only while `poll(data)` says the thing is still on its
 * way and the tab is visible, and keeps the last good value when a re-read fails. A first read that fails (an older
 * master, no access) leaves `data` null — the card then renders nothing, as on the classic page.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
  opts: { readonly poll?: ((v: T | null) => boolean) | undefined; readonly ms?: number | undefined } = {},
): { readonly data: T | null; readonly reload: () => void; readonly set: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    loadRef.current(ctl.signal).then(
      (v) => {
        if (!ctl.signal.aborted) setData(v);
      },
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [key, tick]);
  const polling = opts.poll?.(data) === true;
  const ms = opts.ms ?? 10_000;
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
    }, ms);
    return () => {
      clearInterval(t);
    };
  }, [polling, ms]);
  return { data, reload, set: setData };
}
