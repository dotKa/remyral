import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { DRAG_TYPE, parseDragPayload, type TreeNode } from '../../../api/output-folders';
import { cx } from '../../../components/ui';
import { findNode, nodeKey, ROOT_KEY, useLevels } from '../../../screens/outputs/OutputsTree';
import { DyIcon, type IconName } from '../../icons';
import { DyButton, SkeletonRows } from '../parts';
import { useT } from '../../../i18n/I18nProvider';
import { nodeLabel } from './Folders';

/**
 * p12-diyalog-w2: the folder tree of Çıktılar in the Diyalog language — projects and Klasörlerim, a project's
 * Klasörler / Siteler / Notlar / jobs, a job's out/ directories and sub-folders, one level at a time (the classic
 * `useLevels` loader). WAI-ARIA tree as the classic one: one tab stop (roving tabindex), ↑ / ↓ move, → opens / enters,
 * ← closes / goes to the parent, Home / End, Enter / Space select. Folder rows accept dropped output cards (links, not
 * moves). Phones get {@link DrillDown}: one level per screen with a way back.
 */

const KIND_ICON: Readonly<Record<TreeNode['kind'], IconName>> = {
  project: 'grid',
  personal: 'flag',
  folders: 'folder',
  sites: 'globe',
  notes: 'pen',
  job: 'jobs',
  dir: 'folder',
  folder: 'folder',
};

interface Row {
  readonly node: TreeNode;
  readonly level: number;
  readonly parent: string;
  readonly trail: readonly TreeNode[];
}

export function OutputsTree(props: {
  readonly selected: string | null;
  readonly onSelect: (node: TreeNode, trail: readonly TreeNode[]) => void;
  readonly onDropItem: (folder: TreeNode, item: { project: string; key: string }) => void;
  readonly refreshKey: number;
}): ReactNode {
  const t = useT().outputs;
  const { levels, load } = useLevels(props.refreshKey);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    if (!levels.has(ROOT_KEY)) load(null);
  }, [levels, load]);
  useEffect(() => {
    for (const k of expanded) {
      if (levels.has(k)) continue;
      const row = findNode(levels, k);
      if (row !== null) load(row);
    }
  }, [expanded, levels, load]);

  const rows: Row[] = [];
  const walk = (parentKey: string, level: number, trail: readonly TreeNode[]): void => {
    for (const node of levels.get(parentKey)?.nodes ?? []) {
      const k = nodeKey(node);
      rows.push({ node, level, parent: parentKey, trail: [...trail, node] });
      if (expanded.has(k)) walk(k, level + 1, [...trail, node]);
    }
  };
  walk(ROOT_KEY, 1, []);
  const focusKey = focus ?? props.selected ?? (rows[0] === undefined ? null : nodeKey(rows[0].node));

  function toggle(node: TreeNode, open?: boolean): void {
    const k = nodeKey(node);
    const willOpen = open ?? !expanded.has(k);
    setExpanded((s) => {
      const next = new Set(s);
      if (willOpen) next.add(k);
      else next.delete(k);
      return next;
    });
    if (willOpen && !levels.has(k)) load(node);
  }

  function move(k: string): void {
    setFocus(k);
    refs.current.get(k)?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLLIElement>, row: Row): void {
    const i = rows.findIndex((r) => r.node === row.node);
    const k = nodeKey(row.node);
    const go = (r: Row | undefined): void => {
      if (r !== undefined) move(nodeKey(r.node));
    };
    switch (e.key) {
      case 'ArrowDown':
        go(rows[i + 1]);
        break;
      case 'ArrowUp':
        go(rows[i - 1]);
        break;
      case 'Home':
        go(rows[0]);
        break;
      case 'End':
        go(rows.at(-1));
        break;
      case 'ArrowRight':
        if (!row.node.hasChildren) break;
        if (!expanded.has(k)) toggle(row.node, true);
        else go(rows[i + 1]?.parent === k ? rows[i + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (expanded.has(k)) toggle(row.node, false);
        else if (row.parent !== ROOT_KEY) move(row.parent);
        break;
      case 'Enter':
      case ' ':
        props.onSelect(row.node, row.trail);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const drop = {
    over(e: DragEvent, node: TreeNode): void {
      if (node.kind !== 'folder' || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      setDropOn(nodeKey(node));
    },
    drop(e: DragEvent, node: TreeNode): void {
      setDropOn(null);
      if (node.kind !== 'folder') return;
      const payload = parseDragPayload(e.dataTransfer.getData(DRAG_TYPE));
      if (payload === null) return;
      e.preventDefault();
      props.onDropItem(node, payload);
    },
  };

  const root = levels.get(ROOT_KEY);
  if (root === undefined || (root.loading && root.nodes.length === 0))
    return <SkeletonRows label={t.tree.loading} rows={4} />;
  if (root.error !== null && root.nodes.length === 0)
    return <p className="m-0 p-2 text-[0.8125rem] text-dy-muted">{t.tree.unreadable}</p>;

  const render = (parentKey: string): ReactNode =>
    rows
      .filter((r) => r.parent === parentKey)
      .map((row) => {
        const k = nodeKey(row.node);
        const open = expanded.has(k);
        const child = levels.get(k);
        const selected = props.selected === k;
        return (
          <li
            key={k}
            ref={(el) => {
              if (el === null) refs.current.delete(k);
              else refs.current.set(k, el);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-selected={selected}
            aria-expanded={row.node.hasChildren ? open : undefined}
            aria-label={nodeLabel(row.node, t.nodes)}
            tabIndex={focusKey === k ? 0 : -1}
            data-testid="tree-node"
            data-kind={row.node.kind}
            onKeyDown={(e) => {
              onKey(e, row);
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocus(k);
            }}
            className="outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-dy-teal"
          >
            <div
              className={cx(
                'flex min-h-9 cursor-pointer items-center gap-1.5 rounded-[8px] pr-2 text-[0.84375rem]',
                selected
                  ? 'bg-dy-teal-soft font-bold text-dy-teal-ink'
                  : '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                dropOn === k && 'ring-2 ring-dy-teal',
              )}
              style={{ paddingLeft: `${String((row.level - 1) * 0.875 + 0.125)}rem` }}
              onClick={() => {
                setFocus(k);
                props.onSelect(row.node, row.trail);
              }}
              onDragOver={(e) => {
                drop.over(e, row.node);
              }}
              onDragLeave={() => {
                setDropOn(null);
              }}
              onDrop={(e) => {
                drop.drop(e, row.node);
              }}
              data-drop={row.node.kind === 'folder' ? 'folder' : undefined}
            >
              {row.node.hasChildren ? (
                <span
                  aria-hidden="true"
                  className="grid size-6 shrink-0 place-items-center rounded-md text-dy-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(row.node);
                  }}
                >
                  <DyIcon
                    name="chev"
                    className={cx('size-3.5 transition-transform duration-150', !open && '-rotate-90')}
                  />
                </span>
              ) : (
                <span aria-hidden="true" className="inline-block size-6 shrink-0" />
              )}
              <DyIcon
                name={KIND_ICON[row.node.kind]}
                className={cx('size-3.5 shrink-0', selected ? 'text-dy-teal-ink' : 'text-dy-faint')}
              />
              <span className="min-w-0 flex-1 truncate">{nodeLabel(row.node, t.nodes)}</span>
              {row.node.count !== null && row.node.count > 0 ? (
                <span className="shrink-0 font-dy-mono text-[0.75rem] font-normal text-dy-muted tabular-nums">
                  {row.node.count}
                </span>
              ) : null}
            </div>
            {open ? (
              <ul role="group" className="m-0 flex list-none flex-col p-0">
                {child === undefined || (child.loading && child.nodes.length === 0) ? (
                  <li role="none" className="py-1 pl-8 text-[0.78125rem] text-dy-muted">
                    {t.tree.loadingShort}
                  </li>
                ) : (
                  render(k)
                )}
                {child !== undefined && !child.loading && child.nodes.length < child.total ? (
                  <li role="none" className="pl-8">
                    <button
                      type="button"
                      className="min-h-8 text-[0.78125rem] font-medium text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      onClick={() => {
                        load(row.node, child.nodes.length);
                      }}
                    >
                      {t.tree.more({ n: child.total - child.nodes.length })}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>
        );
      });

  return (
    <ul
      role="tree"
      aria-label={t.tree.label}
      className="m-0 flex list-none flex-col p-0"
      data-testid="outputs-tree"
    >
      {render(ROOT_KEY)}
    </ul>
  );
}

/** Phone layout: one level of the tree at a time; a node with children opens its level, "Geri" returns. */
export function DrillDown(props: {
  readonly onSelect: (node: TreeNode | null, trail: readonly TreeNode[]) => void;
  readonly refreshKey: number;
}): ReactNode {
  const t = useT().outputs;
  const { levels, load } = useLevels(props.refreshKey);
  const [stack, setStack] = useState<readonly TreeNode[]>([]);
  const top = stack.at(-1) ?? null;
  const key = top === null ? ROOT_KEY : nodeKey(top);
  const level = levels.get(key);
  useEffect(() => {
    if (!levels.has(key)) load(top);
  }, [key, levels, load, top]);

  return (
    <nav
      aria-label={t.tree.label}
      className="overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy"
      data-testid="outputs-drilldown"
    >
      <div className="flex min-h-12 items-center gap-2 border-b border-dy-line px-2">
        {top !== null ? (
          <DyButton
            variant="ghost"
            icon="back"
            onClick={() => {
              const next = stack.slice(0, -1);
              setStack(next);
              props.onSelect(next.at(-1) ?? null, next);
            }}
          >
            {t.tree.back}
          </DyButton>
        ) : null}
        <span className="min-w-0 truncate px-1 text-[0.875rem] font-bold">
          {top === null ? t.tree.all : nodeLabel(top, t.nodes)}
        </span>
      </div>
      {level === undefined || (level.loading && level.nodes.length === 0) ? (
        <SkeletonRows label={t.tree.loading} rows={3} />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {level.nodes.map((n) => (
            <li key={nodeKey(n)} className="border-t border-dy-line first:border-t-0">
              <button
                type="button"
                className="dy-press flex min-h-12 w-full items-center gap-2.5 px-3.5 text-left text-[0.9375rem]"
                onClick={() => {
                  const trail = [...stack, n];
                  props.onSelect(n, trail);
                  if (n.hasChildren) setStack(trail);
                }}
              >
                <DyIcon name={KIND_ICON[n.kind]} className="size-4 shrink-0 text-dy-faint" />
                <span className="min-w-0 flex-1 truncate">{nodeLabel(n, t.nodes)}</span>
                {n.count !== null && n.count > 0 ? (
                  <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">{n.count}</span>
                ) : null}
                {n.hasChildren ? <DyIcon name="chev" className="size-4 -rotate-90 text-dy-faint" /> : null}
              </button>
            </li>
          ))}
          {level.nodes.length === 0 ? (
            <li className="px-3.5 py-3 text-[0.875rem] text-dy-muted">{t.tree.nothing}</li>
          ) : null}
        </ul>
      )}
    </nav>
  );
}
