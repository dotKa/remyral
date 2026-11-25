import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.5: chat drafts of version-2 workflows — `draft_workflow` with typed nodes is validated against
 * the node catalog (types, static fields, the K1 address floor) before the card exists, the card carries the typed
 * graph summary and the privileged actions; confirming a privileged version needs `workflows.define.*` and a fresh
 * step-up (the POST /workflows rule); `workflow_node_catalog` serves the catalog compactly.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'chatwf2';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/chatwf2.git', baseRef: 'main' },
};

type Out = {
  ok: boolean;
  data?: Record<string, unknown>;
  draft?: { id: string; payload: Record<string, unknown> };
};

describeIntegration(
  'chat drafts of version-2 workflows (integration, p14-workflow-engine 14.5)',
  { timeout: 180_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let op: Client;
    let opId = '';
    let tools: ChatTools;
    let store: ChatStore;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      opId = await h.createUser('op.chatwf2', PW, 'operator');
      await h.grant(opId, [PROJECT], 'operator');
      const { secret } = await enroll(h, 'op.chatwf2', PW);
      op = await fullLogin(h, 'op.chatwf2', PW, secret);
      store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        workflows: () => h.app.workflows,
      } as unknown as ChatToolsDeps);
    });
    afterAll(async () => {
      await h.stop();
    });

    async function caller(userId: string, role: Role): Promise<ToolCaller> {
      const thread = await store.createThread(userId, 'workflows');
      return {
        userId,
        subject: await loadSubject(h.db.pool, { id: userId, role }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
    }
    const draft = async (c: ToolCaller, definition: Record<string, unknown>): Promise<Out> =>
      (await tools.run(c, 'draft_workflow', { project: PROJECT, definition })) as Out;
    const doc = (name: string, nodes: Record<string, unknown>[], edges: Record<string, unknown>[]) => ({
      schemaVersion: 2,
      name,
      defaults: DEFAULTS,
      nodes,
      edges,
    });

    describe('workflow_node_catalog', () => {
      it('lists every type compactly and the config schema of the types asked for', async () => {
        const c = await caller(opId, 'operator');
        const all = (await tools.run(c, 'workflow_node_catalog', {})) as Out;
        expect(all.ok, JSON.stringify(all)).toBe(true);
        const types = all.data?.types as {
          type: string;
          executable: boolean;
          needs?: string;
          fields: object;
        }[];
        expect(types.find((t) => t.type === 'http.request')).toMatchObject({
          executable: true,
          needs: 'workflows.define.network',
          fields: { origin: 'static', path: 'expr' },
        });
        expect(types.find((t) => t.type === 'control.if')).toMatchObject({ executable: true });
        expect(all.data?.configSchemas).toBeUndefined();
        const some = (await tools.run(c, 'workflow_node_catalog', { types: ['email.send'] })) as Out;
        expect(Object.keys(some.data?.configSchemas as object)).toEqual(['email.send']);
        expect(JSON.stringify(some.data).length).toBeLessThan(64 * 1024);
        expect(await tools.run(c, 'workflow_node_catalog', { types: ['nope.thing'] })).toMatchObject({
          ok: false,
          code: 'invalid',
        });
      });
    });

    describe('draft_workflow with schemaVersion 2', () => {
      it('a valid v2 draft carries the typed graph; saving it needs nothing privileged', async () => {
        const c = await caller(opId, 'operator');
        const out = await draft(
          c,
          doc(
            'triage',
            [
              { id: 'start', type: 'trigger.manual' },
              { id: 'seed', type: 'data.set', config: { fields: { n: { $expr: '3' } } } },
              { id: 'big', type: 'control.if', label: 'Big?', config: { condition: '{{ $input.n > 2 }}' } },
              { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Big' } },
              { id: 'note', type: 'chat.message', config: { text: 'Small: {{ $node.seed.out.n }}' } },
            ],
            [
              { from: 'start', to: 'seed' },
              { from: 'seed', to: 'big' },
              { from: 'big', fromPort: 'true', to: 'tell' },
              { from: 'big', fromPort: 'false', to: 'note' },
            ],
          ),
        );
        expect(out.ok, JSON.stringify(out)).toBe(true);
        expect(out.draft?.payload).toMatchObject({
          schemaVersion: 2,
          valid: true,
          issues: [],
          privileged: [],
          needsStepUp: false,
        });
        const summary = out.draft?.payload as {
          nodes: { id: string; type: string; label?: string }[];
          edges: { from: string; to: string; fromPort?: string }[];
        };
        expect(summary.nodes.find((n) => n.id === 'big')).toMatchObject({
          type: 'control.if',
          label: 'Big?',
        });
        expect(summary.nodes.find((n) => n.id === 'tell')?.type).toBe('notify.users');
        expect(summary.edges).toContainEqual({ from: 'big', to: 'tell', fromPort: 'true' });
        // No prompt or config travels in the summary.
        expect(JSON.stringify(out.draft?.payload.nodes)).not.toContain('Small:');
        const ok = await op.req('POST', `/chat/drafts/${out.draft?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        const saved = await h.db.pool.query<{ definition: { schemaVersion: number } }>(
          'SELECT definition FROM workflow_definitions WHERE project = $1 AND name = $2',
          [PROJECT, 'triage'],
        );
        expect(saved.rows[0]?.definition.schemaVersion).toBe(2);
      });

      it('unknown types, expressions in static fields and internal addresses come back as issues (codes only)', async () => {
        const c = await caller(opId, 'operator');
        const unknownType = await draft(
          c,
          doc('bad-type', [{ id: 'x', type: 'magic.wand', config: {} }], []),
        );
        expect(unknownType.draft?.payload.valid).toBe(false);
        expect(JSON.stringify(unknownType.draft?.payload.issues)).toContain('nodes.0.type');
        const staticExpr = await draft(
          c,
          doc(
            'bad-static',
            [
              {
                id: 'tell',
                type: 'notify.users',
                config: { recipients: { $expr: '$inputs.who' }, title: 'x' },
              },
            ],
            [],
          ),
        );
        expect(staticExpr.draft?.payload.valid).toBe(false);
        expect(JSON.stringify(staticExpr.draft?.payload.issues)).toContain('static_field');
        const ssrf = await draft(
          c,
          doc(
            'bad-host',
            [{ id: 'h', type: 'http.request', config: { origin: 'http://169.254.169.254' } }],
            [],
          ),
        );
        expect(ssrf.draft?.payload.valid).toBe(false);
        const issues = ssrf.draft?.payload.issues as { path: string; code: string }[];
        expect(issues.map((x) => x.path)).toEqual(['nodes.0.config.origin']);
        expect(JSON.stringify(issues)).not.toContain('169.254');
        // p16-workflow-quality: an invalid draft is no card — hidden, the issues go back to the model.
        expect(ssrf.ok).toBe(false);
        expect((ssrf as { message?: string }).message).toContain('draft_workflow');
        expect((ssrf.draft as { state?: string } | undefined)?.state).toBe('invalid');
        expect(await store.drafts(c.threadId)).toEqual([]);
        const refused = await op.req('POST', `/chat/drafts/${ssrf.draft?.id ?? ''}/confirm`);
        expect(refused.statusCode).toBe(409);
      });

      it('an HTTP node needs a project admin and a fresh step-up at confirmation', async () => {
        const http = doc(
          'enrich',
          [
            { id: 'start', type: 'trigger.manual' },
            {
              id: 'fetch',
              type: 'http.request',
              config: { method: 'GET', origin: 'https://api.example.com', path: '/v1/people' },
            },
          ],
          [{ from: 'start', to: 'fetch' }],
        );
        // An operator may draft it, but is told only a project admin can save it; confirming is refused (audited).
        const byOp = await draft(await caller(opId, 'operator'), http);
        expect(byOp.draft?.payload).toMatchObject({
          valid: true,
          privileged: ['workflows.define.network'],
          needsStepUp: true,
        });
        expect(String(byOp.data?.confirmation)).toContain('lacks workflows.define.network');
        const denied = await op.req('POST', `/chat/drafts/${byOp.draft?.id ?? ''}/confirm`);
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ error: 'forbidden' });

        // The owner: refused with a stale verification, saved with a fresh one (audited with the privileged delta).
        const byOwner = await draft(await caller(ownerId, 'owner'), http);
        expect(String(byOwner.data?.confirmation)).toContain('verification code');
        h.clock.advance(11 * 60_000);
        const stale = await owner.req('POST', `/chat/drafts/${byOwner.draft?.id ?? ''}/confirm`);
        expect(stale.statusCode).toBe(403);
        expect(stale.json()).toMatchObject({ error: 'step_up_required' });
        const step = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
        expect(step.statusCode, step.body).toBe(200);
        const ok = await owner.req('POST', `/chat/drafts/${byOwner.draft?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        const id = ok.json<{ result: { workflowId: string } }>().result.workflowId;
        const audit = await h.db.pool.query<{ metadata: { privilegedDelta?: string[] } }>(
          `SELECT metadata FROM audit_events WHERE action = 'workflow.define' AND target = $1`,
          [`workflow:${id}`],
        );
        expect(audit.rows[0]?.metadata.privilegedDelta).toEqual(['fetch:http.request:added']);
      });
    });
  },
);
