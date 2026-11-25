import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Category, WorkflowCatalog } from '../../../api/workflowEngine';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon, type IconName } from '../../icons';
import type { AddKind } from './model';
import { availability, CATEGORY_ORDER, nodeTypeText } from './nodeCatalog';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.1): the node palette that replaces "Adım ekle" when
 * the master runs the new engine — categories (Tetikleyiciler · Yapay zeka · Akış kontrolü · Veri · Entegrasyonlar ·
 * Kod), search, a one-line description per node, entries that cannot be added yet disabled with the reason (a later
 * phase, a permission). Keyboard: `/` opens it (editor), ↑ / ↓ move, Enter adds after the selected node.
 */

export type PaletteChoice =
  { readonly kind: 'ai'; readonly add: AddKind } | { readonly kind: 'type'; readonly type: string };

const AI_KINDS: readonly { add: AddKind; icon: IconName }[] = [
  { add: 'executor', icon: 'jobs' },
  { add: 'planner', icon: 'grid' },
  { add: 'verifier', icon: 'checkc' },
  { add: 'reviewer', icon: 'search' },
  { add: 'integrator', icon: 'merge' },
  { add: 'gate', icon: 'shield' },
];

const CATEGORY_ICON: Readonly<Record<Category, IconName>> = {
  trigger: 'send',
  ai: 'jobs',
  control: 'branch',
  data: 'file',
  integration: 'globe',
  code: 'grid',
};

interface Entry {
  readonly key: string;
  readonly category: Category;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
  readonly choice: PaletteChoice;
  readonly disabled: string | null;
}

export function Palette(props: {
  readonly catalog: WorkflowCatalog;
  readonly projectRole: string | null;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onAdd: (c: PaletteChoice) => void;
}): ReactNode {
  const t = useT();
  const w = t.workflows;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { open, onOpen } = props;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    search.current?.focus();
    const close = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('mousedown', close);
    };
  }, [open, onOpen]);

  const entries: Entry[] = useMemo(() => {
    const ai: Entry[] = AI_KINDS.map((k) => ({
      key: `ai:${k.add}`,
      category: 'ai',
      label: w.palette.ai[k.add].label,
      description: w.palette.ai[k.add].description,
      icon: k.icon,
      choice: { kind: 'ai', add: k.add },
      disabled: null,
    }));
    const typed: Entry[] = props.catalog.types
      .filter((x) => x.type !== 'ai.step')
      .map((x) => {
        const a = availability(x, props.catalog, props.projectRole);
        return {
          key: x.type,
          category: x.category,
          label: nodeTypeText(w, x.type)?.label ?? x.type,
          description: nodeTypeText(w, x.type)?.description ?? '',
          icon: CATEGORY_ICON[x.category],
          choice: { kind: 'type', type: x.type } as const,
          disabled: a.ok ? null : w.palette.unavailable[a.reason],
        };
      });
    return [...ai, ...typed];
  }, [props.catalog, props.projectRole, w]);

  const q = query.trim().toLocaleLowerCase();
  const shown = entries.filter(
    (e) =>
      q === '' ||
      e.label.toLocaleLowerCase().includes(q) ||
      e.description.toLocaleLowerCase().includes(q) ||
      e.key.toLowerCase().includes(q),
  );
  const enabled = shown.filter((e) => e.disabled === null);

  const add = (e: Entry): void => {
    if (e.disabled !== null) return;
    onOpen(false);
    props.onAdd(e.choice);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        data-testid="toolbar-palette"
        aria-keyshortcuts="/"
        onClick={() => {
          onOpen(!open);
        }}
        className="dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[8px] bg-dy-ink px-2.5 text-[0.8125rem] font-bold text-dy-card disabled:opacity-40"
      >
        <DyIcon name="plus" className="size-4" />
        {w.palette.button}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={w.palette.title}
          data-testid="workflow-palette"
          className="dy-pop absolute top-full left-0 z-30 mt-1 grid max-h-[70vh] w-[min(92vw,360px)] grid-rows-[auto_1fr] gap-1 rounded-[12px] border border-dy-line bg-dy-card p-2 shadow-dy-pop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onOpen(false);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (enabled.length === 0) return;
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const pick = enabled[active];
              if (pick !== undefined) add(pick);
            }
          }}
        >
          <input
            ref={search}
            type="search"
            value={query}
            aria-label={w.palette.search}
            placeholder={w.palette.search}
            data-testid="palette-search"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem]"
          />
          <div className="min-h-0 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="m-0 p-2 text-[0.84375rem] text-dy-muted">{w.palette.none}</p>
            ) : (
              CATEGORY_ORDER.map((c) => {
                const items = shown.filter((e) => e.category === c);
                if (items.length === 0) return null;
                return (
                  <section key={c} aria-label={w.palette.categories[c]} className="mb-1">
                    <h3 className="m-0 px-2 pt-1.5 pb-0.5 text-[0.75rem] font-bold tracking-wide text-dy-muted uppercase">
                      {w.palette.categories[c]}
                    </h3>
                    <ul className="m-0 grid list-none gap-0.5 p-0">
                      {items.map((e) => {
                        const isActive = e.disabled === null && enabled[active]?.key === e.key;
                        return (
                          <li key={e.key}>
                            <button
                              type="button"
                              disabled={e.disabled !== null}
                              aria-describedby={`pal-${e.key.replace(/[^a-z0-9]/gi, '-')}`}
                              data-testid={`palette-${e.key}`}
                              data-active={isActive ? 'true' : undefined}
                              onClick={() => {
                                add(e);
                              }}
                              className={cx(
                                'flex w-full items-start gap-2 rounded-[8px] px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50',
                                isActive
                                  ? 'bg-dy-sunk'
                                  : '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                              )}
                            >
                              <DyIcon name={e.icon} className="mt-0.5 size-4 shrink-0 text-dy-muted" />
                              <span className="min-w-0">
                                <span className="block text-[0.875rem] text-dy-ink">{e.label}</span>
                                <span
                                  id={`pal-${e.key.replace(/[^a-z0-9]/gi, '-')}`}
                                  className="block text-[0.75rem] text-dy-muted"
                                >
                                  {e.disabled ?? e.description}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
