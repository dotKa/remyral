import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatInputUploads } from '../../src/chat/input-uploads.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps, type ToolCaller } from '../../src/chat/tools.js';
import { bundleSha256 } from '../../src/input-uploads/index.js';
import { JobStore } from '../../src/jobs/index.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060) against a real master (Postgres, Redis hints) and real
 * job workers (fake runtime): a .zip's files uploaded as a job input bundle (chunked like a site upload; the browser's
 * part is done here through the same API), the master's checks (caps, path rules, executables by magic bytes and the
 * security policy's override, secret findings with the audited "send anyway"), POST /jobs and draft_job `inputUpload`,
 * placement only on `input-bundle-v1` workers, the worker pulling the files into in/ (workspace) or a scratch in/ next to
 * the checkout (repository, never committed), the lease-checked relay (stale epoch refused and audited) and retention.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 9;
const WS = 'genel';
const OTHER = 'zipother';
const MiB = 1024 * 1024;
const DAY = 86_400_000;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type F = { path: string; content: Buffer };
interface Upload {
  id: string;
  state: string;
  project: string;
  fileCount: number;
  totalBytes: number;
  partSize: number;
  partCount: number;
  bundleSha256: string;
  keptUntil: string | null;
  secretFindings: { path: string; rule: string; line: number }[];
  sentWithSecrets: boolean;
  files: { path: string; size: number; sha256: string }[] | null;
}
interface Refused {
  error: string;
  message: string;
  refused?: { path: string; reason: string }[];
  findings?: { path: string; rule: string; line: number }[];
}

/** A big file that spans several 64 KiB parts. */
const BIG = Buffer.alloc(150_000, 0x61);
const TREE = (): F[] => [
  { path: 'src/main.ts', content: Buffer.from('export const answer = 42;\n') },
  { path: 'src/big.txt', content: BIG },
  { path: '.gitignore', content: Buffer.from('dist/\n') },
  { path: 'docs/Sunum çalışması.md', content: Buffer.from('# Sunum\n') },
  { path: 'data/empty.csv', content: Buffer.alloc(0) },
  // Nested archives are stored as files, never extracted.
  { path: 'vendor/lib.zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) },
];
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(120, 0)]);
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2).slice(0, 36)}`;

describeIntegration(
  'job input bundles from a .zip (integration, p16-zip-job-input)',
  { timeout: 240_000 },
  () => {
    let h: Harness;
    let url = '';
    let fileUrl = '';
    let owner: Client;
    let ownerId = '';
    let ownerSecret = '';
    let operator: Client;
    let operatorId = '';
    let viewer: Client;
    let outsider: Client;
    let jobs: JobStore;
    const dirs: string[] = [];
    const workers: JobWorker[] = [];
    let raw: RawWorker | null = null;
    let rawId = '';
    let treeId = '';

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) })).statusCode).toBe(200);
    }

    function start(
      c: Client,
      project: string,
      files: (F | { path: string; size: number; sha256: string })[],
      partSize?: number,
    ) {
      return c.req('POST', `/projects/${project}/input-uploads`, {
        files: files.map((f) =>
          'content' in f ? { path: f.path, size: f.content.length, sha256: sha(f.content) } : f,
        ),
        label: 'proje.zip',
        ...(partSize === undefined ? {} : { partSize }),
      });
    }

    async function sendParts(c: Client, project: string, up: Upload, files: F[]): Promise<void> {
      const all = Buffer.concat(files.map((f) => f.content));
      for (let n = 0; n < up.partCount; n++) {
        const part = all.subarray(n * up.partSize, (n + 1) * up.partSize);
        const r = await c.req('PUT', `/projects/${project}/input-uploads/${up.id}/parts/${String(n)}`, part, {
          'content-type': 'application/octet-stream',
          'x-part-sha256': sha(part),
        });
        expect(r.statusCode, r.body).toBe(200);
      }
    }

    /** Start → parts → complete (what the chip does after unpacking). */
    async function upload(c: Client, project: string, files: F[], partSize?: number) {
      const s = await start(c, project, files, partSize);
      expect(s.statusCode, s.body).toBe(201);
      const up = s.json<Upload>();
      await sendParts(c, project, up, files);
      return { up, done: await c.req('POST', `/projects/${project}/input-uploads/${up.id}/complete`, {}) };
    }

    async function state(c: Client, id: string): Promise<string> {
      const d = (await c.req('GET', `/jobs/${id}`)).json<{
        job: { state: string };
        orchestration?: { schedule: { reasons: { code: string }[] } | null };
      }>();
      if (d.job.state === 'QUEUED' && d.orchestration?.schedule) {
        return `QUEUED ${JSON.stringify(d.orchestration.schedule.reasons.map((r) => r.code))}`;
      }
      return d.job.state;
    }

    async function newWorker(
      opts: Partial<Parameters<typeof startJobWorker>[2]>,
    ): Promise<{ id: string; w: JobWorker }> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, owner, ownerSecret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, ...opts });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return { id, w };
    }

    const wsSpec = (prompt = 'Bu dosyalarla bir rapor hazırla') => ({
      runtime: 'codex',
      prompt,
      sandboxProfile: 'host-restricted',
      sourceTrust: 'trusted',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
    });

    beforeAll(async () => {
      h = new Harness(Date.now());
      await h.start({
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: `t${randomUUID().slice(0, 8)}`,
          tickIntervalMs: 50,
          timing: {
            leaseTtlMs: 3_600_000,
            reconnectGraceMs: 7_200_000,
            retryBackoffMs: 0,
            effectRetryAfterMs: 0,
          },
        },
      });
      url = await h.listen();
      fileUrl = await createBareRepo(dirs);
      jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      ownerId = await h.createUser('owner1', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      for (const p of [PROJECT, OTHER]) {
        await h.db.pool.query(
          'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
          [p],
        );
      }
      operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [WS, PROJECT], 'operator');
      operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
      const vw = await h.createUser('view1', PW, 'viewer');
      await h.grant(vw, [WS], 'viewer');
      viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
      const out = await h.createUser('oper2', PW, 'operator');
      await h.grant(out, [OTHER], 'operator');
      outsider = await fullLogin(h, 'oper2', PW, (await enroll(h, 'oper2', PW)).secret);
    });
    afterAll(async () => {
      raw?.close();
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      await h.stop();
      await removeDirs(dirs);
    });

    it('only people who may create jobs in the project upload; viewers read; CSRF is required', async () => {
      const files = [{ path: 'a.txt', content: Buffer.from('x') }];
      expect((await start(viewer, WS, files)).statusCode).toBe(403);
      expect((await start(outsider, WS, files)).statusCode).toBe(404);
      const noCsrf = operator.clone();
      noCsrf.sendCsrf = false;
      expect((await start(noCsrf, WS, files)).statusCode).toBe(403);
      expect((await viewer.req('GET', `/projects/${WS}/input-uploads`)).statusCode).toBe(200);
      expect((await outsider.req('GET', `/projects/${WS}/input-uploads`)).statusCode).toBe(404);
    });

    it('refuses unsafe paths, collisions, oversized files, executables by extension and too much in total — before any byte', async () => {
      const s = 'a'.repeat(64);
      const res = await start(operator, WS, [
        { path: 'ok.txt', size: 1, sha256: s },
        { path: '../escape.txt', size: 1, sha256: s },
        { path: '/abs.txt', size: 1, sha256: s },
        { path: 'a\\b.txt', size: 1, sha256: s },
        { path: '.git/config', size: 1, sha256: s },
        { path: 'con.txt', size: 1, sha256: s },
        { path: 'Readme.md', size: 1, sha256: s },
        { path: 'README.md', size: 1, sha256: s },
        { path: 'huge.bin', size: 25 * MiB + 1, sha256: s },
        { path: 'setup.exe', size: 10, sha256: s },
      ]);
      expect(res.statusCode, res.body).toBe(400);
      const body = res.json<Refused>();
      expect(body.error).toBe('input_refused');
      const reasons = Object.fromEntries((body.refused ?? []).map((r) => [r.path, r.reason]));
      expect(reasons).toMatchObject({
        '../escape.txt': 'unsafe path segment',
        '/abs.txt': 'not a relative path',
        'a\\b.txt': 'not a relative path',
        '.git/config': 'git metadata folder',
        'con.txt': 'reserved device name',
        'README.md': expect.stringMatching(/listed twice/) as unknown,
        'huge.bin': 'larger than 25 MiB',
        'setup.exe': expect.stringMatching(/executables are not allowed/) as unknown,
      });
      expect(reasons['ok.txt']).toBeUndefined();
      const total = await start(
        operator,
        WS,
        Array.from({ length: 5 }, (_, i) => ({ path: `p${String(i)}.bin`, size: 25 * MiB, sha256: s })),
      );
      expect(total.json<Refused>().message).toMatch(/at most 100 MiB/);
      const many = await start(
        operator,
        WS,
        Array.from({ length: 2001 }, (_, i) => ({ path: `f${String(i)}.txt`, size: 1, sha256: s })),
      );
      expect(many.statusCode).toBe(400);
      const audit = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'input.upload.start' AND outcome = 'denied'`,
      );
      expect(audit.rowCount).toBeGreaterThan(0);
    });

    it('stores a source tree across parts (hidden files, Unicode names, an empty file, a nested zip); bytes never served', async () => {
      const files = TREE();
      const { up, done } = await upload(operator, WS, files, 64 * 1024);
      expect(up.partCount).toBeGreaterThan(2);
      expect(done.statusCode, done.body).toBe(200);
      const ready = done.json<Upload>();
      treeId = ready.id;
      expect(ready).toMatchObject({
        state: 'ready',
        fileCount: files.length,
        sentWithSecrets: false,
        secretFindings: [],
      });
      expect(ready.bundleSha256).toBe(
        bundleSha256(files.map((f) => ({ path: f.path, sha256: sha(f.content) }))),
      );
      expect(ready.files?.map((f) => f.path)).toEqual(files.map((f) => f.path));
      expect(Date.parse(ready.keptUntil ?? '') - h.clock.now().getTime()).toBeGreaterThan(13 * DAY);
      const got = await viewer.req('GET', `/projects/${WS}/input-uploads/${ready.id}`);
      expect(got.statusCode).toBe(200);
      expect(got.body).not.toContain('answer = 42');
      const rows = await h.db.pool.query<{ path: string; size_bytes: number }>(
        'SELECT path, size_bytes FROM input_upload_files WHERE upload_id = $1 ORDER BY idx',
        [ready.id],
      );
      expect(rows.rows.map((r) => r.size_bytes)).toEqual(files.map((f) => f.content.length));
      expect(
        (await h.db.pool.query('SELECT 1 FROM input_upload_parts WHERE upload_id = $1', [ready.id])).rowCount,
      ).toBe(0);
    });

    it('refuses a native executable by its magic bytes (discarded, audited) unless the security policy allows them', async () => {
      const files = [
        { path: 'README.md', content: Buffer.from('# tool\n') },
        { path: 'bin/tool', content: ELF },
      ];
      const first = await upload(operator, WS, files);
      expect(first.done.statusCode, first.done.body).toBe(422);
      const body = first.done.json<Refused>();
      expect(body.error).toBe('input_refused');
      expect(body.refused).toEqual([
        { path: 'bin/tool', reason: expect.stringMatching(/ELF executable/) as unknown },
      ]);
      expect((await operator.req('GET', `/projects/${WS}/input-uploads/${first.up.id}`)).statusCode).toBe(
        404,
      );
      const denied = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'input.upload.complete' AND outcome = 'denied' AND target = $1`,
        [`input-upload:${first.up.id}`],
      );
      expect(denied.rowCount).toBe(1);
      await stepUp();
      const put = await owner.req('PUT', '/security/policy', { inputs: { executables: true } });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json<{ changed: string[] }>().changed).toContain('inputs.executables');
      await h.app.inputUploads.sweep(true);
      const second = await upload(operator, WS, files);
      expect(second.done.statusCode, second.done.body).toBe(200);
      await stepUp();
      expect(
        (await owner.req('PUT', '/security/policy', { inputs: { executables: false } })).statusCode,
      ).toBe(200);
    });

    it('secret findings block by default (file, rule, line — never the value); "send anyway" completes the same upload, audited', async () => {
      const files = [
        { path: 'config/app.env', content: Buffer.from(`NAME=x\nGITHUB_TOKEN=${TOKEN}\n`) },
        { path: 'notes.md', content: Buffer.from('plain\n') },
      ];
      const { up, done } = await upload(operator, WS, files);
      expect(done.statusCode, done.body).toBe(422);
      expect(done.body).not.toContain(TOKEN);
      const body = done.json<Refused>();
      expect(body.error).toBe('input_secrets_found');
      expect(body.findings?.[0]).toMatchObject({ path: 'config/app.env', line: 2 });
      // The parts are kept: nothing has to be sent again.
      const still = await operator.req('GET', `/projects/${WS}/input-uploads/${up.id}`);
      expect(still.json<Upload>().state).toBe('receiving');
      // Someone else cannot complete (or override) it.
      expect(
        (await owner.req('POST', `/projects/${WS}/input-uploads/${up.id}/complete`, { allowSecrets: true }))
          .statusCode,
      ).toBe(404);
      const ok = await operator.req('POST', `/projects/${WS}/input-uploads/${up.id}/complete`, {
        allowSecrets: true,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const ready = ok.json<Upload>();
      expect(ready.sentWithSecrets).toBe(true);
      expect(ready.secretFindings[0]).toMatchObject({ path: 'config/app.env', line: 2 });
      const audit = await h.db.pool.query<{ outcome: string; metadata: unknown }>(
        `SELECT outcome, metadata FROM audit_events WHERE target = $1 AND action IN ('input.upload.complete', 'input.upload.secrets_override') ORDER BY occurred_at, id`,
        [`input-upload:${up.id}`],
      );
      expect(audit.rows.map((r) => r.outcome)).toEqual(['denied', 'success', 'success']);
      expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);
      const override = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'input.upload.secrets_override' AND target = $1 AND actor_id = $2`,
        [`input-upload:${up.id}`, operatorId],
      );
      expect(override.rowCount).toBe(1);
    });

    it('POST /jobs inputUpload: same project only; unknown 404; the job page shows the facts', async () => {
      const bad = await operator.req('POST', '/jobs', {
        project: WS,
        spec: wsSpec(),
        inputUpload: randomUUID(),
      });
      expect(bad.statusCode).toBe(404);
      expect(bad.json<{ error: string }>().error).toBe('input_upload_not_found');
      const wrong = await operator.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec(),
        inputUpload: treeId,
      });
      expect(wrong.statusCode, wrong.body).toBe(409);
      expect(wrong.json<{ error: string }>().error).toBe('input_upload_wrong_project');
    });

    it('a lease-checked relay: only the attempt holding the live lease reads its own bundle; a stale epoch is refused and audited', async () => {
      // A raw machine that advertises input-bundle-v1 but has no runtime (never placed by the orchestrator).
      raw = await RawWorker.connect(url, new TestKey());
      const pending = await raw.handshake({ pairingCode: 'ZIPA-ABCD' });
      rawId = pending.workerId ?? '';
      await stepUp();
      expect(
        (await owner.req('POST', `/workers/${rawId}/approve`, { pairingCode: 'ZIPA-ABCD' })).statusCode,
      ).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      raw.sendJson(
        raw.envelope(
          'CAPABILITIES',
          {
            runtimes: [],
            sandboxProfiles: ['host-restricted'],
            maxParallelJobs: 1,
            tools: [],
            features: ['workspace-v1', 'input-bundle-v1'],
          },
          { workerId: rawId },
        ),
      );
      const res = await operator.req('POST', '/jobs', {
        project: WS,
        spec: wsSpec('relay'),
        inputUpload: treeId,
      });
      expect(res.statusCode, res.body).toBe(201);
      const jobId = res.json<{ job: { id: string } }>().job.id;
      const grant = await jobs.acquireLease(jobId, rawId, 60 * 60_000);
      const w = raw;
      const ask = (op: unknown, epoch = grant.lease.epoch, job = jobId) => {
        w.sendJson(
          w.envelope(
            'INPUT_BUNDLE_REQUEST',
            { attemptId: grant.attempt.id, epoch, requestId: randomUUID(), op },
            { workerId: rawId, jobId: job },
          ),
        );
        return w.next('INPUT_BUNDLE_DATA', 10_000);
      };
      const listed = await ask({ op: 'list', offset: 0 });
      expect(listed.payload.status).toBe('ok');
      expect(listed.payload.total).toBe(TREE().length);
      const big = listed.payload.entries?.find((e) => e.path === 'src/big.txt');
      expect(big).toMatchObject({ size: BIG.length, sha256: sha(BIG) });
      const chunks: Buffer[] = [];
      for (let offset = 0; ;) {
        const r = await ask({ op: 'read', index: big?.index ?? 0, offset });
        expect(r.payload.status).toBe('ok');
        const c = Buffer.from(r.payload.data ?? '', 'base64');
        chunks.push(c);
        offset += c.length;
        if (r.payload.eof === true) break;
      }
      expect(sha(Buffer.concat(chunks))).toBe(sha(BIG));
      expect((await ask({ op: 'list', offset: 0 }, grant.lease.epoch + 7)).payload.status).toBe('refused');
      // Another job's bundle cannot be asked for under this lease.
      const plain = await operator.req('POST', '/jobs', { project: WS, spec: wsSpec('no bundle') });
      const plainId = plain.json<{ job: { id: string } }>().job.id;
      expect((await ask({ op: 'list', offset: 0 }, grant.lease.epoch, plainId)).payload.status).toBe(
        'refused',
      );
      const audit = await h.db.pool.query<{ outcome: string }>(
        `SELECT outcome FROM audit_events WHERE action = 'job.input_bundle.read' AND target = $1 ORDER BY occurred_at, id`,
        [`job:${jobId}`],
      );
      // The test clock does not move between the two reads: the row id keeps their order.
      expect(audit.rows.map((x) => x.outcome)).toEqual(['success', 'denied']);
      const page = await viewer.req('GET', `/jobs/${jobId}/input-upload`);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.json()).toMatchObject({
        inputUpload: {
          sourceId: treeId,
          fileCount: TREE().length,
          kept: true,
          pulledAt: expect.any(String) as unknown,
        },
      });
      await jobs.transition(jobId, 'lease_acked', {
        actor: { type: 'worker', id: rawId },
        epoch: grant.lease.epoch,
      });
      await operator.req('POST', `/jobs/${jobId}/cancel`, { reason: 'relay test done' });
    });

    it('placement: an old worker is excluded (input_bundle_unsupported); an input-bundle-v1 worker pulls the files into in/', async () => {
      const readScript: FakeScript = () => [
        { kind: 'read-file', path: 'in/src/main.ts' },
        { kind: 'read-file', path: 'in/docs/Sunum çalışması.md' },
        { kind: 'write-file', path: 'out/report.md', content: '# Rapor\n' },
        { kind: 'summary', text: 'read the inputs' },
      ];
      const old = await newWorker({
        workspaces: { genel: { egress: 'none', allowHosts: [] } },
        fake: { script: readScript },
      });
      const first = await operator.req('POST', '/jobs', { project: WS, spec: wsSpec(), inputUpload: treeId });
      expect(first.statusCode, first.body).toBe(201);
      const refused = first.json<{ job: { id: string } }>().job.id;
      // The only machine is too old: no placement, and the reason says why (update the worker).
      await expect.poll(() => state(operator, refused), { timeout: 15_000 }).toBe('FAILED');
      const why = await h.db.pool.query<{ reason: string }>(
        `SELECT reason FROM job_transitions WHERE job_id = $1 AND trigger = 'infeasible'`,
        [refused],
      );
      expect(why.rows[0]?.reason).toMatch(/input-bundle-v1.*update the worker/);
      await old.w.stop();
      await newWorker({
        workspaces: { genel: { egress: 'none', allowHosts: [] } },
        fake: { script: readScript },
        features: ['input-bundle-v1'],
      });
      const res = await operator.req('POST', '/jobs', { project: WS, spec: wsSpec(), inputUpload: treeId });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ job: { id: string } }>().job.id;
      await expect.poll(() => state(operator, id), { timeout: 30_000 }).toBe('SUCCEEDED');
      const events = await h.db.pool.query<{ payload: { event?: { kind: string; text?: string } } }>(
        `SELECT payload FROM worker_inbox WHERE job_id = $1 AND type = 'EVENT'`,
        [id],
      );
      const texts = events.rows.map((r) => r.payload.event?.text ?? '');
      expect(texts.some((t) => t.includes('export const answer = 42;'))).toBe(true);
      expect(texts.some((t) => t.includes('# Sunum'))).toBe(true);
      expect(texts.some((t) => /Input files from a \.zip are in \.\/in\/ \(6 files/.test(t))).toBe(true);
    });

    it('repository jobs get a scratch in/ next to the checkout — readable, read-only, never inside the repository', async () => {
      const repoTree: F[] = [
        { path: 'spec/requirements.md', content: Buffer.from('# Gereksinimler\n') },
        { path: 'data/sample.json', content: Buffer.from('{"a":1}') },
      ];
      const { done } = await upload(operator, PROJECT, repoTree);
      expect(done.statusCode, done.body).toBe(200);
      const bundle = done.json<Upload>().id;
      // Only the repository machine below takes this job.
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      const seen: { dir: string | null; text: string | null; prompt: string } = {
        dir: null,
        text: null,
        prompt: '',
      };
      const script: FakeScript = (prompt) => {
        seen.prompt = prompt;
        const m = /read-only in (\S+) \(top level/.exec(prompt);
        seen.dir = m?.[1] ?? null;
        if (seen.dir !== null) seen.text = readFileSync(`${seen.dir}/spec/requirements.md`, 'utf8');
        return [
          { kind: 'write-file', path: 'NOTES.md', content: 'done\n' },
          { kind: 'summary', text: 'ok' },
        ];
      };
      await newWorker({ projects: [PROJECT], fake: { script }, features: ['input-bundle-v1'] });
      const res = await operator.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec(),
        inputUpload: bundle,
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ job: { id: string } }>().job.id;
      await expect.poll(() => state(operator, id), { timeout: 30_000 }).toMatch(/^(SUCCEEDED|FAILED)$/);
      const ends = await h.db.pool.query<{ trigger: string; reason: string | null }>(
        'SELECT trigger, reason FROM job_transitions WHERE job_id = $1 ORDER BY occurred_at, id',
        [id],
      );
      expect(await state(operator, id), JSON.stringify(ends.rows)).toBe('SUCCEEDED');
      expect(seen.text).toBe('# Gereksinimler\n');
      expect(seen.dir).toMatch(/sandboxes\/[0-9a-f-]+\/[^/]+\/in$/);
      expect(seen.prompt).toMatch(/NOT part of the repository checkout/);
    });

    it('the assistant: draft_job inputUpload (same project, re-checked at confirm) and list_input_bundle_files', async () => {
      const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
      const chatInputs = new ChatInputUploads({ service: h.app.inputUploads, db: h.db.pool });
      const tools = new ChatTools({
        db: h.db.pool,
        store,
        clock: h.clock.now,
        inputUploads: () => chatInputs,
      } as unknown as ChatToolsDeps);
      const thread = await store.createThread(ownerId, 'zip');
      const c: ToolCaller = {
        userId: ownerId,
        subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
        threadId: thread.id,
        turnId: randomUUID(),
      };
      const files = await tools.run(c, 'list_input_bundle_files', { uploadId: treeId, offset: 1, limit: 2 });
      expect(files.ok, JSON.stringify(files)).toBe(true);
      expect(files.ok ? files.data : null).toMatchObject({
        uploadId: treeId,
        project: WS,
        total: TREE().length,
        offset: 1,
        nextOffset: 3,
        files: [{ path: 'src/big.txt' }, { path: '.gitignore' }],
      });
      // A bundle of another project is refused with the project to use (draft_job asks exactly this).
      expect(await chatInputs.checkForJob(c.subject, PROJECT, treeId)).toMatchObject({
        ok: false,
        code: 'invalid',
        message: expect.stringContaining(`belongs to project ${WS}`) as unknown,
      });
      expect(await chatInputs.checkForJob(c.subject, WS, randomUUID())).toMatchObject({ code: 'not_found' });
      expect(await chatInputs.checkForJob(c.subject, WS, treeId)).toBeNull();
      const drafted = await tools.run(c, 'draft_job', {
        project: WS,
        mode: 'workspace',
        title: 'Rapor',
        prompt: 'Use the files in in/ and write a report',
        runtime: 'codex',
        inputUpload: treeId,
      });
      if (!drafted.ok || drafted.draft === undefined) throw new Error(JSON.stringify(drafted));
      expect(drafted.draft.payload).toMatchObject({ inputUpload: treeId });
      expect(drafted.data).toMatchObject({ inputUpload: treeId });
      await stepUp();
      const confirmed = await owner.req('POST', `/chat/drafts/${drafted.draft.id}/confirm`, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const jobId = confirmed.json<{ result: { jobId: string } }>().result.jobId;
      const row = await h.db.pool.query<{ source_id: string }>(
        'SELECT source_id::text AS source_id FROM job_input_uploads WHERE job_id = $1',
        [jobId],
      );
      expect(row.rows[0]?.source_id).toBe(treeId);
      // A message may only carry the sender's own bundles.
      const other = await loadSubject(h.db.pool, { id: operatorId, role: 'operator' });
      const mine = await chatInputs.resolve(other, [treeId]);
      expect(mine[0]).toMatchObject({ id: treeId, project: WS, fileCount: TREE().length });
      await expect(chatInputs.resolve(c.subject, [treeId])).rejects.toMatchObject({
        code: 'input_upload_not_found',
      });
    });

    it('retention: kept while an unfinished job needs it, removed 14 days after its last use; the job keeps its facts', async () => {
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
      // An unfinished job (queued, no machine) pins the bundle past the retention.
      const files = [{ path: 'only.txt', content: Buffer.from('x') }];
      const { done } = await upload(operator, WS, files);
      const id = done.json<Upload>().id;
      const res = await operator.req('POST', '/jobs', {
        project: WS,
        spec: wsSpec('later'),
        inputUpload: id,
      });
      const jobId = res.json<{ job: { id: string } }>().job.id;
      // A receiving upload expires after an hour without a part.
      const s = await start(operator, WS, files);
      const receiving = s.json<Upload>().id;
      h.clock.advance(15 * DAY);
      await h.app.inputUploads.sweep(true);
      expect((await h.db.pool.query('SELECT 1 FROM input_uploads WHERE id = $1', [receiving])).rowCount).toBe(
        0,
      );
      expect((await h.db.pool.query('SELECT 1 FROM input_uploads WHERE id = $1', [id])).rowCount).toBe(1);
      await h.db.pool.query(`UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE id = $1`, [
        jobId,
      ]);
      await h.app.inputUploads.sweep(true);
      expect((await h.db.pool.query('SELECT 1 FROM input_uploads WHERE id = $1', [id])).rowCount).toBe(0);
      const facts = await h.app.inputUploads.forJob(jobId);
      expect(facts).toMatchObject({ sourceId: id, fileCount: 1, kept: false, upload: null });
      const pruned = await h.db.pool.query(`SELECT 1 FROM audit_events WHERE action = 'input.upload.prune'`);
      expect(pruned.rowCount).toBeGreaterThan(0);
    });
  },
);
