import { JobSpec } from '@remyral/protocol';
import { nodeType, SMTP_PRESETS } from '../catalog.js';
import { CredentialRef, HttpOrigin, MAIL_ADDRESS } from '../fields.js';
import { WORKFLOW_NAME_PATTERN } from '../v1.js';
import { CONTENT_PRODUCTION } from './content.js';
import { MARKETING_CONTENT_CALENDAR, MARKETING_LEAD_INTAKE } from './marketing.js';
import type { PlaceholderSpec, TemplateText, WorkflowTemplate } from './types.js';
import { VIDEO_PRODUCTION } from './video.js';

export type * from './types.js';

/** p14-workflow-engine 14.5: every ready-made template, in gallery order. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  MARKETING_CONTENT_CALENDAR,
  MARKETING_LEAD_INTAKE,
  CONTENT_PRODUCTION,
  VIDEO_PRODUCTION,
];

const BY_ID = new Map(WORKFLOW_TEMPLATES.map((t) => [t.id, t]));

export function workflowTemplate(id: string): WorkflowTemplate | undefined {
  return BY_ID.get(id);
}

export const MAX_TEMPLATE_TEXT = 200;
const CRON = /^[0-9*/,-]+(\s+[0-9*/,A-Za-z-]+){4}$/;
const PATH = /^\/[A-Za-z0-9._~/-]{0,200}$/;

/** Why a placeholder value is refused (null: fine). Empty values are handled by the caller. */
export function placeholderProblem(spec: PlaceholderSpec, value: string): string | null {
  switch (spec.kind) {
    case 'origin':
      return HttpOrigin.safeParse(value).success && /^https?:\/\/[^/]+$/.test(value)
        ? null
        : 'invalid_origin';
    case 'path':
      return PATH.test(value) && !value.includes('//') && !value.includes('..') ? null : 'invalid_path';
    case 'credential':
      return CredentialRef.safeParse(value).success ? null : 'invalid_credential';
    case 'email':
      return MAIL_ADDRESS.test(value) && value.length <= 254 ? null : 'invalid_email';
    case 'text':
      // Values are placed into literal fields and model instructions, never into expressions.
      return value.length > MAX_TEMPLATE_TEXT ||
        value.includes('{{') ||
        value.includes('}}') ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f]/.test(value)
        ? 'invalid_text'
        : null;
    case 'cron':
      return CRON.test(value) && value.length >= 9 && value.length <= 120 ? null : 'invalid_cron';
    case 'smtpProvider':
      return Object.hasOwn(SMTP_PRESETS, value) ? null : 'invalid_option';
    case 'runtime':
      return JobSpec.shape.runtime.safeParse(value).success ? null : 'invalid_option';
    case 'number': {
      if (!/^-?\d{1,9}$/.test(value)) return 'invalid_number';
      const n = Number(value);
      return (spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)
        ? 'out_of_range'
        : null;
    }
    case 'choice':
      return (spec.options ?? []).includes(value) ? null : 'invalid_option';
  }
}

export interface TemplateIssue {
  readonly path: string;
  readonly code: string;
}

export type FillResult =
  | { readonly ok: true; readonly definition: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly TemplateIssue[] };

/**
 * Fills a template: checks every value by its placeholder kind (unknown keys refused, required ones present, defaults
 * applied, optional ones may stay empty) and the workflow name, then builds the v2 definition. The result still goes
 * through the master's full validation (catalog, egress policy, vault credentials and their bound hosts).
 */
export function fillTemplate(
  id: string,
  values: Readonly<Record<string, string>>,
  text: TemplateText,
): FillResult | null {
  const template = BY_ID.get(id);
  if (template === undefined) return null;
  const issues: TemplateIssue[] = [];
  if (!WORKFLOW_NAME_PATTERN.test(text.name)) issues.push({ path: 'name', code: 'invalid_format' });
  const known = new Set(template.placeholders.map((p) => p.key));
  for (const k of Object.keys(values)) {
    if (!known.has(k)) issues.push({ path: `values.${k.slice(0, 64)}`, code: 'unknown' });
  }
  const filled: Record<string, string> = {};
  for (const p of template.placeholders) {
    const raw = Object.hasOwn(values, p.key) ? (values[p.key] ?? '').trim() : '';
    const value = raw === '' ? (p.default ?? '') : raw;
    if (value === '') {
      if (p.required) issues.push({ path: `values.${p.key}`, code: 'required' });
      filled[p.key] = '';
      continue;
    }
    const problem = placeholderProblem(p, value);
    if (problem !== null) issues.push({ path: `values.${p.key}`, code: problem });
    filled[p.key] = value;
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, definition: template.build(filled, text) };
}

/** The define actions beyond `workflows.define` a template's nodes need (saving them needs a fresh step-up too). */
export function templateRequires(definition: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const n of nodesOf(definition)) {
    const r = nodeType(n.type)?.requires;
    if (r !== undefined && r !== 'workflows.define') out.add(r);
  }
  return [...out].sort();
}

/** Worker features a template's nodes need (`function-v1`, `function-code-v1`). */
export function templateWorkerFeatures(definition: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const n of nodesOf(definition)) {
    const f = nodeType(n.type)?.workerFeature;
    if (f !== undefined) out.add(f);
  }
  return [...out].sort();
}

function nodesOf(definition: Record<string, unknown>): { type: string }[] {
  const nodes = definition.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n): n is { type: string } => typeof (n as { type?: unknown }).type === 'string')
    : [];
}

/** Sample values that satisfy every placeholder (tests, the gallery's graph preview). */
export function sampleValues(template: WorkflowTemplate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of template.placeholders) {
    if (p.default !== undefined) out[p.key] = p.default;
    else
      out[p.key] =
        p.kind === 'origin'
          ? `https://${p.key.replace(/_origin$/, '').replace(/_/g, '-')}.example.com`
          : p.kind === 'credential'
            ? p.key.replace(/_/g, '-')
            : p.kind === 'email'
              ? 'team@example.com'
              : p.kind === 'number'
                ? String(p.min ?? 1)
                : p.kind === 'choice'
                  ? (p.options?.[0] ?? '')
                  : 'Example';
  }
  return out;
}
