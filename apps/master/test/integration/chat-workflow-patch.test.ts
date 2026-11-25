import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Role } from '../../src/auth/users.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { CLIP_MARKER } from '../../src/workflows/patch.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p22-workflow-patch: the assistant reads a saved workflow's complete definition (describe_workflow definition: true)
 * and changes single steps with a patch (draft_workflow workflowId + patch) — applied by the master to the latest
 * saved document, validated like a whole draft, shown with a step diff against the saved version, refused when a
 * newer version exists; added HTTP steps need an admin and a fresh step-up at confirmation, as for a whole draft.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'chatwfpatch';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/chatwfpatch.git', baseRef: 'main' },
};
const LONG = `Scan the city {{inputs.city}} for leads. ${'Check every source carefully. '.repeat(240)}END`;

type Out = {
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  draft?: { id: string; payload: Record<string, unknown> };
};

const http = (id: string) => ({
  id,
  type: 'http.request',
  label: `WhatsApp ${id}`,
  config: { method: 'POST', origin: 'https://graph.example.com', path: '/v1/messages' },
});

describeIntegration(
  'chat: read and patch a saved workflow (integration, p22-workflow-patch)',
  { timeout: 180_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let op: Client;
    let opId = '';
    let viewerId = '';
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
      opId = await h.createUser('op.wfpatch', PW, 'operator');
      await h.grant(opId, [PROJECT], 'operator');
      const { secret } = await enroll(h, 'op.wfpatch', PW);
      op = await fullLogin(h, 'op.wfpatch', PW, secret);
      viewerId = await h.createUser('viewer.wfpatch', PW, 'viewer');
      await h.grant(viewerId, [PROJECT], 'viewer');
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

    /** The operator confirms a card (the HTTP test moves the clock, so it runs last). */
    async function opConfirm(draftId: string | undefined): Promise<{ statusCode: number; body: string }> {
      return op.req('POST', `/chat/drafts/${draftId ?? ''}/confirm`);
    }

    /** Saves version 1 of a lead workflow whose two message steps are to be replaced. */
    async function saveLeads(name: string): Promise<string> {
      const res = await op.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          schemaVersion: 2,
          name,
          description: 'Lead package',
          inputs: { city: { required: true } },
          defaults: DEFAULTS,
          nodes: [
            { id: 'start', type: 'trigger.manual' },
            { id: 'scan', type: 'ai.step', role: 'executor', prompt: LONG },
            {
              id: 'pick',
              type: 'ai.step',
              role: 'reviewer',
              prompt: 'Pick the best ten of {{upstream.scan.summary}}.',
            },
            { id: 'wa1', type: 'chat.message', config: { text: 'first' } },
            { id: 'wa2', type: 'chat.message', config: { text: 'second' } },
          ],
          edges: [
            { from: 'start', to: 'scan' },
            { from: 'scan', to: 'pick' },
            { from: 'pick', to: 'wa1' },
            { from: 'pick', to: 'wa2' },
          ],
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }

    const patchDraft = async (
      c: ToolCaller,
      workflowId: string,
      baseVersionId: string,
      ops: unknown[],
    ): Promise<Out> =>
      (await tools.run(c, 'draft_workflow', {
        project: PROJECT,
        workflowId,
        patch: { baseVersionId, ops },
      })) as Out;

    it('describe_workflow definition: true returns the whole document (prompts, configs), bounded, for a reader', async () => {
      const id = await saveLeads('leads-read');
      const viewer = await caller(viewerId, 'viewer');
      const summary = (await tools.run(viewer, 'describe_workflow', { workflowId: id })) as Out;
      expect(summary.ok).toBe(true);
      expect(summary.data?.definition).toBeUndefined();
      expect(JSON.stringify(summary.data)).not.toContain('Pick the best ten');
      const out = (await tools.run(viewer, 'describe_workflow', { workflowId: id, definition: true })) as Out;
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const def = out.data?.definition as Record<string, unknown>;
      expect(def).toMatchObject({
        versionId: id,
        version: 1,
        isLatest: true,
        canEdit: false,
        limits: { promptChars: 6000, textChars: 2000 },
      });
      expect(def.clipped).toEqual([`nodes.scan.prompt (${String(LONG.length)} characters)`]);
      expect(String(def.note)).toContain('DATA written by people');
      expect(String(def.note)).toContain(`baseVersionId: "${id}"`);
      const doc = out.data?.document as {
        nodes: Record<string, unknown>[];
        edges: unknown[];
        inputs: unknown;
      };
      expect(doc.nodes.find((n) => n.id === 'pick')?.prompt).toBe(
        'Pick the best ten of {{upstream.scan.summary}}.',
      );
      expect(doc.nodes.find((n) => n.id === 'wa1')?.config).toMatchObject({ text: 'first' });
      expect(String(doc.nodes.find((n) => n.id === 'scan')?.prompt)).toContain(CLIP_MARKER);
      expect(doc.edges).toHaveLength(4);
      expect(doc.inputs).toEqual({ city: { required: true } });
      // Steps are in the document; the summary list is not repeated.
      expect((out.data?.workflow as Record<string, unknown>).steps).toBeUndefined();
      const narrowed = (await tools.run(viewer, 'describe_workflow', {
        workflowId: id,
        definition: true,
        nodeIds: ['wa2'],
      })) as Out;
      expect((narrowed.data?.document as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual([
        'wa2',
      ]);
      expect((narrowed.data?.document as { edges: unknown[] }).edges).toEqual([{ from: 'pick', to: 'wa2' }]);
      // Another project's reader does not see it.
      const strangerId = await h.createUser('stranger.wfpatch', PW, 'viewer');
      const stranger = await caller(strangerId, 'viewer');
      expect(
        await tools.run(stranger, 'describe_workflow', { workflowId: id, definition: true }),
      ).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    });

    it('adds, removes and rewires steps; update_node merges config keys', async () => {
      const id = await saveLeads('leads-edit');
      const c = await caller(opId, 'operator');
      const out = await patchDraft(c, id, id, [
        { op: 'remove_node', id: 'wa2' },
        {
          op: 'add_node',
          node: {
            id: 'tell',
            type: 'notify.users',
            config: { recipients: { creator: true }, title: 'Leads ready' },
          },
        },
        { op: 'add_edge', edge: { from: 'pick', to: 'tell' } },
        { op: 'update_node', id: 'wa1', config: { text: 'first, edited' } },
        { op: 'set', field: 'description', value: 'Lead package v2' },
      ]);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(out.draft?.payload).toMatchObject({ valid: true, privileged: [], needsStepUp: false });
      const kinds = (
        out.draft?.payload.versionChanges as { changes: { kind: string; id: string }[] }
      ).changes.map((x) => `${x.kind}:${x.id}`);
      expect(kinds.sort()).toEqual(
        [
          'node_added:tell',
          'node_changed:wa1',
          'node_removed:wa2',
          'edge_added:pick → tell',
          'edge_removed:pick → wa2',
          'setting_changed:description',
        ].sort(),
      );
      const confirmed = await opConfirm(out.draft?.id);
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const v2 = await h.db.pool.query<{ definition: { nodes: Record<string, unknown>[] } }>(
        'SELECT definition FROM workflow_definitions WHERE project = $1 AND name = $2 AND version = 2',
        [PROJECT, 'leads-edit'],
      );
      expect(v2.rows[0]?.definition.nodes.find((n) => n.id === 'wa1')?.config).toEqual({
        // The merge changed only the named key; the saved default stays.
        text: 'first, edited',
        thread: 'creator-ops',
      });
    });

    it('a patch that cannot apply, or whose result is invalid, is no card and lists the issues', async () => {
      const id = await saveLeads('leads-bad');
      const c = await caller(opId, 'operator');
      const unknown = await patchDraft(c, id, id, [{ op: 'remove_node', id: 'ghost' }]);
      expect(unknown).toMatchObject({ ok: false, code: 'invalid' });
      expect(unknown.message).toContain('patch.ops.0: unknown_node:ghost');
      const copied = await patchDraft(c, id, id, [
        {
          op: 'update_node',
          id: 'scan',
          set: { prompt: `Scan ${CLIP_MARKER} 7000 characters; the rest stays as saved]` },
        },
      ]);
      expect(copied.message).toContain('copied_marker');
      const cycle = await patchDraft(c, id, id, [{ op: 'add_edge', edge: { from: 'pick', to: 'scan' } }]);
      expect(cycle.ok).toBe(false);
      expect(cycle.message).toContain('NO card');
      const ssrf = await patchDraft(c, id, id, [
        {
          op: 'replace_node',
          id: 'wa1',
          node: { ...http('wa1'), config: { method: 'GET', origin: 'http://169.254.169.254' } },
        },
      ]);
      expect(ssrf.ok).toBe(false);
      expect(ssrf.message).toContain('[node wa1]');
      expect(ssrf.message).not.toContain('169.254');
      const noop = await patchDraft(c, id, id, [{ op: 'update_node', id: 'wa1', config: { text: 'first' } }]);
      expect(noop.message).toContain('changes nothing');
      const both = (await tools.run(c, 'draft_workflow', {
        project: PROJECT,
        workflowId: id,
        definition: { name: 'leads-bad', nodes: [{ id: 'a', role: 'executor', prompt: 'x' }], edges: [] },
        patch: { baseVersionId: id, ops: [{ op: 'remove_node', id: 'wa1' }] },
      })) as Out;
      expect(both.message).toContain('exactly one of definition');
      expect(await store.drafts(c.threadId)).toEqual([]);
    });

    it('a patch written against an older version is refused (no silent overwrite)', async () => {
      const v1 = await saveLeads('leads-stale');
      const c = await caller(opId, 'operator');
      const first = await patchDraft(c, v1, v1, [{ op: 'update_node', id: 'wa1', config: { text: 'one' } }]);
      expect((await opConfirm(first.draft?.id)).statusCode).toBe(200);
      const latest = await h.db.pool.query<{ id: string }>(
        'SELECT id::text AS id FROM workflow_definitions WHERE project = $1 AND name = $2 AND version = 2',
        [PROJECT, 'leads-stale'],
      );
      const v2 = latest.rows[0]?.id ?? '';
      const stale = await patchDraft(c, v2, v1, [{ op: 'update_node', id: 'wa2', config: { text: 'two' } }]);
      expect(stale).toMatchObject({ ok: false, code: 'invalid' });
      expect(stale.message).toContain('Stale base version');
      expect(stale.message).toContain(v2);
      // Built on the latest version it goes through.
      const fresh = await patchDraft(c, v2, v2, [{ op: 'update_node', id: 'wa2', config: { text: 'two' } }]);
      expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
      expect(fresh.draft?.payload).toMatchObject({ baseVersion: 2 });
      // A version id of another workflow is not a base.
      const other = await saveLeads('leads-other');
      const mixed = await patchDraft(c, v2, other, [{ op: 'remove_node', id: 'wa2' }]);
      expect(mixed.message).toContain('not a version of workflow leads-stale');
    });

    it('a patch replaces two steps with http.request; the card lists the step diff; an admin saves it with a fresh code', async () => {
      const id = await saveLeads('leads-http');
      const ops = [
        { op: 'replace_node', id: 'wa1', node: http('wa1') },
        { op: 'replace_node', id: 'wa2', node: http('wa2') },
      ];
      // An operator may draft it but cannot save it (needs workflows.define.network).
      const byOp = await patchDraft(await caller(opId, 'operator'), id, id, ops);
      expect(byOp.ok, JSON.stringify(byOp)).toBe(true);
      expect(byOp.draft?.payload).toMatchObject({
        valid: true,
        privileged: ['workflows.define.network'],
        needsStepUp: true,
        patched: true,
        patchOps: 2,
        baseVersion: 1,
      });
      expect(String(byOp.data?.confirmation)).toContain('lacks workflows.define.network');
      const changes = byOp.draft?.payload.versionChanges as {
        fromVersion: number;
        changes: { kind: string; id: string }[];
      };
      expect(changes.fromVersion).toBe(1);
      expect(changes.changes.map((x) => `${x.kind}:${x.id}`)).toEqual([
        'node_changed:wa1',
        'node_changed:wa2',
      ]);
      expect(byOp.data?.changes).toEqual(changes);
      expect((await op.req('POST', `/chat/drafts/${byOp.draft?.id ?? ''}/confirm`)).statusCode).toBe(403);

      // The owner: stale verification refused, fresh one saves v2 — every untouched step exactly as saved.
      const byOwner = await patchDraft(await caller(ownerId, 'owner'), id, id, ops);
      expect(byOwner.draft?.payload.needsStepUp).toBe(true);
      h.clock.advance(11 * 60_000);
      const stale = await owner.req('POST', `/chat/drafts/${byOwner.draft?.id ?? ''}/confirm`);
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
      const ok = await owner.req('POST', `/chat/drafts/${byOwner.draft?.id ?? ''}/confirm`);
      expect(ok.statusCode, ok.body).toBe(200);
      const saved = await h.db.pool.query<{
        version: number;
        definition: { nodes: Record<string, unknown>[] };
      }>(
        'SELECT version, definition FROM workflow_definitions WHERE project = $1 AND name = $2 ORDER BY version',
        [PROJECT, 'leads-http'],
      );
      expect(saved.rows.map((r) => r.version)).toEqual([1, 2]);
      const [v1, v2] = saved.rows.map((r) => r.definition.nodes);
      expect(v2?.find((n) => n.id === 'scan')?.prompt).toBe(LONG);
      expect(v2?.slice(0, 3)).toEqual(v1?.slice(0, 3));
      expect(v2?.find((n) => n.id === 'wa1')).toMatchObject({
        type: 'http.request',
        label: 'WhatsApp wa1',
      });
    });
  },
);
