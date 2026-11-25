// p17-workflow-canvas (docs/design/p17-workflow-canvas.md): the card zones never overlap for any catalog node, every
// node type has a family (colour tokens with contrast in both themes, an icon), edge colours are deterministic, the
// arrange modes lay out without overlaps and are one undo step, the remembered mode survives blocked storage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_TYPES } from '../../../packages/workflow-nodes/src/catalog';
import { HARNESS_TYPES } from '../src/diyalog/harness/screens/workflowCanvas';
import { ARRANGE_KEY, loadArrangeMode, saveArrangeMode } from '../src/diyalog/screens/workflows/ArrangeMenu';
import {
  EDGE_COLORS,
  edgeLooks,
  FAMILIES,
  FAMILY_ICON,
  familyOf,
} from '../src/diyalog/screens/workflows/canvasLook';
import { historyReducer, initHistory } from '../src/diyalog/screens/workflows/history';
import {
  arrange,
  type ArrangeMode,
  type ArrangeNode,
  GROUP_PAD,
} from '../src/diyalog/screens/workflows/layout';
import { type Doc, movePositions, positionsOf } from '../src/diyalog/screens/workflows/model';
import {
  CARD_MAX_W,
  CARD_MIN_W,
  cardLayout,
  groupHeaderHeight,
  type LayoutDir,
  type LayoutInput,
  layoutProblems,
  ROW_H,
} from '../src/diyalog/screens/workflows/nodeLayout';

const CASES = {
  cases: [
    { name: 'acil' },
    { name: 'haftalik-bakim-penceresi-cok-uzun-bir-durum-adi' },
    { name: 'diger' },
    { name: 'ozel-musteri' },
    { name: 'şube-İzmir' },
  ],
};

/** The ports a card shows for a catalog type (the editor's rule: no label on a lone `in` / on `out`). */
function cardPorts(type: (typeof NODE_TYPES)[number]): NonNullable<LayoutInput['ports']> {
  const ports = type.ports(CASES);
  const ins = ports.filter((p) => p.direction === 'in');
  const outs = ports.filter((p) => p.direction === 'out' && p.side !== 'inner');
  const inner = ports.filter((p) => p.direction === 'out' && p.side === 'inner');
  return {
    in: ins.map((p) => ({ name: p.name, label: ins.length === 1 && p.name === 'in' ? '' : p.name })),
    out: outs.map((p) => ({ name: p.name, label: p.name === 'out' ? '' : p.name })),
    ...(inner.length === 0 ? {} : { inner: inner.map((p) => ({ name: p.name, label: p.name })) }),
  };
}

const TITLES = ['step', 'oncelik-yonlendirme', 'cok-uzun-bir-donusum-adimi-adi-burada-ve-daha-da-uzun-1234'];
const SUBTITLES = [
  'İş adımı · Claude Code',
  'Sürüm yöneticisi onayı (üretim ortamı, çok uzun bir açıklama başlığı)',
  'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
];

describe('card layout zones (no overlaps)', () => {
  for (const type of NODE_TYPES) {
    it(`${type.type}: title, subtitle, badges and port labels never overlap`, () => {
      const ports = cardPorts(type);
      for (const dir of ['LR', 'TB'] as LayoutDir[])
        for (const title of TITLES)
          for (const subtitle of SUBTITLES)
            for (const badges of [
              { gate: false, issues: 0 },
              { gate: true, issues: 12 },
            ]) {
              const input: LayoutInput = {
                title,
                subtitle,
                ports,
                dir,
                ...badges,
                group: type.group === true,
                subtitleIcon: true,
              };
              const l = cardLayout(input);
              expect(layoutProblems(l), `${type.type} ${dir} ${title} / ${subtitle}`).toEqual([]);
              if (type.group !== true) {
                expect(l.w).toBeGreaterThanOrEqual(CARD_MIN_W);
                expect(l.w).toBeLessThanOrEqual(CARD_MAX_W);
              }
              // Every port has a handle; labelled ones a label box on the handle's row (left → right).
              const all = [...ports.in, ...ports.out, ...(ports.inner ?? [])];
              expect(l.ports.map((p) => p.name).sort()).toEqual(all.map((p) => p.name).sort());
              for (const p of l.ports) {
                if (p.label !== null && (dir === 'LR' || type.group === true))
                  expect(p.label.y + p.label.h / 2).toBe(p.y);
                // A group keeps its ports beside its header in both directions.
                const lr = dir === 'LR' || type.group === true;
                if (lr && p.side === 'in') expect(p.x).toBe(0);
                if (lr && p.side === 'out') expect(p.x).toBe(l.w);
                if (!lr && p.side === 'in') expect(p.y).toBe(0);
                if (!lr && p.side === 'out') expect(p.y).toBe(l.h);
              }
              // Too long for the maximum width: cut with a tooltip.
              if (title === TITLES[2] && type.group !== true) expect(l.titleTruncated).toBe(true);
            }
    });
  }

  it('grows in height with the number of ports and in width with the longest label', () => {
    const port = (n: number, len: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `p${String(i)}`, label: 'x'.repeat(len) + String(i) }));
    const base = { title: 'n', subtitle: 's', dir: 'LR' as const };
    const two = cardLayout({ ...base, ports: { in: port(1, 1), out: port(2, 3) } });
    const six = cardLayout({ ...base, ports: { in: port(1, 1), out: port(6, 3) } });
    expect(six.h - two.h).toBe(4 * ROW_H);
    const wide = cardLayout({ ...base, ports: { in: port(1, 20), out: port(2, 20) } });
    expect(wide.w).toBeGreaterThan(two.w);
    const huge = cardLayout({ ...base, ports: { in: port(1, 80), out: port(2, 80) } });
    expect(huge.w).toBe(CARD_MAX_W);
    expect(huge.ports.some((p) => p.truncated)).toBe(true);
    expect(layoutProblems(huge)).toEqual([]);
  });

  it('the AI step of the report: in / context sit below the title and subtitle', () => {
    const l = cardLayout({
      title: 'step',
      subtitle: 'İş adımı · Claude Code',
      dir: 'LR',
      ports: {
        in: [
          { name: 'in', label: 'in' },
          { name: 'context', label: 'context' },
        ],
        out: [
          { name: 'out', label: '' },
          { name: 'error', label: 'error' },
        ],
      },
    });
    const sub = l.subtitle.y + l.subtitle.h;
    for (const p of l.ports) if (p.label !== null) expect(p.label.y).toBeGreaterThanOrEqual(sub);
  });

  it('a group header fits above its body (GROUP_PAD.top)', () => {
    for (const type of NODE_TYPES.filter((t) => t.group === true)) {
      const h = groupHeaderHeight({
        title: 'her-siparis',
        subtitle: 'Her öğe için',
        ports: cardPorts(type),
        dir: 'LR',
      });
      expect(h).toBeLessThanOrEqual(GROUP_PAD.top);
    }
  });

  it('the harness table matches the catalog package (types and ports)', () => {
    expect(HARNESS_TYPES.map((r) => r[0])).toEqual(NODE_TYPES.map((t) => t.type));
    for (const t of NODE_TYPES) {
      const row = HARNESS_TYPES.find((r) => r[0] === t.type);
      const names = (row?.[4] ?? '').split(' ').map((p) => p.replace(/^[<>~]/, '').replace(/[!*]+$/, ''));
      expect(names).toEqual(
        t
          .ports(CASES)
          .filter((p) => p.dynamic !== 'cases')
          .map((p) => p.name),
      );
    }
  });
});

// ------------------------------------------------------------------------------------------------ families

const css = readFileSync(join(__dirname, '../src/diyalog/screens/workflows/canvas.css'), 'utf8');
const dycss = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');

function tokens(block: string, prefix: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+):\\s*(#[0-9a-f]{6})\\s*;`, 'gi'))].map((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
}
const wfLight = tokens(/\n\.dy-wf-flow \{([^}]*--wf-trigger[^}]*)\}/.exec(css)?.[1] ?? '', 'wf');
const wfDarkMedia = tokens(
  /\[data-ui='diyalog'\]:not\(\[data-theme='light'\]\) \.dy-wf-flow \{([^}]*)\}/.exec(css)?.[1] ?? '',
  'wf',
);
const wfDarkAttr = tokens(
  /\[data-ui='diyalog'\]\[data-theme='dark'\] \.dy-wf-flow \{([^}]*)\}/.exec(css)?.[1] ?? '',
  'wf',
);
const dyLight = tokens(/\[data-ui='diyalog'\] \{([^}]*)\}/.exec(dycss)?.[1] ?? '', 'dy');
const dyDark = tokens(/\[data-ui='diyalog'\]\[data-theme='dark'\] \{([^}]*)\}/.exec(dycss)?.[1] ?? '', 'dy');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function contrast(a: string | undefined, b: string | undefined): number {
  const x = luminance(a ?? '#000000');
  const y = luminance(b ?? '#000000');
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('node families', () => {
  it('every catalog type has a family; the families follow the catalog categories', () => {
    for (const t of NODE_TYPES) {
      const f = familyOf(t.type);
      expect(FAMILIES).toContain(f);
      if (t.category === 'trigger') expect(f).toBe('trigger');
      if (t.category === 'ai') expect(f).toBe('ai');
      if (t.category === 'data') expect(f).toBe('data');
      if (t.category === 'integration') expect(f).toBe('integration');
      if (t.category === 'code') expect(f).toBe('other');
      if (t.category === 'control') expect(['flow', 'wait']).toContain(f);
    }
    expect(familyOf('control.subWorkflow')).toBe('flow');
    expect(familyOf('control.approval')).toBe('wait');
    expect(familyOf('control.waitWebhook')).toBe('wait');
    expect(familyOf('http.request')).toBe('integration');
    expect(familyOf('github.pullRequest')).toBe('integration');
    expect(familyOf('deploy.coolify')).toBe('integration');
    // v1 AI steps (a role, no type) and unknown types.
    expect(familyOf('planner')).toBe('ai');
    expect(familyOf(undefined)).toBe('ai');
    expect(familyOf('future.thing')).toBe('other');
    // Every family is used by the catalog and has its own icon (distinguishable without colour).
    expect(new Set(NODE_TYPES.map((t) => familyOf(t.type)))).toEqual(new Set(FAMILIES));
    expect(new Set(Object.values(FAMILY_ICON)).size).toBe(FAMILIES.length);
  });

  for (const [theme, wf, dy] of [
    ['light', wfLight, dyLight],
    ['dark (media)', wfDarkMedia, dyDark],
    ['dark (attribute)', wfDarkAttr, dyDark],
  ] as const) {
    it(`${theme}: family tokens with contrast (graphics ≥ 3:1, text on the tint AA)`, () => {
      const colours = new Set<string>();
      for (const f of FAMILIES) {
        const c = wf[f];
        const tint = wf[`${f}-tint`];
        const soft = wf[`${f}-soft`];
        expect(c, `--wf-${f}`).toMatch(/^#/);
        colours.add(c ?? '');
        expect(contrast(c, dy.card), `${f} on card`).toBeGreaterThanOrEqual(3);
        expect(contrast(c, tint), `${f} on its tint`).toBeGreaterThanOrEqual(3);
        expect(contrast(c, soft), `${f} on its chip`).toBeGreaterThanOrEqual(3);
        expect(contrast(dy.ink, tint), `ink on ${f} tint`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dy.muted, tint), `muted on ${f} tint`).toBeGreaterThanOrEqual(4.5);
      }
      expect(colours.size).toBe(FAMILIES.length);
      for (let i = 0; i < EDGE_COLORS; i++) {
        expect(
          contrast(wf[`e${String(i)}`], dy.thread),
          `edge ${String(i)} on the canvas`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('every family has a class and every palette slot an edge class', () => {
    for (const f of FAMILIES) expect(css).toContain(`.dy-wf-fam-${f} {`);
    for (let i = 0; i < EDGE_COLORS; i++) expect(css).toContain(`.dy-wf-edge-c${String(i)} {`);
  });
});

// ------------------------------------------------------------------------------------------------ edges

describe('edge colours', () => {
  const edges = [
    { id: 'a:out->b:in', from: 'a', to: 'b' },
    { id: 'a:error->c:in', from: 'a', to: 'c' },
    { id: 'a:true->d:in', from: 'a', to: 'd' },
    { id: 'b:out->d:in', from: 'b', to: 'd' },
    { id: 'c:out->d:in', from: 'c', to: 'd' },
  ];

  it('is deterministic (same set → same colours, whatever the order)', () => {
    const one = edgeLooks(edges);
    expect(edgeLooks([...edges].reverse())).toEqual(one);
    expect(edgeLooks(edges)).toEqual(one);
    for (const l of one.values()) {
      expect(l.color).toBeGreaterThanOrEqual(0);
      expect(l.color).toBeLessThan(EDGE_COLORS);
    }
  });

  it('edges sharing a source or a target get different colours; a fan-out differs in dash too', () => {
    const l = edgeLooks(edges);
    const c = (id: string): number => l.get(id)?.color ?? -1;
    expect(new Set([c('a:out->b:in'), c('a:error->c:in'), c('a:true->d:in')]).size).toBe(3);
    expect(new Set([c('a:true->d:in'), c('b:out->d:in'), c('c:out->d:in')]).size).toBe(3);
    expect(new Set(['a:out->b:in', 'a:error->c:in', 'a:true->d:in'].map((id) => l.get(id)?.dash)).size).toBe(
      3,
    );
  });
});

// ------------------------------------------------------------------------------------------------ arrange

const node = (id: string, over: Partial<ArrangeNode> = {}): ArrangeNode => ({ id, w: 232, h: 76, ...over });
const overlapping = (pos: Record<string, { x: number; y: number }>, ns: readonly ArrangeNode[]): string[] => {
  const out: string[] = [];
  const top = ns.filter((n) => n.parent === undefined);
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i];
      const b = top[j];
      const pa = pos[a?.id ?? ''];
      const pb = pos[b?.id ?? ''];
      if (a === undefined || b === undefined || pa === undefined || pb === undefined) continue;
      if (pa.x < pb.x + b.w && pb.x < pa.x + a.w && pa.y < pb.y + b.h && pb.y < pa.y + a.h)
        out.push(`${a.id} × ${b.id}`);
    }
  return out;
};

describe('arrange modes', () => {
  const ns = [
    node('t'),
    node('if', { h: 132 }),
    node('yes'),
    node('no', { w: 320 }),
    node('m'),
    node('lone'),
  ];
  const es = [
    { from: 't', to: 'if' },
    { from: 'if', to: 'yes', fromPort: 'true' },
    { from: 'if', to: 'no', fromPort: 'false' },
    { from: 'yes', to: 'm' },
    { from: 'no', to: 'm' },
  ];
  const positions = Object.fromEntries(ns.map((n) => [n.id, { x: 0, y: 0 }]));

  for (const mode of ['lr', 'tb', 'grid', 'tree'] as ArrangeMode[]) {
    it(`${mode}: every card placed, none overlapping`, () => {
      const p = arrange(mode, ns, es, { positions, viewport: { width: 1200, height: 800 } });
      expect(Object.keys(p).sort()).toEqual(ns.map((n) => n.id).sort());
      expect(overlapping(p, ns)).toEqual([]);
    });
  }

  it('lr reads left to right, tb top to bottom; tree keeps branches further apart', () => {
    const lr = arrange('lr', ns, es, { positions });
    expect((lr.t?.x ?? 0) < (lr.if?.x ?? 0) && (lr.if?.x ?? 0) < (lr.m?.x ?? 0)).toBe(true);
    const tb = arrange('tb', ns, es, { positions });
    expect((tb.t?.y ?? 0) < (tb.if?.y ?? 0) && (tb.if?.y ?? 0) < (tb.m?.y ?? 0)).toBe(true);
    const tree = arrange('tree', ns, es, { positions, dir: 'LR' });
    const gap = (p: typeof lr): number => Math.abs((p.yes?.y ?? 0) - (p.no?.y ?? 0));
    expect(gap(tree)).toBeGreaterThan(gap(lr));
  });

  it('lays a group body out below its header and the group around it', () => {
    const g = [
      node('each', { group: true, w: 320, h: 180, min: { w: 320, h: 84 } }),
      node('a', { parent: 'each' }),
      node('b', { parent: 'each' }),
      node('after'),
    ];
    const p = arrange(
      'lr',
      g,
      [
        { from: 'a', to: 'b' },
        { from: 'each', to: 'after', fromPort: 'results' },
      ],
      {
        positions: {},
      },
    );
    expect(p.a).toEqual({ x: GROUP_PAD.x, y: GROUP_PAD.top });
    expect((p.b?.x ?? 0) > (p.a?.x ?? 0)).toBe(true);
  });

  it('align: the selection on the anchor’s line, in order, GAP apart; one card takes its neighbours', () => {
    const at = { t: { x: 0, y: 40 }, if: { x: 300, y: 0 }, yes: { x: 280, y: 300 }, no: { x: 900, y: 500 } };
    const two = arrange('align', ns, es, { positions: at, selection: ['if', 'yes'], dir: 'LR' });
    const mid = (id: 'if' | 'yes'): number => (two[id]?.y ?? 0) + (ns.find((n) => n.id === id)?.h ?? 0) / 2;
    expect(mid('yes')).toBe(mid('if'));
    expect(Math.abs((two.yes?.x ?? 0) - (two.if?.x ?? 0))).toBeGreaterThanOrEqual(232 + 32);
    const one = arrange('align', ns, es, { positions: at, selection: ['if'], dir: 'LR' });
    expect(Object.keys(one).sort()).toEqual(['if', 'no', 't', 'yes']);
    expect(arrange('align', ns, es, { positions: at, selection: [], dir: 'LR' })).toEqual({});
    expect(arrange('align', ns, es, { positions: at, selection: ['lone'], dir: 'LR' })).toEqual({});
  });

  it('an arrangement is one undo step: undo restores the positions', () => {
    const doc: Doc = {
      name: 'x',
      inputs: {},
      defaults: {},
      nodes: ns.map((n) => ({ id: n.id, role: 'executor', prompt: 'p' })),
      edges: es,
      layout: { positions: { t: { x: 5, y: 5 }, if: { x: 9, y: 400 } } },
    };
    let h = initHistory(doc);
    const moved = arrange('grid', ns, es, { positions: positionsOf(doc) });
    h = historyReducer(h, { type: 'commit', doc: movePositions(doc, moved), now: 1 });
    expect(positionsOf(h.present)).not.toEqual(positionsOf(doc));
    h = historyReducer(h, { type: 'undo' });
    expect(positionsOf(h.present)).toEqual({ t: { x: 5, y: 5 }, if: { x: 9, y: 400 } });
  });
});

describe('the remembered arrange mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('remembers per browser; unknown values and blocked storage fall back to left → right', () => {
    expect(loadArrangeMode()).toBe('lr');
    saveArrangeMode('tree');
    expect(window.localStorage.getItem(ARRANGE_KEY)).toBe('tree');
    expect(loadArrangeMode()).toBe('tree');
    window.localStorage.setItem(ARRANGE_KEY, 'spiral');
    expect(loadArrangeMode()).toBe('lr');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(loadArrangeMode()).toBe('lr');
    expect(() => {
      saveArrangeMode('grid');
    }).not.toThrow();
  });
});
