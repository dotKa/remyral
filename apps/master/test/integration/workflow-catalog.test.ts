import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'cat-alpha';
const OTHER = 'cat-beta';

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/catalog.git', baseRef: 'main' },
};

const doc = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: 'Build and verify',
  inputs: { task: { required: true } },
  defaults: DEFAULTS,
  nodes: [
    { id: 'build', role: 'executor', prompt: 'SECRET-PROMPT build {{inputs.task}}' },
    { id: 'check', role: 'verifier', prompt: 'Verify {{upstream.build.summary}}' },
  ],
  edges: [{ from: 'build', to: 'check' }],
  ...extra,
});

interface Issue {
  path: string;
  code: string;
}

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md): the workflow catalog behind the Diyalog editor — validation as
 * issues, versioning (PUT, base-version conflicts, immutable name), the full document, version list, archive / restore
 * (runs and versions refused while archived), duplicate, list statistics, authorization and audit. Real master and
 * Postgres; nothing is dispatched (no workers), runs are inserted as rows for the statistics.
 */
describeIntegration('workflow catalog (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let owner: Client;
  let viewer: Client;
  let outsider: Client;
  let id1 = '';

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('cat.owner', PW, 'owner');
    owner = await fullLogin(h, 'cat.owner', PW, (await enroll(h, 'cat.owner', PW)).secret);
    const v = await h.createUser('cat.viewer', PW, 'viewer');
    await h.grant(v, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'cat.viewer', PW, (await enroll(h, 'cat.viewer', PW)).secret);
    const o = await h.createUser('cat.outsider', PW, 'operator');
    await h.grant(o, [OTHER], 'operator');
    outsider = await fullLogin(h, 'cat.outsider', PW, (await enroll(h, 'cat.outsider', PW)).secret);
  });

  afterAll(async () => {
    await h.stop();
  });

  it('validates without saving: ok, and every issue as a path and a code (never prompt text)', async () => {
    const ok = await owner.req('POST', '/workflows/validate', { project: PROJECT, definition: doc('ship') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, issues: [] });

    const cycle = await owner.req('POST', '/workflows/validate', {
      project: PROJECT,
      definition: doc('ship', {
        edges: [
          { from: 'build', to: 'check' },
          { from: 'check', to: 'build' },
        ],
      }),
    });
    expect(cycle.json<{ ok: boolean; issues: Issue[] }>()).toEqual({
      ok: false,
      issues: [{ path: 'edges', code: 'cycle' }],
    });

    const unknown = await owner.req('POST', '/workflows/validate', {
      project: PROJECT,
      definition: doc('ship', { edges: [{ from: 'build', to: 'ghost' }] }),
    });
    expect(unknown.json<{ issues: Issue[] }>().issues).toContainEqual({
      path: 'edges.0.to',
      code: 'unknown_node',
    });

    const undeclared = await owner.req('POST', '/workflows/validate', {
      project: PROJECT,
      definition: doc('ship', { inputs: {} }),
    });
    expect(undeclared.json<{ issues: Issue[] }>().issues).toContainEqual({
      path: 'nodes.0.prompt',
      code: 'undeclared_input:task',
    });

    const layout = await owner.req('POST', '/workflows/validate', {
      project: PROJECT,
      definition: doc('ship', { layout: { positions: { build: { x: 0, y: 0 }, ghost: { x: 10, y: 10 } } } }),
    });
    expect(layout.json<{ issues: Issue[] }>().issues).toEqual([
      { path: 'layout.positions.ghost', code: 'unknown_node' },
    ]);

    const spec = await owner.req('POST', '/workflows/validate', {
      project: PROJECT,
      definition: doc('ship', {
        defaults: { ...DEFAULTS, repository: { url: 'not a url', baseRef: 'main' } },
      }),
    });
    const specBody = spec.json<{ ok: boolean; issues: Issue[] }>();
    expect(specBody.ok).toBe(false);
    expect(JSON.stringify(specBody)).not.toContain('SECRET-PROMPT');

    const missing = await owner.req('POST', '/workflows/validate', {
      project: 'nope',
      definition: doc('ship'),
    });
    expect(missing.statusCode).toBe(404);
    // Nothing was saved.
    const { rows } = await h.db.pool.query('SELECT 1 FROM workflow_definitions WHERE name = $1', ['ship']);
    expect(rows).toHaveLength(0);
  });

  it('defines, reads the full document and saves new versions (PUT) with base-version conflicts', async () => {
    const bad = await owner.req('POST', '/workflows', {
      project: PROJECT,
      definition: doc('ship', { edges: [{ from: 'build', to: 'ghost' }] }),
    });
    expect(bad.statusCode).toBe(400);
    const badBody = bad.json<{ error: string; issues: Issue[] }>();
    expect(badBody.error).toBe('invalid_workflow');
    expect(badBody.issues).toContainEqual({ path: 'edges.0.to', code: 'unknown_node' });

    const created = await owner.req('POST', '/workflows', {
      project: PROJECT,
      definition: doc('ship', { layout: { positions: { build: { x: 0, y: 0 }, check: { x: 260, y: 0 } } } }),
    });
    expect(created.statusCode).toBe(201);
    id1 = created.json<{ id: string }>().id;

    const read = await viewer.req('GET', `/workflows/${id1}/definition`);
    expect(read.statusCode).toBe(200);
    const d = read.json<{
      version: number;
      latestVersion: number;
      latestId: string;
      archived: boolean;
      promptsHidden: boolean;
      definition: { nodes: { prompt: string }[]; layout: unknown };
    }>();
    expect(d).toMatchObject({
      version: 1,
      latestVersion: 1,
      latestId: id1,
      archived: false,
      promptsHidden: false,
    });
    // Viewers read job prompts (GET /jobs/:id), so they read step prompts too.
    expect(d.definition.nodes[0]?.prompt).toContain('SECRET-PROMPT');
    expect(d.definition.layout).toEqual({ positions: { build: { x: 0, y: 0 }, check: { x: 260, y: 0 } } });

    const v2 = await owner.req('PUT', `/workflows/${id1}`, {
      definition: doc('ship', { description: 'v2' }),
      baseVersion: 1,
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json()).toMatchObject({ name: 'ship', version: 2 });
    const id2 = v2.json<{ id: string }>().id;

    const stale = await owner.req('PUT', `/workflows/${id1}`, { definition: doc('ship'), baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toBe('version_conflict');

    const renamed = await owner.req('PUT', `/workflows/${id1}`, { definition: doc('other-name') });
    expect(renamed.statusCode).toBe(400);
    expect(renamed.json<{ issues: Issue[] }>().issues).toEqual([{ path: 'name', code: 'immutable' }]);

    const invalid = await owner.req('PUT', `/workflows/${id2}`, {
      definition: doc('ship', { edges: [{ from: 'check', to: 'check' }] }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ issues: Issue[] }>().issues).toContainEqual({ path: 'edges.0', code: 'self_edge' });

    // The old version's document names the latest one.
    const old = await owner.req('GET', `/workflows/${id1}/definition`);
    expect(old.json()).toMatchObject({ version: 1, latestVersion: 2, latestId: id2 });

    const versions = await viewer.req('GET', `/workflows/${id1}/versions`);
    expect(versions.statusCode).toBe(200);
    const vs = versions.json<{ versions: { id: string; version: number; nodes: number; edges: number }[] }>();
    expect(vs.versions.map((x) => x.version)).toEqual([2, 1]);
    expect(vs.versions[0]).toMatchObject({ id: id2, nodes: 2, edges: 1 });

    const audit = await h.db.pool.query<{ metadata: { via?: string; previousVersion?: number } }>(
      `SELECT metadata FROM audit_events WHERE action = 'workflow.define' AND target = $1`,
      [`workflow:${id2}`],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ via: 'update', previousVersion: 1 });
  });

  it('lists catalog facts: creator, description, run statistics and the last run', async () => {
    const now = new Date();
    for (const [state, at] of [
      ['succeeded', new Date(now.getTime() - 3_000)],
      ['failed', new Date(now.getTime() - 2_000)],
      ['running', new Date(now.getTime() - 1_000)],
    ] as const) {
      await h.db.pool.query(
        `INSERT INTO workflow_runs (definition_id, project, name, version, state, inputs, repository, created_by,
                                    created_at, updated_at)
         VALUES ($1, $2, 'ship', 1, $3, '{}', '{}', 'fixture', $4, $4)`,
        [id1, PROJECT, state, at],
      );
    }
    const res = await owner.req('GET', '/workflows');
    const def = res
      .json<{ definitions: Record<string, unknown>[] }>()
      .definitions.find((x) => x.name === 'ship' && x.project === PROJECT);
    expect(def).toMatchObject({
      version: 2,
      nodes: 2,
      edges: 1,
      description: 'v2',
      archived: false,
      archivedAt: null,
      runs: 3,
      succeeded: 1,
      failed: 1,
      lastRun: { state: 'running' },
    });
    expect(typeof def?.createdBy).toBe('string');
    // Projects the user cannot see stay out of the catalog.
    const hidden = await outsider.req('GET', '/workflows');
    expect(
      hidden.json<{ definitions: { project: string }[] }>().definitions.every((x) => x.project !== PROJECT),
    ).toBe(true);
  });

  it('archives (runs and versions refused, listed as archived) and restores', async () => {
    const a = await owner.req('POST', `/workflows/${id1}/archive`, { reason: 'replaced' });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ archived: true });
    // Idempotent: archiving again records nothing new.
    expect((await owner.req('POST', `/workflows/${id1}/archive`, {})).statusCode).toBe(200);

    const list = await owner.req('GET', '/workflows');
    const def = list
      .json<{ definitions: { name: string; archived: boolean; archivedAt: string | null }[] }>()
      .definitions.find((x) => x.name === 'ship');
    expect(def?.archived).toBe(true);
    expect(def?.archivedAt).not.toBeNull();

    const run = await owner.req('POST', `/workflows/${id1}/runs`, { inputs: { task: 'x' } });
    expect(run.statusCode).toBe(409);
    expect(run.json<{ error: string }>().error).toBe('workflow_archived');
    const define = await owner.req('POST', '/workflows', { project: PROJECT, definition: doc('ship') });
    expect(define.statusCode).toBe(409);
    expect(define.json<{ error: string }>().error).toBe('workflow_archived');
    const put = await owner.req('PUT', `/workflows/${id1}`, { definition: doc('ship') });
    expect(put.json<{ error: string }>().error).toBe('workflow_archived');
    expect((await owner.req('GET', `/workflows/${id1}/definition`)).json()).toMatchObject({ archived: true });

    const u = await owner.req('POST', `/workflows/${id1}/unarchive`, {});
    expect(u.json()).toEqual({ archived: false });
    const after = await owner.req('POST', '/workflows', { project: PROJECT, definition: doc('ship') });
    expect(after.statusCode).toBe(201);

    const audit = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('workflow.archive', 'workflow.unarchive') AND target = $1
       ORDER BY id`,
      [`workflow:${id1}`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['workflow.archive', 'workflow.unarchive']);
  });

  it('duplicates a version under a new name (409 when the name exists)', async () => {
    const dup = await owner.req('POST', `/workflows/${id1}/duplicate`, { name: 'ship-copy' });
    expect(dup.statusCode).toBe(201);
    const copy = dup.json<{ id: string; name: string; version: number }>();
    expect(copy).toMatchObject({ name: 'ship-copy', version: 1 });
    const read = await owner.req('GET', `/workflows/${copy.id}/definition`);
    expect(read.json<{ project: string; definition: { name: string; nodes: unknown[] } }>()).toMatchObject({
      project: PROJECT,
      definition: { name: 'ship-copy' },
    });
    const again = await owner.req('POST', `/workflows/${id1}/duplicate`, { name: 'ship-copy' });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('workflow_exists');
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'workflow.duplicate' AND target = $1`,
      [`workflow:${copy.id}`],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('authorizes: viewers read but cannot write; non-members see 404', async () => {
    for (const [method, url, body] of [
      ['PUT', `/workflows/${id1}`, { definition: doc('ship') }],
      ['POST', `/workflows/${id1}/archive`, {}],
      ['POST', `/workflows/${id1}/unarchive`, {}],
      ['POST', `/workflows/${id1}/duplicate`, { name: 'viewer-copy' }],
      ['POST', '/workflows/validate', { project: PROJECT, definition: doc('ship') }],
    ] as const) {
      const res = await viewer.req(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of [`/workflows/${id1}/definition`, `/workflows/${id1}/versions`]) {
      expect((await outsider.req('GET', url)).statusCode, url).toBe(404);
    }
    expect((await outsider.req('PUT', `/workflows/${id1}`, { definition: doc('ship') })).statusCode).toBe(
      404,
    );
    const denied = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'workflow.archive' AND outcome = 'denied'`,
    );
    expect(denied.rows.length).toBeGreaterThan(0);
  });
});
