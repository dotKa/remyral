import type { ReactNode } from 'react';
import type { WorkflowTemplate } from '../../../../api/workflowTemplates';
import { useT } from '../../../../i18n/I18nProvider';
import { layoutDag, NODE_H, NODE_W } from '../../../../lib/dag-layout';
import { nodeTypeText } from '../nodeCatalog';
import { templateText } from './templateText';

/**
 * p14-workflow-engine 14.5: a static picture of a template's graph (the chat draft card's SVG approach — lib/dag-layout,
 * no canvas library, so the gallery chunk stays light). Node title = the template's node label from the catalog, sub
 * line = the node type; nodes inside a loop body dashed; an edge leaving a named port (true / false / item …) carries
 * the port name. Decorative for screen readers (`aria-label` on the figure names it).
 */

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function TemplateGraph(props: {
  readonly template: WorkflowTemplate;
  readonly testId?: string | undefined;
}): ReactNode {
  const t = useT();
  const tpl = props.template;
  const text = templateText(t, tpl.id);
  const ids = tpl.nodes.map((n) => n.id);
  if (ids.length === 0) return null;
  const layout = layoutDag(ids, tpl.edges);
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const marker = `tpl-arrow-${tpl.id}`;
  const typeLabel = (type: string, role: string | null): string => {
    if (type === 'ai.step' && role !== null) {
      const r = (t.workflows.palette.ai as Record<string, { label: string } | undefined>)[role];
      if (r !== undefined) return r.label;
    }
    return nodeTypeText(t.workflows, type)?.label ?? type;
  };
  return (
    <figure
      className="m-0 max-w-full overflow-x-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2"
      aria-label={t.workflowGallery.graphLabel({ name: text.name })}
      data-testid={props.testId ?? 'template-graph'}
    >
      <svg
        aria-hidden="true"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
        className="block max-w-none"
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
            <path d="M0,0 L10,5 L0,10 z" className="fill-dy-faint" />
          </marker>
        </defs>
        {tpl.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (a === undefined || b === undefined) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <g key={`${e.from}->${e.to}-${String(i)}`}>
              <path
                d={`M${String(x1)},${String(y1)} C${String(mid)},${String(y1)} ${String(mid)},${String(y2)} ${String(x2 - 1)},${String(y2)}`}
                className="fill-none stroke-dy-line-2"
                strokeWidth={1.5}
                markerEnd={`url(#${marker})`}
              />
              {e.fromPort === null || e.fromPort === 'out' ? null : (
                <text x={x1 + 4} y={y1 - 4} className="fill-dy-muted text-[10px]">
                  {e.fromPort}
                </text>
              )}
            </g>
          );
        })}
        {tpl.nodes.map((n) => {
          const p = pos.get(n.id);
          if (p === undefined) return null;
          return (
            <g
              key={n.id}
              transform={`translate(${String(p.x)},${String(p.y)})`}
              data-testid="template-graph-node"
              data-type={n.type}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={10}
                className="fill-dy-card stroke-dy-line-2"
                strokeWidth={1.25}
                strokeDasharray={n.parent === null ? undefined : '4 3'}
              />
              <text x={12} y={22} className="fill-dy-ink text-[12px] font-bold">
                {clip(text.nodes[n.id] ?? n.id, 22)}
              </text>
              <text x={12} y={40} className="fill-dy-muted text-[11px]">
                {clip(typeLabel(n.type, n.role), 26)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
