/**
 * Layered layout for a workflow DAG (p4-dag run view): column = longest path from a root, rows ordered by
 * the barycentre of their upstream rows to keep edges short. Pure; no layout library.
 */
export interface LayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly layer: number;
}

export interface Layout {
  readonly nodes: readonly LayoutNode[];
  readonly width: number;
  readonly height: number;
}

export const NODE_W = 168;
export const NODE_H = 52;
const GAP_X = 64;
const GAP_Y = 24;
const PAD = 16;

export function layoutDag(ids: readonly string[], edges: readonly { from: string; to: string }[]): Layout {
  const known = new Set(ids);
  const es = edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const up = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of es) up.get(e.to)?.push(e.from);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // defensive: cycles are rejected by the master
    visiting.add(id);
    const d = Math.max(-1, ...(up.get(id) ?? []).map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  const layers: string[][] = [];
  for (const id of [...ids].sort()) {
    const l = layer.get(id) ?? 0;
    (layers[l] ??= []).push(id);
  }
  const row = new Map<string, number>();
  layers.forEach((ls, li) => {
    if (li > 0) {
      const bary = (id: string): number => {
        const ups = (up.get(id) ?? []).map((u) => row.get(u) ?? 0);
        return ups.length === 0 ? 0 : ups.reduce((a, b) => a + b, 0) / ups.length;
      };
      ls.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    }
    ls.forEach((id, i) => row.set(id, i));
  });
  const maxRows = Math.max(1, ...layers.map((l) => l.length));
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;
  const nodes: LayoutNode[] = [];
  layers.forEach((ls, li) => {
    const colH = ls.length * NODE_H + (ls.length - 1) * GAP_Y;
    const top = (height - colH) / 2;
    ls.forEach((id, i) => {
      nodes.push({ id, layer: li, x: PAD + li * (NODE_W + GAP_X), y: top + i * (NODE_H + GAP_Y) });
    });
  });
  const width = PAD * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * GAP_X;
  return { nodes, width, height };
}
