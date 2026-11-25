import { sampleValues, WORKFLOW_TEMPLATES } from '@remyral/workflow-nodes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.5 (ADR-0055): the ready-made templates over the API — the gallery list, a dry run of every
 * template (valid against the catalog, the egress policy and the vault credentials' bound hosts), instantiation into a
 * workspace project as version 1 (HTTP / e-mail / code nodes need the project admin and a fresh step-up, exactly as in
 * the editor), refusals (bad values, existing name, operator without network rights, engine off), and a run of the
 * content template that reaches its first worker node (a function job is created and waits for a machine).
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'wf-templates';

interface TemplateView {
  id: string;
  category: string;
  nodes: { id: string; type: string }[];
  placeholders: { key: string; kind: string; credentialKind: string | null; hostFrom: string | null }[];
  requires: string[];
  workerFeatures: string[];
  triggers: string[];
}

/** Sample values whose credentials exist in the vault, bound to the sample hosts. */
function valuesFor(t: (typeof WORKFLOW_TEMPLATES)[number]): Record<string, string> {
  const v = sampleValues(t);
  for (const p of t.placeholders) {
    if (p.kind !== 'credential') continue;
    v[p.key] = p.credentialKind === 'smtp' ? 'tpl-smtp' : `tpl-${p.hostFrom ?? ''}`.replace(/_/g, '-');
  }
  return v;
}

describeIntegration('workflow templates (integration, p14 14.5)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let operator: Client;
  let secret = '';

  async function stepUp(c: Client = owner): Promise<void> {
    h.clock.advance(31_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }
  const instantiate = (c: Client, id: string, body: Record<string, unknown>) =>
    c.req('POST', `/workflows/templates/${id}/instantiate`, { project: PROJECT, ...body });

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
    await h.db.pool.query(
      `INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT DO NOTHING`,
      [PROJECT],
    );
    const opId = await h.createUser('oper1', PW, 'operator');
    await h.grant(opId, [PROJECT], 'operator');
    operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
    // Vault credentials bound to the hosts of the sample values (metadata rows; no value is needed to save).
    const creds = new Map<string, { kind: string; host: string }>();
    for (const t of WORKFLOW_TEMPLATES) {
      const v = valuesFor(t);
      for (const p of t.placeholders) {
        if (p.kind !== 'credential') continue;
        const from = p.hostFrom ?? '';
        const host =
          p.credentialKind === 'smtp'
            ? 'smtp.gmail.com'
            : new URL(v[from] ?? 'https://x.example.com').hostname;
        creds.set(v[p.key] ?? '', { kind: p.credentialKind ?? 'http-auth', host });
      }
    }
    for (const [id, c] of creds) {
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at, allowed_hosts)
         VALUES ($1, $1, $2, $3, 1, 'active', now(), now(), $4)`,
        [id, c.kind, c.kind === 'smtp' ? 'REMYRAL_SMTP_PASSWORD' : 'REMYRAL_HTTP_AUTH', [c.host]],
      );
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  it('lists the templates with their graph, placeholders and needed rights (viewer+)', async () => {
    const res = await operator.req('GET', '/workflows/templates');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ engineV2: boolean; templates: TemplateView[] }>();
    expect(body.engineV2).toBe(true);
    expect(body.templates.map((t) => t.id)).toEqual(WORKFLOW_TEMPLATES.map((t) => t.id));
    const lead = body.templates.find((t) => t.id === 'marketing-lead-intake');
    expect(lead?.requires).toEqual(['workflows.define.code', 'workflows.define.network']);
    expect(lead?.workerFeatures).toEqual(['function-code-v1', 'function-v1']);
    expect(lead?.triggers).toEqual(['trigger.webhook']);
    expect(lead?.placeholders.find((p) => p.key === 'crm_credential')).toMatchObject({
      kind: 'credential',
      credentialKind: 'http-auth',
      hostFrom: 'crm_origin',
    });
    expect(body.templates.find((t) => t.id === 'video-production')?.nodes.length).toBeGreaterThan(10);
  });

  it('dry-runs every template as valid (catalog, expressions, egress, bound credentials)', async () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const res = await instantiate(operator, t.id, {
        name: `dry-${t.id}`,
        values: valuesFor(t),
        dryRun: true,
        locale: 'en',
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ valid: boolean; issues: unknown[]; definition: { name: string } }>();
      expect(body.issues, t.id).toEqual([]);
      expect(body.valid).toBe(true);
      expect(body.definition.name).toBe(`dry-${t.id}`);
    }
  });

  it('refuses bad values, an unknown template and a credential not bound to the host', async () => {
    const t = WORKFLOW_TEMPLATES[0];
    if (t === undefined) throw new Error('no templates');
    const bad = await instantiate(owner, t.id, {
      name: 'bad-values',
      values: { ...valuesFor(t), social_origin: 'http://10.0.0.1', nope: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    const issues = bad.json<{ error: string; issues: { path: string; code: string }[] }>();
    expect(issues.error).toBe('invalid_template_values');
    expect(issues.issues).toEqual(
      expect.arrayContaining([
        { path: 'values.nope', code: 'unknown' },
        { path: 'values.social_origin', code: 'invalid_origin' },
      ]),
    );
    expect(bad.body).not.toContain('10.0.0.1');
    expect((await instantiate(owner, 'no-such-template', { name: 'x', values: {} })).statusCode).toBe(404);
    const unbound = await instantiate(owner, t.id, {
      name: 'unbound',
      values: { ...valuesFor(t), social_credential: 'tpl-smtp' },
      dryRun: true,
    });
    expect(unbound.statusCode, unbound.body).toBe(200);
    expect(unbound.json<{ valid: boolean }>().valid).toBe(false);
  });

  it('saves version 1 of each template as the admin with a fresh step-up, and refuses without', async () => {
    const t = WORKFLOW_TEMPLATES[0];
    if (t === undefined) throw new Error('no templates');
    // An operator lacks workflows.define.network for the HTTP / e-mail nodes.
    const op = await instantiate(operator, t.id, { name: 'op-calendar', values: valuesFor(t) });
    expect(op.statusCode, op.body).toBe(403);
    expect(op.json<{ error: string }>().error).toBe('forbidden');
    // The owner's login step-up has gone stale.
    h.clock.advance(11 * 60_000);
    const stale = await instantiate(owner, t.id, { name: 'stale-calendar', values: valuesFor(t) });
    expect(stale.statusCode, stale.body).toBe(403);
    expect(stale.json<{ error: string }>().error).toBe('step_up_required');
    for (const tpl of WORKFLOW_TEMPLATES) {
      await stepUp();
      const res = await instantiate(owner, tpl.id, {
        name: `my-${tpl.id}`,
        values: valuesFor(tpl),
        locale: 'tr',
      });
      expect(res.statusCode, res.body).toBe(201);
      const saved = res.json<{ id: string; name: string; version: number }>();
      expect(saved).toMatchObject({ name: `my-${tpl.id}`, version: 1 });
      const doc = await owner.req('GET', `/workflows/${saved.id}/definition`);
      expect(doc.statusCode, doc.body).toBe(200);
      const def = doc.json<{ definition: Record<string, unknown> }>().definition;
      expect(
        (await owner.req('POST', '/workflows/validate', { project: PROJECT, definition: def })).json(),
      ).toEqual({ ok: true, issues: [] });
      // Labels and texts in the requested language.
      expect(JSON.stringify(def)).toMatch(/[çğıöşüÇĞİÖŞÜ]/);
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'workflow.template.instantiate' AND target = $1`,
        [`workflow:${saved.id}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ template: tpl.id, project: PROJECT, version: 1 });
    }
    await stepUp();
    const again = await instantiate(owner, t.id, { name: `my-${t.id}`, values: valuesFor(t) });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('workflow_exists');
  });

  it('p18-multi-project W4: "Kullan" also offers and attaches the new workflow to other projects', async () => {
    const t = WORKFLOW_TEMPLATES[0];
    if (t === undefined) throw new Error('no templates');
    const TARGET = 'wf-templates-target';
    await h.db.pool.query(
      `INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now()) ON CONFLICT DO NOTHING`,
      [TARGET],
    );
    // Offering needs the owner project's admin: an operator is refused before anything is saved.
    const byOperator = await instantiate(operator, t.id, {
      name: 'op-attach',
      values: valuesFor(t),
      attachTo: [TARGET],
    });
    expect(byOperator.statusCode).toBe(403);
    expect((await owner.req('GET', '/workflows')).body).not.toContain('op-attach');
    await stepUp();
    const res = await instantiate(owner, t.id, {
      name: 'shared-from-template',
      values: valuesFor(t),
      attachTo: [TARGET, 'wf-templates-missing', PROJECT],
    });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json<{
      id: string;
      attached: { project: string; attachmentId: string; state: string }[];
      refused: { project: string; code: string }[];
    }>();
    expect(out.attached).toEqual([expect.objectContaining({ project: TARGET })]);
    // The template's credential slots are not bound in the target yet: the attachment waits there, disabled.
    expect(['enabled', 'disabled']).toContain(out.attached[0]?.state);
    expect(out.refused).toEqual([
      expect.objectContaining({ project: 'wf-templates-missing', code: 'project_not_found' }),
    ]);
    const sharing = await owner.req('GET', `/workflows/${out.id}/sharing`);
    expect(sharing.json<{ projects: string[] }>().projects).toEqual([TARGET]);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'workflow.attach' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      ownerProject: PROJECT,
      project: TARGET,
      name: 'shared-from-template',
    });
  });

  it('runs the content template up to its first worker node (a function job waits for a machine)', async () => {
    const list = await owner.req('GET', '/workflows');
    const wf = list
      .json<{ definitions: { id: string; name: string }[] }>()
      .definitions.find((d) => d.name === 'my-content-production');
    expect(wf).toBeDefined();
    const run = await owner.req('POST', `/workflows/${wf?.id ?? ''}/runs`, {
      inputs: { topic: 'Workflow motorları', keyword: 'workflow' },
    });
    expect(run.statusCode, run.body).toBe(201);
    const runId = run.json<{ runId: string }>().runId;
    for (let i = 0; i < 3; i++) await h.app.workflows.progress();
    const jobs = await h.db.pool.query<{ kind: string; node: string }>(
      `SELECT j.spec->>'kind' AS kind, nr.node_id AS node FROM workflow_node_run_jobs l
         JOIN workflow_node_runs nr ON nr.id = l.node_run_id JOIN jobs j ON j.id = l.job_id WHERE nr.run_id = $1`,
      [runId],
    );
    expect(jobs.rows).toEqual([{ kind: 'function', node: 'research' }]);
    const view = await owner.req('GET', `/workflows/runs/${runId}`);
    expect(view.json<{ run: { state: string } }>().run.state).not.toMatch(/failed|succeeded/);
  });

  describe('with the engine off', () => {
    const off = new Harness();
    let user: Client;
    beforeAll(async () => {
      await off.start({
        orchestration: { tickIntervalMs: 0, workflowEngine: { v2: false, v2ForV1: false } },
      });
      await off.createUser('owner2', PW);
      user = await fullLogin(off, 'owner2', PW, (await enroll(off, 'owner2', PW)).secret);
      await off.db.pool.query(
        `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING`,
        [PROJECT],
      );
    });
    afterAll(async () => {
      await off.stop();
    });

    it('lists the templates as unavailable and refuses to instantiate (409)', async () => {
      const list = await user.req('GET', '/workflows/templates');
      expect(list.json<{ engineV2: boolean }>().engineV2).toBe(false);
      const t = WORKFLOW_TEMPLATES[0];
      const res = await user.req('POST', `/workflows/templates/${t?.id ?? ''}/instantiate`, {
        project: PROJECT,
        name: 'off',
        values: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('engine_v2_disabled');
    });
  });
});
