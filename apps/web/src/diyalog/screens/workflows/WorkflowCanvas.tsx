import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  type EdgeChange,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './canvas.css';
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Messages } from '@remyral/i18n';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { edgeLooks, FAMILY_ICON, familyOf, type NodeFamily } from './canvasLook';
import type { Pos } from './model';
import { type Box, cardLayout, cardSize, type LayoutInput, type PortPlace } from './nodeLayout';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3): the one canvas renderer of workflows — the editor (drag,
 * connect, select, delete) and, read-only, the run page with each step's live state. React Flow (@xyflow/react, MIT)
 * draws it; this file is the only one that imports it, so the library stays in the lazy editor/run chunks. Controlled:
 * the caller owns the document; positions come in, moves / connections / deletions go out as callbacks. Styles are
 * the bundled base.css plus canvas.css (Diyalog tokens) — no inline <style>, CSP `style-src 'self'` holds.
 */

export interface CardState {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
  readonly running: boolean;
  /** The step's own state word for tests / styling (`data-state`). */
  readonly key: string;
}

/** p14: a port as the card shows it (handle id = the port name). */
export interface PortView {
  readonly name: string;
  /** The small label next to the handle (empty: none — a node's only `in` / `out`). */
  readonly label: string;
  readonly error?: boolean;
}

export interface CardData extends Record<string, unknown> {
  readonly id: string;
  /**
   * p14: the node's ports (absent: one unnamed input and output, the v1 card). `inner`: a group's ports towards its
   * body (`item`).
   */
  readonly ports?: {
    readonly in: readonly PortView[];
    readonly out: readonly PortView[];
    readonly inner?: readonly PortView[];
  };
  /** p14: a group (forEach / loop) drawn as a container around its body. */
  readonly group?: boolean;
  readonly role: string;
  readonly roleLabel: string;
  readonly runtime: string | null;
  readonly gate: boolean;
  readonly dynamic: boolean;
  /** A step a planner added at run time (dashed). */
  readonly planned: boolean;
  readonly issues: number;
  readonly state: CardState | null;
  readonly editable: boolean;
  /** Where links enter / leave: left → right or top → bottom. */
  readonly dir: 'LR' | 'TB';
  /** p15-workflow-ai: the node's mark while an AI proposal is reviewed, and its words for screen readers. */
  readonly diff?: 'added' | 'removed' | 'changed';
  readonly diffLabel?: string;
  /** p17-workflow-canvas: the node type (its family colour and icon); absent: from `role` (v1: an AI step). */
  readonly type?: string;
}

export interface CanvasNode {
  readonly id: string;
  readonly position: Pos;
  readonly data: CardData;
  /** p14: the group the node sits in (its position is relative to the group). */
  readonly parent?: string;
  /** p14: the drawn size (groups, cards with several ports). */
  readonly size?: { readonly w: number; readonly h: number };
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly invalid?: boolean;
  readonly dashed?: boolean;
  readonly live?: boolean;
  /** p14: the ports (handle ids) the edge leaves / enters. */
  readonly fromPort?: string;
  readonly toPort?: string;
  /** p14: the branch label (`true`, `false`, a case, `error`). */
  readonly label?: string;
  readonly error?: boolean;
  /** p15-workflow-ai: the edge's mark while an AI proposal is reviewed. */
  readonly diff?: 'added' | 'removed';
}

/**
 * p17-workflow-canvas: the layout input of a card — its title, subtitle (as drawn), ports, badges and direction.
 * `dynamicWord`: the "dinamik" word of a planner's subtitle.
 */
export function cardInput(d: CardData, dynamicWord: string): LayoutInput {
  return {
    title: d.id,
    subtitle: cardSubtitle(d, dynamicWord),
    ports: d.ports,
    dir: d.dir,
    gate: d.gate,
    issues: d.issues,
    group: d.group === true,
    subtitleIcon: ROLE_ICON[d.role] !== undefined,
  };
}

function cardSubtitle(d: CardData, dynamicWord: string): string {
  return d.state === null
    ? [d.roleLabel, d.runtime, d.dynamic ? dynamicWord : null].filter(Boolean).join(' · ')
    : `${d.roleLabel} · ${d.state.label}`;
}

/** The family of a card (its node type; v1 AI steps are `ai`). */
export function cardFamily(d: CardData): NodeFamily {
  return familyOf(d.type ?? (d.role.includes('.') ? d.role : 'ai.step'));
}

function handleSide(side: PortPlace['side'], dir: 'LR' | 'TB'): Position {
  if (side === 'inner') return Position.Left;
  if (side === 'in') return dir === 'TB' ? Position.Top : Position.Left;
  return dir === 'TB' ? Position.Bottom : Position.Right;
}

const box = (b: Box): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });

const BORDER: Readonly<Record<Tone, string>> = {
  teal: 'border-dy-teal',
  amber: 'border-dy-amber',
  red: 'border-dy-red',
  green: 'border-dy-green',
  violet: 'border-dy-violet',
  neutral: 'border-dy-line-2',
};
const DOT: Readonly<Record<Tone, string>> = {
  teal: 'bg-dy-teal',
  amber: 'bg-dy-amber',
  red: 'bg-dy-red',
  green: 'bg-dy-green',
  violet: 'bg-dy-violet',
  neutral: 'bg-dy-faint',
};

const ROLE_ICON: Readonly<Record<string, IconName>> = {
  planner: 'grid',
  executor: 'jobs',
  verifier: 'checkc',
  reviewer: 'search',
  integrator: 'merge',
};

function StepCard(props: NodeProps<Node<CardData>>): ReactNode {
  const d = props.data;
  const c = useT().workflows.canvas;
  const tone: Tone = d.issues > 0 ? 'red' : (d.state?.tone ?? 'neutral');
  const family = cardFamily(d);
  const L = useMemo(
    () =>
      cardLayout(
        cardInput(d, c.dynamic),
        props.width === undefined || props.height === undefined
          ? undefined
          : { w: props.width, h: props.height },
      ),
    [d, c.dynamic, props.width, props.height],
  );
  const portBy = new Map(
    [...(d.ports?.in ?? []), ...(d.ports?.out ?? []), ...(d.ports?.inner ?? [])].map((p) => [p.name, p]),
  );
  const subtitle = cardSubtitle(d, c.dynamic);
  const roleIcon = ROLE_ICON[d.role];
  return (
    <div
      data-testid="workflow-node"
      data-node={d.id}
      data-state={d.state?.key}
      data-issues={d.issues > 0 ? String(d.issues) : undefined}
      data-group={d.group === true ? 'true' : undefined}
      data-diff={d.diff}
      data-family={family}
      className={cx(
        'dy-wf-card rounded-[12px] border text-left',
        `dy-wf-fam-${family}`,
        d.group === true ? 'dy-wf-group' : 'shadow-dy',
        props.selected ? 'border-dy-ink ring-2 ring-dy-ink/15' : BORDER[tone],
        d.planned && 'border-dashed',
        d.diff !== undefined && `dy-wf-diff-${d.diff}`,
      )}
    >
      <span aria-hidden="true" className="dy-wf-band" />
      {L.ports.map((p) => {
        const view = portBy.get(p.name);
        const error = view?.error === true;
        const type = p.side === 'in' ? 'target' : 'source';
        // A group keeps its ports beside its header in both directions (its body fills the rest).
        const side = handleSide(p.side, d.group === true ? 'LR' : d.dir);
        const style: CSSProperties =
          p.side === 'inner'
            ? { top: p.y, left: p.x }
            : side === Position.Left || side === Position.Right
              ? { top: p.y }
              : { left: p.x };
        return (
          <Handle
            key={`${p.side}-${p.name}`}
            {...(d.ports === undefined ? {} : { id: p.name })}
            type={type}
            position={side}
            isConnectable={d.editable}
            style={style}
            data-port={d.ports === undefined ? undefined : p.name}
            title={d.ports === undefined ? undefined : p.name}
            className={cx('dy-wf-handle', error && 'dy-wf-handle-error', !d.editable && 'dy-wf-handle-off')}
          />
        );
      })}
      {L.ports.map((p) =>
        p.label === null ? null : (
          <span
            key={`label-${p.side}-${p.name}`}
            data-port-label={p.name}
            data-align={p.align}
            title={p.truncated ? p.name : undefined}
            style={box(p.label)}
            className={cx('dy-wf-port-label', portBy.get(p.name)?.error === true && 'text-dy-red-ink')}
          >
            {portBy.get(p.name)?.label ?? p.name}
          </span>
        ),
      )}
      <span aria-hidden="true" className="dy-wf-chip" style={box(L.chip)} data-testid="workflow-node-chip">
        <DyIcon name={FAMILY_ICON[family]} className="size-4" />
        {tone === 'neutral' && d.state === null ? null : (
          <span className={cx('dy-wf-chip-dot', DOT[tone], d.state?.running === true && 'dy-breathe')} />
        )}
      </span>
      <span
        className="dy-wf-box flex items-center truncate font-dy-mono text-[0.8125rem] leading-5 font-bold text-dy-ink"
        style={box(L.title)}
        title={L.titleTruncated ? d.id : undefined}
        data-testid="workflow-node-title"
      >
        <span className="truncate">{d.id}</span>
      </span>
      {L.badges === null ? null : (
        <span className="dy-wf-box flex items-center justify-end gap-1" style={box(L.badges)}>
          {d.gate ? (
            <span title={c.gate} className="text-dy-amber-ink">
              <DyIcon name="shield" className="size-3.5" />
              <span className="sr-only">{c.gate}</span>
            </span>
          ) : null}
          {d.issues > 0 ? (
            <span className="rounded-full bg-dy-red-soft px-1.5 font-dy-mono text-[0.6875rem] leading-4 font-bold text-dy-red-ink">
              {d.issues}
              <span className="sr-only">{` ${c.issues}`}</span>
            </span>
          ) : null}
        </span>
      )}
      <span
        className="dy-wf-box flex items-center gap-1.5 text-[0.75rem] leading-[18px] text-dy-muted"
        style={box(L.subtitle)}
        title={L.subtitleTruncated ? subtitle : undefined}
      >
        {roleIcon === undefined ? null : <DyIcon name={roleIcon} className="size-3.5 shrink-0" />}
        <span className="truncate">{subtitle}</span>
      </span>
    </div>
  );
}

const CARD = memo(StepCard);
const NODE_TYPES = { step: CARD, typed: CARD, group: CARD };

/** React Flow's accessible names and descriptions in the current language (view / edit). */
function ariaConfig(c: Messages['workflows']['canvas'], editable: boolean) {
  const view = {
    'node.a11yDescription.default': c.nodeSelect,
    'node.a11yDescription.keyboardDisabled': c.nodeSelect,
    'edge.a11yDescription.default': c.edge,
    'minimap.ariaLabel': c.minimap,
    'handle.ariaLabel': c.handle,
  };
  if (!editable) return view;
  return {
    ...view,
    'node.a11yDescription.default': c.nodeEdit,
    'node.a11yDescription.ariaLiveMessage': ({
      direction,
      x,
      y,
    }: {
      direction: string;
      x: number;
      y: number;
    }) => c.moved({ direction, x: Math.round(x), y: Math.round(y) }),
    'edge.a11yDescription.default': c.edgeEdit,
  };
}

export interface CanvasProps {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly selectedNode: string | null;
  /** p17-workflow-canvas: further selected nodes (shift / ⌘-click, box selection), first selected first. */
  readonly selectedNodes?: readonly string[];
  readonly selectedEdge?: string | null;
  readonly editable: boolean;
  readonly snap?: boolean;
  readonly minimap?: boolean;
  /** Increment to fit every step into view. */
  readonly fitSignal?: number;
  readonly label: string;
  readonly onSelectNode: (id: string | null) => void;
  /** p17-workflow-canvas: the whole node selection changed (in the order the nodes were selected). */
  readonly onSelectNodes?: (ids: readonly string[]) => void;
  readonly onSelectEdge?: (id: string | null) => void;
  /** A drag ended (or is in progress: `done` false) — the new top-left positions. */
  readonly onMove?: (moved: Record<string, Pos>, done: boolean) => void;
  readonly onConnect?: (from: string, to: string, fromPort?: string, toPort?: string) => void;
  readonly canConnect?: (from: string, to: string, fromPort?: string, toPort?: string) => boolean;
  readonly onDelete?: (nodes: readonly string[], edges: readonly string[]) => void;
  readonly className?: string;
}

function toRf(
  n: CanvasNode,
  selected: boolean,
  prev: Node<CardData> | undefined,
  issueCount: (p: { n: number }) => string,
  dynamicWord: string,
): Node<CardData> {
  // p17: the card is as large as its layout needs (a group: at least its body).
  const { w, h } = cardSize(cardInput(n.data, dynamicWord), n.size);
  const type = n.data.group === true ? 'group' : n.data.ports === undefined ? 'step' : 'typed';
  return {
    id: n.id,
    type,
    position: n.position,
    data: n.data,
    selected,
    width: w,
    height: h,
    style: { width: w, height: h },
    ...(n.parent === undefined ? {} : { parentId: n.parent }),
    ariaLabel: `${n.data.id} (${n.data.roleLabel})${n.data.state === null ? '' : `: ${n.data.state.label}`}${
      n.data.issues > 0 ? `, ${issueCount({ n: n.data.issues })}` : ''
    }${n.data.diffLabel === undefined ? '' : `, ${n.data.diffLabel}`}`,
    ...(prev?.measured === undefined ? {} : { measured: prev.measured }),
  };
}

function Inner(props: CanvasProps): ReactNode {
  const w = useT().workflows;
  const aria = useMemo(() => ariaConfig(w.canvas, props.editable), [w, props.editable]);
  const flow = useReactFlow();
  const [rf, setRf] = useState<Node<CardData>[]>([]);
  const prevRef = useRef(new Map<string, Node<CardData>>());
  const picked = props.selectedNodes;
  useEffect(() => {
    const prev = prevRef.current;
    const sel = new Set(picked ?? []);
    // Keep the measured size and a drag in progress; everything else follows the document.
    setRf((cur) => {
      const curBy = new Map(cur.map((n) => [n.id, n]));
      return props.nodes.map((n) => {
        const c = curBy.get(n.id);
        const node = toRf(
          n,
          n.id === props.selectedNode || sel.has(n.id),
          c ?? prev.get(n.id),
          w.editor.issueCount,
          w.canvas.dynamic,
        );
        return c?.dragging === true ? { ...node, position: c.position, dragging: true } : node;
      });
    });
  }, [props.nodes, props.selectedNode, picked, w]);
  useEffect(() => {
    prevRef.current = new Map(rf.map((n) => [n.id, n]));
  }, [rf]);

  const fit = props.fitSignal ?? 0;
  useEffect(() => {
    if (fit === 0) return;
    // After the nodes of this render are measured.
    const t = window.setTimeout(() => {
      void flow.fitView({ padding: 0.2, duration: 0, maxZoom: 1.2 });
    }, 0);
    return () => {
      window.clearTimeout(t);
    };
  }, [fit, flow]);

  const { onMove, onSelectNode, onSelectNodes, onSelectEdge, onDelete } = props;
  // p17: the selection in the order it was made (its first node is the align anchor).
  const order = useRef<string[]>([]);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardData>>[]) => {
      // Removals go through onDelete (the document decides); selection is the caller's.
      const local = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
      if (local.length > 0) setRf((cur) => applyNodeChanges(local, cur));
      const moved: Record<string, Pos> = {};
      let done = false;
      for (const c of changes) {
        if (c.type === 'position' && c.position !== undefined) moved[c.id] = c.position;
        if (c.type === 'position' && c.dragging === false) done = true;
      }
      if (onMove !== undefined && (Object.keys(moved).length > 0 || done)) onMove(moved, done);
      for (const c of changes) {
        if (c.type === 'select' && c.selected) onSelectNode(c.id);
      }
      if (onSelectNodes !== undefined && changes.some((c) => c.type === 'select')) {
        let next = [...order.current];
        for (const c of changes) {
          if (c.type !== 'select') continue;
          next = next.filter((id) => id !== c.id);
          if (c.selected) next.push(c.id);
        }
        order.current = next;
        onSelectNodes(next);
      }
    },
    [onMove, onSelectNode, onSelectNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) {
        if (c.type === 'select' && c.selected) onSelectEdge?.(c.id);
      }
    },
    [onSelectEdge],
  );

  // p17: each edge its own palette colour (deterministic by id), the arrowhead in the same colour; error, invalid
  // and diff edges keep their meaning colours.
  const looks = useMemo(() => edgeLooks(props.edges), [props.edges]);
  const edges: Edge[] = useMemo(
    () =>
      props.edges.map((e) => {
        const look = looks.get(e.id) ?? { color: 0, dash: 0 };
        const meaning =
          e.invalid === true ||
          e.error === true ||
          e.diff !== undefined ||
          e.dashed === true ||
          e.live === true;
        const color =
          e.diff === 'added'
            ? 'var(--dy-green)'
            : e.invalid === true || e.error === true || e.diff === 'removed'
              ? 'var(--dy-red)'
              : `var(--wf-e${String(look.color)})`;
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          ...(e.fromPort === undefined ? {} : { sourceHandle: e.fromPort }),
          ...(e.toPort === undefined ? {} : { targetHandle: e.toPort }),
          type: 'default',
          selected: e.id === props.selectedEdge,
          animated: e.live === true,
          className: cx(
            e.invalid === true || e.error === true ? null : `dy-wf-edge-c${String(look.color)}`,
            // A fan-out's links differ in dash too (colour-blind safe), unless the dash already means something.
            !meaning && look.dash > 0 && `dy-wf-edge-dash-${String(look.dash)}`,
            e.invalid === true && 'dy-wf-edge-invalid',
            e.dashed === true && 'dy-wf-edge-dashed',
            e.error === true && 'dy-wf-edge-error',
            e.diff !== undefined && `dy-wf-edge-diff-${e.diff}`,
          ),
          data: { color: look.color },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
          ...(e.label === undefined ? {} : { label: e.label, labelBgPadding: [4, 2] as [number, number] }),
          ariaLabel: `${e.from} → ${e.to}${e.label === undefined ? '' : ` (${e.label})`}`,
          focusable: props.editable,
        };
      }),
    [props.edges, props.selectedEdge, props.editable, looks],
  );

  const canConnect = props.canConnect;
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      canConnect === undefined
        ? true
        : canConnect(c.source, c.target, c.sourceHandle ?? undefined, c.targetHandle ?? undefined),
    [canConnect],
  );

  return (
    <ReactFlow<Node<CardData>>
      nodes={rf}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(c) => {
        props.onConnect?.(c.source, c.target, c.sourceHandle ?? undefined, c.targetHandle ?? undefined);
      }}
      isValidConnection={isValidConnection}
      onPaneClick={() => {
        onSelectNode(null);
        onSelectEdge?.(null);
        order.current = [];
        onSelectNodes?.([]);
      }}
      onDelete={({ nodes, edges: es }) => {
        onDelete?.(
          nodes.map((n) => n.id),
          es.map((e) => e.id),
        );
      }}
      deleteKeyCode={props.editable ? ['Delete', 'Backspace'] : null}
      nodesDraggable={props.editable}
      nodesConnectable={props.editable}
      elementsSelectable
      edgesFocusable={props.editable}
      snapToGrid={props.snap === true}
      snapGrid={[16, 16]}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      ariaLabelConfig={aria}
      aria-label={props.label}
      className={cx('dy-wf-flow', props.className)}
    >
      <Background
        variant={props.snap === true ? BackgroundVariant.Lines : BackgroundVariant.Dots}
        gap={16}
        size={1}
      />
      {props.minimap === true ? <MiniMap pannable zoomable className="dy-wf-minimap" /> : null}
    </ReactFlow>
  );
}

/** The canvas (fills its parent; give the parent a height). */
export default function WorkflowCanvas(props: CanvasProps): ReactNode {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
