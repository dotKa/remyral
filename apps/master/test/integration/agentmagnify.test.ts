import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { agentMagnifyUrlOk } from '../../src/integrations/agentmagnify.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p6-agentmagnify against a fake AgentMagnify API: session handshake with the bearer token, batches with
 * envelope fields and monotonic sequence, the job lifecycle mapping, metadata only, retry after an outage,
 * and alerts as blockers.
 */
const TOKEN = 'am-test-token-0123456789';
const PROMPT = 'PROMPT-CANARY use sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SYSTEM: JobActor = { type: 'system', id: 'reconciler' };

interface Captured {
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: { sessionId?: string; events?: Record<string, unknown>[] } & Record<string, unknown>;
}

describeIntegration('p6-agentmagnify forwarder (integration)', () => {
  const h = new Harness();
  const requests: Captured[] = [];
  let failBatches = 0;
  let server: Server;
  let jobs: JobStore;

  const read = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString('utf8')));
      req.on('end', () => {
        resolve(data);
      });
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void read(req).then((raw) => {
        const body = JSON.parse(raw) as Captured['body'];
        requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401).end('{"error":{"code":"UNAUTHORIZED"}}');
        } else if (req.url === '/v1/agent/sessions') {
          res
            .writeHead(201)
            .end(JSON.stringify({ sessionId: 'ses_fake_1', protocol: { version: '2026-07-31.1' } }));
        } else if (req.url === '/v1/events/batch') {
          if (failBatches > 0) {
            failBatches -= 1;
            res.writeHead(503).end('{}');
            return;
          }
          res.writeHead(200).end(
            JSON.stringify({
              results: (body.events ?? []).map((e) => ({ eventId: e.eventId, accepted: true })),
            }),
          );
        } else res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await h.start({
      agentmagnify: { apiUrl: `http://127.0.0.1:${String(port)}`, token: TOKEN, projectName: 'remyral-test' },
      // p22-ops-hygiene: the blocker resolves with the alert, at once here (no 15-min resolve hold).
      alerts: { resolveAfterMs: 0 },
    });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    await h.createUser('am-owner', 'quartz-meadow-lantern-7', 'owner');
  });
  afterAll(async () => {
    await h.stop();
    await new Promise<void>((r) => {
      server.close(() => {
        r();
      });
    });
  });

  const events = () =>
    requests.filter((r) => r.path === '/v1/events/batch').flatMap((r) => r.body.events ?? []);

  it('is disabled by default and only accepts https or loopback http URLs', () => {
    expect(agentMagnifyUrlOk('https://api.agentmagnify.example/')).toBe(true);
    expect(agentMagnifyUrlOk('http://127.0.0.1:8080')).toBe(true);
    expect(agentMagnifyUrlOk('http://agentmagnify.example')).toBe(false);
    expect(agentMagnifyUrlOk('https://user:pw@agentmagnify.example')).toBe(false);
  });

  it('forwards the job lifecycle as task events with metadata only, retrying after an outage', async () => {
    const am = h.app.agentmagnify;
    if (am === null) throw new Error('forwarder not wired');
    const spec = {
      runtime: 'pi',
      prompt: PROMPT,
      repository: { url: 'https://example.com/acme/secret-repo.git', baseRef: 'main', workBranch: 'rac/am' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    };
    const ok = (await jobs.create({ project: 'alpha', spec, actor: CREATOR, submit: true })).job.id;
    const { lease } = await jobs.acquireLease(ok, 'wrk_cccccccccccccccccccccccccc', 3_600_000);
    const w: JobActor = { type: 'worker', id: 'wrk_cccccccccccccccccccccccccc' };
    await jobs.transition(ok, 'lease_acked', { actor: w, epoch: lease.epoch });
    await jobs.transition(ok, 'runtime_started', { actor: w, epoch: lease.epoch });
    await jobs.transition(ok, 'run_finished', { actor: w, epoch: lease.epoch });
    await jobs.transition(ok, 'verification_passed', { actor: SYSTEM });
    await jobs.transition(ok, 'approval_granted', { actor: CREATOR });

    failBatches = 1; // API outage: nothing is lost
    expect(await am.runOnce()).toBe(0);
    expect(am.stats.queued).toBeGreaterThan(0);
    const sent = await am.runOnce();
    expect(sent).toBe(am.stats.sent);

    const session = requests.find((r) => r.path === '/v1/agent/sessions');
    expect(session?.auth).toBe(`Bearer ${TOKEN}`);
    expect(session?.body).toMatchObject({ executor: { type: 'custom' }, project: { name: 'remyral-test' } });
    const ev = events().filter((e) => (e.metadata as { jobId?: string }).jobId === ok);
    const types = [...new Set(ev.map((e) => e.type))];
    expect(types).toEqual(
      expect.arrayContaining([
        'task.created',
        'task.assigned',
        'task.started',
        'task.progress',
        'task.completed',
      ]),
    );
    for (const e of ev) {
      expect(e).toMatchObject({ sessionId: 'ses_fake_1', protocolVersion: '2026-07-31.1' });
      expect(String(e.eventId)).toMatch(/^rac-t-\d+$/);
      expect(e.task).toMatchObject({ id: `job-${ok}` });
    }
    expect(ev.find((e) => e.type === 'task.started')?.reporter).toMatchObject({
      agentId: 'wrk_cccccccccccccccccccccccccc',
      kind: 'logical',
    });
    expect(ev.find((e) => e.type === 'task.completed')?.verification).toMatchObject({ result: 'passed' });
    // Sequence is monotonic within the session (the retried batch got fresh numbers).
    const seqs = events().map((e) => Number(e.sequence));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const wire = JSON.stringify(requests);
    expect(wire).not.toContain('PROMPT-CANARY');
    expect(wire).not.toContain('sk-ant-');
    expect(wire).not.toContain('secret-repo');
  });

  it('forwards alarms as blockers (created → resolved)', async () => {
    const am = h.app.agentmagnify;
    if (am === null) throw new Error('forwarder not wired');
    const spec = {
      runtime: 'pi',
      prompt: PROMPT,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/am2' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    };
    const id = (await jobs.create({ project: 'alpha', spec, actor: CREATOR, submit: true })).job.id;
    h.clock.advance(6 * 60_000);
    await h.app.alerts.evaluate();
    await jobs.acquireLease(id, 'w-x', 3_600_000);
    await h.app.alerts.evaluate();
    await am.runOnce();
    const blockers = events().filter((e) => String(e.type).startsWith('blocker.'));
    expect(blockers.map((e) => e.type)).toEqual(['blocker.created', 'blocker.resolved']);
    expect(blockers[0]?.blocker).toMatchObject({ id: 'alert-queue.backlog-global', severity: 'high' });
  });
});
