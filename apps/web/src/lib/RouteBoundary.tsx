import { Component, type ReactNode, Suspense } from 'react';

/**
 * p14-web-perf (docs/design/p14-web-perf.md §2): the boundary around a shell's route content.
 *
 * - `<Suspense>`: the first visit to a lazily loaded screen shows `loading` inside the shell (rail, top bar stay);
 *   a later navigation runs in the router's transition, so React keeps the previous screen until the chunk is there.
 * - error boundary: a chunk that failed to load (a deploy replaced the bundle while the tab stayed open, the network
 *   dropped) shows `failed` with a reload instead of a blank page. It resets when `resetKey` (the path) changes, so
 *   navigating elsewhere tries again. Errors that are not chunk-load errors are rethrown (never swallowed).
 */
export function RouteBoundary(props: {
  readonly resetKey: string;
  readonly loading: ReactNode;
  readonly failed: (reload: () => void) => ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ChunkErrorBoundary resetKey={props.resetKey} failed={props.failed}>
      <Suspense fallback={props.loading}>{props.children}</Suspense>
    </ChunkErrorBoundary>
  );
}

/** A dynamic import that failed (Chromium, Firefox and Safari word it differently; Vite's preload says the same). */
export function isChunkLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically/i.test(
    e.message,
  );
}

interface BoundaryState {
  readonly error: unknown;
  readonly key: string;
}

class ChunkErrorBoundary extends Component<
  {
    readonly resetKey: string;
    readonly failed: (reload: () => void) => ReactNode;
    readonly children: ReactNode;
  },
  BoundaryState
> {
  override state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { readonly resetKey: string },
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    // Not ours: rethrown unchanged to the next boundary up (React passes whatever was thrown).
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (!isChunkLoadError(error)) throw error;
    return this.props.failed(() => {
      window.location.reload();
    });
  }
}
