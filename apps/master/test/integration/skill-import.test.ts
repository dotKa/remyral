import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { SKILL_SIGNATURE_CONTEXT, skillKeyId, skillSha256 } from '@remyral/protocol';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PanelSkillsKey } from '../../src/skills/panel-key.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p14-skill-import (ADR-0054, docs/design/p14-mcp-skills.md §3, §7, §8): import previews from a folder, a zip and a
 * GitHub link (pinned to a commit, fake api.github.com), findings (a secret blocks), publish with the panel key behind
 * an always-fresh step-up, provenance, the owners' critical notification, audit, and the per-project "offline-signed
 * only" trust level enforced by the master (assignment, publish, delivery) and sent to the worker.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 11;

const md = (name: string, body = 'Do the thing carefully.') =>
  `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n\n# ${name}\n\n${body}\n`;
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

function keypair(): { key: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: publicKey.export({ format: 'jwk' }).x ?? '' };
}

function offlineSigned(k: { key: KeyObject; pub: string }, id: string, version: string) {
  const files: Record<string, string> = { 'SKILL.md': md(id, 'Offline signed.') };
  const manifest = {
    schema: 1,
    kind: 'remana.skill',
    id,
    title: id,
    version,
    description: `${id} skill`,
    runtimes: ['codex'],
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: skillSha256(content),
      size: Buffer.byteLength(content),
      executable: false,
    })),
    createdAt: '2026-10-20T10:00:00.000Z',
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const signature = sign(null, Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT), bytes]), k.key).toString(
    'base64url',
  );
  return { manifest: bytes.toString('base64'), signature: { keyId: skillKeyId(k.pub), signature }, files };
}

/** One-entry-per-file stored/deflated zip. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [n, content] of Object.entries(files)) {
    const name = Buffer.from(n);
    const data = Buffer.from(content);
    const body = deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data) >>> 0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data) >>> 0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, body);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A fake api.github.com serving one repository `acme/skills` with `skills/review` at one commit. */
function fakeGitHub() {
  const gitSha = (b: Buffer) =>
    createHash('sha1')
      .update(`blob ${String(b.length)}\u0000`)
      .update(b)
      .digest('hex');
  const h = (s: string) => createHash('sha1').update(s).digest('hex');
  const skill = Buffer.from(md('code-review', 'Review the diff. See https://example.org/guide.'));
  const lic = Buffer.from('Apache License\nVersion 2.0, January 2004\n');
  const commit = h('c1');
  const root = h('root');
  const sub = h('sub');
  const urls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = (url: string): Promise<Response> => {
    urls.push(url);
    const p = url.replace('https://api.github.com', '');
    const routes: Record<string, unknown> = {
      '/repos/acme/skills/commits/main': { sha: commit, commit: { tree: { sha: root } } },
      [`/repos/acme/skills/git/trees/${root}`]: {
        tree: [{ path: 'skills', mode: '040000', type: 'tree', sha: h('skills') }],
      },
      [`/repos/acme/skills/git/trees/${h('skills')}`]: {
        tree: [{ path: 'review', mode: '040000', type: 'tree', sha: sub }],
      },
      [`/repos/acme/skills/git/trees/${sub}?recursive=1`]: {
        truncated: false,
        tree: [
          { path: 'SKILL.md', mode: '100644', type: 'blob', sha: gitSha(skill), size: skill.length },
          { path: 'LICENSE.txt', mode: '100644', type: 'blob', sha: gitSha(lic), size: lic.length },
        ],
      },
      [`/repos/acme/skills/git/blobs/${gitSha(skill)}`]: {
        encoding: 'base64',
        content: skill.toString('base64'),
      },
      [`/repos/acme/skills/git/blobs/${gitSha(lic)}`]: {
        encoding: 'base64',
        content: lic.toString('base64'),
      },
    };
    const body = routes[p];
    return Promise.resolve(body === undefined ? json({ message: 'Not Found' }, 404) : json(body));
  };
  return { fetch, urls, commit };
}

describeIntegration(
  'skills: panel import, publish with the panel key, project trust (integration)',
  { timeout: 120_000 },
  () => {
    const offline = keypair();
    const gh = fakeGitHub();
    let panel: PanelSkillsKey;
    let h: Harness;
    let url: string;
    let owner: Client;
    let viewer: Client;
    let secret: string;
    let fileUrl: string;
    const dirs: string[] = [];
    const workers: JobWorker[] = [];
    const prefix = `si${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      const root = await tempDataDir(dirs);
      const { privateKey } = generateKeyPairSync('ed25519');
      const pem = join(root, 'skills-panel.pem');
      await writeFile(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      panel = await PanelSkillsKey.fromFile(pem);
      h = new Harness();
      await h.start({
        skills: { publicKeys: [offline.pub], panelKey: panel, githubFetch: gh.fetch },
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
      const viewerId = await h.createUser('viewer1', PW, 'viewer');
      const v = await enroll(h, 'viewer1', PW);
      viewer = await fullLogin(h, 'viewer1', PW, v.secret);
      await h.grant(viewerId, [PROJECT], 'viewer');
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [PROJECT],
      );
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
      h.clock.advance(31_000);
      expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    }

    async function auditCount(action: string, outcome: string): Promise<number> {
      const { rows } = await h.db.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM audit_events WHERE action = $1 AND outcome = $2',
        [action, outcome],
      );
      return Number(rows[0]?.n ?? 0);
    }

    interface View {
      id: string;
      blocked: boolean;
      state: string;
      suggested: {
        skillId: string | null;
        title: string | null;
        description: string | null;
        version: string;
      };
      findings: { kind: string; severity: string; path?: string }[];
      files: { path: string; executable: boolean }[];
      source: { repo?: string; commit?: string; path?: string };
    }

    const publishBody = (skillId: string, extra: Record<string, unknown> = {}) => ({
      skillId,
      title: skillId,
      description: `Use when testing ${skillId}.`,
      version: '1.0.0',
      runtimes: ['codex'],
      ...extra,
    });

    it('folder import: preview with findings, nothing signed; publish needs admin + always-fresh step-up', async () => {
      const files = {
        kind: 'files',
        files: [
          { path: 'lint-helper/SKILL.md', data: b64(md('lint-helper', 'Run `scripts/lint.sh`.')) },
          { path: 'lint-helper/scripts/lint.sh', data: b64('#!/bin/sh\nnpm run lint\n') },
          { path: 'lint-helper/.DS_Store', data: b64('junk') },
        ],
      };
      expect((await viewer.req('POST', '/skills/imports', files)).statusCode).toBe(403);
      await stepUp();
      const res = await owner.req('POST', '/skills/imports', files);
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json<View>();
      expect(view).toMatchObject({
        blocked: false,
        state: 'previewed',
        suggested: { skillId: 'lint-helper', version: '1.0.0', description: 'Use when testing lint-helper.' },
      });
      expect(view.files.map((f) => [f.path, f.executable])).toEqual([
        ['SKILL.md', false],
        ['scripts/lint.sh', true],
      ]);
      expect(view.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(['script', 'skipped']));
      expect(
        (await h.db.pool.query("SELECT 1 FROM skill_versions WHERE skill_id = 'lint-helper'")).rowCount,
      ).toBe(0);
      expect((await owner.req('GET', `/skills/imports/${view.id}`)).json()).toMatchObject({ id: view.id });
      expect((await viewer.req('GET', `/skills/imports/${view.id}`)).statusCode).toBe(403);

      // Always-fresh: a step-up older than 10 minutes is not enough to sign.
      h.clock.advance(11 * 60_000);
      const stale = await owner.req('POST', `/skills/imports/${view.id}/publish`, publishBody('lint-helper'));
      expect(stale.statusCode).toBe(403);
      expect(stale.json()).toMatchObject({ error: 'step_up_required' });
      expect(
        (await viewer.req('POST', `/skills/imports/${view.id}/publish`, publishBody('lint-helper')))
          .statusCode,
      ).toBe(403);
      await stepUp();
      const pub = await owner.req(
        'POST',
        `/skills/imports/${view.id}/publish`,
        publishBody('lint-helper', { assign: { project: PROJECT } }),
      );
      expect(pub.statusCode, pub.body).toBe(201);
      expect(pub.json()).toMatchObject({
        version: {
          version: '1.0.0',
          signer: 'panel',
          keyId: panel.keyId,
          provenance: { kind: 'upload', fileName: 'lint-helper', importId: view.id },
        },
        assignment: { project: PROJECT, skillId: 'lint-helper' },
      });
      // The preview is closed; the version is listed with its provenance.
      expect(
        (await owner.req('POST', `/skills/imports/${view.id}/publish`, publishBody('lint-helper'))).json(),
      ).toMatchObject({ error: 'skill_import_closed' });
      const list = await viewer.req('GET', '/skills');
      const skill = list
        .json<{ skills: { id: string; versions: { provenance: unknown }[] }[] }>()
        .skills.find((s) => s.id === 'lint-helper');
      expect(skill?.versions[0]?.provenance).toMatchObject({ kind: 'upload' });

      // Owners get a critical notification for every panel-signed publish.
      const n = await h.db.pool.query<{ severity: string; title: string }>(
        `SELECT severity, title FROM notifications WHERE kind = 'skills.panel_published'`,
      );
      expect(n.rows[0]).toMatchObject({ severity: 'critical' });
      expect(n.rows[0]?.title).toContain('lint-helper 1.0.0');
      expect(await auditCount('skill.import.preview', 'success')).toBe(1);
      expect(await auditCount('skill.import.publish', 'success')).toBe(1);
      expect(await auditCount('skill.upload', 'success')).toBe(1);
    });

    it('a secret blocks publishing; the value never appears in the preview or the audit', async () => {
      await stepUp();
      const token = `ghp_${'Zx9Yw8Vu7T'.repeat(4)}`;
      const res = await owner.req('POST', '/skills/imports', {
        kind: 'files',
        files: [{ path: 'SKILL.md', data: b64(md('leaky', `export GITHUB_TOKEN=${token}`)) }],
      });
      expect(res.statusCode, res.body).toBe(201);
      const view = res.json<View>();
      expect(view.blocked).toBe(true);
      expect(view.findings).toContainEqual(expect.objectContaining({ kind: 'secret', severity: 'block' }));
      expect(JSON.stringify(view.findings)).not.toContain(token);
      const pub = await owner.req('POST', `/skills/imports/${view.id}/publish`, publishBody('leaky'));
      expect(pub.statusCode).toBe(409);
      expect(pub.json()).toMatchObject({ error: 'skill_import_blocked' });
      const audit = await h.db.pool.query<{ t: string }>(
        `SELECT metadata::text AS t FROM audit_events WHERE action LIKE 'skill.import.%'`,
      );
      expect(audit.rows.map((r) => r.t).join('\n')).not.toContain(token);
      expect((await owner.req('DELETE', `/skills/imports/${view.id}`)).statusCode).toBe(204);
      expect((await owner.req('GET', `/skills/imports/${view.id}`)).json()).toMatchObject({
        state: 'discarded',
      });
    });

    it('zip and GitHub imports; the GitHub version is pinned to the commit and only api.github.com is read', async () => {
      await stepUp();
      const z = await owner.req('POST', '/skills/imports', {
        kind: 'zip',
        fileName: 'notes.zip',
        data: zip({
          'notes/SKILL.md': md('release-notes'),
          'notes/references/style.md': 'Short lines.\n',
        }).toString('base64'),
      });
      expect(z.statusCode, z.body).toBe(201);
      expect(z.json<View>()).toMatchObject({ blocked: false, suggested: { skillId: 'release-notes' } });
      const bad = await owner.req('POST', '/skills/imports', {
        kind: 'zip',
        data: b64('not a zip archive at all!!'),
      });
      expect(bad.json()).toMatchObject({ error: 'skill_import_zip_invalid' });

      const g = await owner.req('POST', '/skills/imports', {
        kind: 'github',
        url: 'https://github.com/acme/skills/tree/main/skills/review',
      });
      expect(g.statusCode, g.body).toBe(201);
      const view = g.json<View>();
      expect(view.source).toMatchObject({ repo: 'acme/skills', path: 'skills/review', commit: gh.commit });
      expect(view.files.map((f) => f.path)).toEqual(['SKILL.md', 'resources/LICENSE.txt']);
      expect(view.findings).toContainEqual(expect.objectContaining({ kind: 'license' }));
      // p22-github-raw: the API for trees, file contents from the raw host pinned to a commit SHA.
      expect(
        gh.urls.every(
          (u) =>
            u.startsWith('https://api.github.com/') ||
            /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(u),
        ),
      ).toBe(true);
      expect(
        (
          await owner.req('POST', '/skills/imports', { kind: 'github', url: 'https://evil.example/x' })
        ).json(),
      ).toMatchObject({
        error: 'github_url_invalid',
      });
      await stepUp();
      const pub = await owner.req('POST', `/skills/imports/${view.id}/publish`, publishBody('code-review'));
      expect(pub.statusCode, pub.body).toBe(201);
      expect(pub.json()).toMatchObject({
        version: {
          provenance: { kind: 'github', repo: 'acme/skills', commit: gh.commit, path: 'skills/review' },
        },
        assignment: null,
      });
    });

    it('project trust "offline-signed only": assignment, publish and delivery refuse panel-signed versions', async () => {
      expect(
        (await viewer.req('PUT', `/projects/${PROJECT}/skill-trust`, { trust: 'offline-only' })).statusCode,
      ).toBe(403);
      await stepUp();
      const set = await owner.req('PUT', `/projects/${PROJECT}/skill-trust`, { trust: 'offline-only' });
      expect(set.statusCode, set.body).toBe(200);
      // lint-helper (panel-signed only) is assigned to the project: it is now skipped.
      expect(set.json()).toMatchObject({ trust: 'offline-only', panelSignedAssignments: ['lint-helper'] });
      expect((await viewer.req('GET', `/projects/${PROJECT}/skill-trust`)).json()).toMatchObject({
        trust: 'offline-only',
      });
      expect((await viewer.req('GET', '/skills')).json()).toMatchObject({ offlineOnlyProjects: [PROJECT] });

      const assign = await owner.req('PUT', '/skills/assignments', {
        skillId: 'code-review',
        project: PROJECT,
      });
      expect(assign.statusCode).toBe(409);
      expect(assign.json()).toMatchObject({ error: 'skill_trust_offline_only' });

      // Publishing an import straight into the project is refused before anything is signed; the preview stays open.
      const imp = await owner.req('POST', '/skills/imports', {
        kind: 'files',
        files: [{ path: 'SKILL.md', data: b64(md('late-skill')) }],
      });
      const id = imp.json<View>().id;
      await stepUp();
      const pub = await owner.req(
        'POST',
        `/skills/imports/${id}/publish`,
        publishBody('late-skill', { assign: { project: PROJECT } }),
      );
      expect(pub.statusCode).toBe(409);
      expect(pub.json()).toMatchObject({ error: 'skill_trust_offline_only' });
      expect((await owner.req('GET', `/skills/imports/${id}`)).json()).toMatchObject({ state: 'previewed' });
      expect(
        (await h.db.pool.query("SELECT 1 FROM skill_versions WHERE skill_id = 'late-skill'")).rowCount,
      ).toBe(0);

      // An offline-signed skill still reaches the project's jobs; the panel-signed one does not.
      expect(
        (await owner.req('POST', '/skills', offlineSigned(offline, 'house-style', '1.0.0'))).statusCode,
      ).toBe(201);
      expect(
        (await owner.req('PUT', '/skills/assignments', { skillId: 'house-style', project: PROJECT }))
          .statusCode,
      ).toBe(200);
      const skillsRoot = await tempDataDir(dirs);
      const dir = await tempDataDir(dirs);
      const workerId = await pairRealWorker(h, url, owner, secret, dir);
      const w = await startJobWorker(url, dir, {
        fileUrl,
        skillKeys: [offline.pub, panel.publicKey],
        panelSkillKeys: [panel.publicKey],
        fake: { skillDelivery: 'native', skillsRoot },
      });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
      const job = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
      expect(job.statusCode, job.body).toBe(201);
      const jobId = job.json<{ job: { id: string } }>().job.id;
      await expect
        .poll(
          async () => (await owner.req('GET', `/jobs/${jobId}`)).json<{ job: { state: string } }>().job.state,
          {
            timeout: 30_000,
          },
        )
        .toBe('SUCCEEDED');
      expect(w.adapter.deliveredSkills.at(-1)?.skills.map((s) => s.id)).toEqual(['house-style']);
      // The orchestrator sends execution.skillTrust with the skills (payload shape: unit skill-import.test.ts), so a
      // skill-trust-v1 worker refuses any panel-signed skill itself.
      expect(await h.app.skills.trustForJob(jobId)).toBe('offline-only');
      expect(await auditCount('project.skill_trust', 'success')).toBe(1);

      // Back to "any": the panel-signed skill reaches new jobs again.
      await stepUp();
      expect((await owner.req('PUT', `/projects/${PROJECT}/skill-trust`, { trust: 'any' })).statusCode).toBe(
        200,
      );
      const job2 = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
      const job2Id = job2.json<{ job: { id: string } }>().job.id;
      await expect
        .poll(
          async () =>
            (await owner.req('GET', `/jobs/${job2Id}`)).json<{ job: { state: string } }>().job.state,
          {
            timeout: 30_000,
          },
        )
        .toBe('SUCCEEDED');
      expect(
        w.adapter.deliveredSkills
          .at(-1)
          ?.skills.map((s) => s.id)
          .sort(),
      ).toEqual(['house-style', 'lint-helper']);
    });
  },
);
