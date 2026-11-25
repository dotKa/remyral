import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FakeScript } from '@remyral/agent-adapters';
import { createNodeFileOps, FileSecretStore } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PanelSkillsKey } from '../../src/skills/panel-key.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p14-mcp-core (docs/design/p14-mcp-skills.md §8 P3) end to end with a real worker daemon: publish (panel-signed) →
 * vault binding → tool policy (allow / ask / deny) → assignment → project switch on → a job on an `mcp-v1` worker gets
 * ASSIGN_JOB.mcp, the worker verifies it with its own keys and hands the servers to the (fake) runtime, which decides
 * every call through the shared MCP gate: the allowed call runs, the `ask` call becomes an approval request (action
 * `tool.mcp`) that an admin approves, the denied call is refused. Calls are recorded (metadata only) and audited; the
 * secret value reaches only the runtime's request headers. Switch off → the next job gets no MCP; an untrusted-source
 * job never does.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 14;
const VALUE = 'ghp_e2eMcpToken0123456789abcdefABCDEF';
const CRED = 'gh-mcp-e2e';

const script: FakeScript = () => [
  { kind: 'mcp', server: 'github', tool: 'list_issues', args: { repo: 'acme/app' }, result: '3 issues' },
  { kind: 'mcp', server: 'github', tool: 'create_issue', args: { title: 'Flaky test' } },
  { kind: 'mcp', server: 'github', tool: 'delete_repo', args: { repo: 'acme/app' } },
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } },
];

describeIntegration(
  'MCP end to end with a real worker (integration, p14-mcp-core)',
  { timeout: 180_000 },
  () => {
    let panel: PanelSkillsKey;
    let h: Harness;
    let url: string;
    let owner: Client;
    let secret: string;
    let fileUrl: string;
    let w: JobWorker | undefined;
    let workerId = '';
    const dirs: string[] = [];
    const prefix = `me${randomUUID().slice(0, 8)}`;

    async function stepUp(): Promise<void> {
      h.clock.advance(31_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function submit(over: Record<string, unknown> = {}): Promise<string> {
      const res = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec(over) });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ job: { id: string } }>().job.id;
    }

    const state = async (jobId: string): Promise<string> =>
      (await owner.req('GET', `/jobs/${jobId}`)).json<{ job: { state: string } }>().job.state;

    async function audits(action: string, jobId: string): Promise<Record<string, unknown>[]> {
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = $1 AND metadata->>'jobId' = $2 ORDER BY id`,
        [action, jobId],
      );
      return rows.map((r) => r.metadata);
    }

    beforeAll(async () => {
      const root = await tempDataDir(dirs);
      const { privateKey } = generateKeyPairSync('ed25519');
      const pem = join(root, 'skills-panel.pem');
      await writeFile(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      panel = await PanelSkillsKey.fromFile(pem);
      h = new Harness();
      await h.start({
        skills: { publicKeys: [], panelKey: panel },
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: prefix,
          tickIntervalMs: 50,
          timing: {
            leaseTtlMs: 3_600_000,
            reconnectGraceMs: 60_000,
            retryBackoffMs: 0,
            effectRetryAfterMs: 0,
          },
        },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
      fileUrl = await createBareRepo(dirs);
    });

    /** Pairs and starts the real worker (pairRealWorker uses expect.poll, which needs a running test). */
    async function startWorker(): Promise<JobWorker> {
      const dir = await tempDataDir(dirs);
      await stepUp();
      workerId = await pairRealWorker(h, url, owner, secret, dir);
      // The vault value as the worker's credential vault stores it (`vault-<id>`); the sealed delivery itself is covered
      // by vault-e2e.test.ts. The master only knows the credential id and that this worker holds it.
      await new FileSecretStore(createNodeFileOps(), dir).set(`vault-${CRED}`, VALUE);
      await h.db.pool.query(
        `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ($1, 'GitHub MCP token', 'generic', 'GH_MCP_E2E', 1, 'active', now(), now())`,
        [CRED],
      );
      await h.db.pool.query(
        `INSERT INTO vault_credential_workers (credential_id, worker_id, version, key_id, sealed, sealed_digest, state,
         acked_version, acked_at, ack_outcome, updated_at)
       VALUES ($1, $2, 1, $3, '{"sealed":true}', $4, 'active', 1, now(), 'applied', now())`,
        [CRED, workerId, 'k'.repeat(22), 'd'.repeat(64)],
      );
      w = await startJobWorker(url, dir, {
        fileUrl,
        fake: { script },
        features: ['mcp-v1'],
        mcp: { keys: [panel.publicKey] },
      });
      await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
      return w;
    }

    afterAll(async () => {
      await w?.stop().catch(() => undefined);
      await h.stop();
      await removeDirs(dirs);
    });

    it('a job on a real mcp-v1 worker: allow runs, ask → approval tool.mcp → approved, deny refused; audited', async () => {
      const wk = await startWorker();
      await stepUp();
      const pub = await owner.req('POST', '/mcp/servers', {
        id: 'github',
        title: 'GitHub',
        version: '1.0.0',
        transport: 'http',
        url: 'https://mcp.github.example.com/mcp',
        headers: { Authorization: { secret: 'token', format: 'Bearer {}' } },
        secrets: [{ slot: 'token', why: 'fine-grained PAT' }],
        runtimes: ['codex'],
      });
      expect(pub.statusCode, pub.body).toBe(201);
      await stepUp();
      expect(
        (
          await owner.req('PUT', '/mcp/servers/github/secrets', {
            bindings: [{ slot: 'token', credentialId: CRED }],
          })
        ).statusCode,
      ).toBe(200);
      await stepUp();
      expect(
        (
          await owner.req('PUT', '/mcp/servers/github/tool-policy', {
            rules: [
              { tool: 'list_*', effect: 'allow' },
              { tool: 'create_issue', effect: 'ask' },
              { tool: 'delete_repo', effect: 'deny' },
            ],
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await owner.req('PUT', '/mcp/assignments', { serverId: 'github', project: PROJECT })).statusCode,
      ).toBe(200);
      await stepUp();
      expect((await owner.req('PUT', `/projects/${PROJECT}/mcp`, { allowed: true })).statusCode).toBe(200);

      const jobId = await submit();
      // The ask call: an approval request with action tool.mcp, approved by an admin.
      let approvalId = '';
      await expect
        .poll(
          async () => {
            const res = await owner.req('GET', '/approvals?status=pending');
            const item = res
              .json<{ items: { id: string; jobId: string; action: string; summary: string }[] }>()
              .items.find((a) => a.jobId === jobId);
            approvalId = item?.id ?? '';
            return item?.action;
          },
          { timeout: 30_000 },
        )
        .toBe('tool.mcp');
      const detail = (await owner.req('GET', `/approvals/${approvalId}`)).json<{
        request: { summary: string; requestedAction: string; stepUp: boolean; risk: string };
      }>();
      expect(detail.request).toMatchObject({ requestedAction: 'tool.mcp', stepUp: false, risk: 'high' });
      expect(detail.request.summary).toContain('x-github/create_issue');
      const ok = await owner.req('POST', `/approvals/${approvalId}/approve`, {});
      expect(ok.statusCode, ok.body).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 30_000 }).toBe('SUCCEEDED');

      // The runtime got the server with the secret in its request header — and only there.
      const calls = wk.adapter.mcpCalls.filter((c) => c.server === 'github');
      expect(calls.map((c) => c.tool)).toEqual(['list_issues', 'create_issue']);
      expect(calls[0]).toMatchObject({
        url: 'https://mcp.github.example.com/mcp',
        headers: { Authorization: `Bearer ${VALUE}` },
      });

      // Call records (metadata only) and their audit rows.
      const view = (await owner.req('GET', `/jobs/${jobId}/mcp`)).json<{
        setHash: string;
        servers: { id: string; version: string; egressHosts: string[] }[];
        calls: { tool: string; decision: string; outcome: string }[];
      }>();
      expect(view.setHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(view.servers).toEqual([
        expect.objectContaining({ id: 'github', version: '1.0.0', egressHosts: ['mcp.github.example.com'] }),
      ]);
      expect(view.calls.map((c) => [c.tool, c.decision, c.outcome])).toEqual([
        ['list_issues', 'allow', 'ok'],
        ['create_issue', 'ask', 'ok'],
        ['delete_repo', 'deny', 'denied'],
      ]);
      const audited = await audits('mcp.tool.call', jobId);
      expect(audited.map((a) => [a.tool, a.decision, a.outcome])).toEqual([
        ['list_issues', 'allow', 'ok'],
        ['create_issue', 'ask', 'ok'],
        ['delete_repo', 'deny', 'denied'],
      ]);
      expect(await audits('mcp.issue', jobId)).toHaveLength(1);

      // The secret value is nowhere on the master side or in the worker's logs / job events.
      const events = await owner.req('GET', `/jobs/${jobId}/events`);
      expect(events.statusCode).toBe(200);
      expect(events.body).not.toContain(VALUE);
      expect(JSON.stringify(wk.lines)).not.toContain(VALUE);
      expect(h.logs.text).not.toContain(VALUE);
      const auditText = await h.db.pool.query<{ t: string }>(
        "SELECT coalesce(string_agg(metadata::text, ''), '') AS t FROM audit_events",
      );
      expect(auditText.rows[0]?.t).not.toContain(VALUE);
    });

    it('switch off → the next job gets no MCP; an untrusted-source job never does', async () => {
      await stepUp();
      expect((await owner.req('PUT', `/projects/${PROJECT}/mcp`, { allowed: false })).statusCode).toBe(200);
      const wk = w as JobWorker;
      const before = wk.adapter.mcpCalls.length;
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect((await owner.req('GET', `/jobs/${jobId}/mcp`)).json()).toMatchObject({
        setHash: 'none',
        skipped: 'project_switch_off',
        servers: [],
        // The runtime had no servers (its calls were refused); the worker forwards no call of an unpinned server.
        calls: [],
      });
      expect(wk.adapter.mcpCalls.length).toBe(before);

      await stepUp();
      expect((await owner.req('PUT', `/projects/${PROJECT}/mcp`, { allowed: true })).statusCode).toBe(200);
      const untrusted = await submit({ sourceTrust: 'untrusted', sandboxProfile: 'container' });
      expect(await h.app.mcp.issueForJob(untrusted, workerId)).toBeNull();
      expect((await owner.req('GET', `/jobs/${untrusted}/mcp`)).json()).toMatchObject({
        setHash: 'none',
        skipped: 'untrusted_source',
        servers: [],
      });
    });
  },
);
