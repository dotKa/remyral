import { useCallback, useEffect, useRef, useState } from 'react';
import { getTree, type TreeNode } from '../../api/output-folders';

/**
 * p8-outputs-folders (docs/design/p8-outputs-folders.md §7): the left tree of the Outputs screen — projects and My
 * folders, a project's Folders / Sites / Notes / jobs, a job's out/ directories and folders' sub-folders, loaded one
 * level at a time. WAI-ARIA tree: one tab stop (roving tabindex), ↑/↓ move, → opens / enters, ← closes / goes to the
 * parent, Home / End, Enter / Space select. Folder rows accept dropped Outputs cards (links, not moves). Phones get
 * {@link DrillDown} instead: one level per screen with a back button.
 */

export const ROOT_KEY = '#root';

/** Stable key of a node (project + path). */
export function nodeKey(n: Pick<TreeNode, 'project' | 'path'>): string {
  return `${n.project ?? ''}|${n.path}`;
}

export interface Level {
  readonly nodes: TreeNode[];
  readonly total: number;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Loads and caches tree levels (one request per opened node). Shared with the Diyalog tree. */
export function useLevels(refreshKey: number) {
  const [levels, setLevels] = useState<ReadonlyMap<string, Level>>(new Map());
  const pending = useRef(new Set<string>());

  useEffect(() => {
    // A save elsewhere (new folder, link) reloads the opened levels.
    setLevels(new Map());
    pending.current.clear();
  }, [refreshKey]);

  const load = useCallback((parent: TreeNode | null, offset = 0): void => {
    const key = parent === null ? ROOT_KEY : nodeKey(parent);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setLevels((m) => {
      const next = new Map(m);
      const cur = m.get(key);
      next.set(key, { nodes: cur?.nodes ?? [], total: cur?.total ?? 0, loading: true, error: null });
      return next;
    });
    getTree(parent?.project ?? null, parent?.path ?? '', offset).then(
      (r) => {
        pending.current.delete(key);
        setLevels((m) => {
          const next = new Map(m);
          const before = offset > 0 ? (m.get(key)?.nodes ?? []) : [];
          next.set(key, { nodes: [...before, ...r.nodes], total: r.total, loading: false, error: null });
          return next;
        });
      },
      (err: unknown) => {
        pending.current.delete(key);
        setLevels((m) => {
          const next = new Map(m);
          next.set(key, {
            nodes: m.get(key)?.nodes ?? [],
            total: 0,
            loading: false,
            error: err instanceof Error ? err.message : 'Could not load.',
          });
          return next;
        });
      },
    );
  }, []);

  return { levels, load };
}

export function findNode(levels: ReadonlyMap<string, Level>, key: string): TreeNode | null {
  for (const l of levels.values()) {
    const n = l.nodes.find((x) => nodeKey(x) === key);
    if (n !== undefined) return n;
  }
  return null;
}
