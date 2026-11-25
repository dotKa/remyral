import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signRemyralWebhook } from '../../src/automations/webhook-signature.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-multi-project W1 + W2 (docs/design/p18-multi-project.md §6): shared workflows end to end on real Postgres and
 * the real master routes. A workflow of project A is offered to B and C; B's admin attaches it and B's operator runs
 * it — the run, its jobs, repository and egress policy are B's; credential slots resolve only through B's binding;
 * non-privileged owner versions are followed, privileged ones wait for B's admin (notified), pinned attachments never
 * move; B's viewers read it only once attached; names collide; archiving in A stops runs in B. W2: each attaching
 * project has its own webhook automation / URL, its own error workflow and retention, and approver overrides only
 * raise.
 */

const PW = 'quartz-meadow-lantern-7';
const A = 'shr-alpha';
const B = 'shr-beta';
const C = 'shr-gamma';
const REPO_A = 'https://git.example.test/acme/alpha.git';
const REPO_B = 'https://git.example.test/acme/beta.git';
const HOST = 'api.example.test';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: REPO_A, baseRef: 'main' },
};
type Node = Record<string, unknown>;
const n = (id: string, type: string, config: Record<string, unknown> = {}, extra: Node = {}): Node => ({
  id,
  type,
  config,
  ...extra,
});
const step = (id: string, prompt: string, extra: Node = {}): Node => ({
  id,
  type: 'ai.step',
  role: 'executor',
  prompt,
  needsRepository: true,
  ...extra,
});
const http = (id: string, credential?: string): Node =>
  n(id, 'http.request', {
    origin: `https://${HOST}`,
    path: '/hook',
    method: 'GET',
    ...(credential === undefined ? {} : { auth: { credential, placement: 'bearer' } }),
  });

interface Attachment {
  id: string;
  project: string;
  state: string;
  follow: string;
  version: number;
  pendingVersion: number | null;
  pendingReason: string | null;
  definitionId: string | null;
  slots: { slot: string; credentialId: string | null }[];
}
interface Report {
  credentialUnbound: string[];
  privileged: { node: string }[];
  repository: string;
  issues: { path: string; code: string }[];
}

describeIntegration(
  'shared workflows across projects (integration, p18-multi-project W1 + W2)',
  { timeout: 300_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret: string;
    let ownerId: string;
    let opB: Client;
    let opBSecret: string;
    let viewerB: Client;
    let viewerBSecret: string;
    let opA: Client;
    let opASecret: string;

    beforeAll(async () => {
      await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
      ownerId = await h.createUser('owner1', PW);
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      const ob = await h.createUser('op.b', PW, 'operator');
      await h.grant(ob, [B], 'operator');
      opBSecret = (await enroll(h, 'op.b', PW)).secret;
      const vb = await h.createUser('viewer.b', PW, 'viewer');
      await h.grant(vb, [B], 'viewer');
      viewerBSecret = (await enroll(h, 'viewer.b', PW)).secret;
      const oa = await h.createUser('op.a', PW, 'operator');
      await h.grant(oa, [A], 'operator');
      opASecret = (await enroll(h, 'op.a', PW)).secret;
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [C],
      );
      for (const [p, url] of [
        [A, REPO_A],
        [B, REPO_B],
      ] as const)
        await h.db.pool.query(
          `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                          require_ci, ci_timeout_sec, updated_by, updated_at)
         VALUES ($1, 1, 'git', $2, 'main', 'merge', false, 3600, $3, now())`,
          [p, url, ownerId],
        );
      // A's credential and B's own credential for the same host (the vault is global; slots decide which is used).
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at, allowed_hosts)
       VALUES ('cred-alpha', 'A token', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('cred-beta', 'B token', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(), $1),
              ('cred-elsewhere', 'Other host', 'http-auth', 'REMYRAL_HTTP_AUTH', 1, 'active', now(), now(),
               '{other.example.test}')`,
        [[HOST]],
      );
    });
    afterAll(async () => {
      await h.stop();
    });
    beforeEach(async () => {
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      opB = await fullLogin(h, 'op.b', PW, opBSecret);
      viewerB = await fullLogin(h, 'viewer.b', PW, viewerBSecret);
      opA = await fullLogin(h, 'op.a', PW, opASecret);
    });

    async function stepUp(c: Client = owner, s: string = ownerSecret): Promise<void> {
      h.clock.advance(31_000);
      const res = await c.req('POST', '/auth/step-up', { code: h.code(s) });
      expect(res.statusCode, res.body).toBe(200);
    }
    const doc = (name: string, nodes: Node[], edges: Node[], extra: Node = {}) => ({
      schemaVersion: 2,
      name,
      defaults: DEFAULTS,
      nodes,
      edges,
      ...extra,
    });
    async function define(project: string, d: Record<string, unknown>): Promise<string> {
      await stepUp();
      const res = await owner.req('POST', '/workflows', { project, definition: d });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    async function save(id: string, d: Record<string, unknown>, baseVersion: number) {
      await stepUp();
      const res = await owner.req('PUT', `/workflows/${id}`, { definition: d, baseVersion });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        id: string;
        version: number;
        attachments?: { advanced: string[]; pending: string[]; pinned: string[] };
      }>();
    }
    async function offer(id: string, projects: string[]): Promise<void> {
      await stepUp();
      const res = await owner.req('PUT', `/workflows/${id}/sharing`, { projects });
      expect(res.statusCode, res.body).toBe(200);
    }
    async function attach(
      project: string,
      name: string,
      extra: Record<string, unknown> = {},
    ): Promise<{ attachment: Attachment; report: Report }> {
      await stepUp();
      const res = await owner.req('POST', `/projects/${project}/workflow-attachments`, {
        ownerProject: A,
        name,
        ...extra,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    }
    async function attachment(id: string): Promise<Attachment> {
      const res = await owner.req('GET', `/workflow-attachments/${id}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ attachment: Attachment }>().attachment;
    }
    const progress = async (times = 3) => {
      for (let i = 0; i < times; i++) await h.app.workflows.progress();
    };
    async function runJobs(runId: string) {
      const { rows } = await h.db.pool.query<{
        project: string;
        spec: Record<string, unknown>;
        node: string;
      }>(
        `SELECT j.project, j.spec, nr.node_id AS node FROM workflow_node_run_jobs l
         JOIN workflow_node_runs nr ON nr.id = l.node_run_id JOIN jobs j ON j.id = l.job_id
        WHERE nr.run_id = $1 ORDER BY l.created_at`,
        [runId],
      );
      return rows;
    }
    async function runRow(runId: string) {
      const { rows } = await h.db.pool.query<{
        project: string;
        attachment_id: string | null;
        version: number;
        state: string;
        repository: { url: string } | null;
      }>('SELECT project, attachment_id, version, state, repository FROM workflow_runs WHERE id = $1', [
        runId,
      ]);
      return rows[0];
    }

    let shared = '';
    let sharedAttachmentB = '';

    describe('W1 — offer, attach, run in the target', () => {
      it('without an offer the workflow is invisible to B; an offer lets B attach; B viewers read it only once attached (e)', async () => {
        shared = await define(
          A,
          doc(
            'report',
            [n('start', 'trigger.manual'), step('write', 'Write the weekly report.')],
            [{ from: 'start', to: 'write' }],
          ),
        );
        // B cannot read, run or attach A's workflow before it is offered.
        expect((await viewerB.req('GET', `/workflows/${shared}/definition?project=${B}`)).statusCode).toBe(
          404,
        );
        expect((await opB.req('GET', `/workflows/${shared}/definition`)).statusCode).toBe(404);
        expect(
          (await opB.req('POST', `/workflows/${shared}/runs`, { project: B, inputs: {} })).statusCode,
        ).toBe(404);
        await stepUp();
        const early = await owner.req('POST', `/projects/${B}/workflow-attachments`, {
          ownerProject: A,
          name: 'report',
        });
        expect(early.statusCode, early.body).toBe(404);
        // Offering needs the owner project's admin (an operator of A may not).
        await stepUp(opA, opASecret);
        expect((await opA.req('PUT', `/workflows/${shared}/sharing`, { projects: [B] })).statusCode).toBe(
          403,
        );
        await offer(shared, [B, C]);
        const offers = await owner.req('GET', `/workflows/offers?project=${B}`);
        expect(offers.statusCode, offers.body).toBe(200);
        expect(offers.json<{ offers: { name: string; attached: boolean }[] }>().offers).toEqual([
          expect.objectContaining({ name: 'report', attached: false }),
        ]);
        // Offered, not attached: still invisible to B's viewers (an admin may look before attaching).
        expect((await viewerB.req('GET', `/workflows/${shared}/definition?project=${B}`)).statusCode).toBe(
          404,
        );
        expect((await owner.req('GET', `/workflows/${shared}/definition?project=${B}`)).statusCode).toBe(200);
        // Attaching needs B's admin.
        expect(
          (await opB.req('POST', `/projects/${B}/workflow-attachments`, { ownerProject: A, name: 'report' }))
            .statusCode,
        ).toBe(403);
        const a = await attach(B, 'report');
        sharedAttachmentB = a.attachment.id;
        expect(a.attachment).toMatchObject({ project: B, state: 'enabled', follow: 'auto', version: 1 });
        expect(a.report).toMatchObject({ credentialUnbound: [], privileged: [], repository: 'registered' });
        const read = await viewerB.req('GET', `/workflows/${shared}/definition?project=${B}`);
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json<{ attachment: { project: string } | null }>().attachment).toMatchObject({
          project: B,
        });
        // Read-only there: B's operator cannot save a version of A's workflow.
        await stepUp(opB, opBSecret);
        const write = await opB.req('PUT', `/workflows/${shared}`, {
          definition: doc('report', [n('start', 'trigger.manual')], []),
        });
        expect(write.statusCode).toBe(404);
        // The list shows it in B as a shared workflow of A.
        const list = await viewerB.req('GET', '/workflows');
        const items = list.json<{
          definitions: { name: string; project: string; attachment?: { ownerProject: string } }[];
        }>().definitions;
        expect(items).toEqual([
          expect.objectContaining({
            name: 'report',
            project: B,
            attachment: expect.objectContaining({ ownerProject: A }) as unknown,
          }),
        ]);
      });

      it("B's operator runs it: the run, its jobs and the repository are B's (b)", async () => {
        const res = await opB.req('POST', `/workflows/${shared}/runs`, { project: B, inputs: {} });
        expect(res.statusCode, res.body).toBe(201);
        const runId = res.json<{ runId: string }>().runId;
        await progress();
        expect(await runRow(runId)).toMatchObject({
          project: B,
          attachment_id: sharedAttachmentB,
          repository: { url: REPO_B },
        });
        const jobs = await runJobs(runId);
        expect(jobs.length).toBeGreaterThan(0);
        for (const j of jobs) {
          expect(j.project).toBe(B);
          expect((j.spec.repository as { url: string }).url).toBe(REPO_B);
          expect(JSON.stringify(j.spec)).not.toContain(REPO_A);
        }
        // The run view names the owner project and the attachment; B's viewers read it.
        const v = await viewerB.req('GET', `/workflows/runs/${runId}`);
        expect(v.statusCode).toBe(200);
        expect(v.json<{ run: Record<string, unknown> }>().run).toMatchObject({
          project: B,
          ownerProject: A,
          attachmentId: sharedAttachmentB,
        });
        // A's operator (not a member of B) does not see B's run.
        expect((await opA.req('GET', `/workflows/runs/${runId}`)).statusCode).toBe(404);
        // The owner project still runs it in A, unchanged.
        const own = await owner.req('POST', `/workflows/${shared}/runs`, { inputs: {} });
        expect(own.statusCode).toBe(201);
        expect(await runRow(own.json<{ runId: string }>().runId)).toMatchObject({
          project: A,
          attachment_id: null,
          repository: { url: REPO_A },
        });
      });

      it('name collisions are refused in both directions (f)', async () => {
        // B cannot define its own "report" now…
        await stepUp();
        const own = await owner.req('POST', '/workflows', {
          project: B,
          definition: doc('report', [n('start', 'trigger.manual')], []),
        });
        expect(own.statusCode, own.body).toBe(409);
        expect(own.json<{ error: string }>().error).toBe('name_taken');
        // …and C cannot attach "report" while it has its own workflow of that name.
        await define(C, doc('report', [n('start', 'trigger.manual')], []));
        await stepUp();
        const clash = await owner.req('POST', `/projects/${C}/workflow-attachments`, {
          ownerProject: A,
          name: 'report',
        });
        expect(clash.statusCode, clash.body).toBe(409);
        expect(clash.json<{ error: string }>().error).toBe('name_taken');
        // "Projeye kopyala": B's operator copies it into B under another name (an own workflow of B).
        const copy = await opB.req('POST', `/workflows/${shared}/duplicate`, {
          name: 'report-b',
          targetProject: B,
        });
        expect(copy.statusCode, copy.body).toBe(201);
        const doc2 = await opB.req('GET', `/workflows/${copy.json<{ id: string }>().id}/definition`);
        expect(
          doc2.json<{ project: string; definition: { defaults: Record<string, unknown> } }>(),
        ).toMatchObject({
          project: B,
        });
        // The owner's repository stays behind.
        expect(
          doc2.json<{ definition: { defaults: Record<string, unknown> } }>().definition.defaults.repository,
        ).toBe(undefined);
      });
    });

    describe('W1 — credential slots (c)', () => {
      it('an HTTP node attaches disabled until B binds the slot; B runs use B’s credential, never A’s', async () => {
        // Egress: A allows the host; B allows it and one more host (B's policy must be the one in B's jobs).
        await stepUp();
        expect(
          (await owner.req('PUT', `/projects/${A}/workflow-egress`, { mode: 'allowlist', hosts: [HOST] }))
            .statusCode,
        ).toBe(200);
        await stepUp();
        expect(
          (
            await owner.req('PUT', `/projects/${B}/workflow-egress`, {
              mode: 'allowlist',
              hosts: [HOST, 'b-only.example.test'],
            })
          ).statusCode,
        ).toBe(200);
        const id = await define(
          A,
          doc(
            'ping',
            [n('start', 'trigger.manual'), http('call', 'cred-alpha')],
            [{ from: 'start', to: 'call' }],
          ),
        );
        await offer(id, [B]);
        // Attaching a version with privileged nodes needs a fresh step-up.
        h.clock.advance(11 * 60_000);
        const stale = await owner.req('POST', `/projects/${B}/workflow-attachments`, {
          ownerProject: A,
          name: 'ping',
        });
        expect(stale.statusCode, stale.body).toBe(403);
        expect(stale.json<{ error: string }>().error).toBe('step_up_required');
        const a = await attach(B, 'ping');
        expect(a.attachment.state).toBe('disabled');
        expect(a.report.credentialUnbound).toEqual(['cred-alpha']);
        expect(a.report.privileged.map((p) => p.node)).toEqual(['call']);
        // Not enableable, not runnable while the slot is unbound.
        const enable = await owner.req('PATCH', `/workflow-attachments/${a.attachment.id}`, {
          state: 'enabled',
        });
        expect(enable.statusCode, enable.body).toBe(409);
        expect(enable.json<{ error: string }>().error).toBe('credential_unbound');
        expect((await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} })).statusCode).toBe(
          409,
        );
        // Binding needs B's admin and an always-fresh step-up; the credential must be bound to the node's host.
        expect(
          (
            await opB.req('PUT', `/workflow-attachments/${a.attachment.id}/credentials/cred-alpha`, {
              credentialId: 'cred-beta',
            })
          ).statusCode,
        ).toBe(403);
        await stepUp();
        const wrong = await owner.req(
          'PUT',
          `/workflow-attachments/${a.attachment.id}/credentials/cred-alpha`,
          {
            credentialId: 'cred-elsewhere',
          },
        );
        expect(wrong.statusCode, wrong.body).toBe(400);
        expect(wrong.json<{ error: string }>().error).toBe('credential_host_not_bound');
        await stepUp();
        const bound = await owner.req(
          'PUT',
          `/workflow-attachments/${a.attachment.id}/credentials/cred-alpha`,
          {
            credentialId: 'cred-beta',
          },
        );
        expect(bound.statusCode, bound.body).toBe(200);
        const on = await owner.req('PATCH', `/workflow-attachments/${a.attachment.id}`, { state: 'enabled' });
        expect(on.statusCode, on.body).toBe(200);
        const res = await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} });
        expect(res.statusCode, res.body).toBe(201);
        const runId = res.json<{ runId: string }>().runId;
        await progress();
        const jobs = await runJobs(runId);
        const fn = jobs.find((j) => j.node === 'call');
        expect(fn?.project).toBe(B);
        const spec = fn?.spec as { function: { credential: { id: string }; egress: { hosts: string[] } } };
        expect(spec.function.credential.id).toBe('cred-beta');
        expect(spec.function.egress.hosts).toEqual([HOST, 'b-only.example.test']);
        // A's credential never appears in B's job specs.
        for (const j of jobs) expect(JSON.stringify(j.spec)).not.toContain('cred-alpha');
        // In A the same node uses A's credential (the implicit self-attachment).
        const own = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
        await progress();
        const ownJobs = await runJobs(own.json<{ runId: string }>().runId);
        const ownSpec = ownJobs.find((j) => j.node === 'call')?.spec as {
          function: { credential: { id: string } };
        };
        expect(ownSpec.function.credential.id).toBe('cred-alpha');
        // Audit: the binding names the slot and the credential.
        const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'workflow.attachment.credential' AND outcome = 'success'",
        );
        expect(audit.rows.at(-1)?.metadata).toMatchObject({
          ownerProject: A,
          project: B,
          slot: 'cred-alpha',
          boundVaultId: 'cred-beta',
        });
      });
    });

    describe('W1 — following the owner’s versions (d)', () => {
      it('non-privileged versions are followed, privileged ones wait for B’s admin, pinned attachments never move', async () => {
        const v1 = await define(
          A,
          doc(
            'digest',
            [n('start', 'trigger.manual'), step('sum', 'Summarise.')],
            [{ from: 'start', to: 'sum' }],
          ),
        );
        await offer(v1, [B, C]);
        const b = await attach(B, 'digest');
        const c = await attach(C, 'digest', { follow: 'pin' });
        // v2: a prompt change (not privileged) → B follows, C stays.
        const v2 = await save(
          v1,
          doc(
            'digest',
            [n('start', 'trigger.manual'), step('sum', 'Summarise in Turkish.')],
            [{ from: 'start', to: 'sum' }],
          ),
          1,
        );
        expect(v2.attachments).toEqual({ advanced: [B], pending: [], pinned: [C] });
        expect((await attachment(b.attachment.id)).version).toBe(2);
        expect((await attachment(c.attachment.id)).version).toBe(1);
        // v3: adds an HTTP node (privileged) → B stays on 2 with v3 pending; its admins are told.
        const v3 = await save(
          v2.id,
          doc(
            'digest',
            [n('start', 'trigger.manual'), step('sum', 'Summarise in Turkish.'), http('post')],
            [
              { from: 'start', to: 'sum' },
              { from: 'sum', to: 'post' },
            ],
          ),
          2,
        );
        expect(v3.attachments).toEqual({ advanced: [], pending: [B], pinned: [C] });
        const pendingB = await attachment(b.attachment.id);
        expect(pendingB).toMatchObject({ version: 2, pendingVersion: 3, pendingReason: 'privileged' });
        const notes = await h.db.pool.query<{ recipient_id: string; link: string }>(
          "SELECT recipient_id, link FROM notifications WHERE kind = 'workflow.update_pending'",
        );
        expect(notes.rows.map((r) => r.recipient_id)).toContain(ownerId);
        expect(notes.rows[0]?.link).toBe(`/workflows/${v3.id}?project=${B}`);
        // B keeps running version 2 meanwhile.
        const run = await opB.req('POST', `/workflows/${v3.id}/runs`, { project: B, inputs: {} });
        expect(run.statusCode, run.body).toBe(201);
        expect((await runRow(run.json<{ runId: string }>().runId))?.version).toBe(2);
        // Accepting needs B's admin with a fresh step-up.
        expect(
          (await opB.req('POST', `/workflow-attachments/${b.attachment.id}/accept`, { version: 3 }))
            .statusCode,
        ).toBe(403);
        h.clock.advance(11 * 60_000);
        const stale = await owner.req('POST', `/workflow-attachments/${b.attachment.id}/accept`, {
          version: 3,
        });
        expect(stale.statusCode).toBe(403);
        expect(stale.json<{ error: string }>().error).toBe('step_up_required');
        await stepUp();
        const ok = await owner.req('POST', `/workflow-attachments/${b.attachment.id}/accept`, { version: 3 });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json<{ attachment: Attachment }>().attachment).toMatchObject({
          version: 3,
          pendingVersion: null,
        });
        // The pinned attachment never moved.
        expect((await attachment(c.attachment.id)).version).toBe(1);
        // "Nerede kullanılıyor": the owner sees both; an operator of A sees neither project (a count instead).
        const where = await owner.req('GET', `/workflows/${v1}/attachments`);
        expect(
          where.json<{ attachments: { project: string }[] }>().attachments.map((x) => x.project),
        ).toEqual([B, C]);
        const hidden = await opA.req('GET', `/workflows/${v1}/attachments`);
        expect(hidden.json<{ attachments: unknown[]; hidden: number }>()).toMatchObject({
          attachments: [],
          hidden: 2,
        });
      });
    });

    describe('W1 — version-1 documents (engine 1)', () => {
      it('a v1 workflow runs in B on engine 1 with B’s repository and raised gate roles', async () => {
        const id = await define(A, {
          name: 'legacy',
          inputs: {},
          defaults: DEFAULTS,
          nodes: [{ id: 'a', role: 'executor', prompt: 'Do it.', approval: { approverRole: 'operator' } }],
          edges: [],
        });
        await offer(id, [B]);
        await attach(B, 'legacy', { overrides: { approvers: { a: 'admin' } } });
        const res = await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} });
        expect(res.statusCode, res.body).toBe(201);
        const runId = res.json<{ runId: string }>().runId;
        expect(await runRow(runId)).toMatchObject({ project: B, repository: { url: REPO_B } });
        const nodes = await h.db.pool.query<{
          gate_role: string | null;
          project: string;
          spec: { repository?: { url: string } };
        }>(
          `SELECT n.gate_role, j.project, j.spec FROM workflow_nodes n JOIN jobs j ON j.id = n.job_id WHERE n.run_id = $1`,
          [runId],
        );
        expect(nodes.rows).toEqual([
          expect.objectContaining({
            gate_role: 'admin',
            project: B,
            spec: expect.objectContaining({
              repository: expect.objectContaining({ url: REPO_B }) as unknown,
            }) as unknown,
          }),
        ]);
      });
    });

    describe('W1 — archive and detach (g)', () => {
      it("archiving in A stops new runs in B; detaching frees the name and keeps B's runs readable", async () => {
        const id = await define(A, doc('nightly', [n('start', 'trigger.manual')], []));
        await offer(id, [B]);
        const a = await attach(B, 'nightly');
        const first = await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} });
        expect(first.statusCode).toBe(201);
        const arch = await owner.req('POST', `/workflows/${id}/archive`, {});
        expect(arch.statusCode, arch.body).toBe(200);
        const refused = await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} });
        expect(refused.statusCode).toBe(409);
        expect(refused.json<{ error: string }>().error).toBe('workflow_archived');
        expect((await attachment(a.attachment.id)) as unknown as { ownerArchived: boolean }).toMatchObject({
          ownerArchived: true,
        });
        await owner.req('POST', `/workflows/${id}/unarchive`, {});
        const del = await owner.req('DELETE', `/workflow-attachments/${a.attachment.id}`);
        expect(del.statusCode, del.body).toBe(204);
        expect((await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} })).statusCode).toBe(
          404,
        );
        // The finished run stays readable in B.
        expect(
          (await viewerB.req('GET', `/workflows/runs/${first.json<{ runId: string }>().runId}`)).statusCode,
        ).toBe(200);
        // The name is free in B again.
        await define(B, doc('nightly', [n('start', 'trigger.manual')], []));
      });
    });

    describe('W2 — per-project triggers and settings', () => {
      it('each attaching project gets its own webhook URL; firing B’s starts a B run only', async () => {
        const id = await define(
          A,
          doc(
            'inbound',
            [n('hook', 'trigger.webhook'), n('note', 'data.set', { fields: { ok: true } })],
            [{ from: 'hook', to: 'note' }],
          ),
        );
        await offer(id, ['*']);
        await attach(B, 'inbound');
        const inC = await attach(C, 'inbound');
        const activate = async (project: string) => {
          await stepUp();
          const res = await owner.req('PUT', `/workflows/${id}/activation`, { enabled: true, project });
          expect(res.statusCode, res.body).toBe(200);
          const v = res.json<{
            project: string;
            triggers: { nodeId: string; automationId: string | null; webhookUrl: string | null }[];
            webhookSecrets: { nodeId: string; secret: string }[];
          }>();
          expect(v.project).toBe(project);
          return {
            automation: v.triggers.find((t) => t.nodeId === 'hook')?.automationId ?? '',
            url: v.triggers.find((t) => t.nodeId === 'hook')?.webhookUrl ?? '',
            secret: v.webhookSecrets.find((s) => s.nodeId === 'hook')?.secret ?? '',
          };
        };
        // An operator of B may not turn on a webhook trigger (automations.external).
        expect(
          (await opB.req('PUT', `/workflows/${id}/activation`, { enabled: true, project: B })).statusCode,
        ).toBe(403);
        const hb = await activate(B);
        const hc = await activate(C);
        expect(hb.automation).not.toBe(hc.automation);
        expect(hb.url).not.toBe(hc.url);
        const automations = await h.db.pool.query<{ id: string; project: string }>(
          'SELECT id, project FROM automations WHERE id = ANY($1::uuid[]) ORDER BY project',
          [[hb.automation, hc.automation]],
        );
        expect(automations.rows.map((r) => r.project)).toEqual([B, C]);
        const body = JSON.stringify({ event: 'go' });
        const ts = String(Math.floor(h.clock.now().getTime() / 1000));
        const fire = await h.app.inject({
          method: 'POST',
          url: `/v1/hooks/${hb.automation}`,
          headers: {
            'content-type': 'application/json',
            'x-remyral-timestamp': ts,
            'x-remyral-nonce': 'nonce-shared-00000001',
            'x-remyral-signature': signRemyralWebhook(hb.secret, ts, 'nonce-shared-00000001', body),
          },
          payload: body,
        });
        expect(fire.statusCode, fire.body).toBe(202);
        await h.app.automations.idle();
        await h.app.automations.startQueued();
        const runs = await h.db.pool.query<{ project: string; trigger_kind: string }>(
          "SELECT project, trigger_kind FROM workflow_runs WHERE name = 'inbound'",
        );
        expect(runs.rows).toEqual([{ project: B, trigger_kind: 'webhook' }]);
        // Detaching C pauses C's automation (history kept); B's stays active.
        const del = await owner.req('DELETE', `/workflow-attachments/${inC.attachment.id}`);
        expect(del.statusCode, del.body).toBe(204);
        const after = await h.db.pool.query<{ id: string; state: string }>(
          'SELECT id, state FROM automations WHERE id = ANY($1::uuid[])',
          [[hb.automation, hc.automation]],
        );
        expect(Object.fromEntries(after.rows.map((r) => [r.id, r.state]))).toEqual({
          [hb.automation]: 'active',
          [hc.automation]: 'paused',
        });
      });

      it("B's error workflow (its own name) runs when B's run fails; A's does not", async () => {
        await define(
          B,
          doc(
            'on-fail-b',
            [n('err', 'trigger.error'), n('note', 'data.set', { fields: { b: true } })],
            [{ from: 'err', to: 'note' }],
          ),
        );
        await define(
          A,
          doc(
            'on-fail-a',
            [n('err', 'trigger.error'), n('note', 'data.set', { fields: { a: true } })],
            [{ from: 'err', to: 'note' }],
          ),
        );
        const id = await define(
          A,
          doc(
            'fragile',
            [n('start', 'trigger.manual'), n('boom', 'control.fail', { reason: 'nope' })],
            [{ from: 'start', to: 'boom' }],
            { settings: { onFailure: { workflow: 'on-fail-a' } } },
          ),
        );
        await offer(id, [B]);
        await attach(B, 'fragile', { overrides: { onFailure: { workflow: 'on-fail-b' } } });
        const res = await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} });
        expect(res.statusCode, res.body).toBe(201);
        const runId = res.json<{ runId: string }>().runId;
        await progress();
        const err = await h.db.pool.query<{ project: string; name: string }>(
          'SELECT project, name FROM workflow_runs WHERE error_of = $1',
          [runId],
        );
        expect(err.rows).toEqual([{ project: B, name: 'on-fail-b' }]);
      });

      it("retention pruning uses B's value; approver overrides only raise", async () => {
        const id = await define(
          A,
          doc(
            'keepsake',
            [n('start', 'trigger.manual'), n('seed', 'data.set', { fields: { v: 1 } })],
            [{ from: 'start', to: 'seed' }],
            { settings: { retentionDays: 30 } },
          ),
        );
        await offer(id, [B]);
        await attach(B, 'keepsake', { overrides: { retentionDays: 1 } });
        const inB = (await opB.req('POST', `/workflows/${id}/runs`, { project: B, inputs: {} })).json<{
          runId: string;
        }>().runId;
        const inA = (await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} })).json<{
          runId: string;
        }>().runId;
        await progress();
        expect((await runRow(inB))?.state).toBe('succeeded');
        expect((await runRow(inA))?.state).toBe('succeeded');
        h.clock.advance(2 * 86_400_000);
        await h.app.workflows.v2.pruneData({ force: true });
        owner = await fullLogin(h, 'owner1', PW, ownerSecret);
        opB = await fullLogin(h, 'op.b', PW, opBSecret);
        const pruned = await h.db.pool.query<{ id: string; pruned: boolean }>(
          'SELECT id, data_pruned_at IS NOT NULL AS pruned FROM workflow_runs WHERE id = ANY($1::uuid[])',
          [[inA, inB]],
        );
        expect(Object.fromEntries(pruned.rows.map((r) => [r.id, r.pruned]))).toEqual({
          [inA]: false,
          [inB]: true,
        });

        const gate = await define(
          A,
          doc(
            'gated',
            [
              n('start', 'trigger.manual'),
              n('ask', 'control.approval', { title: 'Go?', approverRole: 'admin' }),
            ],
            [{ from: 'start', to: 'ask' }],
          ),
        );
        await offer(gate, [B]);
        const g = await attach(B, 'gated');
        const lower = await owner.req('PATCH', `/workflow-attachments/${g.attachment.id}`, {
          overrides: { approvers: { ask: 'operator' } },
        });
        expect(lower.statusCode, lower.body).toBe(400);
        expect(lower.body).toContain('lower_than_definition');
        // A lower role at attach time is refused the same way.
        await stepUp();
        const bad = await owner.req('POST', `/projects/${C}/workflow-attachments`, {
          ownerProject: A,
          name: 'gated',
          overrides: { approvers: { ask: 'operator' } },
        });
        expect(bad.statusCode).toBe(404); // not offered to C
        const raise = await owner.req('PATCH', `/workflow-attachments/${g.attachment.id}`, {
          overrides: { approvers: { ask: 'owner' } },
        });
        expect(raise.statusCode, raise.body).toBe(200);
        const run = (await opB.req('POST', `/workflows/${gate}/runs`, { project: B, inputs: {} })).json<{
          runId: string;
        }>().runId;
        await progress();
        const waiting = await h.db.pool.query<{ gate_role: string | null; state: string }>(
          "SELECT gate_role, state FROM workflow_node_runs WHERE run_id = $1 AND node_id = 'ask'",
          [run],
        );
        expect(waiting.rows[0]).toMatchObject({ state: 'waiting', gate_role: 'owner' });
        // In A the gate keeps the definition's role.
        const ownRun = (await owner.req('POST', `/workflows/${gate}/runs`, { inputs: {} })).json<{
          runId: string;
        }>().runId;
        await progress();
        const ownGate = await h.db.pool.query<{ gate_role: string | null }>(
          "SELECT gate_role FROM workflow_node_runs WHERE run_id = $1 AND node_id = 'ask'",
          [ownRun],
        );
        expect(ownGate.rows[0]?.gate_role).toBe('admin');
      });
    });
  },
);
