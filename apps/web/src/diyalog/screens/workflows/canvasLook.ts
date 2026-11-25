import type { IconName } from '../../icons';

/**
 * p17-workflow-canvas (docs/design/p17-workflow-canvas.md §2–3): the canvas' colour language — pure, no React.
 *
 * Node families: every node type of the catalog (packages/workflow-nodes) belongs to one family; the card shows it as
 * a top band, a faint background tint and a coloured icon chip (the icon tells the families apart without colour).
 * The colours are tokens in canvas.css (`--wf-<family>`, `-soft`, `-tint`; light and dark), checked for contrast in
 * test/workflow-canvas.test.ts.
 *
 * Edges: each edge gets a colour of a categorical, colour-blind-safe palette (`--wf-e0` … `--wf-e7`), assigned
 * deterministically from its id; edges that leave or enter the same node get different colours (and, in a fan-out,
 * different dash patterns) while the palette allows. Error links stay red and dashed.
 */

export const FAMILIES = ['trigger', 'ai', 'flow', 'data', 'integration', 'wait', 'other'] as const;
export type NodeFamily = (typeof FAMILIES)[number];

export const FAMILY_ICON: Readonly<Record<NodeFamily, IconName>> = {
  trigger: 'bolt',
  ai: 'brain',
  flow: 'branch',
  data: 'db',
  integration: 'globe',
  wait: 'clock',
  other: 'code',
};

/** Waiting for a person, a time or a call: the approval, the delays, the webhook wait. */
const WAIT = new Set(['control.approval', 'control.delay', 'control.waitUntil', 'control.waitWebhook']);
/** The integration kinds by type prefix (master integrations, HTTP / e-mail, git, deploy, DNS, uptime). */
const INTEGRATION = ['notify.', 'chat.', 'jobs.', 'deploy.', 'dns.', 'github.', 'uptime.', 'http.', 'email.'];

/** The family of a node type (`ai.step` and v1 AI steps: `ai`; unknown types: `other`). */
export function familyOf(type: string | null | undefined): NodeFamily {
  if (type === null || type === undefined || type === '' || type === 'ai.step' || !type.includes('.'))
    return 'ai';
  if (type.startsWith('trigger.')) return 'trigger';
  if (WAIT.has(type)) return 'wait';
  if (type.startsWith('control.')) return 'flow';
  if (type.startsWith('data.')) return 'data';
  if (INTEGRATION.some((p) => type.startsWith(p))) return 'integration';
  return 'other';
}

/** Size of the categorical edge palette (`--wf-e0` … `--wf-e7`). */
export const EDGE_COLORS = 8;
/** Dash patterns that tell the links of one fan-out apart without colour (solid first). */
export const EDGE_DASHES = ['', '9 3', '2 3'] as const;

/** FNV-1a: a small, stable hash of an id. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface EdgeLook {
  /** Palette index (0 … EDGE_COLORS-1). */
  readonly color: number;
  /** Index into EDGE_DASHES (0: solid). */
  readonly dash: number;
}

/**
 * The look of every edge: the colour its id hashes to, moved to the next free palette slot when an edge that shares
 * its source or target already has it (edges in id order, so the result depends only on the set of edges); the n-th
 * link of a fan-out (same source) gets the n-th dash pattern.
 */
export function edgeLooks(
  edges: readonly { readonly id: string; readonly from: string; readonly to: string }[],
): Map<string, EdgeLook> {
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map<string, Set<number>>();
  const fan = new Map<string, number>();
  const out = new Map<string, EdgeLook>();
  for (const e of sorted) {
    if (out.has(e.id)) continue;
    const a = used.get(`>${e.from}`) ?? new Set<number>();
    const b = used.get(`<${e.to}`) ?? new Set<number>();
    const start = hash(e.id) % EDGE_COLORS;
    let color = start;
    for (let k = 0; k < EDGE_COLORS; k++) {
      const c = (start + k) % EDGE_COLORS;
      if (!a.has(c) && !b.has(c)) {
        color = c;
        break;
      }
    }
    a.add(color);
    b.add(color);
    used.set(`>${e.from}`, a);
    used.set(`<${e.to}`, b);
    const n = fan.get(e.from) ?? 0;
    fan.set(e.from, n + 1);
    out.set(e.id, { color, dash: n % EDGE_DASHES.length });
  }
  return out;
}
