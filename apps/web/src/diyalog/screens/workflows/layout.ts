import { graphlib, layout } from '@dagrejs/dagre';
import type { DocEdge, Pos } from './model';

/**
 * p13-workflows-ui: "Düzenle" (tidy up) — a layered layout by dagre (@dagrejs/dagre, MIT), left to right or top to
 * bottom, whichever shows the graph larger in the canvas. Positions are the node's top-left corner (React Flow's).
 */

export const CARD_W = 232;
export const CARD_H = 76;
/** p17-workflow-canvas: the gaps the layouts keep between cards. */
const GAP = 32;

export type Direction = 'LR' | 'TB';

/** The viewport the graph should fit (the canvas' size): picks the direction that shows the graph largest. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Tidy layout. With a viewport, both reading directions are laid out and the one that fits the viewport at the larger
 * zoom wins (a long pipeline reads left to right on a wide screen, top to bottom on a phone); ties keep LR.
 */
export function tidyPositions(
  ids: readonly string[],
  edges: readonly DocEdge[],
  viewport?: Viewport,
  sizes: Readonly<Record<string, Size>> = {},
): Record<string, Pos> {
  const lr = layoutIn('LR', ids, edges, sizes);
  if (viewport === undefined || viewport.width <= 0 || viewport.height <= 0) return lr;
  const tb = layoutIn('TB', ids, edges, sizes);
  return fitScale(tb, viewport, sizes) > fitScale(lr, viewport, sizes) * 1.1 ? tb : lr;
}

function fitScale(pos: Record<string, Pos>, v: Viewport, sizes: Readonly<Record<string, Size>> = {}): number {
  const ps = Object.entries(pos);
  if (ps.length === 0) return 1;
  const size = (id: string): Size => sizes[id] ?? { w: CARD_W, h: CARD_H };
  const w = Math.max(...ps.map(([id, p]) => p.x + size(id).w)) - Math.min(...ps.map(([, p]) => p.x));
  const h = Math.max(...ps.map(([id, p]) => p.y + size(id).h)) - Math.min(...ps.map(([, p]) => p.y));
  return Math.min(v.width / w, v.height / h);
}

interface DagreStyle {
  readonly nodesep: number;
  readonly ranksep: number;
  readonly edgesep?: number;
  readonly ranker?: string;
  /** Reserve room for branch labels on links that leave a named port (tree / branch spacing). */
  readonly labels?: boolean;
}

const LAYERED: Readonly<Record<Direction, DagreStyle>> = {
  LR: { nodesep: 32, ranksep: 64 },
  TB: { nodesep: 28, ranksep: 56 },
};
/** p17-workflow-canvas: "Dallanma aralıklı" — branches of conditions / loops kept apart. */
const BRANCHY: Readonly<Record<Direction, DagreStyle>> = {
  LR: { nodesep: 72, ranksep: 96, edgesep: 24, ranker: 'tight-tree', labels: true },
  TB: { nodesep: 64, ranksep: 88, edgesep: 24, ranker: 'tight-tree', labels: true },
};

function layoutIn(
  dir: Direction,
  ids: readonly string[],
  edges: readonly DocEdge[],
  sizes: Readonly<Record<string, Size>> = {},
  style: DagreStyle = LAYERED[dir],
): Record<string, Pos> {
  const g = new graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: dir,
    nodesep: style.nodesep,
    ranksep: style.ranksep,
    ...(style.edgesep === undefined ? {} : { edgesep: style.edgesep }),
    ...(style.ranker === undefined ? {} : { ranker: style.ranker }),
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const known = new Set(ids);
  const size = (id: string): Size => sizes[id] ?? { w: CARD_W, h: CARD_H };
  for (const id of ids) g.setNode(id, { width: size(id).w, height: size(id).h });
  for (const e of edges)
    if (known.has(e.from) && known.has(e.to)) {
      const named = e.fromPort !== undefined && e.fromPort !== 'out';
      g.setEdge(
        e.from,
        e.to,
        style.labels === true && named ? { width: 56, height: 20, labelpos: 'c' } : {},
        `${e.fromPort ?? 'out'}>${e.toPort ?? 'in'}`,
      );
    }
  layout(g);
  const out: Record<string, Pos> = {};
  for (const id of ids) {
    const n = g.node(id) as { x: number; y: number } | undefined;
    if (n !== undefined)
      out[id] = { x: Math.round(n.x - size(id).w / 2), y: Math.round(n.y - size(id).h / 2) };
  }
  return out;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** p14: a group's inner margin (its header above the body; p17: the header holds the group's port rows). */
export const GROUP_PAD = { x: 24, top: 84, bottom: 24 } as const;
export const GROUP_MIN: Size = { w: 320, h: 180 };

/** p14: a group's size around its children (child positions are relative to the group). */
export function groupSize(
  childPositions: readonly Pos[],
  childSize: (i: number) => Size = () => ({ w: CARD_W, h: CARD_H }),
): Size {
  if (childPositions.length === 0) return GROUP_MIN;
  const right = Math.max(...childPositions.map((p, i) => p.x + childSize(i).w));
  const bottom = Math.max(...childPositions.map((p, i) => p.y + childSize(i).h));
  return {
    w: Math.max(GROUP_MIN.w, right + GROUP_PAD.x),
    h: Math.max(GROUP_MIN.h, bottom + GROUP_PAD.bottom),
  };
}

/**
 * p14: tidy layout with groups — each group's body is laid out first (left to right, relative to the group, below
 * its header), deepest groups first, then each scope with the groups at their resulting size. Without groups this
 * is `tidyPositions`.
 */
export function tidyScoped(
  nodes: readonly {
    readonly id: string;
    readonly parent?: unknown;
    readonly height?: number;
    readonly width?: number;
  }[],
  edges: readonly DocEdge[],
  viewport?: Viewport,
): Record<string, Pos> {
  const parentOf = (id: string): string => {
    const p = nodes.find((n) => n.id === id)?.parent;
    return typeof p === 'string' ? p : '';
  };
  if (nodes.every((n) => parentOf(n.id) === '')) {
    return tidyPositions(
      nodes.map((n) => n.id),
      edges,
      viewport,
    );
  }
  const sizes: Record<string, Size> = {};
  for (const n of nodes)
    if (n.height !== undefined || n.width !== undefined)
      sizes[n.id] = { w: n.width ?? CARD_W, h: n.height ?? CARD_H };
  const out: Record<string, Pos> = {};
  const depth = (id: string): number => {
    let d = 0;
    for (let p = parentOf(id); p !== '' && d < 10; p = parentOf(p)) d++;
    return d;
  };
  const scopes = [...new Set(nodes.map((n) => parentOf(n.id)))].sort(
    (a, b) => (b === '' ? -1 : depth(b) + 1) - (a === '' ? -1 : depth(a) + 1),
  );
  for (const scope of scopes) {
    const ids = nodes.filter((n) => parentOf(n.id) === scope).map((n) => n.id);
    const inner = edges.filter((e) => ids.includes(e.from) && ids.includes(e.to));
    const pos = layoutIn('LR', ids, inner, sizes);
    for (const id of ids) {
      const p = pos[id] ?? { x: 0, y: 0 };
      out[id] = scope === '' ? p : { x: p.x + GROUP_PAD.x, y: p.y + GROUP_PAD.top };
    }
    if (scope !== '') {
      sizes[scope] = groupSize(
        ids.map((id) => out[id] ?? { x: 0, y: 0 }),
        (i) => sizes[ids[i] ?? ''] ?? { w: CARD_W, h: CARD_H },
      );
    }
  }
  return out;
}

/** The reading direction of placed steps (where links mostly point), for the cards' connection points. */
export function directionOf(pos: Readonly<Record<string, Pos>>, edges: readonly DocEdge[]): Direction {
  let dx = 0;
  let dy = 0;
  for (const e of edges) {
    const a = pos[e.from];
    const b = pos[e.to];
    if (a === undefined || b === undefined) continue;
    dx += Math.abs(b.x - a.x);
    dy += Math.abs(b.y - a.y);
  }
  return dy > dx ? 'TB' : 'LR';
}

/** A stand-in for the canvas size before it is on screen (the window minus the side panel and the page head). */
export function windowViewport(): Viewport {
  const w = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const h = typeof window === 'undefined' ? 800 : window.innerHeight;
  return { width: Math.max(320, w - (w >= 1024 ? 440 : 0)), height: Math.max(320, h - 260) };
}

// ------------------------------------------------------------------------------------------------ arrange modes

/**
 * p17-workflow-canvas (docs/design/p17-workflow-canvas.md §4): the arrange button's modes — layered left → right,
 * layered top → bottom, a compact grid, branch spacing (layered, wider apart, room for branch labels) and aligning
 * the selection. Every mode except `align` lays out each scope (a group's body first, deepest first) and grows the
 * groups around their bodies.
 */
export const ARRANGE_MODES = ['lr', 'tb', 'grid', 'tree', 'align'] as const;
export type ArrangeMode = (typeof ARRANGE_MODES)[number];

export interface ArrangeNode {
  readonly id: string;
  readonly parent?: string | undefined;
  /** The drawn size (a group: at least `min`, grown around its body). */
  readonly w: number;
  readonly h: number;
  /** A group's smallest size (its header and ports). */
  readonly min?: Size;
  readonly group?: boolean;
}

export interface ArrangeOptions {
  /** The current positions (top-left; a group's children relative to it). */
  readonly positions: Readonly<Record<string, Pos>>;
  /** `align`: the selected nodes (first: the anchor). */
  readonly selection?: readonly string[];
  /** `tree` / `align`: the reading direction (default: of the current positions). */
  readonly dir?: Direction;
  readonly viewport?: Viewport;
}

/** The new positions of a mode (only the nodes it moves; merge them over the current ones). */
export function arrange(
  mode: ArrangeMode,
  nodes: readonly ArrangeNode[],
  edges: readonly DocEdge[],
  opts: ArrangeOptions,
): Record<string, Pos> {
  if (mode === 'align') return alignSelection(nodes, edges, opts);
  const dir: Direction =
    mode === 'lr' ? 'LR' : mode === 'tb' ? 'TB' : (opts.dir ?? directionOf(opts.positions, edges));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const scopeOf = (id: string): string => byId.get(id)?.parent ?? '';
  const depth = (id: string): number => {
    let d = 0;
    for (let p = scopeOf(id); p !== '' && d < 10; p = scopeOf(p)) d++;
    return d;
  };
  const sizes: Record<string, Size> = {};
  for (const n of nodes) sizes[n.id] = { w: n.w, h: n.h };
  const scopes = [...new Set(nodes.map((n) => scopeOf(n.id)))].sort(
    (a, b) => (b === '' ? -1 : depth(b) + 1) - (a === '' ? -1 : depth(a) + 1),
  );
  const out: Record<string, Pos> = {};
  for (const scope of scopes) {
    const ids = nodes.filter((n) => scopeOf(n.id) === scope).map((n) => n.id);
    const inner = edges.filter((e) => ids.includes(e.from) && ids.includes(e.to));
    const pos =
      mode === 'grid'
        ? gridIn(ids, inner, sizes, scope === '' ? opts.viewport : undefined)
        : layoutIn(dir, ids, inner, sizes, mode === 'tree' ? BRANCHY[dir] : LAYERED[dir]);
    for (const id of ids) {
      const p = pos[id] ?? { x: 0, y: 0 };
      out[id] = scope === '' ? p : { x: p.x + GROUP_PAD.x, y: p.y + GROUP_PAD.top };
    }
    if (scope !== '') {
      const g = byId.get(scope);
      const grown = groupSize(
        ids.map((id) => out[id] ?? { x: 0, y: 0 }),
        (i) => sizes[ids[i] ?? ''] ?? { w: CARD_W, h: CARD_H },
      );
      sizes[scope] = { w: Math.max(grown.w, g?.min?.w ?? 0), h: Math.max(grown.h, g?.min?.h ?? 0) };
    }
  }
  return out;
}

/**
 * The compact grid: cards in reading order (layered left → right, then top → bottom) filled row by row, as many
 * columns as keep the grid near the viewport's shape (or square).
 */
function gridIn(
  ids: readonly string[],
  edges: readonly DocEdge[],
  sizes: Readonly<Record<string, Size>>,
  viewport?: Viewport,
): Record<string, Pos> {
  if (ids.length === 0) return {};
  const order = layoutIn('LR', ids, edges, sizes);
  const sorted = [...ids].sort((a, b) => {
    const pa = order[a] ?? { x: 0, y: 0 };
    const pb = order[b] ?? { x: 0, y: 0 };
    return pa.x - pb.x || pa.y - pb.y || (a < b ? -1 : 1);
  });
  const size = (id: string): Size => sizes[id] ?? { w: CARD_W, h: CARD_H };
  const cellW = Math.max(...ids.map((id) => size(id).w)) + GAP;
  const cellH = Math.max(...ids.map((id) => size(id).h)) + GAP;
  const aspect =
    viewport !== undefined && viewport.width > 0 && viewport.height > 0
      ? viewport.width / viewport.height
      : 1;
  const cols = Math.max(
    1,
    Math.min(ids.length, Math.round(Math.sqrt((ids.length * aspect * cellH) / cellW)) || 1),
  );
  const out: Record<string, Pos> = {};
  let y = 0;
  for (let row = 0; row * cols < sorted.length; row++) {
    const items = sorted.slice(row * cols, row * cols + cols);
    items.forEach((id, col) => {
      out[id] = { x: col * cellW, y };
    });
    y += Math.max(...items.map((id) => size(id).h)) + GAP;
  }
  return out;
}

/**
 * Align the selection: the selected cards (one card: it and its direct neighbours in its scope) on the anchor's line
 * across the reading direction — same middle height left → right, same middle column top → bottom — in their order
 * along it, at least GAP apart.
 */
function alignSelection(
  nodes: readonly ArrangeNode[],
  edges: readonly DocEdge[],
  opts: ArrangeOptions,
): Record<string, Pos> {
  const sel = (opts.selection ?? []).filter((id) => nodes.some((n) => n.id === id));
  const anchorId = sel[0];
  if (anchorId === undefined) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const scope = byId.get(anchorId)?.parent ?? '';
  const inScope = (id: string): boolean => (byId.get(id)?.parent ?? '') === scope;
  let ids = sel.filter(inScope);
  if (ids.length === 1) {
    const near = edges.flatMap((e) => (e.from === anchorId ? [e.to] : e.to === anchorId ? [e.from] : []));
    ids = [...new Set([anchorId, ...near.filter(inScope)])];
  }
  if (ids.length < 2) return {};
  const dir = opts.dir ?? directionOf(opts.positions, edges);
  const at = (id: string): Pos => opts.positions[id] ?? { x: 0, y: 0 };
  const size = (id: string): Size => {
    const n = byId.get(id);
    return { w: n?.w ?? CARD_W, h: n?.h ?? CARD_H };
  };
  const a = at(anchorId);
  const line = dir === 'LR' ? a.y + size(anchorId).h / 2 : a.x + size(anchorId).w / 2;
  const along = (id: string): number => (dir === 'LR' ? at(id).x : at(id).y);
  const sorted = [...ids].sort((p, q) => along(p) - along(q) || (p < q ? -1 : 1));
  const out: Record<string, Pos> = {};
  let next = -Infinity;
  for (const id of sorted) {
    const s = size(id);
    const main = Math.max(along(id), next);
    out[id] =
      dir === 'LR'
        ? { x: Math.round(main), y: Math.round(line - s.h / 2) }
        : { x: Math.round(line - s.w / 2), y: Math.round(main) };
    next = main + (dir === 'LR' ? s.w : s.h) + GAP;
  }
  return out;
}
