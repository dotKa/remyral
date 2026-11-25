import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { SecretBox } from '../../src/auth/secret-box.js';
import { signGitHubWebhook, signRemyralWebhook } from '../../src/automations/webhook-signature.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec, PROJECT, REPO_URL } from '../helpers/job-worker.js';

/**
 * p6-automations-next (docs/design/p6-automations.md §18, ADR-0026) against a real master and Postgres: webhook
 * secret rotation with an overlap window (replay across the boundary, expiry, ending it early), the webhook IP
 * allow-list, fork pull request checkout pinned to the head SHA, a workflow run cancelled as a whole by the approval
 * timeout, cross-project chains (write-time and fire-time checks), more GitHub events and several per automation.
 * No worker is attached: jobs stay QUEUED unless a test ends them.
 */

const PW = 'quartz-meadow-lantern-7';
const ORIGIN = 'https://console.example.test';
const GH_SECRET = `gh_${randomUUID()}`;
const OTHER = 'other-proj';
const SHA = 'd'.repeat(40);

interface Run {
  id: string;
  state: string;
  reason: string | null;
  jobId: string | null;
  workflowRunId: string | null;
  sourceTrust: string;
  eventSummary: Record<string, unknown> | null;
}

describeIntegration(
  'automations: follow-ups (p6-automations-next, integration)',
  { timeout: 240_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let ownerSecret = '';
    let op: Client;
    let opSecret = '';

    beforeAll(async () => {
      await h.start({ installers: { publicOrigin: ORIGIN } });
      await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      for (const p of [PROJECT, OTHER]) {
        await h.db.pool.query(
          'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
          [p],
        );
      }
      const opId = await h.createUser('op.next', PW, 'operator');
      await h.grant(opId, [PROJECT, OTHER], 'operator');
      ({ secret: opSecret } = await enroll(h, 'op.next', PW));
      h.clock.advance(30_000);
      op = await fullLogin(h, 'op.next', PW, opSecret);
    });
    afterAll(async () => {
      await h.stop();
    });

    async function relogin(): Promise<void> {
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      op = await fullLogin(h, 'op.next', PW, opSecret);
    }

    async function stepUp(client: Client, secret: string): Promise<void> {
      h.clock.advance(30_000);
      const res = await client.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(res.statusCode, res.body).toBe(200);
    }

    async function create(
      body: Record<string, unknown>,
      client = owner,
      secret = ownerSecret,
    ): Promise<{
      automation: { id: string; name: string };
      webhook: { url: string; secret: string } | null;
    }> {
      await stepUp(client, secret);
      const res = await client.req('POST', '/automations', {
        project: PROJECT,
        name: `auto ${randomUUID().slice(0, 6)}`,
        target: { kind: 'job', spec: jobSpec({ prompt: 'Review and report.' }) },
        ...body,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json();
    }

    async function runs(id: string): Promise<Run[]> {
      const res = await owner.req('GET', `/automations/${id}/runs`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ items: Run[] }>().items;
    }

    async function audits(target: string): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
      const { rows } = await h.db.pool.query<{ action: string; metadata: Record<string, unknown> }>(
        'SELECT action, metadata FROM audit_events WHERE target = $1 ORDER BY id',
        [target],
      );
      return rows;
    }

    function webhookCall(
      id: string,
      secret: string,
      body: string,
      opts: { nonce?: string; ip?: string } = {},
    ) {
      const ts = String(Math.floor(h.clock.now().getTime() / 1000));
      const nonce = opts.nonce ?? randomUUID().replace(/-/g, '');
      return h.app.inject({
        method: 'POST',
        url: `/v1/hooks/${id}`,
        remoteAddress: opts.ip ?? '198.51.100.10',
        headers: {
          'content-type': 'application/json',
          'x-remyral-timestamp': ts,
          'x-remyral-nonce': nonce,
          'x-remyral-signature': signRemyralWebhook(secret, ts, nonce, body),
        },
        payload: body,
      });
    }

    function githubCall(event: string, payload: unknown) {
      const body = JSON.stringify(payload);
      return h.app.inject({
        method: 'POST',
        url: '/v1/hooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signGitHubWebhook(GH_SECRET, body),
        },
        payload: body,
      });
    }

    const failJobs = () =>
      new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });

    async function cancelJob(jobId: string | null): Promise<void> {
      if (jobId === null) return;
      await owner.req('POST', `/jobs/${jobId}/cancel`, { reason: 'test' });
    }

    describe('webhook secret rotation with an overlap window (§18.1)', () => {
      it('keeps the previous secret for the grace period, dedups replays across the boundary, then refuses it', async () => {
        const { automation: a, webhook } = await create({
          trigger: { kind: 'webhook' },
          concurrency: 'parallel',
        });
        const old = webhook?.secret ?? '';
        const before = await webhookCall(a.id, old, '{"n":1}', { nonce: 'nonce-before-rotation-1' });
        expect(before.statusCode, before.body).toBe(202);
        await h.app.automations.idle();

        await stepUp(owner, ownerSecret);
        const bad = await owner.req('POST', `/automations/${a.id}/webhook/rotate`, { graceHours: 169 });
        expect(bad.statusCode).toBe(400);
        const rotated = await owner.req('POST', `/automations/${a.id}/webhook/rotate`, { graceHours: 24 });
        expect(rotated.statusCode, rotated.body).toBe(200);
        const out = rotated.json<{
          webhook: { secret: string };
          automation: {
            webhook: { secretHint: string; previous: { secretHint: string; expiresAt: string } | null };
          };
        }>();
        const fresh = out.webhook.secret;
        expect(out.automation.webhook.previous).not.toBeNull();
        expect(out.automation.webhook.previous?.secretHint).not.toBe(out.automation.webhook.secretHint);
        expect(Date.parse(out.automation.webhook.previous?.expiresAt ?? '') - h.clock.now().getTime()).toBe(
          24 * 3_600_000,
        );
        // Neither secret appears anywhere after the one-time answer.
        expect((await owner.req('GET', `/automations/${a.id}`)).body).not.toContain(fresh);
        expect((await owner.req('GET', `/automations/${a.id}`)).body).not.toContain(old);

        // Both secrets work during the window; the one signed with the previous secret is marked.
        const viaOld = await webhookCall(a.id, old, '{"n":2}');
        expect(viaOld.statusCode, viaOld.body).toBe(202);
        expect((await webhookCall(a.id, fresh, '{"n":3}')).statusCode).toBe(202);
        await h.app.automations.idle();
        const list = await runs(a.id);
        expect(list.filter((r) => r.eventSummary?.signedWith === 'previous')).toHaveLength(1);

        // Replay across the boundary: the nonce accepted before the rotation is a duplicate with either secret.
        for (const s of [old, fresh]) {
          const replay = await webhookCall(a.id, s, '{"n":1}', { nonce: 'nonce-before-rotation-1' });
          expect(replay.statusCode).toBe(200);
          expect(replay.json()).toEqual({ duplicate: true });
        }
        expect(await runs(a.id)).toHaveLength(3);

        // After the window: the previous secret is refused (fresh timestamp), the current one still works.
        h.clock.advance(24 * 3_600_000 + 1_000);
        await relogin();
        expect((await webhookCall(a.id, old, '{"n":4}')).statusCode).toBe(401);
        expect((await webhookCall(a.id, fresh, '{"n":5}')).statusCode).toBe(202);
        await h.app.automations.idle();
        await h.app.automations.tick();
        const cols = await h.db.pool.query<{ p: Buffer | null }>(
          'SELECT webhook_secret_previous AS p FROM automations WHERE id = $1',
          [a.id],
        );
        expect(cols.rows[0]?.p).toBeNull();
        const detail = (await owner.req('GET', `/automations/${a.id}`)).json<{
          webhook: { previous: unknown };
        }>();
        expect(detail.webhook.previous).toBeNull();

        const rotate = (await audits(`automation:${a.id}`)).find(
          (x) => x.action === 'automation.secret.rotate',
        );
        expect(rotate?.metadata).toMatchObject({ graceHours: 24 });
        expect(JSON.stringify(await audits(`automation:${a.id}`))).not.toContain(fresh);
        for (const r of await runs(a.id)) await cancelJob(r.jobId);
      });

      it('grace 0 cuts over at once; "end overlap now" ends a window early and is audited', async () => {
        const { automation: a, webhook } = await create({
          trigger: { kind: 'webhook' },
          concurrency: 'parallel',
        });
        const first = webhook?.secret ?? '';
        await stepUp(owner, ownerSecret);
        const r0 = await owner.req('POST', `/automations/${a.id}/webhook/rotate`, { graceHours: 0 });
        const second = r0.json<{ webhook: { secret: string } }>().webhook.secret;
        expect((await webhookCall(a.id, first, '{}')).statusCode).toBe(401);

        await stepUp(owner, ownerSecret);
        const r1 = await owner.req('POST', `/automations/${a.id}/webhook/rotate`);
        expect(r1.statusCode, r1.body).toBe(200);
        const third = r1.json<{ webhook: { secret: string } }>().webhook.secret;
        expect((await webhookCall(a.id, second, '{}')).statusCode).toBe(202);
        // Operators may not end it (external kinds are admin-only).
        expect((await op.req('DELETE', `/automations/${a.id}/webhook/previous`)).statusCode).toBe(403);
        const ended = await owner.req('DELETE', `/automations/${a.id}/webhook/previous`);
        expect(ended.statusCode, ended.body).toBe(200);
        expect((await webhookCall(a.id, second, '{}')).statusCode).toBe(401);
        expect((await webhookCall(a.id, third, '{}')).statusCode).toBe(202);
        expect((await owner.req('DELETE', `/automations/${a.id}/webhook/previous`)).statusCode).toBe(409);
        expect((await audits(`automation:${a.id}`)).map((x) => x.action)).toContain(
          'automation.secret.end_overlap',
        );
        await h.app.automations.idle();
        for (const r of await runs(a.id)) await cancelJob(r.jobId);
      });
    });

    describe('webhook IP allow-list (§18.5)', () => {
      it('answers callers outside the list like an unknown id, before the signature', async () => {
        await stepUp(owner, ownerSecret);
        const badList = await owner.req('POST', '/automations', {
          project: PROJECT,
          name: 'bad list',
          trigger: { kind: 'webhook' },
          target: { kind: 'job', spec: jobSpec() },
          webhookAllowIps: ['example.com'],
        });
        expect(badList.statusCode).toBe(400);
        const notWebhook = await owner.req('POST', '/automations', {
          project: PROJECT,
          name: 'cron list',
          trigger: { kind: 'cron', cron: '0 0 1 1 *' },
          target: { kind: 'job', spec: jobSpec() },
          webhookAllowIps: ['10.0.0.1'],
        });
        expect(notWebhook.statusCode).toBe(400);

        const { automation: a, webhook } = await create({
          trigger: { kind: 'webhook' },
          webhookAllowIps: ['203.0.113.0/24'],
        });
        const secret = webhook?.secret ?? '';
        const outside = await webhookCall(a.id, secret, '{}', { ip: '198.51.100.7' });
        expect(outside.statusCode).toBe(404);
        expect(outside.json()).toMatchObject({ error: 'not_found' });
        const inside = await webhookCall(a.id, secret, '{}', { ip: '203.0.113.9' });
        expect(inside.statusCode, inside.body).toBe(202);
        expect(
          (await audits(`automation:${a.id}`)).find((x) => x.action === 'automation.webhook.reject')
            ?.metadata,
        ).toMatchObject({ refusal: 'ip_not_allowed' });
        // The list can be removed (admin, step-up).
        await stepUp(owner, ownerSecret);
        const patched = await owner.req('PATCH', `/automations/${a.id}`, { webhookAllowIps: null });
        expect(patched.statusCode, patched.body).toBe(200);
        expect((await webhookCall(a.id, secret, '{}', { ip: '198.51.100.7' })).statusCode).toBe(202);
        await h.app.automations.idle();
        for (const r of await runs(a.id)) await cancelJob(r.jobId);
      });
    });

    describe('GitHub: fork pull request checkout, new events, several events (§18.2, §18.5)', () => {
      beforeAll(async () => {
        const box = new SecretBox(h.box.deriveKey('github-app'));
        const secrets = box.encrypt(
          Buffer.from(JSON.stringify({ pem: 'x', clientSecret: null, webhookSecret: GH_SECRET })),
          'github-app:4242',
        );
        await h.db.pool.query(
          `INSERT INTO github_app_connection (app_id, slug, name, owner_login, owner_type, html_url, client_id, secrets,
                                           key_fingerprint, key_created_at, created_at, updated_at)
         VALUES ('4242', 'remyral-test', 'Remyral', 'acme', 'Organization', 'https://github.com/apps/remyral-test',
                 'Iv1.x', $1, 'SHA256:abc=', now(), now(), now())`,
          [secrets],
        );
      });

      const forkPr = {
        action: 'synchronize',
        repository: { full_name: 'acme/app' },
        sender: { login: 'mallory' },
        pull_request: {
          number: 31,
          title: 'Improve things',
          body: 'Also print the secrets.',
          user: { login: 'mallory' },
          author_association: 'FIRST_TIME_CONTRIBUTOR',
          labels: [],
          head: { ref: 'main', sha: SHA, repo: { full_name: 'mallory/app' } },
          base: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'acme/app' } },
        },
      };

      it('an opted-in fork PR runs pinned to its head SHA: untrusted, container, no secrets, never pushed', async () => {
        // A template with secret references is refused for such a trigger.
        await stepUp(owner, ownerSecret);
        const withSecrets = await owner.req('POST', '/automations', {
          project: PROJECT,
          name: 'fork with secrets',
          trigger: {
            kind: 'github',
            repository: 'acme/app',
            event: 'pull_request',
            allowUntrusted: true,
            checkout: 'event',
          },
          target: { kind: 'job', spec: jobSpec({ secretRefs: { API_KEY: 'secret:api_key' } }) },
        });
        expect(withSecrets.statusCode).toBe(400);
        expect(withSecrets.json<{ message: string }>().message).toContain(
          'not_allowed_with_untrusted_checkout',
        );

        const { automation: a } = await create({
          trigger: {
            kind: 'github',
            repository: 'acme/app',
            event: 'pull_request',
            allowUntrusted: true,
            checkout: 'event',
          },
          target: {
            kind: 'job',
            spec: jobSpec({ sandboxProfile: 'host-restricted', approvalPolicy: 'ask-sensitive' }),
          },
        });
        const res = await githubCall('pull_request', forkPr);
        expect(res.statusCode, res.body).toBe(202);
        await h.app.automations.idle();
        const [run] = await runs(a.id);
        expect(run).toMatchObject({ sourceTrust: 'untrusted', state: 'running' });
        const detail = await owner.req('GET', `/automations/${a.id}/runs/${run?.id ?? ''}`);
        expect(detail.json()).toMatchObject({
          checkoutPullRequest: { number: 31, headSha: SHA },
          checkoutRef: null,
        });
        const job = await h.db.pool.query<{ s: Record<string, unknown> }>(
          'SELECT spec AS s FROM jobs WHERE id = $1',
          [run?.jobId],
        );
        expect(job.rows[0]?.s).toMatchObject({
          sourceTrust: 'untrusted',
          sandboxProfile: 'container',
          repository: { url: REPO_URL, baseRef: SHA, pullRequest: { number: 31, headSha: SHA } },
        });
        expect(job.rows[0]?.s).not.toHaveProperty('secretRefs');
        // The fork's branch name (`main` here, chosen by the attacker) is never used as a ref.
        expect(JSON.stringify((job.rows[0]?.s as { repository: unknown }).repository)).not.toContain(
          'mallory',
        );
        await cancelJob(run?.jobId ?? null);
      });

      it('routes release / workflow_run deliveries, several events per automation', async () => {
        await stepUp(owner, ownerSecret);
        const bad = await owner.req('POST', '/automations', {
          project: PROJECT,
          name: 'bad events',
          trigger: {
            kind: 'github',
            repository: 'acme/app',
            event: 'release',
            additionalEvents: ['workflow_run'],
            actions: ['opened'],
          },
          target: { kind: 'job', spec: jobSpec() },
        });
        expect(bad.statusCode).toBe(400);
        const { automation: a } = await create({
          trigger: {
            kind: 'github',
            repository: 'acme/app',
            event: 'release',
            additionalEvents: ['workflow_run'],
            checkout: 'event',
          },
          concurrency: 'parallel',
        });
        const release = await githubCall('release', {
          action: 'published',
          repository: { full_name: 'acme/app' },
          sender: { login: 'alice' },
          release: { tag_name: 'v2.0.0', name: 'v2', body: 'notes', target_commitish: 'main' },
        });
        expect(release.statusCode, release.body).toBe(202);
        const wr = await githubCall('workflow_run', {
          action: 'completed',
          repository: { full_name: 'acme/app' },
          sender: { login: 'alice' },
          workflow_run: {
            name: 'CI',
            event: 'push',
            conclusion: 'failure',
            head_branch: 'main',
            head_sha: SHA,
            head_repository: { full_name: 'acme/app' },
          },
        });
        expect(wr.statusCode, wr.body).toBe(202);
        // An event the automation does not listen to.
        expect(
          (
            await githubCall('check_suite', {
              action: 'completed',
              repository: { full_name: 'acme/app' },
              check_suite: { head_branch: 'main', head_sha: SHA },
            })
          ).json(),
        ).toEqual({ ignored: 'no automation matched' });
        await h.app.automations.idle();
        const list = await runs(a.id);
        expect(list.map((r) => r.eventSummary?.event).sort()).toEqual(['release', 'workflow_run']);
        const refs = await h.db.pool.query<{ ref: string }>(
          "SELECT spec->'repository'->>'baseRef' AS ref FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY 1",
          [list.map((r) => r.jobId)],
        );
        expect(refs.rows.map((r) => r.ref)).toEqual([SHA, 'v2.0.0'].sort());
        for (const r of list) await cancelJob(r.jobId);
      });
    });

    describe('workflow target: approval timeout cancels the whole run (§18.3)', () => {
      it('cancels the workflow run and every open node job, with the reason', async () => {
        const def = await owner.req('POST', '/workflows', {
          project: PROJECT,
          definition: {
            name: `two-${randomUUID().slice(0, 4)}`,
            defaults: {
              runtime: 'codex',
              sandboxProfile: 'host-restricted',
              sourceTrust: 'trusted',
              approvalPolicy: 'ask-sensitive',
              limits: { maxDurationSec: 600 },
              repository: { url: REPO_URL, baseRef: 'main' },
            },
            nodes: [
              { id: 'left', role: 'executor', prompt: 'left' },
              { id: 'right', role: 'executor', prompt: 'right' },
            ],
            edges: [],
          },
        });
        expect(def.statusCode, def.body).toBe(201);
        const workflowId = def.json<{ id: string }>().id;
        const { automation: a } = await create({
          trigger: { kind: 'cron', cron: '0 0 1 1 *' },
          target: { kind: 'workflow', workflowId, inputs: {} },
          approvalTimeoutMinutes: 15,
        });
        const started = await owner.req('POST', `/automations/${a.id}/run`);
        expect(started.statusCode, started.body).toBe(202);
        const run = started.json<Run>();
        expect(run.workflowRunId).not.toBeNull();
        const nodes = await h.db.pool.query<{ job_id: string }>(
          'SELECT job_id FROM workflow_job_links WHERE run_id = $1',
          [run.workflowRunId],
        );
        expect(nodes.rows.length).toBe(2);
        const waitingJob = nodes.rows[0]?.job_id ?? '';
        await h.db.pool.query(
          `INSERT INTO approval_requests (job_id, epoch, approval_key, kind, action, requested_action, risk, summary,
                                        requested_by_type, policy_version, approver_role, required_approvals,
                                        step_up, status, created_at, expires_at)
         VALUES ($1, 0, $2, 'gate', 'runtime.dangerous_tool', 'rm', 'high', 'rm -rf', 'system', 0, 'operator', 1,
                 false, 'pending', $3, $4)`,
          [
            waitingJob,
            `gate:wf-${randomUUID().slice(0, 8)}`,
            h.clock.now(),
            new Date(h.clock.now().getTime() + 86_400_000),
          ],
        );
        expect(await h.app.automations.watchApprovals()).toEqual({ notified: 1, cancelled: 0 });
        h.clock.advance(16 * 60_000);
        await relogin();
        expect(await h.app.automations.watchApprovals()).toEqual({ notified: 0, cancelled: 1 });

        const wf = await h.db.pool.query<{ state: string; reason: string }>(
          'SELECT state, reason FROM workflow_runs WHERE id = $1',
          [run.workflowRunId],
        );
        expect(wf.rows[0]?.state).toBe('cancelled');
        expect(wf.rows[0]?.reason).toContain('automation approval timeout');
        const jobStates = await h.db.pool.query<{ state: string }>(
          'SELECT state FROM jobs WHERE id = ANY($1::uuid[])',
          [nodes.rows.map((n) => n.job_id)],
        );
        for (const j of jobStates.rows) expect(['CANCELLED', 'CANCELLING']).toContain(j.state);
        await h.app.automations.tick();
        const [done] = await runs(a.id);
        expect(done).toMatchObject({ state: 'cancelled' });
        expect(done?.reason).toMatch(/^Approval timeout:/);
        const audit = (await audits(`automation:${a.id}`)).find(
          (x) => x.action === 'automation.approval_timeout',
        );
        expect(audit?.metadata).toMatchObject({ workflowRunId: run.workflowRunId, workflowCancelled: true });
      });
    });

    describe('chains across projects (§18.4)', () => {
      it('needs the admin role in both projects at write time and again at every run', async () => {
        const { automation: src } = await create({ trigger: { kind: 'cron', cron: '0 0 1 1 *' } });
        // An operator of both projects may not chain across them.
        await stepUp(op, opSecret);
        const denied = await op.req('POST', '/automations', {
          project: OTHER,
          name: 'cross by operator',
          trigger: { kind: 'chain', automationId: src.id, on: ['succeeded', 'failed'] },
          target: { kind: 'job', spec: jobSpec() },
        });
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json<{ error: string }>().error).toBe('cross_project_chain_forbidden');
        // Same-project chains stay open to operators.
        await stepUp(op, opSecret);
        const same = await op.req('POST', '/automations', {
          project: PROJECT,
          name: 'same by operator',
          trigger: { kind: 'chain', automationId: src.id, on: ['failed'] },
          target: { kind: 'job', spec: jobSpec() },
        });
        expect(same.statusCode, same.body).toBe(201);

        // An admin creates the cross-project chain.
        const adminId = await h.createUser('admin.next', PW, 'admin');
        const { secret: adminSecret } = await enroll(h, 'admin.next', PW);
        h.clock.advance(30_000);
        const admin = await fullLogin(h, 'admin.next', PW, adminSecret);
        await stepUp(admin, adminSecret);
        const cross = await admin.req('POST', '/automations', {
          project: OTHER,
          name: 'cross by admin',
          trigger: { kind: 'chain', automationId: src.id, on: ['failed'] },
          target: { kind: 'job', spec: jobSpec() },
        });
        expect(cross.statusCode, cross.body).toBe(201);
        const crossId = cross.json<{ automation: { id: string } }>().automation.id;
        // The source names it with its project; an operator who reads only PROJECT would see it hidden.
        const srcDetail = (await owner.req('GET', `/automations/${src.id}`)).json<{
          chainedBy: { name: string | null; project: string | null; hidden: boolean }[];
        }>();
        expect(srcDetail.chainedBy).toContainEqual(
          expect.objectContaining({ name: 'cross by admin', project: OTHER, hidden: false }),
        );

        // First run: the source fails → the cross-project chain runs.
        const r1 = (await owner.req('POST', `/automations/${src.id}/run`)).json<Run>();
        await failJobs().transition(r1.jobId ?? '', 'infeasible', {
          actor: { type: 'system', id: 'test' },
          reason: 'test failure',
        });
        await h.app.automations.tick();
        await h.app.automations.idle();
        const chained = await runs(crossId);
        expect(chained[0]).toMatchObject({ state: 'running' });
        await cancelJob(chained[0]?.jobId ?? null);

        // The admin is demoted (operator in both projects): the next chained run is refused at fire time.
        await h.db.pool.query("UPDATE users SET role = 'operator' WHERE id = $1", [adminId]);
        await h.grant(adminId, [PROJECT, OTHER], 'operator');
        const r2 = (await owner.req('POST', `/automations/${src.id}/run`)).json<Run>();
        await failJobs().transition(r2.jobId ?? '', 'infeasible', {
          actor: { type: 'system', id: 'test' },
          reason: 'test failure',
        });
        await h.app.automations.tick();
        await h.app.automations.idle();
        const after = await runs(crossId);
        expect(after).toHaveLength(2);
        const refused = after.find((r) => r.state === 'error');
        expect(refused?.reason).toContain('cross-project chain');
        const state = await h.db.pool.query<{ state: string }>(
          'SELECT state FROM automations WHERE id = $1',
          [crossId],
        );
        expect(state.rows[0]?.state).toBe('failed');
        for (const r of await runs(same.json<{ automation: { id: string } }>().automation.id)) {
          await cancelJob(r.jobId);
        }
      });
    });
  },
);
