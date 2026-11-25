import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { HTML_PREVIEW_CSP } from '../../src/outputs/site-preview.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const P = 'outp';
const OTHER = 'outq';
const MiB = 1024 * 1024;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface Item {
  key: string;
  type: string;
  project: string;
  title: string | null;
  name: string;
  tags: string[];
  pinned: boolean;
  noteCount: number;
  jobId: string | null;
  site: { url: string | null; env: string; provider: string; opsActionId: string } | null;
  file: {
    source: string;
    download: string | null;
    preview: string;
    expiresAt: string | null;
    removed: string | null;
  } | null;
  note: { id: string; body: string; links: string[] } | null;
}

/** Entries of a stored-only ZIP (name → bytes), checking the central directory against the local headers. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = buf.readUInt16LE(end + 10);
  let cd = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(cd)).toBe(0x02014b50);
    const method = buf.readUInt16LE(cd + 10);
    const size = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const local = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    cd += 46 + nameLen;
  }
  return out;
}

/**
 * p6-outputs: the Outputs read model and its writes against a real master (Postgres, Redis) — authorization per
 * role, audit, search, notes ownership, the retention exemption of pinned files, ZIP limits and the preview headers.
 */
describeIntegration('outputs (integration)', { timeout: 120_000 }, () => {
  let h: Harness;
  let owner: Client;
  let op: Client;
  let op2: Client;
  let viewer: Client;
  let outsider: Client;
  let opId: string;
  let ownerId: string;
  let jobA: string;
  let jobB: string;
  let jobOther: string;
  let attemptA: string;

  async function login(name: string, role: 'owner' | 'operator' | 'viewer', projects: string[] | null) {
    const id = await h.createUser(name, PW, role);
    if (projects !== null && role !== 'owner') await h.grant(id, projects, role);
    const { secret } = await enroll(h, name, PW);
    return { id, client: await fullLogin(h, name, PW, secret) };
  }

  async function job(project: string, actor: JobActor, workspace = false): Promise<string> {
    const jobs = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const { job: j } = await jobs.create({
      project,
      actor,
      submit: true,
      spec: workspace
        ? {
            runtime: 'codex',
            prompt: 'Outputs fixture',
            sandboxProfile: 'host-restricted',
            sourceTrust: 'trusted',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          }
        : {
            runtime: 'codex',
            prompt: 'Outputs fixture',
            repository: {
              url: 'https://example.com/acme/repo.git',
              baseRef: 'main',
              workBranch: `rac/${randomUUID()}`,
            },
            sandboxProfile: 'container',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 3600 },
          },
    });
    await h.db.pool.query(
      `UPDATE jobs SET state = 'SUCCEEDED', state_changed_at = $2, version = version + 1 WHERE id = $1`,
      [j.id, h.clock.now()],
    );
    return j.id;
  }

  async function artifact(
    jobId: string,
    attemptId: string,
    name: string,
    mediaType: string,
    content: Buffer,
    opts: { kind?: string; createdAt?: Date; redacted?: boolean; id?: string } = {},
  ): Promise<string> {
    const id =
      opts.id ??
      `ws-${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 60)}`;
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted,
                                  content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        attemptId,
        jobId,
        id,
        name,
        mediaType,
        content.length,
        sha(content),
        opts.kind ?? 'output',
        opts.redacted ?? false,
        content,
        opts.createdAt ?? h.clock.now(),
      ],
    );
    return id;
  }

  async function deploy(project: string, target: Record<string, unknown>, opts: Record<string, unknown>) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
         state, requested_by_type, requested_by_id, via, idempotency_key, result, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4, repeat('0', 64), $5, '{}', 'auto', 'fixture', $6, 'user', $7, 'api', $8, $9, $10, $10, $10)
       RETURNING id`,
      [
        project,
        opts.kind ?? 'pages.deploy',
        opts.env ?? 'preview',
        JSON.stringify(opts.params ?? {}),
        JSON.stringify(target),
        opts.state ?? 'succeeded',
        ownerId,
        `fx-${randomUUID()}`,
        JSON.stringify(opts.result ?? {}),
        opts.at ?? h.clock.now(),
      ],
    );
    return rows[0]?.id ?? '';
  }

  async function list(c: Client, query: string): Promise<{ items: Item[]; total: number }> {
    const res = await c.req('GET', `/outputs${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    ({ id: ownerId, client: owner } = await login('owner.one', 'owner', null));
    ({ id: opId, client: op } = await login('op.one', 'operator', [P]));
    ({ client: op2 } = await login('op.two', 'operator', [P]));
    ({ client: viewer } = await login('viewer.one', 'viewer', [P]));
    ({ client: outsider } = await login('op.out', 'operator', [OTHER]));
    const actor: JobActor = { type: 'user', id: ownerId };
    jobA = await job(P, actor);
    jobB = await job(P, actor);
    jobOther = await job(OTHER, actor);
    attemptA = randomUUID();
    await artifact(
      jobA,
      attemptA,
      'report.md',
      'text/markdown',
      Buffer.from('# Weekly report\n\nAll good.\n'),
    );
    await artifact(jobA, attemptA, 'data.csv', 'text/csv', Buffer.from('a,b\n1,2\n'));
    await artifact(jobA, attemptA, 'paper.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));
    await artifact(jobB, randomUUID(), 'summary.md', 'text/markdown', Buffer.from('Done.\n'), {
      kind: 'summary',
    });
    await artifact(jobOther, randomUUID(), 'secret-plan.md', 'text/markdown', Buffer.from('other project\n'));
    // Run artifact (repository job): metadata only, from the live view.
    await h.db.pool.query(
      `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream_seq,
                               kind, payload, ts, received_at, size_bytes)
       VALUES ($1, $2, 1, 1, 'worker-1', 5, $3, 1, 'artifact', $4, $5, $5, 10)`,
      [
        jobB,
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          kind: 'artifact',
          artifactId: 'diff-0123456789abcdef',
          name: 'attempt.diff',
          mediaType: 'text/x-diff',
          sizeBytes: 1234,
          sha256: 'a'.repeat(64),
        }),
        h.clock.now(),
      ],
    );
    // Two preview deploys of the same Pages project: only the latest is the live site; one failed deploy is ignored.
    h.clock.advance(1_000);
    await deploy(
      P,
      { provider: 'cloudflare-pages', project: 'acme-site', env: 'preview' },
      {
        params: { jobId: jobA },
        result: { url: 'https://old.acme-site.pages.dev' },
        at: new Date(h.clock.now().getTime() - 60_000),
      },
    );
    await deploy(
      P,
      { provider: 'cloudflare-pages', project: 'acme-site', env: 'preview' },
      {
        params: { jobId: jobA },
        result: { url: 'https://new.acme-site.pages.dev' },
      },
    );
    await deploy(
      P,
      { provider: 'cloudflare-pages', project: 'acme-site', env: 'preview' },
      {
        state: 'failed',
        result: { url: 'https://broken.acme-site.pages.dev' },
        at: new Date(h.clock.now().getTime() + 1_000),
      },
    );
    await deploy(
      P,
      {
        provider: 'coolify',
        env: 'production',
        resources: [{ uuid: 'abc123def', name: 'web', fqdn: 'https://acme.example.com' }],
      },
      { kind: 'coolify.deploy', env: 'production' },
    );
  });

  afterAll(async () => {
    await h.stop();
  });

  describe('read model', () => {
    it('aggregates live sites, files and run artifacts of the visible projects only', async () => {
      const all = await list(viewer, '');
      const keys = all.items.map((i) => i.key);
      expect(keys).toContain(`file:${jobA}:ws-report-md`);
      expect(keys).toContain(`run:${jobB}:diff-0123456789abcdef`);
      expect(keys.some((k) => k.includes(jobOther))).toBe(false);
      const sites = all.items.filter((i) => i.type === 'site');
      expect(sites).toHaveLength(2);
      const pages = sites.find((s) => s.site?.provider === 'pages');
      expect(pages?.key).toBe('site:pages:acme-site:preview');
      expect(pages?.site?.url).toBe('https://new.acme-site.pages.dev');
      expect(pages?.jobId).toBe(jobA);
      const coolify = sites.find((s) => s.site?.provider === 'coolify');
      expect(coolify?.site?.url).toBe('https://acme.example.com');
      expect(coolify?.site?.env).toBe('production');
      const report = all.items.find((i) => i.key === `file:${jobA}:ws-report-md`);
      expect(report?.file).toMatchObject({
        source: 'workspace',
        download: `/jobs/${jobA}/artifacts/ws-report-md`,
        preview: 'markdown',
      });
      const diff = all.items.find((i) => i.key.startsWith('run:'));
      expect(diff?.file).toMatchObject({ source: 'run', download: null, preview: 'diff' });
      expect(all.items.find((i) => i.name === 'data.csv')?.file?.preview).toBe('csv');
      expect(all.items.find((i) => i.name === 'paper.pdf')?.file?.preview).toBe('pdf');
    });

    it('filters by type, job and key; a hidden project is a 404, an unknown key an empty page', async () => {
      expect((await list(viewer, '?type=site')).items.every((i) => i.type === 'site')).toBe(true);
      const byJob = await list(viewer, `?job=${jobB}`);
      expect(byJob.items.map((i) => i.name).sort()).toEqual(['attempt.diff', 'summary.md']);
      const one = await list(
        viewer,
        `?project=${P}&key=${encodeURIComponent('site:pages:acme-site:preview')}`,
      );
      expect(one.total).toBe(1);
      expect((await outsider.req('GET', `/outputs?project=${P}`)).statusCode).toBe(404);
      expect((await list(owner, `?key=file:${jobA}:ws-nope`)).items).toEqual([]);
      const page = await list(owner, '?limit=2&offset=1');
      expect(page.items).toHaveLength(2);
      expect(page.total).toBeGreaterThan(3);
    });
  });

  describe('writes and authorization', () => {
    it('viewers cannot write; operators title, tag and pin (audited) and search finds it', async () => {
      const key = `file:${jobA}:ws-report-md`;
      const body = { project: P, key, title: 'Weekly vendor report', tags: ['research', 'Q4'], pinned: true };
      expect((await viewer.req('PUT', '/outputs/items', body)).statusCode).toBe(403);
      expect((await outsider.req('PUT', '/outputs/items', body)).statusCode).toBe(404);
      const res = await op.req('PUT', '/outputs/items', body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<Item>()).toMatchObject({
        title: 'Weekly vendor report',
        tags: ['research', 'Q4'],
        pinned: true,
      });
      // A key that names nothing in the project is refused; so is one of another project's job.
      expect(
        (
          await op.req('PUT', '/outputs/items', {
            project: P,
            key: `file:${jobOther}:ws-secret-plan-md`,
            pinned: true,
          })
        ).statusCode,
      ).toBe(404);
      expect((await op.req('PUT', '/outputs/items', { ...body, tags: ['<script>'] })).statusCode).toBe(400);
      const first = (await list(viewer, '')).items[0];
      expect(first?.key).toBe(key); // pinned first
      expect((await list(viewer, '?q=vendor')).items.map((i) => i.key)).toEqual([key]);
      expect((await list(viewer, '?tag=Q4')).items.map((i) => i.key)).toEqual([key]);
      expect((await list(viewer, '?pinned=true')).items.map((i) => i.key)).toEqual([key]);
      expect((await list(viewer, '?q=100%25')).items).toEqual([]);
      const audit = await h.db.pool.query<{ actor_id: string; outcome: string }>(
        `SELECT actor_id, outcome FROM audit_events WHERE action = 'outputs.item.update' ORDER BY id`,
      );
      expect(audit.rows.map((r) => r.outcome)).toContain('success');
      expect(audit.rows.some((r) => r.actor_id === opId)).toBe(true);
    });

    it('item notes: authors edit their own, others are refused, admins may delete any', async () => {
      const key = 'site:pages:acme-site:preview';
      const created = await op.req('POST', '/outputs/item-notes', {
        project: P,
        key,
        body: 'Shared with **marketing**.',
      });
      expect(created.statusCode, created.body).toBe(201);
      const note = created.json<{ id: string; body: string }>();
      expect(
        (await viewer.req('POST', '/outputs/item-notes', { project: P, key, body: 'x' })).statusCode,
      ).toBe(403);
      expect((await op.req('POST', '/outputs/item-notes', { project: P, key, body: '   ' })).statusCode).toBe(
        400,
      );
      const thread = await viewer.req('GET', `/outputs/thread?project=${P}&key=${encodeURIComponent(key)}`);
      expect(thread.json<{ items: { body: string }[] }>().items.map((n) => n.body)).toEqual([
        'Shared with **marketing**.',
      ]);
      expect((await op2.req('PATCH', `/outputs/item-notes/${note.id}`, { body: 'hijack' })).statusCode).toBe(
        403,
      );
      expect((await outsider.req('PATCH', `/outputs/item-notes/${note.id}`, { body: 'x' })).statusCode).toBe(
        404,
      );
      const edited = await op.req('PATCH', `/outputs/item-notes/${note.id}`, { body: 'Shared with sales.' });
      expect(edited.statusCode, edited.body).toBe(200);
      expect((await list(viewer, '?q=sales')).items.map((i) => i.key)).toEqual([key]);
      expect((await list(viewer, `?key=${encodeURIComponent(key)}`)).items[0]?.noteCount).toBe(1);
      expect((await op2.req('DELETE', `/outputs/item-notes/${note.id}`)).statusCode).toBe(403);
      expect((await owner.req('DELETE', `/outputs/item-notes/${note.id}`)).statusCode).toBe(204);
      const denied = await h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'outputs.item_note.update' AND outcome = 'denied'`,
      );
      expect(denied.rowCount).toBeGreaterThan(0);
    });

    it('note cards: https links only, own edits, listed under Notes and searchable', async () => {
      const bad = await op.req('POST', '/outputs/notes', {
        project: P,
        title: 'Launch',
        links: ['javascript:alert(1)'],
      });
      expect(bad.statusCode).toBe(400);
      expect(
        (await op.req('POST', '/outputs/notes', { project: P, title: 'L', links: ['http://example.com'] }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await op.req('POST', '/outputs/notes', {
            project: P,
            title: 'L',
            links: ['https://u:p@example.com'],
          })
        ).statusCode,
      ).toBe(400);
      const res = await op.req('POST', '/outputs/notes', {
        project: P,
        title: 'Launch checklist',
        body: '- DNS\n- analytics',
        tags: ['launch'],
        links: ['https://acme.example.com/launch'],
      });
      expect(res.statusCode, res.body).toBe(201);
      const card = res.json<{ id: string }>();
      expect((await viewer.req('POST', '/outputs/notes', { project: P, title: 'x' })).statusCode).toBe(403);
      const notes = await list(viewer, '?type=note');
      expect(notes.items.map((i) => i.name)).toEqual(['Launch checklist']);
      expect(notes.items[0]?.note?.links).toEqual(['https://acme.example.com/launch']);
      expect((await list(viewer, '?q=analytics')).items.map((i) => i.type)).toEqual(['note']);
      expect((await op2.req('PATCH', `/outputs/notes/${card.id}`, { title: 'Mine now' })).statusCode).toBe(
        403,
      );
      const patched = await op.req('PATCH', `/outputs/notes/${card.id}`, {
        pinned: true,
        title: 'Launch list',
      });
      expect(patched.json<{ title: string; pinned: boolean }>()).toMatchObject({
        title: 'Launch list',
        pinned: true,
      });
      expect((await viewer.req('GET', `/outputs/notes/${card.id}`)).statusCode).toBe(200);
      expect((await outsider.req('GET', `/outputs/notes/${card.id}`)).statusCode).toBe(404);
      expect((await op.req('DELETE', `/outputs/notes/${card.id}`)).statusCode).toBe(204);
    });
  });

  describe('retention exemption', () => {
    it('pinned workspace files survive the retention sweep; unpinned ones are pruned', async () => {
      const proj = 'outret';
      await h.grant(opId, [proj], 'operator');
      await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [proj]);
      await h.db.pool.query(
        `INSERT INTO project_workspaces (project, egress, artifact_retention_days, updated_at) VALUES ($1, 'none', 1, now())`,
        [proj],
      );
      const j = await job(proj, { type: 'user', id: ownerId }, true);
      const old = new Date(h.clock.now().getTime() - 3 * 86_400_000);
      const att = randomUUID();
      await artifact(j, att, 'keep.md', 'text/markdown', Buffer.from('keep me\n'), { createdAt: old });
      await artifact(j, att, 'drop.md', 'text/markdown', Buffer.from('drop me\n'), { createdAt: old });
      const fresh = (await list(op, `?project=${proj}`)).items;
      expect(fresh.find((i) => i.name === 'drop.md')?.file?.expiresAt).not.toBeNull();
      expect(
        (await op.req('PUT', '/outputs/items', { project: proj, key: `file:${j}:ws-keep-md`, pinned: true }))
          .statusCode,
      ).toBe(200);
      const after = (await list(op, `?project=${proj}`)).items;
      expect(after.find((i) => i.name === 'keep.md')?.file?.expiresAt).toBeNull();
      await h.app.workspaceStorage.sweep();
      const { rows } = await h.db.pool.query<{ name: string; pruned: boolean }>(
        `SELECT name, pruned_at IS NOT NULL AS pruned FROM job_artifacts WHERE job_id = $1 ORDER BY name`,
        [j],
      );
      expect(rows).toEqual([
        { name: 'drop.md', pruned: true },
        { name: 'keep.md', pruned: false },
      ]);
      const listed = (await list(op, `?project=${proj}`)).items;
      expect(listed.find((i) => i.name === 'drop.md')?.file).toMatchObject({
        removed: 'retention',
        download: null,
      });
    });

    it('a pinned run artifact keeps its event through the live retention', async () => {
      const j = await job(P, { type: 'user', id: ownerId });
      const attempt = randomUUID();
      await h.db.pool.query(`INSERT INTO job_live_heads (job_id, head) VALUES ($1, 2)`, [j]);
      for (const [seq, id] of [
        [1, 'diff-pinned'],
        [2, 'diff-other'],
      ] as const) {
        await h.db.pool.query(
          `INSERT INTO job_events (job_id, attempt_id, attempt_no, epoch, worker_id, worker_seq, message_id, stream_seq,
                                   kind, payload, ts, received_at, size_bytes)
           VALUES ($1, $2, 1, 1, 'worker-1', $3, $4, $3, 'artifact', $5, $6, $6, 10)`,
          [
            j,
            attempt,
            seq,
            randomUUID(),
            JSON.stringify({ kind: 'artifact', artifactId: id, name: `${id}.txt` }),
            h.clock.now(),
          ],
        );
      }
      expect(
        (await op.req('PUT', '/outputs/items', { project: P, key: `run:${j}:diff-pinned`, pinned: true }))
          .statusCode,
      ).toBe(200);
      await h.app.live.store.purge(new Date(h.clock.now().getTime() + 40 * 86_400_000), {
        retentionDays: 30,
      });
      const { rows } = await h.db.pool.query<{ id: string }>(
        `SELECT payload->>'artifactId' AS id FROM job_events WHERE job_id = $1 ORDER BY stream_seq`,
        [j],
      );
      expect(rows.map((r) => r.id)).toEqual(['diff-pinned']);
    });
  });

  describe('download and preview', () => {
    it('zips selected files with a manifest; other projects, run artifacts and removed files are left out', async () => {
      const res = await viewer.req('POST', '/outputs/zip', {
        project: P,
        keys: [
          `file:${jobA}:ws-report-md`,
          `file:${jobA}:ws-data-csv`,
          `file:${jobOther}:ws-secret-plan-md`,
          `run:${jobB}:diff-0123456789abcdef`,
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="outputs-outp-/);
      const files = unzip(res.rawPayload);
      const a8 = jobA.slice(0, 8);
      expect([...files.keys()].sort()).toEqual([`${a8}/data.csv`, `${a8}/report.md`, 'MANIFEST.txt'].sort());
      expect(files.get(`${a8}/report.md`)?.toString()).toBe('# Weekly report\n\nAll good.\n');
      const manifest = files.get('MANIFEST.txt')?.toString() ?? '';
      expect(manifest).toContain(`run:${jobB}:diff-0123456789abcdef`);
      expect(manifest).toContain(`file:${jobOther}:ws-secret-plan-md`);
      expect(
        (await outsider.req('POST', '/outputs/zip', { project: P, keys: [`file:${jobA}:ws-report-md`] }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await viewer.req('POST', '/outputs/zip', {
            project: P,
            keys: [`run:${jobB}:diff-0123456789abcdef`],
          })
        ).statusCode,
      ).toBe(409);
    });

    it('refuses a ZIP over the total size limit before sending anything', async () => {
      const big = await job(P, { type: 'user', id: ownerId });
      const att = randomUUID();
      const keys: string[] = [];
      for (let i = 0; i < 11; i += 1) {
        const id = `ws-big-${String(i)}`;
        await h.db.pool.query(
          `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                      redacted, content, created_at)
           VALUES ($1, $2, $3, $4, 'text/plain', ${String(5 * MiB)}, repeat('0', 64), 'output', false,
                   convert_to(repeat('a', ${String(5 * MiB)}), 'UTF8'), now())`,
          [att, big, id, `big-${String(i)}.txt`],
        );
        keys.push(`file:${big}:${id}`);
      }
      const res = await viewer.req('POST', '/outputs/zip', { project: P, keys });
      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: string }>().error).toBe('zip_too_large');
      const tooMany = await viewer.req('POST', '/outputs/zip', {
        project: P,
        keys: Array.from({ length: 101 }, (_, i) => `file:${big}:ws-n${String(i)}`),
      });
      expect(tooMany.statusCode).toBe(400);
    });

    it('PDF previews inline for the browser viewer; text previews keep the sandbox CSP; others stay attachments', async () => {
      const pdf = await viewer.req('GET', `/jobs/${jobA}/artifacts/ws-paper-pdf?inline=1`);
      expect(pdf.statusCode).toBe(200);
      expect(String(pdf.headers['content-disposition'])).toMatch(/^inline;/);
      expect(pdf.headers['content-security-policy']).not.toContain('sandbox');
      expect(pdf.headers['content-security-policy']).toContain("default-src 'none'");
      expect(pdf.headers['x-content-type-options']).toBe('nosniff');
      const md = await viewer.req('GET', `/jobs/${jobA}/artifacts/ws-report-md?inline=1`);
      expect(md.headers['content-security-policy']).toContain('sandbox');
      const dl = await viewer.req('GET', `/jobs/${jobA}/artifacts/ws-paper-pdf`);
      expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
    });

    it('raster images preview inline with their own type, nosniff and CORP same-origin (job Files + Outputs)', async () => {
      // p9-files-image-preview: the job page's Files tab and the Outputs drawer both point <img src> at this route.
      const imgJob = await job(P, { type: 'user', id: ownerId });
      const attempt = randomUUID();
      const RIFF = (tag: string): Buffer =>
        Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from(tag)]);
      const images = [
        {
          name: 'generated-images/hero.png',
          type: 'image/png',
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
        },
        { name: 'photo.jpg', type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]) },
        { name: 'banner.webp', type: 'image/webp', body: RIFF('WEBP') },
        { name: 'spinner.gif', type: 'image/gif', body: Buffer.from('GIF89a\x01\x00') },
      ];
      for (const i of images) {
        const id = await artifact(imgJob, attempt, i.name, i.type, i.body);
        const res = await viewer.req('GET', `/jobs/${imgJob}/artifacts/${id}?inline=1`);
        expect(res.statusCode, i.name).toBe(200);
        expect(res.headers['content-type'], i.name).toBe(i.type);
        const base = i.name.split('/').at(-1) ?? '';
        expect(String(res.headers['content-disposition']), i.name).toMatch(
          new RegExp(`^inline; filename="${base.replace('.', '\\.')}"`),
        );
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
        // The image's own document policy stays locked down (never rendered as a page of the console).
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
        expect(res.headers['content-security-policy']).toContain('sandbox');
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(res.rawPayload.equals(i.body)).toBe(true);
        // Without `inline=1` it is a download.
        const dl = await viewer.req('GET', `/jobs/${imgJob}/artifacts/${id}`);
        expect(String(dl.headers['content-disposition'])).toMatch(/^attachment;/);
      }
      // The Outputs read model offers an image preview at the same route.
      const byJob = await list(viewer, `?job=${imgJob}`);
      const hero = byJob.items.find((i) => i.name === 'generated-images/hero.png');
      expect(hero?.file?.preview).toBe('image');
      expect(hero?.file?.download).toBe(`/jobs/${imgJob}/artifacts/ws-generated-images-hero-png`);
      // Outsiders get nothing.
      const res = await outsider.req('GET', `/jobs/${imgJob}/artifacts/ws-photo-jpg?inline=1`);
      expect(res.statusCode).toBe(404);
    });

    it('site bundle HTML is served only for a sandboxed frame with a strict CSP; scripts as text; flagged → 409', async () => {
      const site = await job(P, { type: 'user', id: ownerId });
      const html = '<!doctype html><h1>Hi</h1><script>parent.document.title="pwned"</script>';
      const files = [
        { path: 'index.html', contentType: 'text/html', body: html },
        { path: 'app.js', contentType: 'application/javascript', body: 'alert(1)' },
        { path: 'logo.svg', contentType: 'image/svg+xml', body: '<svg onload="alert(1)"/>' },
      ].map((f) => ({
        path: f.path,
        contentType: f.contentType,
        sha256: sha(f.body),
        base64: Buffer.from(f.body).toString('base64'),
      }));
      const bundle = Buffer.from(JSON.stringify({ version: 1, directory: 'site', files }));
      await artifact(site, randomUUID(), 'site-bundle.json', 'application/json', bundle, {
        kind: 'site',
        id: 'ws-site-bundle',
      });
      const meta = await viewer.req('GET', `/jobs/${site}/site-bundle`);
      expect(meta.statusCode, meta.body).toBe(200);
      expect(
        meta.json<{ files: { path: string; view: string }[] }>().files.map((f) => [f.path, f.view]),
      ).toEqual([
        ['index.html', 'html'],
        ['app.js', 'source'],
        ['logo.svg', 'source'],
      ]);
      const page = await viewer.req('GET', `/jobs/${site}/site-bundle/file?path=index.html`);
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers['content-security-policy']).toBe(HTML_PREVIEW_CSP);
      expect(HTML_PREVIEW_CSP).toMatch(/\bsandbox$/);
      expect(HTML_PREVIEW_CSP).not.toMatch(/allow-scripts|allow-same-origin/);
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      const js = await viewer.req('GET', `/jobs/${site}/site-bundle/file?path=app.js`);
      expect(js.headers['content-type']).toBe('text/plain; charset=utf-8');
      const svg = await viewer.req('GET', `/jobs/${site}/site-bundle/file?path=logo.svg`);
      expect(svg.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect((await viewer.req('GET', `/jobs/${site}/site-bundle/file?path=../etc/passwd`)).statusCode).toBe(
        404,
      );
      expect((await outsider.req('GET', `/jobs/${site}/site-bundle`)).statusCode).toBe(404);
      await h.db.pool.query(`UPDATE job_artifacts SET redacted = true WHERE job_id = $1 AND kind = 'site'`, [
        site,
      ]);
      expect((await viewer.req('GET', `/jobs/${site}/site-bundle/file?path=index.html`)).statusCode).toBe(
        409,
      );
    });
  });
});
