import { useEffect, useRef } from 'react';
import { usePageParams } from './pager';

/**
 * p9-pagination: back to page 1 when a filter kept in component state changes (`key` describes the filters).
 * The first render keeps the page from the URL, so a linked `?page=3` still opens page 3.
 */
export function useResetPageOn(key: string, prefix?: string): void {
  const pager = usePageParams(prefix === undefined ? {} : { prefix });
  const last = useRef(key);
  const goFirst = useRef(pager.goFirst);
  goFirst.current = pager.goFirst;
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    goFirst.current();
  }, [key]);
}
