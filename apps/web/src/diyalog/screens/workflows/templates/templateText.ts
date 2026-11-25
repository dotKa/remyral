import type { Messages } from '@remyral/i18n';
import type { TemplateCategory } from '../../../../api/workflowTemplates';

/**
 * p14-workflow-engine 14.5: a template's words from the catalog (`workflowTemplates.items[id]`: name, description,
 * node labels, placeholder labels and hints). Read through one narrow view so a template the master lists but this
 * console's catalog does not know yet (a newer master) still renders — with its id and keys as the fallback text.
 */

export interface TemplateText {
  readonly name: string;
  readonly description: string;
  readonly nodes: Readonly<Record<string, string | undefined>>;
  readonly placeholders: Readonly<
    Record<string, { readonly label: string; readonly hint?: string | undefined } | undefined>
  >;
}

interface ItemShape {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly nodes?: unknown;
  readonly placeholders?: unknown;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function templateText(t: Messages, id: string): TemplateText {
  const items = rec((t.workflowTemplates as { readonly items?: unknown }).items);
  const item = rec(items[id]) as ItemShape;
  const nodes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(item.nodes))) if (typeof v === 'string') nodes[k] = v;
  const placeholders: Record<string, { label: string; hint?: string }> = {};
  for (const [k, v] of Object.entries(rec(item.placeholders))) {
    const p = rec(v);
    if (typeof p.label === 'string')
      placeholders[k] = { label: p.label, ...(typeof p.hint === 'string' ? { hint: p.hint } : {}) };
  }
  return {
    name: typeof item.name === 'string' ? item.name : id,
    description: typeof item.description === 'string' ? item.description : '',
    nodes,
    placeholders,
  };
}

export function categoryText(t: Messages, c: TemplateCategory): string {
  return t.workflowTemplates.categories[c];
}

/** What a template's nodes do outside the master (for the badges). */
export function templateFeatures(types: readonly string[]): {
  readonly http: boolean;
  readonly email: boolean;
  readonly code: boolean;
  readonly ai: boolean;
  readonly approval: boolean;
} {
  const has = (p: (x: string) => boolean): boolean => types.some(p);
  return {
    http: has((x) => x === 'http.request'),
    email: has((x) => x === 'email.send'),
    code: has((x) => x.startsWith('code.')),
    ai: has((x) => x === 'ai.step'),
    approval: has((x) => x === 'control.approval'),
  };
}

export const PRIVILEGED_ACTIONS = [
  'workflows.define.network',
  'workflows.define.code',
  'workflows.define.deploy',
] as const;
