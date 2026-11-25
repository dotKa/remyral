import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunEdge, WorkflowNode } from '../../../api/workflows';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { runtimeName } from '../../../lib/reasons';
import { nodeLook } from '../jobs/WorkflowRuns';
import { directionOf, tidyPositions, type Viewport, windowViewport } from './layout';
import { roleName } from './model';
import { nodeName, runPorts, v2Look } from './runView';
import { cardSize } from './nodeLayout';
import WorkflowCanvas, { cardInput, type CanvasEdge, type CanvasNode, type CardData } from './WorkflowCanvas';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §5): the run page's graph — the editor's canvas renderer,
 * read-only, with each step's live state (Kuyrukta / Çalışıyor / Onay bekliyor / Bitti / Başarısız …, a word, a colour
 * and a breathing dot while running). Steps a planner added are dashed. Laid out by the same dagre tidy as the
 * editor (a run has no saved positions: planner steps appear at run time). Lazy chunk (WorkflowRuns.tsx).
 */

const STATE_KEY = (n: WorkflowNode): string =>
  n.state === 'queued' && n.jobState === 'RUNNING' ? 'running' : n.state;

export default function RunGraph(props: {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly RunEdge[];
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}): ReactNode {
  const t = useT();
  const fmt = useFormat();
  // p14: engine-2 runs carry ports on their links: the cards get named handles, labels and dashed skipped paths.
  const ports = runPorts(props.nodes, props.edges);
  const box = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>(windowViewport);
  useLayoutEffect(() => {
    const el = box.current;
    if (el !== null && el.clientWidth > 0 && el.clientHeight > 0)
      setViewport({ width: el.clientWidth, height: el.clientHeight });
  }, []);
  const ids = props.nodes.map((n) => n.id).join('\u0000');
  const edgeIds = props.edges.map((e) => `${e.from}->${e.to}`).join('\u0000');
  const dataOf = (n: WorkflowNode, dir: 'LR' | 'TB'): CardData => {
    const look = v2Look(n, t, fmt) ?? nodeLook(n, t);
    const running = (n.state === 'queued' && n.jobState === 'RUNNING') || n.nodeRunState === 'running';
    const p = ports?.get(n.id);
    const view =
      p === undefined
        ? undefined
        : {
            in: p.in.map((name) => ({ name, label: p.in.length === 1 && name === 'in' ? '' : name })),
            out: p.out.map((name) => ({
              name,
              label: name === 'out' ? '' : name,
              ...(name === 'error' ? { error: true } : {}),
            })),
          };
    return {
      id: n.id,
      type: n.type === '' ? 'ai.step' : n.type,
      role: n.role,
      roleLabel: n.type !== 'ai.step' ? nodeName(n, t) : roleName(t.workflows.model, n.role),
      ...(view === undefined ? {} : { ports: view }),
      runtime: n.runtime === null ? null : runtimeName(n.runtime),
      gate: n.gate !== null,
      dynamic: false,
      planned: n.parent !== null,
      issues: 0,
      state: { label: look.label, tone: look.tone, icon: look.icon, running, key: STATE_KEY(n) },
      editable: false,
      dir,
    };
  };
  // Positions only change when the shape does (a planner expanded), not on every poll; p17: the cards' own sizes.
  const positions = useMemo(
    () =>
      tidyPositions(
        props.nodes.map((n) => n.id),
        props.edges,
        viewport,
        Object.fromEntries(
          props.nodes.map((n) => [n.id, cardSize(cardInput(dataOf(n, 'LR'), t.workflows.canvas.dynamic))]),
        ),
      ),
    [ids, edgeIds, viewport],
  );
  const dir = directionOf(positions, props.edges);
  const nodes: CanvasNode[] = props.nodes.map((n) => ({
    id: n.id,
    position: positions[n.id] ?? { x: 0, y: 0 },
    data: dataOf(n, dir),
  }));
  const stateOf = new Map(props.nodes.map((n) => [n.id, n]));
  const edges: CanvasEdge[] = props.edges.map((e) => {
    const to = stateOf.get(e.to);
    const fp = e.fromPort ?? 'out';
    return {
      id: ports === null ? `${e.from}->${e.to}` : `${e.from}:${fp}->${e.to}:${e.toPort ?? 'in'}`,
      from: e.from,
      to: e.to,
      dashed: (to?.parent !== null && to?.parent !== undefined) || e.state === 'skip',
      live: to !== undefined && to.state === 'queued' && to.jobState === 'RUNNING',
      ...(ports === null
        ? {}
        : {
            fromPort: fp,
            toPort: e.toPort ?? 'in',
            ...(fp === 'out' ? {} : { label: fp }),
            ...(fp === 'error' ? { error: true } : {}),
          }),
    };
  });
  return (
    <div
      ref={box}
      className="h-full w-full"
      data-edges={edges.map((e) => e.id).join(' ')}
      data-skipped-edges={edges
        .filter((e) => e.dashed === true)
        .map((e) => e.id)
        .join(' ')}
    >
      <WorkflowCanvas
        label={t.workflows.canvas.runGraph}
        nodes={nodes}
        edges={edges}
        selectedNode={props.selected}
        editable={false}
        minimap={props.nodes.length > 12}
        onSelectNode={(id) => {
          if (id !== null) props.onSelect(id);
        }}
        className="h-full w-full"
      />
    </div>
  );
}
