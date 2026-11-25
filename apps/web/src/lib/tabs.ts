import { useSearchParams } from 'react-router';

/**
 * URL tab state shared by the classic `Tabs` and the Diyalog `SegTabs` (moved here from components/Tabs.tsx so the
 * Diyalog UI does not import a classic component for it; behaviour unchanged).
 */

export interface TabItem {
  /** URL value (`?tab=<id>`); keep it short and stable. */
  readonly id: string;
  readonly label: string;
  /** A count shown next to the label (tabular numerals); 0 / undefined shows nothing. */
  readonly count?: number;
}

/**
 * The tab selected by the URL (`?<param>=<id>`), falling back to the first item for a missing or unknown
 * value, plus a setter that writes the URL (replace: switching tabs does not pile up history entries). The
 * first tab is the clean URL (no parameter). `clear` names parameters a switch drops (one tab's filters, p17-settings-tabs).
 */
export function useTabParam(
  items: readonly TabItem[],
  param = 'tab',
  clear: readonly string[] = [],
): readonly [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param);
  const first = items[0]?.id ?? '';
  const active = items.some((t) => t.id === raw) ? (raw ?? first) : first;
  const select = (id: string): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of clear) next.delete(k);
        if (id === first) next.delete(param);
        else next.set(param, id);
        return next;
      },
      { replace: true },
    );
  };
  return [active, select] as const;
}
