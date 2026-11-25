import { JOB_STATES, TERMINAL_STATES } from './states.js';
import { TRANSITIONS } from './transitions.js';

/**
 * Renders the transition table as a Mermaid `stateDiagram-v2`. Edges between the same pair of states are
 * merged and their triggers listed in table order; output is deterministic (docs are checked by a test).
 */
export function toMermaid(): string {
  const edges = new Map<string, string[]>();
  for (const rule of TRANSITIONS) {
    const key = `${rule.from} --> ${rule.to}`;
    const triggers = edges.get(key) ?? [];
    triggers.push(rule.trigger);
    edges.set(key, triggers);
  }
  const lines = ['stateDiagram-v2', '  [*] --> DRAFT'];
  for (const [edge, triggers] of edges) lines.push(`  ${edge}: ${triggers.join(', ')}`);
  for (const state of JOB_STATES) if (TERMINAL_STATES.has(state)) lines.push(`  ${state} --> [*]`);
  return `${lines.join('\n')}\n`;
}

/** Markdown table of every transition with its guards, in table order. */
export function toMarkdownTable(): string {
  const rows = [
    '| From | Trigger | To | Actors | Reason | Retry-safe | Meaning |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of TRANSITIONS) {
    rows.push(
      `| ${r.from} | \`${r.trigger}\` | ${r.to} | ${r.actors.join(', ')} | ${r.requiresReason ? 'yes' : ''} | ${
        r.requiresRetrySafe ? 'yes' : ''
      } | ${r.description} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}
