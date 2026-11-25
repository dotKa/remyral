import type { DataSchema } from '../data-schema.js';
import type { TemplateText, TemplateValues } from './types.js';

/** Small builders shared by the templates (pure). */

export type Json = Record<string, unknown>;

export const ex = (source: string): { $expr: string } => ({ $expr: source });

/** A catalog node (`type` + `config`), with the localized label. */
export function node(t: TemplateText, id: string, type: string, config: Json = {}, extra: Json = {}): Json {
  const label = t.label(id);
  return { id, type, config, ...(label === undefined ? {} : { label }), ...extra };
}

/** An AI step (fields at node level). */
export function aiStep(
  t: TemplateText,
  id: string,
  role: 'planner' | 'executor' | 'verifier' | 'reviewer' | 'integrator',
  prompt: string,
  extra: { outputSchema?: DataSchema } & Json = {},
): Json {
  const label = t.label(id);
  return { id, type: 'ai.step', role, prompt, ...(label === undefined ? {} : { label }), ...extra };
}

export function edge(from: string, to: string, fromPort?: string): Json {
  return { from, to, ...(fromPort === undefined ? {} : { fromPort }) };
}

/** HTTP `auth` with an optional vault credential (omitted when the placeholder is empty). */
export function bearer(credential: string): Json {
  return credential === '' ? {} : { auth: { credential, placement: 'bearer' } };
}

/**
 * Editor positions: one column per entry, nodes of a column stacked; group bodies use their own columns (the editor
 * draws them inside the group).
 */
export function columns(cols: readonly (readonly string[])[]): Json {
  const positions: Record<string, { x: number; y: number }> = {};
  cols.forEach((col, x) => {
    col.forEach((id, y) => {
      positions[id] = { x: x * 280, y: y * 160 };
    });
  });
  return { positions };
}

export function defaults(v: TemplateValues, maxDurationSec = 1800): Json {
  return {
    runtime: v.runtime ?? 'claude-code',
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec },
  };
}

/** JSON string literal for a value placed inside an expression (only for validated choice / number values). */
export const lit = (s: string): string => JSON.stringify(s);
