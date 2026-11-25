import { createHash } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditEventInput, AuditLog } from '../../src/audit/audit.js';
import { type ExportManifest, splitExport } from '../../src/audit/export.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const GH_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

interface Person {
  readonly id: string;
  readonly secret: string;
  readonly client: Client;
}

type Roles = Record<Role, Person>;

function spec(runtime = 'claude-code', prompt = 'Fix the flaky test') {
  return {
    runtime,
    prompt,
    repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/x' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 3600 },
  };
}

async function people(h: Harness): Promise<Roles> {
  const out = {} as Record<Role, Person>;
  for (const role of ['owner', 'admin', 'operator', 'viewer'] as const) {
    const username = `${role}1`;
    const id = await h.createUser(username, PW, role);
    // p5-rbac: per-project accounts are members of the projects these tests use.
    if (role === 'operator' || role === 'viewer') {
      await h.grant(id, ['authz', 'export-me', 'flt', 'pages', 'acme'], role);
    }
    const { client, secret } = await enroll(h, username, PW);
    out[role] = { id, secret, client };
  }
  return out;
}

async function stepUp(h: Harness, p: Person): Promise<void> {
  h.clock.advance(30_000);
  const res = await p.client.req('POST', '/auth/step-up', { code: h.code(p.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function auditRows(h: Harness, action: string, outcome?: string) {
  const { rows } = await h.db.pool.query<{
    actor_id: string | null;
    target: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_id, target, metadata FROM audit_events WHERE action = $1 AND ($2::text IS NULL OR outcome = $2)
      ORDER BY id`,
    [action, outcome ?? null],
  );
  return rows;
}

interface Item {
  id: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  actor: { type: string; id: string | null };
}

interface Page {
  items: Item[];
  nextCursor: string | null;
}

async function list(c: Client, qs: string): Promise<Page> {
  const res = await c.req('GET', `/audit?${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describeIntegration('audit explorer, jobs read API and exports (integration)', () => {
  let h: Harness;
  let p: Roles;
  let jobs: JobStore;
  /** Writer for seeded events with explicit timestamps. */
  let seedAt: Date;
  let seeder: AuditLog;
  const JOB_UUID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

  async function seed(e: AuditEventInput, at: string): Promise<string> {
    seedAt = new Date(at);
    return (await seeder.record(e)).id;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      accessLimits: { export: { max: 100, windowMs: 60_000 }, verify: { max: 100, windowMs: 60_000 } },
    });
    p = await people(h);
    seedAt = new Date('2026-01-01T00:00:00Z');
    seeder = new AuditLog(h.db.pool, () => seedAt);
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });

    await seed(
      {
        actor: { type: 'worker', id: 'mac-mini-01' },
        action: 'job.transition',
        target: `job:${JOB_UUID}`,
        outcome: 'success',
        metadata: { from: 'QUEUED', to: 'RESERVED' },
      },
      '2026-03-01T10:00:00Z',
    );
    await seed(
      {
        actor: { type: 'system', id: null },
        action: 'approval.expire',
        target: 'approval:abc',
        outcome: 'denied',
        metadata: { reason: '50%_off sale' },
      },
      '2026-03-02T10:00:00Z',
    );
    await seed(
      {
        actor: { type: 'user', id: 'seed-user' },
        action: 'user.update',
        target: '=HYPERLINK("http://evil.example")',
        outcome: 'failure',
        metadata: { password: 'hunter2-secret', note: `token ${GH_TOKEN}` },
      },
      '2026-03-03T10:00:00Z',
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('authorization', () => {
    it('audit routes are owner/admin only; denials are audited', async () => {
      expect((await p.owner.client.req('GET', '/audit')).statusCode).toBe(200);
      expect((await p.admin.client.req('GET', '/audit')).statusCode).toBe(200);
      for (const role of ['operator', 'viewer'] as const) {
        for (const url of ['/audit', '/audit/events/1', '/audit/verify', '/audit/export']) {
          const res = await p[role].client.req('GET', url);
          expect(res.statusCode, `${role} ${url}`).toBe(403);
          expect(res.json()).toMatchObject({ error: 'forbidden' });
        }
      }
      const denied = await auditRows(h, 'audit.read', 'denied');
      expect(denied.map((r) => r.actor_id)).toEqual(expect.arrayContaining([p.operator.id, p.viewer.id]));
      expect(await auditRows(h, 'audit.export', 'denied')).toHaveLength(2);
    });

    it('job reads are open to every role; job export needs operator+', async () => {
      const { job } = await jobs.create({ project: 'authz', spec: spec(), actor: CREATOR });
      for (const role of ['owner', 'admin', 'operator', 'viewer'] as const) {
        expect((await p[role].client.req('GET', '/jobs')).statusCode, role).toBe(200);
        expect((await p[role].client.req('GET', `/jobs/${job.id}`)).statusCode, role).toBe(200);
      }
      const viewer = await p.viewer.client.req('GET', `/jobs/${job.id}/export`);
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json()).toMatchObject({ error: 'forbidden' });
      expect((await auditRows(h, 'job.export', 'denied')).map((r) => r.target)).toContain(`job:${job.id}`);
      await stepUp(h, p.operator);
      expect((await p.operator.client.req('GET', `/jobs/${job.id}/export`)).statusCode).toBe(200);
    });

    it('exports require a fresh step-up', async () => {
      h.clock.advance(11 * 60_000);
      for (const who of [p.owner, p.admin, p.operator, p.viewer]) {
        // keep the sessions alive across the jump (idle timeout)
        expect((await who.client.req('GET', '/auth/session')).statusCode).toBe(200);
      }
      const res = await p.admin.client.req('GET', '/audit/export');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
      expect((await auditRows(h, 'audit.export', 'denied')).at(-1)?.metadata).toMatchObject({
        reason: 'step_up_required',
      });
      await stepUp(h, p.admin);
      expect((await p.admin.client.req('GET', '/audit/export')).statusCode).toBe(200);
    });
  });

  describe('audit search', () => {
    it('filters by actor, outcome, action prefix, target and time range', async () => {
      expect((await list(p.owner.client, 'actorType=worker&actorId=mac-mini-01')).items).toHaveLength(1);
      expect(
        (await list(p.owner.client, 'outcome=denied&action=approval.')).items.map((i) => i.target),
      ).toEqual(['approval:abc']);
      expect((await list(p.owner.client, `target=job:${JOB_UUID}`)).items).toHaveLength(1);
      const ranged = await list(
        p.owner.client,
        `from=${encodeURIComponent('2026-03-02T00:00:00Z')}&to=${encodeURIComponent('2026-03-03T00:00:00Z')}`,
      );
      expect(ranged.items.map((i) => i.action)).toEqual(['approval.expire']);
      // action prefix is literal: "_" is not a wildcard
      expect((await list(p.owner.client, 'action=job_transition')).items).toHaveLength(0);
    });

    it('free text matches identifiers as substrings, LIKE metacharacters literally, all terms required', async () => {
      expect((await list(p.owner.client, 'q=mac-mini')).items.map((i) => i.action)).toEqual([
        'job.transition',
      ]);
      expect((await list(p.owner.client, `q=${JOB_UUID.slice(0, 8)}`)).items).toHaveLength(1);
      expect((await list(p.owner.client, 'q=RESERVED')).items.map((i) => i.action)).toContain(
        'job.transition',
      );
      expect(
        (await list(p.owner.client, `q=${encodeURIComponent('%_')}`)).items.map((i) => i.target),
      ).toEqual(['approval:abc']);
      expect((await list(p.owner.client, 'q=mac-mini+approval')).items).toHaveLength(0);
      expect(
        (await list(p.owner.client, `q=${encodeURIComponent("'; DROP TABLE audit_events; --")}`)).items,
      ).toHaveLength(0);
    });

    it('never finds or returns a secret: metadata stays redacted', async () => {
      expect((await list(p.owner.client, 'q=hunter2')).items).toHaveLength(0);
      const [ev] = (await list(p.owner.client, 'actorId=seed-user')).items;
      expect(ev?.metadata).toMatchObject({ password: '[REDACTED]' });
      expect(JSON.stringify(ev)).not.toContain(GH_TOKEN);
      expect(JSON.stringify(ev)).not.toContain('hunter2');
      const one = await p.owner.client.req('GET', `/audit/events/${ev?.id ?? ''}`);
      expect(one.statusCode).toBe(200);
      expect(one.body).not.toContain(GH_TOKEN);
      expect((await p.owner.client.req('GET', '/audit/events/999999')).statusCode).toBe(404);
    });

    it('rejects invalid cursors and parameters', async () => {
      expect((await p.owner.client.req('GET', '/audit?cursor=bogus')).json()).toMatchObject({
        error: 'invalid_cursor',
      });
      expect((await p.owner.client.req('GET', '/audit?limit=1000')).statusCode).toBe(400);
      expect((await p.owner.client.req('GET', '/audit?outcome=maybe')).statusCode).toBe(400);
      expect((await p.owner.client.req('GET', '/audit?from=yesterday')).statusCode).toBe(400);
      expect(
        (await p.owner.client.req('GET', `/audit?action=${encodeURIComponent("a' OR 1=1")}`)).statusCode,
      ).toBe(400);
    });

    it('keyset pagination is stable while events are appended concurrently', async () => {
      const writer = new AuditLog(h.db.pool, h.clock.now);
      const append = (n: number) =>
        writer.record({
          actor: { type: 'system' },
          action: 'test.page',
          outcome: 'success',
          metadata: { n },
        });
      for (let i = 0; i < 70; i++) await append(i); // ids cross 100: catches text-vs-numeric ordering
      const { rows } = await h.db.pool.query<{ id: string }>(
        "SELECT id::text AS id FROM audit_events WHERE action = 'test.page' ORDER BY audit_events.id DESC",
      );
      const snapshot = rows.map((r) => r.id);
      const maxSnapshot = BigInt(snapshot[0] ?? '0');

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let k = 100;
      do {
        // Concurrent writers race the page request.
        const [page]: [Page, ...unknown[]] = await Promise.all([
          list(p.admin.client, `action=test.page&limit=7${cursor ? `&cursor=${cursor}` : ''}`),
          append(k++),
          append(k++),
        ]);
        // After page 1, every row is older than the cursor, hence part of the snapshot.
        if (pages > 0) for (const i of page.items) expect(BigInt(i.id) <= maxSnapshot).toBe(true);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 50);

      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      for (const id of snapshot) expect(seen).toContain(id); // nothing skipped
      // Only page 1 may contain rows appended after the snapshot; later pages only older rows.
      const extra = seen.filter((id) => BigInt(id) > maxSnapshot);
      expect(extra.length).toBeLessThanOrEqual(7);
      const ids = seen.map((s) => BigInt(s));
      expect([...ids].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(ids); // strictly newest first
    });
  });

  describe('export', () => {
    it('audit JSON Lines export: manifest hash equals the body hash; export is audited', async () => {
      await stepUp(h, p.owner);
      const res = await p.owner.client.req('GET', '/audit/export?actorType=worker&format=jsonl');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-ndjson');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="audit-export-\d{8}T\d{6}Z\.jsonl"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      const { body, manifest } = splitExport(res.body);
      expect(manifest.sha256).toBe(sha(body));
      expect(manifest).toMatchObject({
        kind: 'audit',
        format: 'jsonl',
        record_count: 1,
        truncated: false,
        generated_by: p.owner.id,
        filters: { actorType: 'worker' },
      });
      expect((manifest.chain_head as { id: string }).id).toMatch(/^\d+$/);
      const rec = JSON.parse(body.trim()) as Record<string, unknown>;
      expect(rec).toMatchObject({ type: 'audit_event', actor_id: 'mac-mini-01', action: 'job.transition' });
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);

      const started = (await auditRows(h, 'audit.export.started')).at(-1);
      const completed = (await auditRows(h, 'audit.export.completed')).at(-1);
      expect(started).toMatchObject({ actor_id: p.owner.id });
      expect(completed?.metadata).toMatchObject({
        sha256: manifest.sha256,
        recordCount: 1,
        truncated: false,
      });
    });

    it('audit CSV export neutralises formulas and keeps secrets redacted', async () => {
      const res = await p.owner.client.req('GET', '/audit/export?format=csv&actorId=seed-user');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const { body, manifest } = splitExport(res.body);
      expect(manifest.sha256).toBe(sha(body));
      expect(manifest.record_count).toBe(1);
      const [header, row] = body.trimEnd().split('\r\n');
      expect(header).toBe(
        '"id","occurred_at","actor_type","actor_id","action","target","outcome","ip","user_agent","metadata","prev_hash","hash"',
      );
      expect(row).toContain('"\'=HYPERLINK(""http://evil.example"")"');
      expect(res.body).not.toContain(GH_TOKEN);
      expect(res.body).not.toContain('hunter2');
      expect(manifest.redacted_records).toBe(1); // the GitHub token in the note was caught at export time
    });

    it('job export: the full task record, sanitised, hashed and audited', async () => {
      const { job } = await jobs.create({
        project: 'export-me',
        spec: {
          ...spec('codex', `Use ${GH_TOKEN} to push`),
          repository: {
            url: 'https://bot:s3cr3t-pass@example.com/acme/repo.git',
            baseRef: 'main',
            workBranch: 'w',
          },
        },
        actor: CREATOR,
        submit: true,
      });
      const grant = await jobs.acquireLease(job.id, 'linux-01', 3_600_000);
      await jobs.transition(job.id, 'lease_acked', {
        actor: { type: 'worker', id: 'linux-01' },
        epoch: grant.lease.epoch,
      });

      const detail = await p.viewer.client.req('GET', `/jobs/${job.id}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.body).not.toContain(GH_TOKEN);
      expect(detail.body).not.toContain('s3cr3t-pass');
      const d = detail.json<{
        job: { spec: { repository: { url: string } } };
        transitions: { to: string }[];
        attempts: { workerId: string }[];
        leases: { epoch: number }[];
      }>();
      expect(d.job.spec.repository.url).toBe('https://example.com/acme/repo.git');
      expect(d.transitions.map((t) => t.to)).toEqual(['DRAFT', 'QUEUED', 'RESERVED', 'STARTING']);
      expect(d.attempts).toEqual([expect.objectContaining({ workerId: 'linux-01' })]);
      expect(d.leases).toEqual([expect.objectContaining({ epoch: 1 })]);

      await stepUp(h, p.operator);
      const res = await p.operator.client.req('GET', `/jobs/${job.id}/export`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain(GH_TOKEN);
      expect(res.body).not.toContain('s3cr3t-pass');
      const { body, manifest } = splitExport(res.body);
      expect(manifest.sha256).toBe(sha(body));
      const types = body
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types).toEqual([
        'job',
        'transition',
        'transition',
        'transition',
        'transition',
        'attempt',
        'lease',
      ]);
      expect(manifest).toMatchObject({ kind: 'job', record_count: 7, job_id: job.id, job_state: 'STARTING' });
      expect(manifest.redacted_records).toBeGreaterThanOrEqual(1);
      const done = (await auditRows(h, 'job.export.completed')).at(-1);
      expect(done).toMatchObject({ target: `job:${job.id}`, actor_id: p.operator.id });
      expect(done?.metadata).toMatchObject({ sha256: manifest.sha256, recordCount: 7 });

      expect(
        (await p.operator.client.req('GET', '/jobs/00000000-0000-4000-8000-0000000000ff/export')).statusCode,
      ).toBe(404);
    });
  });

  describe('jobs list', () => {
    it('filters by state, project, runtime and worker', async () => {
      const a = (await jobs.create({ project: 'flt', spec: spec('pi'), actor: CREATOR, submit: true })).job;
      // Distinct timestamps: equal created_at would order by random uuid and flake.
      h.clock.advance(1);
      const b = (await jobs.create({ project: 'flt', spec: spec('opencode'), actor: CREATOR })).job;
      await jobs.acquireLease(a.id, 'rpi-01', 3_600_000);
      const ids = async (qs: string) =>
        (await p.viewer.client.req('GET', `/jobs?${qs}`))
          .json<{ items: { id: string }[] }>()
          .items.map((i) => i.id);
      expect(await ids('project=flt')).toEqual([b.id, a.id]);
      expect(await ids('project=flt&runtime=pi')).toEqual([a.id]);
      expect(await ids('project=flt&state=DRAFT')).toEqual([b.id]);
      expect(await ids('project=flt&state=DRAFT,RESERVED')).toEqual([b.id, a.id]);
      expect(await ids('worker=rpi-01')).toEqual([a.id]);
      expect((await p.viewer.client.req('GET', '/jobs?state=NOPE')).statusCode).toBe(400);
      expect((await p.viewer.client.req('GET', '/jobs?runtime=bash')).statusCode).toBe(400);
      expect((await p.viewer.client.req('GET', '/jobs/not-a-uuid')).statusCode).toBe(400);
      expect(
        (await p.viewer.client.req('GET', '/jobs/00000000-0000-4000-8000-0000000000ff')).statusCode,
      ).toBe(404);
    });

    it('keyset pagination is stable while jobs are created concurrently', async () => {
      for (let i = 0; i < 12; i++) {
        h.clock.advance(1);
        await jobs.create({ project: 'pages', spec: spec(), actor: CREATOR });
      }
      const { rows } = await h.db.pool.query<{ id: string }>("SELECT id FROM jobs WHERE project = 'pages'");
      const snapshot = rows.map((r) => r.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        h.clock.advance(1);
        const [res]: [LightMyRequestResponse, ...unknown[]] = await Promise.all([
          p.viewer.client.req('GET', `/jobs?project=pages&limit=5${cursor ? `&cursor=${cursor}` : ''}`),
          jobs.create({ project: 'pages', spec: spec(), actor: CREATOR }),
        ]);
        const page: { items: { id: string }[]; nextCursor: string | null } = res.json();
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of snapshot) expect(seen).toContain(id);
      expect((await p.viewer.client.req('GET', '/jobs?cursor=e30')).json()).toMatchObject({
        error: 'invalid_cursor',
      });
    });
  });

  describe('chain verification', () => {
    it('reports ok over the whole chain and a range, and is audited', async () => {
      const all = await p.admin.client.req('GET', '/audit/verify');
      expect(all.statusCode, all.body).toBe(200);
      const full = all.json<{ ok: boolean; checked: number; anchored: string; headHash: string }>();
      expect(full).toMatchObject({ ok: true, anchored: 'genesis' });
      expect(full.checked).toBeGreaterThan(50);
      const range = await p.admin.client.req('GET', '/audit/verify?fromId=5&toId=9');
      expect(range.json()).toMatchObject({
        ok: true,
        checked: 5,
        fromId: '5',
        toId: '9',
        anchored: 'predecessor',
      });
      const byTime = await p.admin.client.req(
        'GET',
        `/audit/verify?from=${encodeURIComponent('2026-03-01T00:00:00Z')}&to=${encodeURIComponent('2026-03-04T00:00:00Z')}`,
      );
      expect(byTime.json()).toMatchObject({ ok: true, checked: 3 });
      expect((await auditRows(h, 'audit.verify', 'success')).length).toBeGreaterThanOrEqual(3);
    });

    it('reports the first broken link after tampering', async () => {
      const [ev] = (await list(p.owner.client, 'actorType=worker&actorId=mac-mini-01')).items;
      const id = ev?.id ?? '';
      await h.db.pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete');
      await h.db.pool.query("UPDATE audit_events SET target = 'job:forged' WHERE id = $1", [id]);
      await h.db.pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete');

      const res = await p.owner.client.req('GET', '/audit/verify');
      expect(res.json()).toMatchObject({ ok: false, brokenAtId: id, reason: 'hash_mismatch' });
      const before = await p.owner.client.req('GET', `/audit/verify?toId=${String(BigInt(id) - 1n)}`);
      expect(before.json()).toMatchObject({ ok: true });
      expect((await auditRows(h, 'audit.verify', 'failure')).at(-1)?.metadata).toMatchObject({
        brokenAtId: id,
      });
    });
  });
});

describeIntegration('export limits and rate limiting (integration)', () => {
  let h: Harness;
  let owner: Person;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      accessLimits: { export: { max: 3, windowMs: 60_000 }, verify: { max: 1, windowMs: 60_000 } },
      exportLimits: { maxRecords: 3 },
    });
    const id = await h.createUser('own', PW, 'owner');
    const { client, secret } = await enroll(h, 'own', PW);
    owner = { id, client, secret };
    const log = new AuditLog(h.db.pool, h.clock.now);
    for (let i = 0; i < 5; i++) {
      await log.record({
        actor: { type: 'system' },
        action: 'test.limit',
        outcome: 'success',
        metadata: { i },
      });
    }
  });
  afterAll(async () => {
    await h.stop();
  });

  it('truncates at the record limit and continues from next_cursor', async () => {
    await stepUp(h, owner);
    const first = await owner.client.req('GET', '/audit/export?action=test.limit');
    const a = splitExport(first.body);
    expect(a.manifest).toMatchObject({ record_count: 3, truncated: true });
    expect(a.manifest.next_cursor).toEqual(expect.any(String));
    const second = await owner.client.req(
      'GET',
      `/audit/export?action=test.limit&cursor=${a.manifest.next_cursor ?? ''}`,
    );
    const b = splitExport(second.body);
    expect(b.manifest).toMatchObject({ record_count: 2, truncated: false, next_cursor: null });
    const ids = [a, b].flatMap((x) =>
      x.body
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { metadata: { i: number } }).metadata.i),
    );
    expect(ids).toEqual([0, 1, 2, 3, 4]);
    expect((b.manifest as ExportManifest & { filters: { after_id: string } }).filters.after_id).toMatch(
      /^\d+$/,
    );
  });

  it('rate-limits exports and verification per user (denials audited)', async () => {
    expect((await owner.client.req('GET', '/audit/export')).statusCode).toBe(200); // 3rd export
    const limited = await owner.client.req('GET', '/audit/export');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
    const { rows } = await h.db.pool.query<{ metadata: { reason: string } }>(
      "SELECT metadata FROM audit_events WHERE action = 'audit.export' AND outcome = 'denied'",
    );
    expect(rows.map((r) => r.metadata.reason)).toEqual(['rate_limited']);
    expect((await owner.client.req('GET', '/audit/verify')).statusCode).toBe(200);
    expect((await owner.client.req('GET', '/audit/verify')).statusCode).toBe(429);
  });
});
