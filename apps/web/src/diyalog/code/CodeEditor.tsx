import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { type DiffHandle, type LineRange, mountDiff, mountViewer, type ViewerHandle } from './cm';

/**
 * p19-ide W1: React hosts of the CodeMirror views (cm.ts). The editor lives in the host's shadow root (CSP, cm.ts);
 * React only owns the host element. A new document (or mode) mounts a new view.
 */

export interface ViewerApi {
  goToLine(start: number, end?: number): void;
  openSearch(): void;
}

export function CodeViewerPane(props: {
  readonly text: string;
  readonly path: string;
  readonly label: string;
  readonly mark: LineRange | null;
  readonly onSelect: (range: LineRange | null) => void;
  readonly apiRef?: Ref<ViewerApi | null>;
  readonly className?: string;
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ViewerHandle | null>(null);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;
  const { text, path, label, mark } = props;
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const h = mountViewer(el, {
      text,
      path,
      label,
      onSelect: (r) => {
        onSelect.current(r);
      },
    });
    handle.current = h;
    return () => {
      h.destroy();
      handle.current = null;
    };
  }, [text, path, label]);
  useEffect(() => {
    handle.current?.mark(mark);
    if (mark !== null) handle.current?.goToLine(mark.start, mark.end);
  }, [mark, text]);
  useImperativeHandle(
    props.apiRef,
    () => ({
      goToLine: (start, end) => {
        handle.current?.goToLine(start, end);
      },
      openSearch: () => {
        handle.current?.openSearch();
      },
    }),
    [],
  );
  return <div ref={host} data-testid="code-viewer" className={props.className} />;
}

export interface DiffApi {
  goToLine(side: 'old' | 'new', line: number): void;
}

export function DiffPane(props: {
  readonly old: string;
  readonly new: string;
  readonly path: string;
  readonly mode: 'side' | 'inline';
  readonly labels: { readonly old: string; readonly new: string };
  readonly onSelect: (s: { readonly side: 'old' | 'new'; readonly range: LineRange } | null) => void;
  readonly apiRef?: Ref<DiffApi | null>;
  readonly className?: string;
}): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffHandle | null>(null);
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;
  const { old, path, mode, labels } = props;
  const next = props.new;
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const h = mountDiff(el, {
      old,
      new: next,
      path,
      mode,
      labels,
      onSelect: (s) => {
        onSelect.current(s);
      },
    });
    handle.current = h;
    return () => {
      h.destroy();
      handle.current = null;
    };
    // `labels` is a fresh object per render; its words only change with the language (no remount for that).
  }, [old, next, path, mode]);
  useImperativeHandle(
    props.apiRef,
    () => ({
      goToLine: (side, line) => {
        handle.current?.goToLine(side, line);
      },
    }),
    [],
  );
  return <div ref={host} data-testid="code-diff" data-mode={mode} className={props.className} />;
}
