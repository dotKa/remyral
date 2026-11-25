import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { SITE_UPLOADS_KEPT_PER_PROJECT, SiteUploadService } from '../../src/site-uploads/index.js';
import { describeIntegration } from '../helpers/env.js';
import { FakeCloudflare } from '../helpers/fake-ops.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p10-site-upload (ADR-0037) against a real master (Postgres) and the local fake Cloudflare: a person uploads a
 * ready-made static site (chunked, resumable), the master checks it (paths, types, sizes, magic bytes, secret scan),
 * keeps it without ever serving it back, and `pages.deploy` with `uploadId` publishes it — to the project's target or
 * to a further Pages project the master created for the project ("Create a new Pages project" without "use as
 * target") — with the same policy, approval, step-up, audit and rollback as a job deploy. Plus authz, CSRF and
 * retention.
 */
const PW = 'quartz-meadow-lantern-7';
const SITE = 'genel';
const OTHER = 'other';
const MiB = 1024 * 1024;

const cf = new FakeCloudflare();
let h: Harness;
let owner: Client;
let ownerSecret = '';
let operator: Client;
let operatorId = '';
let viewer: Client;
let outsider: Client;
let zoneId = '';
const bodies: string[] = [];

type Action = {
  id: string;
  kind: string;
  state: string;
  env: string | null;
  policy: { decision: string; reason: string };
  diff: Record<string, unknown>;
  target: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  rollbackAvailable: boolean;
};
type Upload = {
  id: string;
  state: string;
  fileCount: number;
  totalBytes: number;
  partSize: number;
  partCount: number;
  received: number[] | null;
  files: { path: string; size: number; sha256: string; contentType: string }[] | null;
  uploadedBy: { id: string; username: string | null };
};
type Refused = {
  error: string;
  message: string;
  refused?: { path: string; reason: string; rule?: string; line?: number }[];
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A minimal MP4 (ftyp box) padded to `size` bytes. */
function mp4(size: number): Buffer {
  const b = Buffer.alloc(size, 0x11);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}
function png(size = 64): Buffer {
  const b = Buffer.alloc(size, 0x22);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}
const html = (s: string) =>
  Buffer.from(`<!doctype html><title>${s}</title><video src="clip.mp4"></video>`, 'utf8');

async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
  const res = await c.req(method, url, body);
  bodies.push(res.body);
  return res;
}

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  const res = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
  expect(res.statusCode, res.body).toBe(200);
}

function start(
  c: Client,
  project: string,
  files: { path: string; content?: Buffer; size?: number; sha256?: string }[],
  partSize?: number,
) {
  return call(c, 'POST', `/projects/${project}/site-uploads`, {
    files: files.map((f) => ({
      path: f.path,
      size: f.size ?? f.content?.length ?? 0,
      sha256: f.sha256 ?? sha(f.content ?? Buffer.alloc(0)),
    })),
    label: 'presentation',
    ...(partSize === undefined ? {} : { partSize }),
  });
}

function putPart(c: Client, project: string, id: string, n: number, bytes: Buffer, hash = sha(bytes)) {
  return c.req('PUT', `/projects/${project}/site-uploads/${id}/parts/${String(n)}`, bytes, {
    'content-type': 'application/octet-stream',
    'x-part-sha256': hash,
  });
}

/** Start → every part → complete; returns the complete response. */
async function upload(c: Client, project: string, files: { path: string; content: Buffer }[]) {
  const s = await start(c, project, files);
  expect(s.statusCode, s.body).toBe(201);
  const up = s.json<Upload>();
  const all = Buffer.concat(files.map((f) => f.content));
  for (let n = 0; n < up.partCount; n++) {
    const r = await putPart(c, project, up.id, n, all.subarray(n * up.partSize, (n + 1) * up.partSize));
    expect(r.statusCode, r.body).toBe(200);
  }
  return {
    id: up.id,
    done: await call(c, 'POST', `/projects/${project}/site-uploads/${up.id}/complete`, {}),
  };
}

async function request(c: Client, project: string, kind: string, params: Record<string, unknown>) {
  return call(c, 'POST', '/deploy/actions', { project, kind, params, idempotencyKey: `k-${randomUUID()}` });
}

async function targets(project: string): Promise<Record<string, unknown> | null> {
  return (await call(owner, 'GET', `/projects/${project}/deploy-targets`)).json<{
    targets: Record<string, unknown> | null;
  }>().targets;
}

const SIZEABLE = () => [
  { path: 'index.html', content: html('Remyral') },
  { path: 'assets/style.css', content: Buffer.from('body{margin:0}') },
  { path: 'assets/logo.png', content: png() },
  // > 5 MB in one file: more than a job's site bundle can carry.
  { path: 'clips/clip.mp4', content: mp4(6 * MiB + 123) },
];

describeIntegration(
  'uploaded static sites deployed to Cloudflare Pages (integration, p10-site-upload)',
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      await cf.start();
      h = new Harness();
      await h.start({
        installers: { publicOrigin: 'https://console.example.test' },
        ops: {
          internalOrigins: [cf.base],
          cloudflareApi: `${cf.base}/client/v4`,
          controlPlaneAddresses: ['203.0.113.10'],
          limits: { perProjectPer10Min: 100 },
        },
      });
      await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [SITE], 'operator');
      operator = await fullLogin(h, 'oper1', PW, (await enroll(h, 'oper1', PW)).secret);
      const vw = await h.createUser('view1', PW, 'viewer');
      await h.grant(vw, [SITE], 'viewer');
      viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
      const out = await h.createUser('oper2', PW, 'operator');
      await h.grant(out, [OTHER], 'operator');
      outsider = await fullLogin(h, 'oper2', PW, (await enroll(h, 'oper2', PW)).secret);

      zoneId = cf.addZone('demo.test');
      cf.pagesProjects.set('cluster-general', {
        name: 'cluster-general',
        production_branch: 'main',
        domains: [],
        deployments: [],
      });
      await stepUp();
      expect(
        (await owner.req('PUT', '/integrations/ops/cloudflare', { accountId: cf.account, token: cf.token }))
          .statusCode,
      ).toBe(200);
      await stepUp();
      const put = await owner.req('PUT', `/projects/${SITE}/deploy-targets`, {
        targets: {
          pages: { projectName: 'cluster-general' },
          dns: { zones: [{ id: zoneId, name: 'demo.test' }], protectedNames: [] },
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      await stepUp();
      expect(
        (
          await owner.req('PUT', `/projects/${OTHER}/deploy-targets`, {
            targets: { pages: { projectName: 'cluster-general' } },
          })
        ).statusCode,
      ).toBe(200);
    });
    afterAll(async () => {
      await h.stop();
      await cf.stop();
    });

    it('only people who may request deploys in the project can upload; viewers read; CSRF is required', async () => {
      const files = [{ path: 'index.html', content: html('x') }];
      expect((await start(viewer, SITE, files)).statusCode).toBe(403);
      expect((await start(outsider, SITE, files)).statusCode).toBe(404);
      const noCsrf = operator.clone();
      noCsrf.sendCsrf = false;
      expect((await start(noCsrf, SITE, files)).statusCode).toBe(403);
      expect((await call(viewer, 'GET', `/projects/${SITE}/site-uploads`)).statusCode).toBe(200);
      expect((await call(outsider, 'GET', `/projects/${SITE}/site-uploads`)).statusCode).toBe(404);
    });

    it('refuses unsafe paths, wrong types, oversized files and sites without index.html — before any byte', async () => {
      const big = { size: 25 * MiB + 1, sha256: 'a'.repeat(64) };
      const res = await start(operator, SITE, [
        { path: 'index.html', content: html('x') },
        { path: '../escape.html', content: html('x') },
        { path: '/abs.html', content: html('x') },
        { path: 'a\\b.html', content: html('x') },
        { path: '.env', content: Buffer.from('A=1') },
        { path: '.git/config.txt', content: Buffer.from('x') },
        { path: 'tool.exe', content: Buffer.from('MZ') },
        { path: 'a/b/c/d/e/f/g/h/i.html', content: html('x') },
        { path: 'huge.mp4', ...big },
      ]);
      expect(res.statusCode).toBe(400);
      const body = res.json<Refused>();
      expect(body.error).toBe('site_refused');
      const reasons = Object.fromEntries((body.refused ?? []).map((r) => [r.path, r.reason]));
      expect(reasons).toMatchObject({
        '../escape.html': 'unsafe path segment',
        '/abs.html': 'not a relative path',
        'a\\b.html': 'not a relative path',
        '.env': 'hidden file or folder',
        '.git/config.txt': 'hidden file or folder',
        'tool.exe': 'file type not allowed in a site',
        'a/b/c/d/e/f/g/h/i.html': 'nested too deep',
      });
      expect(reasons['huge.mp4']).toContain('25 MiB');
      expect(
        (await start(operator, SITE, [{ path: 'page.html', content: html('x') }])).json<Refused>().message,
      ).toContain('no index.html');
      const many = Array.from({ length: 501 }, (_, i) => ({
        path: `p${String(i)}.txt`,
        content: Buffer.from('x'),
      }));
      expect((await start(operator, SITE, many)).json<Refused>().message).toContain('more than 500 files');
      const total = Array.from({ length: 3 }, (_, i) => ({
        path: `v${String(i)}.mp4`,
        size: 20 * MiB,
        sha256: 'b'.repeat(64),
      }));
      const tooMuch = await start(operator, SITE, [{ path: 'index.html', content: html('x') }, ...total]);
      expect(tooMuch.statusCode).toBe(400);
      expect(tooMuch.json<Refused>().message).toContain('50 MiB');
      expect(await h.db.pool.query('SELECT 1 FROM site_uploads')).toMatchObject({ rowCount: 0 });
    });

    it('parts: checksum, size and owner are checked; complete needs every part; a retry overwrites', async () => {
      const files = SIZEABLE();
      const s = await start(operator, SITE, files);
      expect(s.statusCode, s.body).toBe(201);
      const up = s.json<Upload>();
      expect(up).toMatchObject({ state: 'receiving', fileCount: 4, partCount: 2, received: [] });
      const all = Buffer.concat(files.map((f) => f.content));
      const p0 = all.subarray(0, up.partSize);
      expect((await putPart(operator, SITE, up.id, 0, p0, 'c'.repeat(64))).statusCode).toBe(422);
      expect((await putPart(operator, SITE, up.id, 0, p0.subarray(1))).statusCode).toBe(400);
      expect((await putPart(operator, SITE, up.id, 9, p0)).statusCode).toBe(400);
      // Someone else (even the owner) cannot add parts to it.
      expect((await putPart(owner, SITE, up.id, 0, p0)).statusCode).toBe(404);
      expect((await putPart(operator, SITE, up.id, 0, p0)).statusCode).toBe(200);
      const incomplete = await call(operator, 'POST', `/projects/${SITE}/site-uploads/${up.id}/complete`, {});
      expect(incomplete.statusCode).toBe(409);
      expect(
        (await call(operator, 'GET', `/projects/${SITE}/site-uploads/${up.id}`)).json<Upload>().received,
      ).toEqual([0]);
      expect((await putPart(operator, SITE, up.id, 1, all.subarray(up.partSize))).statusCode).toBe(200);
      expect((await putPart(operator, SITE, up.id, 0, p0)).statusCode).toBe(200);
      const done = await call(operator, 'POST', `/projects/${SITE}/site-uploads/${up.id}/complete`, {});
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json<Upload>()).toMatchObject({ state: 'ready', fileCount: 4, totalBytes: all.length });
      await call(operator, 'DELETE', `/projects/${SITE}/site-uploads/${up.id}`);
    });

    it('refuses a file with a secret naming file, rule and line (never the value); the upload is discarded', async () => {
      const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
      const files = [
        {
          path: 'index.html',
          content: Buffer.from(`<!doctype html>\n<p>hi</p>\n<script>const t = "${token}";</script>\n`),
        },
      ];
      const { id, done } = await upload(operator, SITE, files);
      expect(done.statusCode).toBe(422);
      const body = done.json<Refused>();
      expect(body.refused).toEqual([
        { path: 'index.html', reason: 'looks like it contains a secret', rule: 'github-token', line: 3 },
      ]);
      expect(done.body).not.toContain(token);
      expect((await h.db.pool.query('SELECT 1 FROM site_uploads WHERE id = $1', [id])).rowCount).toBe(0);
      const audit = await h.db.pool.query<{ outcome: string; metadata: unknown }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'site.upload.complete' AND target = $1`,
        [`site-upload:${id}`],
      );
      expect(audit.rows[0]?.outcome).toBe('denied');
      expect(JSON.stringify(audit.rows)).not.toContain(token);
    });

    it('refuses a binary whose bytes do not match its type (magic bytes)', async () => {
      const { done } = await upload(operator, SITE, [
        { path: 'index.html', content: html('x') },
        { path: 'clip.mp4', content: Buffer.from('#!/bin/sh\necho not a video\n') },
        { path: 'pic.png', content: Buffer.from('GIF89a......') },
      ]);
      expect(done.statusCode).toBe(422);
      expect(done.json<Refused>().refused).toEqual([
        { path: 'clip.mp4', reason: 'content is not a video/mp4 file' },
        { path: 'pic.png', reason: 'content is not a image/png file' },
      ]);
    });

    it('"Create a new Pages project" without "use as target" keeps the current target and adds the project', async () => {
      cf.reset();
      const res = await request(operator, SITE, 'pages.create_project', { name: 'demo-site' });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a).toMatchObject({
        state: 'awaiting_approval',
        diff: {
          deployTarget: null,
          pagesProjects: { add: 'demo-site', targetUnchanged: 'cluster-general' },
        },
      });
      const done = (await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>();
      expect(done).toMatchObject({
        state: 'succeeded',
        result: { created: true, deployTarget: false, pagesProjectAdded: true },
      });
      expect(await targets(SITE)).toMatchObject({
        pages: { projectName: 'cluster-general' },
        pagesProjects: ['demo-site'],
      });
      // Stored without the field while it is empty (an older master's strict schema still reads such projects).
      const stored = await h.db.pool.query<{ project: string; has: boolean }>(
        `SELECT project, config ? 'pagesProjects' AS has FROM project_deploy_targets ORDER BY project`,
      );
      expect(stored.rows).toEqual([
        { project: SITE, has: true },
        { project: OTHER, has: false },
      ]);
      // Adopting an existing project (as target or not) is a deploy-target change: operators are refused.
      const adopt = await request(operator, SITE, 'pages.create_project', {
        name: 'cluster-general',
        ifExists: 'adopt',
      });
      expect(adopt.statusCode).toBe(403);
      expect(adopt.json()).toMatchObject({ error: 'targets_write_forbidden' });
    });

    it('attaches the custom domain to the further Pages project (CNAME in the allowed zone); the target is untouched', async () => {
      cf.newDomainStatus = 'active';
      const res = await request(operator, SITE, 'pages.add_domain', {
        domain: 'demo-site.demo.test',
        pagesProject: 'demo-site',
      });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<Action>();
      expect(a.target).toMatchObject({
        project: 'demo-site',
        domain: 'demo-site.demo.test',
      });
      const done = (await call(owner, 'POST', `/deploy/actions/${a.id}/approve`, {})).json<Action>();
      expect(done.state, JSON.stringify(done)).toBe('succeeded');
      expect(cf.pagesDomains.get('demo-site')?.map((d) => d.name)).toEqual(['demo-site.demo.test']);
      expect(cf.pagesDomains.get('cluster-general') ?? []).toEqual([]);
      const cname = cf.zones.get(zoneId)?.records.find((r) => r.name === 'demo-site.demo.test');
      expect(cname).toMatchObject({
        type: 'CNAME',
        content: 'demo-site.pages.dev',
        proxied: true,
      });
      // A Pages project that is not this project's is refused.
      const other = await request(operator, SITE, 'pages.add_domain', {
        domain: 'x.demo.test',
        pagesProject: 'someone-else',
      });
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ error: 'pages_project_not_allowed' });
    });

    it('deploys a > 5 MB site with an mp4 from an upload: preview at once, production after approval + step-up, rollback', async () => {
      const files = SIZEABLE();
      const { id, done } = await upload(operator, SITE, files);
      expect(done.statusCode, done.body).toBe(200);
      const view = done.json<Upload>();
      expect(view.files?.find((f) => f.path === 'clips/clip.mp4')).toMatchObject({
        contentType: 'video/mp4',
        size: 6 * MiB + 123,
      });
      // Metadata only: the console never gets the site's bytes back.
      const got = await call(viewer, 'GET', `/projects/${SITE}/site-uploads/${id}`);
      expect(got.statusCode).toBe(200);
      expect(got.body).not.toContain('<video');
      expect(got.body).not.toContain(files[0]?.content.toString('base64').slice(0, 20));
      expect(
        (await call(viewer, 'GET', `/projects/${SITE}/site-uploads`))
          .json<{ items: Upload[] }>()
          .items.map((u) => u.id),
      ).toContain(id);

      // Not deployable from another project.
      const cross = await request(outsider, OTHER, 'pages.deploy', { uploadId: id });
      expect(cross.statusCode).toBe(404);
      expect(cross.json()).toMatchObject({ error: 'upload_not_found' });
      // Not to a Pages project that is not this project's.
      const foreign = await request(operator, SITE, 'pages.deploy', {
        uploadId: id,
        pagesProject: 'someone-else',
      });
      expect(foreign.statusCode).toBe(403);
      // jobId and uploadId are exclusive.
      expect(
        (await request(operator, SITE, 'pages.deploy', { uploadId: id, jobId: randomUUID() })).statusCode,
      ).toBe(400);

      cf.reset();
      cf.assetBatches.length = 0;
      const pv = await request(operator, SITE, 'pages.deploy', {
        uploadId: id,
        pagesProject: 'demo-site',
        env: 'preview',
      });
      expect(pv.statusCode, pv.body).toBe(201);
      const preview = pv.json<Action>();
      expect(preview).toMatchObject({
        state: 'deploying',
        env: 'preview',
        policy: { decision: 'auto' },
        target: { project: 'demo-site', branch: 'remyral-preview' },
        diff: {
          source: 'upload',
          uploadId: id,
          fileCount: 4,
          bytes: view.totalBytes,
          upload: { label: 'presentation', uploadedBy: 'oper1' },
        },
      });
      // The mp4 reached Cloudflare intact with its content type; the manifest lists every path.
      const manifest = cf.deploymentManifests.at(-1) ?? {};
      expect(Object.keys(manifest).sort()).toEqual([
        '/assets/logo.png',
        '/assets/style.css',
        '/clips/clip.mp4',
        '/index.html',
      ]);
      const clip = cf.assetContent.get(manifest['/clips/clip.mp4'] ?? '');
      expect(clip?.contentType).toBe('video/mp4');
      expect(clip?.bytes.equals(files[3]?.content ?? Buffer.alloc(0))).toBe(true);
      expect(
        (await call(operator, 'POST', `/deploy/actions/${preview.id}/refresh`, {})).json<Action>().state,
      ).toBe('succeeded');
      expect(
        (
          await h.db.pool.query<{ last_action_id: string }>(
            'SELECT last_action_id::text FROM site_uploads WHERE id = $1',
            [id],
          )
        ).rows[0]?.last_action_id,
      ).toBe(preview.id);

      // Production: approval + always-fresh step-up (the project's default policy).
      cf.pagesProjects
        .get('demo-site')
        ?.deployments.push({ id: 'pd-old', environment: 'production', url: 'https://old.pages.dev' });
      const pr = (
        await request(operator, SITE, 'pages.deploy', {
          uploadId: id,
          pagesProject: 'demo-site',
          env: 'production',
        })
      ).json<Action>();
      expect(pr).toMatchObject({
        state: 'awaiting_approval',
        env: 'production',
        policy: { decision: 'approval_step_up' },
        target: { branch: 'main' },
      });
      expect((pr.diff.domains as string[]).sort()).toEqual(
        ['demo-site.demo.test', 'demo-site.pages.dev'].sort(),
      );
      // Operators cannot approve; a stale step-up is refused.
      expect((await call(operator, 'POST', `/deploy/actions/${pr.id}/approve`, {})).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      expect((await call(owner, 'POST', `/deploy/actions/${pr.id}/approve`, {})).statusCode).toBe(403);
      await stepUp();
      const approved = await call(owner, 'POST', `/deploy/actions/${pr.id}/approve`, {});
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json<Action>()).toMatchObject({
        state: 'deploying',
        result: { previousDeploymentId: 'pd-old' },
      });
      const live = (await call(owner, 'POST', `/deploy/actions/${pr.id}/refresh`, {})).json<Action>();
      expect(live).toMatchObject({ state: 'succeeded', rollbackAvailable: true });
      // The genel target was never touched.
      expect(cf.pagesProjects.get('cluster-general')?.deployments).toEqual([]);
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
        [`ops-action:${pr.id}`],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['ops.action.request', 'ops.action.approve']),
      );
      // Rollback names the same further Pages project.
      const rb = await call(operator, 'POST', `/deploy/actions/${pr.id}/rollback`, {
        idempotencyKey: `rb-${randomUUID()}`,
      });
      expect(rb.statusCode, rb.body).toBe(201);
      expect(rb.json<Action>()).toMatchObject({
        kind: 'pages.rollback',
        target: { project: 'demo-site' },
      });
      // The Cloudflare token never reaches a response.
      expect(bodies.join('\n')).not.toContain(cf.token);
    });

    it('retention: undeployed uploads go after 7 days, a project keeps its newest few; pending deploys are kept', async () => {
      await h.db.pool.query('DELETE FROM site_uploads');
      const ids: string[] = [];
      for (let i = 0; i < SITE_UPLOADS_KEPT_PER_PROJECT + 2; i++) {
        h.clock.advance(1000);
        const { id, done } = await upload(operator, SITE, [
          { path: 'index.html', content: html(`v${String(i)}`) },
        ]);
        expect(done.statusCode, done.body).toBe(200);
        ids.push(id);
      }
      // Completing an upload already trims the project to the newest ones.
      const left = (
        await h.db.pool.query<{ id: string }>('SELECT id::text FROM site_uploads ORDER BY created_at')
      ).rows.map((r) => r.id);
      expect(left).toEqual(ids.slice(2));
      // A production deploy waiting for approval keeps its upload.
      const waiting = (
        await request(operator, SITE, 'pages.deploy', { uploadId: ids[2], env: 'production' })
      ).json<Action>();
      expect(waiting.state).toBe('awaiting_approval');
      const later = new Date(h.clock.now().getTime() + 8 * 24 * 3600_000);
      const sweeper = new SiteUploadService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, () => later),
        clock: () => later,
      });
      expect(await sweeper.sweep(true)).toBe(SITE_UPLOADS_KEPT_PER_PROJECT - 1);
      expect(
        (await h.db.pool.query<{ id: string }>('SELECT id::text FROM site_uploads')).rows.map((r) => r.id),
      ).toEqual([ids[2]]);
      const prune = await h.db.pool.query(`SELECT 1 FROM audit_events WHERE action = 'site.upload.prune'`);
      expect(prune.rowCount).toBeGreaterThan(0);
    });

    it('an unfinished upload expires; at most two per person at once', async () => {
      await h.db.pool.query('DELETE FROM site_uploads');
      const f = [{ path: 'index.html', content: html('x') }];
      expect((await start(operator, SITE, f)).statusCode).toBe(201);
      expect((await start(operator, SITE, f)).statusCode).toBe(201);
      const third = await start(operator, SITE, f);
      expect(third.statusCode).toBe(409);
      expect(third.json()).toMatchObject({ error: 'too_many_uploads' });
      const later = new Date(h.clock.now().getTime() + 2 * 3600_000);
      await new SiteUploadService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, () => later),
        clock: () => later,
      }).sweep(true);
      expect((await h.db.pool.query('SELECT 1 FROM site_uploads')).rowCount).toBe(0);
    });
  },
);
