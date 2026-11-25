import { useEffect, useRef, useState } from 'react';
import type { ApiError } from '../../api/client';
import { type PlacementPreview, type PreviewDraft, previewPlacement } from '../../api/composer';
import { toApiError } from '../../components/ui';

/** Debounced "where would this run?" (POST /jobs/placement-preview); the newest draft always wins. */
export function usePlacementPreview(
  draft: PreviewDraft | null,
  delayMs = 350,
): { preview: PlacementPreview | null; loading: boolean; error: ApiError | null } {
  const key = draft === null ? null : JSON.stringify(draft);
  const [state, setState] = useState<{
    preview: PlacementPreview | null;
    loading: boolean;
    error: ApiError | null;
  }>({ preview: null, loading: false, error: null });
  const seq = useRef(0);
  useEffect(() => {
    if (key === null) {
      setState({ preview: null, loading: false, error: null });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      previewPlacement(JSON.parse(key) as PreviewDraft).then(
        (p) => {
          if (mine === seq.current) setState({ preview: p, loading: false, error: null });
        },
        (err: unknown) => {
          if (mine === seq.current) setState((s) => ({ ...s, loading: false, error: toApiError(err) }));
        },
      );
    }, delayMs);
    return () => {
      clearTimeout(t);
    };
  }, [key, delayMs]);
  return state;
}
