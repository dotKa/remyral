import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutDag } from '../src/lib/dag-layout';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dag layout', () => {
  it('places nodes in layers by longest path, without overlaps', () => {
    const l = layoutDag(
      ['plan', 'a', 'b', 'verify'],
      [
        { from: 'plan', to: 'a' },
        { from: 'plan', to: 'b' },
        { from: 'a', to: 'verify' },
        { from: 'b', to: 'verify' },
      ],
    );
    const by = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect([by.plan?.layer, by.a?.layer, by.b?.layer, by.verify?.layer]).toEqual([0, 1, 1, 2]);
    expect(by.a?.x).toBe(by.b?.x);
    expect(by.a?.y).not.toBe(by.b?.y);
    expect(l.width).toBeGreaterThan(3 * 168);
    // Defensive against bad input: unknown edges and cycles do not throw.
    expect(
      layoutDag(
        ['x', 'y'],
        [
          { from: 'x', to: 'y' },
          { from: 'y', to: 'x' },
          { from: 'x', to: 'zzz' },
        ],
      ).nodes,
    ).toHaveLength(2);
  });
});
