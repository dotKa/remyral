import type { ReactNode } from 'react';
import { layoutDag, NODE_H, NODE_W } from '../../lib/dag-layout';

/**
 * p13-workflows-ui: the `workflow` chat draft (`draft_workflow`) read from its payload, and a static preview of its
 * graph — the run page's SVG approach (lib/dag-layout), deliberately not the editor's canvas library, so the chat
 * bundle stays light. Shared by the classic card (screens/chat/DraftCard.tsx) and the Diyalog card
 * (diyalog/drafts/DraftCard.tsx). Every value comes from the assistant: rendered as text only.
 */

export interface WorkflowDraftNode {
  readonly id: string;
  readonly role: string;
  /** Approver role of the node's approval gate, or null. */
  readonly gate: string | null;
  readonly dynamic: boolean;
  /** p14-workflow-engine 14.5: the catalog type (`ai.step` for AI steps of either version). */
  readonly type: string;
  readonly label: string | null;
  /** The group (forEach / loop) the node belongs to, or null. */
  readonly parent: string | null;
}

export interface WorkflowDraftIssue {
  readonly path: string;
  readonly code: string;
  /** The node the issue is about (`nodes.<index>…`), or null. */
  readonly node: string | null;
}

export interface WorkflowDraft {
  readonly name: string;
  readonly project: string;
  /** Null for a new workflow; else the saved version this draft follows. */
  readonly baseVersion: number | null;
  readonly workflowId: string | null;
  readonly valid: boolean;
  readonly issues: readonly WorkflowDraftIssue[];
  readonly nodes: readonly WorkflowDraftNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly fromPort: string | null }[];
  readonly note: string | null;
  /** p14-workflow-engine 14.5: 2 = typed nodes (the new engine). */
  readonly schemaVersion: 1 | 2;
  /** `workflows.define.*` actions saving this version needs (admin + a fresh verification code at confirmation). */
  readonly privileged: readonly string[];
  /** The drafted document itself (what "Editörde aç" opens), or null. */
  readonly definition: Record<string, unknown> | null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function workflowDraftOf(p: Record<string, unknown>): WorkflowDraft {
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []).map((x) => {
    const n = rec(x);
    return {
      id: str(n.id),
      role: str(n.role),
      gate: typeof n.gate === 'string' && n.gate !== '' ? n.gate : null,
      dynamic: n.dynamic === true,
      type: str(n.type) || 'ai.step',
      label: str(n.label) || null,
      parent: str(n.parent) || null,
    };
  });
  const issues = (Array.isArray(p.issues) ? p.issues : []).map((x) => {
    const o = rec(x);
    const path = str(o.path);
    const m = /^nodes\.(\d+)(?:\.|$)/.exec(path);
    const node = m === null ? null : (nodes[Number(m[1])]?.id ?? null);
    return { path, code: str(o.code), node: node === '' ? null : node };
  });
  const edges = (Array.isArray(p.edges) ? p.edges : []).map((x) => {
    const e = rec(x);
    return { from: str(e.from), to: str(e.to), fromPort: str(e.fromPort) || null };
  });
  const definition = rec(p.definition);
  return {
    name: str(p.name),
    project: str(p.project),
    baseVersion: typeof p.baseVersion === 'number' ? p.baseVersion : null,
    workflowId: typeof p.workflowId === 'string' ? p.workflowId : null,
    valid: p.valid === true,
    issues,
    nodes,
    edges,
    note: typeof p.note === 'string' && p.note !== '' ? p.note : null,
    schemaVersion: p.schemaVersion === 2 || definition.schemaVersion === 2 ? 2 : 1,
    privileged: (Array.isArray(p.privileged) ? p.privileged : []).filter(
      (x): x is string => typeof x === 'string',
    ),
    definition: Object.keys(definition).length === 0 ? null : definition,
  };
}

/** One issue as a line: the node (when known) or the path, then the master's code. */
export function issueLine(i: WorkflowDraftIssue): string {
  if (i.node === null) return `${i.path || '(document)'}: ${i.code}`;
  const rest = i.path.replace(/^nodes\.\d+\.?/, '');
  return `${i.node}${rest === '' ? '' : ` · ${rest}`}: ${i.code}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Literal class sets per console (Tailwind only generates what it sees). */
const LOOK = {
  classic: {
    edge: 'fill-none stroke-line-strong',
    arrow: 'fill-muted',
    node: 'fill-surface stroke-line-strong',
    bad: 'fill-surface stroke-danger',
    id: 'fill-fg text-[12px] font-semibold',
    sub: 'fill-muted text-[11px]',
    gate: 'fill-warn',
  },
  diyalog: {
    edge: 'fill-none stroke-dy-line-2',
    arrow: 'fill-dy-faint',
    node: 'fill-dy-card stroke-dy-line-2',
    bad: 'fill-dy-red-soft stroke-dy-red',
    id: 'fill-dy-ink text-[12px] font-bold',
    sub: 'fill-dy-muted text-[11px]',
    gate: 'fill-dy-amber',
  },
} as const;

/**
 * A static picture of the drafted graph (nodes with role and gate, edges with arrows; nodes with an issue outlined
 * red). Decorative for screen readers — the node list next to it carries the same facts.
 */
export function WorkflowDraftGraph(props: {
  readonly draft: WorkflowDraft;
  readonly look: keyof typeof LOOK;
  readonly roleLabel?: (role: string) => string;
  /** p14-workflow-engine 14.5: the label of a catalog type (the card passes the i18n catalog's); default the type. */
  readonly typeLabel?: (type: string) => string;
  /**
   * p17-chat-flow item 7: the scroll area's name — with it the graph is a focusable region that scrolls sideways
   * (keyboard, trackpad), so a wide workflow is never cut off at the card's edge.
   */
  readonly scrollLabel?: string | undefined;
  /** p17-chat-flow item 7: scaled down to the card's width instead of its real size (scrolling). */
  readonly fit?: boolean | undefined;
}): ReactNode {
  const { draft } = props;
  const c = LOOK[props.look];
  const ids = draft.nodes.map((n) => n.id).filter((id) => id !== '');
  if (ids.length === 0) return null;
  const layout = layoutDag(ids, draft.edges);
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const bad = new Set(draft.issues.flatMap((i) => (i.node === null ? [] : [i.node])));
  const marker = `wf-draft-arrow-${props.look}`;
  return (
    <div
      className="max-w-full min-w-0 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:outline-dy-teal"
      data-testid="workflow-draft-graph"
      data-fit={props.fit === true ? 'true' : undefined}
      {...(props.scrollLabel === undefined
        ? {}
        : { role: 'region', 'aria-label': props.scrollLabel, tabIndex: 0 })}
    >
      <svg
        aria-hidden="true"
        width={props.fit === true ? '100%' : layout.width}
        height={props.fit === true ? undefined : layout.height}
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        preserveAspectRatio="xMinYMin meet"
        className={props.fit === true ? 'block h-auto max-w-full' : 'block max-w-none'}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" className={c.arrow} />
          </marker>
        </defs>
        {draft.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (a === undefined || b === undefined) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          // p14-workflow-engine 14.5: a named output port (true / false, a switch case, item, error) labels the edge.
          const port = e.fromPort === null || e.fromPort === 'out' ? null : e.fromPort;
          return (
            // Edges may repeat in an invalid draft: the index is part of the identity.
            <g key={`${e.from}->${e.to}-${String(i)}`}>
              <path
                d={`M${String(x1)},${String(y1)} C${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2 - 1)},${String(y2)}`}
                className={c.edge}
                strokeWidth={1.5}
                markerEnd={`url(#${marker})`}
              />
              {port === null ? null : (
                <text
                  x={mid}
                  y={(y1 + y2) / 2 - 4}
                  textAnchor="middle"
                  className={c.sub}
                  data-testid="workflow-draft-port"
                >
                  {clip(port, 12)}
                </text>
              )}
            </g>
          );
        })}
        {draft.nodes.map((n, i) => {
          const p = pos.get(n.id);
          if (p === undefined) return null;
          const role =
            n.type === 'ai.step'
              ? (props.roleLabel?.(n.role) ?? n.role)
              : (n.label ?? props.typeLabel?.(n.type) ?? n.type);
          return (
            <g
              key={`${n.id}-${String(i)}`}
              transform={`translate(${String(p.x)},${String(p.y)})`}
              data-testid="workflow-draft-node"
              data-type={n.type}
              data-invalid={bad.has(n.id) ? 'true' : undefined}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                className={bad.has(n.id) ? c.bad : c.node}
                strokeWidth={bad.has(n.id) ? 2 : 1.25}
                strokeDasharray={n.dynamic ? '4 3' : undefined}
              />
              {n.gate === null ? null : <circle cx={NODE_W - 14} cy={16} r={4} className={c.gate} />}
              <text x={12} y={22} className={c.id}>
                {clip(n.id, 20)}
              </text>
              <text x={12} y={40} className={c.sub}>
                {clip(n.gate === null ? role : `${role} · ${n.gate}`, 26)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
