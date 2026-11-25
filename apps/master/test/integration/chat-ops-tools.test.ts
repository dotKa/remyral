import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller, type ToolOutcome } from '../../src/chat/tools.js';
import { JobStore } from '../../src/jobs/index.js';
import { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { clearArchiveIndexCache } from '../../src/workspaces/full-archive.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p18-assistant-gaps (docs/design/p18-assistant-gaps.md) against a real master (Postgres, engine 2, blob store, the
 * host applier's directory): the new read tools answer with the caller's permissions, capped and redacted (job outputs
 * with the files of out-rest.zip, a workflow run with its waiting approval); the new draft tools make administration
 * cards that the console's confirmation runs through the same services as the screens (workflow approval decided once,
 * run cancelled, a backup and a restore as host requests — the restore card-only —, a template from a job, a monitor
 * paused, a job agent's question answered, the cost brake lifted), each audited with `source: chat`.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'gap-alpha';
const WS = 'gap-ws';
const OTHER = 'gap-other';
const WORKER = 'wrk-gap-1';
const CANARY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const BACKUP = 'remana-prod-20261027T023000Z';
const keys = generateKeyPairSync('ed25519');
const signer = new LeaseSigner(keys.privateKey);
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/gap.git', baseRef: 'main' },
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A zip in the worker's overflow format (deflate, sizes in the local headers, central directory). */
function makeZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describeIntegration('assistant ops tools (integration, p18-assistant-gaps)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let hostDir: string;
  let statusDir: string;
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let operator: Client;
  let operatorSecret = '';
  let operatorId = '';
  let viewerId = '';
  let outsiderId = '';
  let adminId = '';
  let store: ChatStore;
  let tools: ChatTools;
  let jobs: JobStore;

  const stepUp = async (c: Client, secret: string): Promise<void> => {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  };
  const caller = async (
    id: string,
    role: 'owner' | 'admin' | 'operator' | 'viewer',
  ): Promise<ToolCaller> => ({
    userId: id,
    subject: await loadSubject(h.db.pool, { id, role }),
    threadId: (await store.createThread(id, 'ops tools')).id,
    turnId: randomUUID(),
    opsTools: true,
  });
  const data = (o: ToolOutcome): Record<string, unknown> => {
    expect(o.ok, JSON.stringify(o)).toBe(true);
    return (o.ok ? o.data : {}) as Record<string, unknown>;
  };
  const confirm = async (c: Client, o: ToolOutcome) => {
    expect(o.ok, JSON.stringify(o)).toBe(true);
    const id = o.ok ? (o.draft?.id ?? '') : '';
    return c.req('POST', `/chat/drafts/${id}/confirm`, {});
  };
  const audits = async (action: string) =>
    (
      await h.db.pool.query<{ actor_id: string; outcome: string; metadata: Record<string, unknown> }>(
        'SELECT actor_id, outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      )
    ).rows;
  const heartbeat = async () => {
    await writeFile(
      join(hostDir, 'status/applier.json'),
      `${JSON.stringify({
        kind: 'remyral-host-applier/v1',
        version: '1.1.0',
        at: h.clock.now().toISOString(),
        domain: 'console.example.com',
        tls: 'letsencrypt',
        acmeEmail: '',
        httpsPort: '',
        addresses: [],
        kinds: ['upgrade', 'rollback', 'backup-run', 'backup-drill', 'backup-restore', 'backup-config'],
        current: '1.1.0',
        previous: '',
        releases: ['1.1.0'],
        backup: { recipients: [], offsite: '', PG_WAL_ARCHIVE: 'off' },
      })}\n`,
    );
  };

  beforeAll(async () => {
    hostDir = await mkdtemp(join(tmpdir(), 'remyral-gap-host-'));
    statusDir = await mkdtemp(join(tmpdir(), 'remyral-gap-status-'));
    await mkdir(join(hostDir, 'requests'));
    await mkdir(join(hostDir, 'status'));
    const at = new Date(Date.parse('2026-10-27T03:00:00.000Z')).toISOString();
    await writeFile(
      join(statusDir, 'status.json'),
      JSON.stringify({
        format: 'remana-backup-status/v1',
        env: 'prod',
        updatedAt: at,
        lastBackup: null,
        lastSuccessfulBackup: null,
        backups: [
          {
            runId: BACKUP,
            reason: 'scheduled',
            startedAt: at,
            finishedAt: at,
            durationMs: 4000,
            outcome: 'ok',
            tier: 'daily',
            schemaVersion: '0181',
            dbBytes: 1024,
            dbSha256: 'a'.repeat(64),
            secrets: 'ok',
            offsite: { status: 'not_configured', target: null, error: null },
            warnings: [],
            error: null,
          },
        ],
        lastDrill: null,
        lastSuccessfulDrill: null,
        drills: [],
      }),
    );
    await h.start({
      orchestration: { tickIntervalMs: 0, signer, workflowEngine: { v2: true, v2ForV1: false } },
      consoleDomain: { hostDir },
      backups: { statusDir },
    });
    ownerId = await h.createUser('owner1', PW);
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    adminId = await h.createUser('admin1', PW, 'admin');
    operatorId = await h.createUser('op1', PW, 'operator');
    await h.grant(operatorId, [PROJECT, WS], 'operator');
    operatorSecret = (await enroll(h, 'op1', PW)).secret;
    operator = await fullLogin(h, 'op1', PW, operatorSecret);
    viewerId = await h.createUser('view1', PW, 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    outsiderId = await h.createUser('out1', PW, 'operator');
    await h.grant(outsiderId, [OTHER], 'operator');
    await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [WS]);
    await h.db.pool.query(
      `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'none', now()) ON CONFLICT DO NOTHING`,
      [WS],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    const app = h.app;
    tools = new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      opsTools: () => app.chatOpsTools,
      admin: () => app.chatAdmin,
    } as unknown as ChatToolsDeps);
    clearArchiveIndexCache();
  });
  afterAll(async () => {
    await h.stop();
    await rm(hostDir, { recursive: true, force: true });
    await rm(statusDir, { recursive: true, force: true });
  });

  async function newJob(project: string, title: string, by = ownerId): Promise<string> {
    const { job } = await jobs.create({
      project,
      actor: { type: 'user', id: by },
      submit: true,
      spec: {
        runtime: 'codex',
        title,
        prompt: `${title}: summarise {{topic}} for the team`,
        // A repository project needs a repository (no git config is registered here); a workspace project none.
        ...(project === WS
          ? {}
          : {
              repository: {
                url: 'https://example.com/acme/gap.git',
                baseRef: 'main',
                workBranch: `w/${title}`,
              },
            }),
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    return job.id;
  }

  describe('job outputs: all files, the overflow zip, text by path, binaries as metadata', () => {
    let jobId = '';
    let mdId = '';
    let pngId = '';
    const md = Buffer.from(`# Report\n\nline one\ntoken ${CANARY}\n${'x'.repeat(5000)}\nend ğüş\n`);
    const nested = Buffer.from('inside the overflow zip\n');

    beforeAll(async () => {
      jobId = await newJob(WS, 'Outputs job');
      const zip = makeZip([
        { name: 'nested/deep/b.txt', data: nested },
        { name: 'nested/c.csv', data: Buffer.from('a,b\n') },
      ]);
      const attemptId = randomUUID();
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, outcome, started_at, ended_at)
         VALUES ($1, $2, 1, $3, 'ended', 'succeeded', $4, $4)`,
        [attemptId, jobId, WORKER, now],
      );
      await h.db.pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, result_outcome, result, result_received_at, created_at,
                               updated_at)
         VALUES ($1, $2, $3, 'succeeded', $4, $5, $5, $5)`,
        [
          attemptId,
          jobId,
          WORKER,
          JSON.stringify({
            summary: 'Done.',
            outputs: {
              maxFiles: 3,
              returned: 3,
              storage: true,
              zip: { name: 'out-rest.zip', files: 2, bytes: zip.length },
              skipped: [{ name: 'huge.bin', code: 'too_large', reason: 'over the size limit' }],
              skippedCount: 1,
            },
          }),
          now,
        ],
      );
      const add = async (name: string, body: Buffer, mediaType: string, blob = false): Promise<string> => {
        const artifactId = `ws-o${createHash('md5').update(name).digest('hex').slice(0, 16)}`;
        const blobKey = blob
          ? await h.app.blobs.write('artifact', `artifacts/${jobId}/${attemptId}/${artifactId}`, body)
          : null;
        await h.db.pool.query(
          `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                      redacted, content, blob_key, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, $9, $10)`,
          [
            attemptId,
            jobId,
            artifactId,
            name,
            mediaType,
            body.length,
            sha(body),
            blob ? null : body,
            blobKey,
            now,
          ],
        );
        return artifactId;
      };
      mdId = await add('reports/summary.md', md, 'text/markdown', true);
      pngId = await add('img/chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]), 'image/png');
      await add('out-rest.zip', zip, 'application/zip', true);
    });

    it('list_job_outputs: every file with the zip members, filters, paging, the report; only for readers', async () => {
      const op = await caller(operatorId, 'operator');
      const all = data(await tools.run(op, 'list_job_outputs', { jobId, limit: 2 }));
      expect(all.total).toBe(5);
      expect(all.inZip).toBe(2);
      expect(all.nextOffset).toBe(2);
      expect(all.report).toMatchObject({ zip: { name: 'out-rest.zip' }, notReturned: 1 });
      const rest = data(await tools.run(op, 'list_job_outputs', { jobId, offset: 2, limit: 10 }));
      expect((rest.files as { path: string }[]).map((f) => f.path)).toEqual(
        expect.arrayContaining(['nested/deep/b.txt', 'nested/c.csv']),
      );
      const deep = data(await tools.run(op, 'list_job_outputs', { jobId, glob: '**/*.txt' }));
      expect(deep.files).toEqual([{ path: 'nested/deep/b.txt', size: nested.length, inZip: true }]);
      const reports = data(await tools.run(op, 'list_job_outputs', { jobId, prefix: 'reports/' }));
      expect((reports.files as { artifactId: string }[]).map((f) => f.artifactId)).toEqual([mdId]);
      const outsider = await caller(outsiderId, 'operator');
      expect(await tools.run(outsider, 'list_job_outputs', { jobId })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    });

    it('read_job_output: a window of text, redacted, with nextOffset; a zip member by path; a binary as metadata', async () => {
      const op = await caller(operatorId, 'operator');
      const first = data(await tools.run(op, 'read_job_output', { jobId, artifactId: mdId, limit: 4000 }));
      expect(String(first.content)).toContain('line one');
      expect(String(first.content)).not.toContain(CANARY);
      expect(first.nextOffset).toBe(4000);
      const tail = data(
        await tools.run(op, 'read_job_output', { jobId, path: 'reports/summary.md', offset: md.length - 20 }),
      );
      expect(String(tail.content)).toContain('end ğüş');
      expect(tail.nextOffset).toBeNull();
      const zipped = data(await tools.run(op, 'read_job_output', { jobId, path: 'nested/deep/b.txt' }));
      expect(zipped).toMatchObject({ content: 'inside the overflow zip\n', inZip: 'out-rest.zip' });
      const png = data(await tools.run(op, 'read_job_output', { jobId, artifactId: pngId }));
      expect(png).toMatchObject({ binary: true, content: null, mediaType: 'image/png' });
      expect(await tools.run(op, 'read_job_output', { jobId, path: 'missing.txt' })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
    });
  });

  describe('workflow runs: describe, decide a waiting approval once, cancel', () => {
    async function define(name: string): Promise<string> {
      const res = await owner.req('POST', '/workflows', {
        project: PROJECT,
        definition: {
          schemaVersion: 2,
          name,
          defaults: DEFAULTS,
          nodes: [
            { id: 'ask', type: 'control.approval', config: { approverRole: 'operator', title: 'Ship it?' } },
            { id: 'yes', type: 'data.set', config: { fields: { shipped: true } } },
          ],
          edges: [{ from: 'ask', fromPort: 'approved', to: 'yes' }],
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    async function start(id: string): Promise<string> {
      const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<{ runId: string }>().runId;
      for (let i = 0; i < 3; i++) await h.app.workflows.progress();
      return runId;
    }

    it('describe_workflow_run names the waiting approval; the operator decides it once through the card', async () => {
      const runId = await start(await define('ship'));
      const op = await caller(operatorId, 'operator');
      const view = data(await tools.run(op, 'describe_workflow_run', { runId }));
      expect(view).toMatchObject({ workflow: 'ship', project: PROJECT, link: `/jobs/workflows/${runId}` });
      const approvals = view.approvals as { nodeRunId: string; node: string; canDecide: boolean }[];
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ node: 'ask', canDecide: true });
      const nodeRunId = approvals[0]?.nodeRunId ?? '';
      // Readers see it but may not decide; other projects do not see the run at all.
      const viewer = await caller(viewerId, 'viewer');
      expect(data(await tools.run(viewer, 'describe_workflow_run', { runId })).approvals).toEqual([
        expect.objectContaining({ canDecide: false }),
      ]);
      expect(
        await tools.run(viewer, 'draft_workflow_approval_decision', {
          runId,
          nodeRunId,
          decision: 'approve',
        }),
      ).toMatchObject({ ok: false, code: 'forbidden' });
      const outsider = await caller(outsiderId, 'operator');
      expect(await tools.run(outsider, 'describe_workflow_run', { runId })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      const card = await tools.run(op, 'draft_workflow_approval_decision', {
        runId,
        nodeRunId,
        decision: 'approve',
        reason: 'looks good',
      });
      expect(card.ok && card.draft?.payload).toMatchObject({
        target: 'admin',
        op: 'workflow.decide_node',
        event: 'approvals.decide',
        node: 'ask',
        project: PROJECT,
      });
      await stepUp(operator, operatorSecret);
      const done = await confirm(operator, card);
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json<{ result: Record<string, unknown> }>().result).toMatchObject({
        op: 'workflow.decide_node',
        via: 'card',
        decision: 'approve',
      });
      // One decision wins: the step is decided now.
      expect(
        await tools.run(op, 'draft_workflow_approval_decision', { runId, nodeRunId, decision: 'deny' }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      const gate = await audits('workflow.gate.approve');
      expect(gate.at(-1)).toMatchObject({ actor_id: operatorId, outcome: 'success' });
    });

    it('draft_workflow_run_cancel cancels an open run; an ended run is reported', async () => {
      const runId = await start(await define('hold'));
      const op = await caller(operatorId, 'operator');
      const card = await tools.run(op, 'draft_workflow_run_cancel', { runId, reason: 'not needed' });
      const res = await confirm(operator, card);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ result: Record<string, unknown> }>().result).toMatchObject({ state: 'cancelled' });
      expect(await tools.run(op, 'draft_workflow_run_cancel', { runId, reason: 'again' })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
      const viewer = await caller(viewerId, 'viewer');
      expect(await tools.run(viewer, 'draft_workflow_run_cancel', { runId, reason: 'x' })).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
    });
  });

  describe('backups and the control-plane update (owners, through the host applier)', () => {
    it('without an applier the tool says so; owners only', async () => {
      const own = await caller(ownerId, 'owner');
      const r = await tools.run(own, 'draft_backup_action', { action: 'run' });
      expect(r).toMatchObject({ ok: false, code: 'unavailable' });
      expect(r.ok ? '' : r.message).toMatch(/remyral-backup run/);
      const adm = await caller(adminId, 'admin');
      expect(await tools.run(adm, 'draft_backup_action', { action: 'run' })).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
      expect(await tools.run(adm, 'draft_control_plane_update', {})).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
    });

    it('a backup now is a host request; a restore is card-only and needs the backup id; describe_backups shows them', async () => {
      await heartbeat();
      const own = await caller(ownerId, 'owner');
      const run = await tools.run(own, 'draft_backup_action', { action: 'run', reason: 'before the update' });
      expect(run.ok && run.draft?.payload).toMatchObject({ op: 'backup.run', event: 'backups.manage' });
      await stepUp(owner, ownerSecret);
      const ok = await confirm(owner, run);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json<{ result: Record<string, unknown> }>().result).toMatchObject({
        op: 'backup.run',
        kind: 'backup-run',
        state: 'pending',
      });
      expect(existsSync(join(hostDir, 'requests/backup-run.json'))).toBe(true);
      expect((await audits('host.backup-run.request')).at(-1)?.metadata).toMatchObject({
        reason: 'before the update',
        source: 'chat',
      });
      const desc = await h.app.chatAdmin.read(own.subject, 'describe_backups', {}, { opsTools: true });
      expect(desc.ok && (desc.data as Record<string, unknown>).openRequest).toMatchObject({
        kind: 'backup-run',
      });
      expect(desc.ok && String((desc.data as Record<string, unknown>).actions)).toContain(
        'draft_backup_action',
      );
      const old = await h.app.chatAdmin.read(own.subject, 'describe_backups', {});
      expect(old.ok && String((old.data as Record<string, unknown>).actions)).not.toContain(
        'draft_backup_action',
      );

      expect(await tools.run(own, 'draft_backup_action', { action: 'restore' })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
      const restore = await tools.run(own, 'draft_backup_action', { action: 'restore', backupId: BACKUP });
      expect(restore.ok && restore.draft?.payload).toMatchObject({
        op: 'backup.restore',
        cardOnly: 'always',
        event: 'backups.restore',
        backupId: BACKUP,
      });
      expect(restore.ok && (restore.data as Record<string, unknown>).cardOnly).toMatch(/Always a card/);
    });
  });

  describe('templates, monitors, job questions and the cost brake', () => {
    it('draft_template_from_job saves the job’s prompt as a template of its project', async () => {
      const jobId = await newJob(PROJECT, 'Digest job', operatorId);
      const op = await caller(operatorId, 'operator');
      const card = await tools.run(op, 'draft_template_from_job', { jobId, title: 'Weekly digest' });
      expect(card.ok && card.draft?.payload).toMatchObject({ op: 'template.from_job', project: PROJECT });
      const res = await confirm(operator, card);
      expect(res.statusCode, res.body).toBe(200);
      const templateId = String(res.json<{ result: Record<string, unknown> }>().result.templateId);
      const t = await h.db.pool.query<{ title: string; project: string }>(
        'SELECT title, project FROM job_templates WHERE id = $1',
        [templateId],
      );
      expect(t.rows[0]).toEqual({ title: 'Weekly digest', project: PROJECT });
      const viewer = await caller(viewerId, 'viewer');
      expect(await tools.run(viewer, 'draft_template_from_job', { jobId })).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
    });

    it('a monitor is paused through the card; uptime_history reads it', async () => {
      const m = await h.app.uptime.create(
        { type: 'user', id: ownerId },
        { project: PROJECT, name: 'shop', type: 'tcp', config: { host: 'shop.example.com', port: 443 } },
      );
      const op = await caller(operatorId, 'operator');
      const hist = data(await tools.run(op, 'uptime_history', { monitorId: m.id, range: '7d' }));
      expect(hist).toMatchObject({ monitorId: m.id, name: 'shop', incidents: [], series: { range: '7d' } });
      const card = await tools.run(op, 'draft_monitor_change', { monitorId: m.id, action: 'pause' });
      const res = await confirm(operator, card);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ result: Record<string, unknown> }>().result).toMatchObject({ paused: true });
      expect(await tools.run(op, 'draft_monitor_change', { monitorId: m.id, action: 'pause' })).toMatchObject(
        {
          ok: false,
          code: 'invalid',
        },
      );
    });

    it('a job agent’s question is answered with the user’s answer, once', async () => {
      const jobId = await newJob(PROJECT, 'Question job', operatorId);
      const qid = randomUUID();
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO user_questions (id, source, job_id, attempt_id, request_id, project, title, questions, state,
                                     created_at, deadline_at)
         VALUES ($1, 'job', $2, $3, $4, $5, 'Target', $6, 'pending', $7, $8)`,
        [
          qid,
          jobId,
          randomUUID(),
          randomUUID(),
          PROJECT,
          JSON.stringify({
            v: 1,
            questions: [
              {
                id: 'env',
                prompt: 'Which environment?',
                kind: 'single',
                options: [{ label: 'preview' }, { label: 'production' }],
              },
            ],
          }),
          now,
          new Date(now.getTime() + 3_600_000),
        ],
      );
      const op = await caller(operatorId, 'operator');
      expect(
        await tools.run(op, 'draft_job_question_answer', {
          jobId,
          questionId: qid,
          answers: [{ id: 'nope', text: 'x' }],
        }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      const card = await tools.run(op, 'draft_job_question_answer', {
        jobId,
        questionId: qid,
        answers: [{ id: 'env', choices: ['production'] }],
      });
      const res = await confirm(operator, card);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ result: Record<string, unknown> }>().result).toMatchObject({ state: 'answered' });
      expect(
        await tools.run(op, 'draft_job_question_answer', {
          jobId,
          questionId: qid,
          answers: [{ id: 'env', choices: ['preview'] }],
        }),
      ).toMatchObject({ ok: false, code: 'invalid' });
      expect((await audits('job.question.answer')).at(-1)).toMatchObject({ actor_id: operatorId });
    });

    it('the cost brake is lifted for some hours by an owner only', async () => {
      const op = await caller(operatorId, 'operator');
      expect(
        await tools.run(op, 'draft_cost_brake', {
          action: 'lift',
          scope: 'global',
          hours: 2,
          reason: 'demo',
        }),
      ).toMatchObject({ ok: false, code: 'forbidden' });
      const own = await caller(ownerId, 'owner');
      const card = await tools.run(own, 'draft_cost_brake', {
        action: 'lift',
        scope: PROJECT,
        hours: 2,
        reason: 'demo day',
      });
      expect(card.ok && card.draft?.payload).toMatchObject({
        op: 'cost_brake.lift',
        event: 'limits.budgets',
      });
      await stepUp(owner, ownerSecret);
      const res = await confirm(owner, card);
      expect(res.statusCode, res.body).toBe(200);
      const lifts = (await h.app.opsSafety.brake.compute()).lifts;
      expect(lifts.map((l) => l.scope)).toContain(PROJECT);
    });

    it('memory_review, list_output_library and weekly_reports answer for the caller', async () => {
      const op = await caller(operatorId, 'operator');
      expect(data(await tools.run(op, 'memory_review', { project: PROJECT }))).toMatchObject({
        conflicts: [],
        reviewDue: [],
      });
      const outsider = await caller(outsiderId, 'operator');
      expect(await tools.run(outsider, 'memory_review', { project: PROJECT })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(data(await tools.run(op, 'list_output_library', { project: WS, type: 'file' }))).toMatchObject({
        folders: [],
      });
      expect(await tools.run(outsider, 'list_output_library', { project: WS })).toMatchObject({
        ok: false,
        code: 'not_found',
      });
      expect(data(await tools.run(op, 'weekly_reports', {}))).toMatchObject({ reports: [] });
    });
  });
});
