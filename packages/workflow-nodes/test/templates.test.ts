import { describe, expect, it } from 'vitest';
import {
  fillTemplate,
  isForbiddenHost,
  nodeReferences,
  sampleValues,
  type TemplateText,
  templateRequires,
  templateWorkerFeatures,
  typesDeliveredBy,
  validateV2,
  WORKFLOW_TEMPLATES,
  workflowTemplate,
} from '../src/index.js';
import { tr } from '../../i18n/src/tr/index.js';
import { en } from '../../i18n/src/en/index.js';

/**
 * p14-workflow-engine 14.5: the ready-made templates build valid engine-2 documents from their placeholders (only
 * node types engine 2 runs since 14.3), refuse bad values, and carry localized text for every node and placeholder.
 */

const text = (name: string): TemplateText => ({
  name,
  description: 'd',
  label: (id) => `L ${id}`,
  text: (k) => `T ${k}`,
});
const AVAILABLE = typesDeliveredBy('14.3');

describe('workflow templates', () => {
  it('has the four owner-requested templates with unique ids', () => {
    expect(WORKFLOW_TEMPLATES.map((t) => t.id)).toEqual([
      'marketing-content-calendar',
      'marketing-lead-intake',
      'content-production',
      'video-production',
    ]);
  });

  for (const t of WORKFLOW_TEMPLATES) {
    describe(t.id, () => {
      const filled = fillTemplate(t.id, sampleValues(t), text('my-flow'));
      const def = filled !== null && filled.ok ? filled.definition : {};

      it('builds a valid v2 document from sample values', () => {
        expect(filled?.ok, JSON.stringify(filled)).toBe(true);
        const v = validateV2(def, { available: AVAILABLE });
        expect(v.ok ? [] : v.issues).toEqual([]);
        expect(def.name).toBe('my-flow');
        expect(def.schemaVersion).toBe(2);
      });

      it('uses every placeholder and only engine-2 node types', () => {
        const json = JSON.stringify(def);
        const values = sampleValues(t);
        for (const p of t.placeholders) {
          const v = values[p.key] ?? '';
          expect(json, p.key).toContain(p.kind === 'cron' ? v : JSON.stringify(v).slice(1, -1));
        }
        const nodes = def.nodes as { id: string; type: string; config?: unknown }[];
        for (const n of nodes) expect(AVAILABLE.has(n.type), n.type).toBe(true);
        // JSONata reads `-` as minus: node ids referenced in expressions use underscores.
        for (const n of nodes) expect(n.id).toMatch(/^[a-z][a-z0-9_]*$/);
        for (const n of nodes) for (const r of nodeReferences(n.config ?? {})) expect(r).not.toContain('-');
      });

      it('has no secrets or internal hosts in its defaults', () => {
        for (const p of t.placeholders) {
          if (p.kind === 'origin') expect(p.default).toBeUndefined();
          if (p.kind === 'credential') expect(p.default).toBeUndefined();
        }
        const json = JSON.stringify(def);
        expect(json).not.toMatch(/\bsk-[A-Za-z0-9]{8}|ghp_|password|169\.254|localhost/i);
        for (const m of json.matchAll(/https?:\/\/([a-z0-9.-]+)/g))
          expect(isForbiddenHost(m[1] ?? '')).toBe(false);
      });

      it('has localized text (TR + EN) for its name, every node and placeholder and content string', () => {
        for (const cat of [tr, en]) {
          const items = cat.workflowTemplates.items as Record<
            string,
            {
              name: string;
              description: string;
              nodes: Record<string, string>;
              placeholders: Record<string, { label: string; hint: string }>;
              content: Record<string, string>;
            }
          >;
          const item = items[t.id];
          expect(item?.name).toBeTruthy();
          for (const n of def.nodes as { id: string }[]) expect(item?.nodes[n.id], n.id).toBeTruthy();
          for (const p of t.placeholders) expect(item?.placeholders[p.key]?.label, p.key).toBeTruthy();
          for (const k of t.textKeys) expect(item?.content[k], k).toBeTruthy();
        }
      });
    });
  }

  it('needs network and code rights where it has HTTP / e-mail / code nodes', () => {
    const def = (id: string) => {
      const t = workflowTemplate(id);
      const r = t === undefined ? null : fillTemplate(id, sampleValues(t), text('x'));
      return r !== null && r.ok ? r.definition : {};
    };
    expect(templateRequires(def('marketing-lead-intake'))).toEqual([
      'workflows.define.code',
      'workflows.define.network',
    ]);
    expect(templateRequires(def('marketing-content-calendar'))).toEqual(['workflows.define.network']);
    expect(templateWorkerFeatures(def('content-production'))).toEqual(['function-code-v1', 'function-v1']);
  });

  it('refuses bad values, unknown keys and a bad name', () => {
    const t = workflowTemplate('marketing-content-calendar');
    if (t === undefined) throw new Error('missing');
    const r = fillTemplate(
      t.id,
      {
        ...sampleValues(t),
        social_origin: 'http://169.254.169.254',
        social_path: '../etc',
        mail_from: 'not-mail',
        schedule_cron: 'every day',
        smtp_provider: 'custom',
        brand: 'Acme {{ $eval("x") }}',
        language: 'de',
        runtime: 'openhands',
        extra: 'x',
      },
      text('Bad Name'),
    );
    expect(r?.ok).toBe(false);
    const codes = r !== null && !r.ok ? r.issues.map((i) => `${i.path}:${i.code}`) : [];
    expect(codes).toEqual(
      expect.arrayContaining([
        'name:invalid_format',
        'values.extra:unknown',
        'values.social_origin:invalid_origin',
        'values.social_path:invalid_path',
        'values.mail_from:invalid_email',
        'values.schedule_cron:invalid_cron',
        'values.smtp_provider:invalid_option',
        'values.brand:invalid_text',
        'values.language:invalid_option',
        'values.runtime:invalid_option',
      ]),
    );
    const missing = fillTemplate(t.id, {}, text('ok'));
    const miss = missing !== null && !missing.ok ? missing.issues.map((i) => i.path) : [];
    expect(miss).toEqual(
      expect.arrayContaining(['values.brand', 'values.social_origin', 'values.smtp_credential']),
    );
    expect(miss).not.toContain('values.social_credential');
    expect(fillTemplate('nope', {}, text('ok'))).toBeNull();
    const lead = workflowTemplate('marketing-lead-intake');
    if (lead === undefined) throw new Error('missing');
    const range = fillTemplate(lead.id, { ...sampleValues(lead), threshold: '101' }, text('ok'));
    expect(range !== null && !range.ok ? range.issues : []).toEqual([
      { path: 'values.threshold', code: 'out_of_range' },
    ]);
  });

  it('omits the HTTP auth of an optional credential left empty, and sets it when given', () => {
    const t = workflowTemplate('marketing-lead-intake');
    if (t === undefined) throw new Error('missing');
    const node = (values: Record<string, string>) => {
      const r = fillTemplate(t.id, values, text('lead'));
      const nodes = (r !== null && r.ok ? r.definition.nodes : []) as {
        id: string;
        config: { auth?: unknown };
      }[];
      return nodes.find((n) => n.id === 'enrich')?.config;
    };
    expect(node({ ...sampleValues(t), enrich_credential: '' })?.auth).toBeUndefined();
    expect(node({ ...sampleValues(t), enrich_credential: 'clearbit' })?.auth).toEqual({
      credential: 'clearbit',
      placement: 'bearer',
    });
  });
});
