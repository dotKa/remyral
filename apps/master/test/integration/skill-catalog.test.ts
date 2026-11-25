import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PanelSkillsKey } from '../../src/skills/panel-key.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { fakeGitHubApi, skillCreatorFixture } from '../helpers/fake-github-api.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p14-skill-catalogs (ADR-0054 decision 6, docs/design/p14-mcp-skills.md P2): the Anthropic skills catalog (a fake
 * api.github.com serving the real `skill-creator` skill of github.com/anthropics/skills), admin-configured catalog
 * sources (audited, step-up), an import from a catalog entry pinned to the listing's commit, and layout v2 end to end:
 * the 225 KB / 18-file skill is published as layout 2, a worker without `skills-layout-v2` is never chosen
 * (`skill_layout_unsupported`), and a real worker daemon with it receives the skill out of band (SKILL_FILE_REQUEST,
 * verified against the signed manifest) and materialises every file byte for byte.
 */
const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;

const md = (name: string) => `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n\n# ${name}\n`;

describeIntegration('skills: catalogs and layout v2 delivery (integration)', { timeout: 180_000 }, () => {
  const fx = skillCreatorFixture();
  const files: Record<string, string> = { 'README.md': '# Skills', 'template/SKILL.md': md('template') };
  for (const [p, c] of Object.entries(fx.files)) files[`skills/skill-creator/${p}`] = c;
  files['skills/pdf-lite/SKILL.md'] = md('pdf-lite');
  files['skills/pdf-lite/forms.md'] = 'Fill PDF forms.\n';
  const gh = fakeGitHubApi([
    { owner: 'anthropics', repo: 'skills', files },
    { owner: 'acme', repo: 'team-skills', files: { 'house/style/SKILL.md': md('house-style') } },
  ]);
  const commit = gh.commitOf('anthropics/skills');
  let panel: PanelSkillsKey;
  let h: Harness;
  let url: string;
  let owner: Client;
  let viewer: Client;
  let secret: string;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];
  const prefix = `sc${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const root = await tempDataDir(dirs);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = join(root, 'skills-panel.pem');
    await writeFile(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    panel = await PanelSkillsKey.fromFile(pem);
    h = new Harness();
    await h.start({
      skills: { publicKeys: [], panelKey: panel, githubFetch: gh.fetch },
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: prefix,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
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

  async function auditCount(action: string, outcome = 'success'): Promise<number> {
    const { rows } = await h.db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_events WHERE action = $1 AND outcome = $2',
      [action, outcome],
    );
    return Number(rows[0]?.n ?? 0);
  }

  interface Catalog {
    enabled: boolean;
    sources: { id: string; repo: string; commit: string | null; builtin: boolean; error: string | null }[];
    entries: {
      id: string;
      name: string | null;
      commit: string;
      fit: string;
      fileCount: number;
      path: string;
    }[];
  }

  it('lists the built-in Anthropic catalog pinned to its commit (viewers may read; cached)', async () => {
    const res = await viewer.req('GET', '/skills/catalog');
    expect(res.statusCode, res.body).toBe(200);
    const cat = res.json<Catalog>();
    expect(cat.enabled).toBe(true);
    expect(cat.sources).toEqual([
      expect.objectContaining({
        id: 'anthropic',
        repo: 'anthropics/skills',
        commit,
        builtin: true,
        error: null,
      }),
    ]);
    expect(cat.entries.map((e) => [e.id, e.name, e.fit, e.fileCount])).toEqual([
      ['anthropic:skills/pdf-lite', 'pdf-lite', 'v2', 2],
      ['anthropic:skills/skill-creator', 'skill-creator', 'v2', 18],
    ]);
    expect(cat.entries.every((e) => e.commit === commit)).toBe(true);
    const search = await viewer.req('GET', '/skills/catalog?q=creator');
    expect(search.json<Catalog>().entries.map((e) => e.name)).toEqual(['skill-creator']);
    // Cached: a second listing costs no GitHub request.
    const before = gh.urls.length;
    await viewer.req('GET', '/skills/catalog');
    expect(gh.urls.length).toBe(before);
    // p22-github-raw: the API for trees, file contents from the raw host pinned to a commit SHA.
    expect(
      gh.urls.every(
        (u) =>
          u.startsWith('https://api.github.com/') ||
          /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(u),
      ),
    ).toBe(true);
  });

  it('catalog sources: admin + step-up to change, audited; the built-in one cannot be removed', async () => {
    const body = { title: 'Team skills', repo: 'acme/team-skills', path: 'house' };
    expect((await viewer.req('PUT', '/skills/catalog/sources/team', body)).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('PUT', '/skills/catalog/sources/team', body);
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });
    await stepUp();
    const added = await owner.req('PUT', '/skills/catalog/sources/team', body);
    expect(added.statusCode, added.body).toBe(200);
    expect(
      (await owner.req('PUT', '/skills/catalog/sources/team', { ...body, repo: 'not a repo' })).statusCode,
    ).toBe(400);
    const list = (await viewer.req('GET', '/skills/catalog?source=team')).json<Catalog>();
    expect(list.entries.map((e) => [e.id, e.name, e.fit])).toEqual([
      ['team:house/style', 'house-style', 'v1'],
    ]);
    expect(
      (await owner.req('PUT', '/skills/catalog/sources/anthropic', { title: 'X', repo: 'evil/repo' })).json(),
    ).toMatchObject({ error: 'catalog_source_builtin' });
    expect((await owner.req('DELETE', '/skills/catalog/sources/anthropic')).json()).toMatchObject({
      error: 'catalog_source_builtin',
    });
    expect((await owner.req('POST', '/skills/catalog/sources/team/refresh')).statusCode).toBe(200);
    expect((await viewer.req('POST', '/skills/catalog/sources/team/refresh')).statusCode).toBe(403);
    expect((await owner.req('DELETE', '/skills/catalog/sources/team')).statusCode).toBe(204);
    expect(await auditCount('skill.catalog.source')).toBe(2);
    expect(await auditCount('skill.catalog.refresh')).toBe(1);
  });

  it('a catalog skill (skill-creator, 18 files / 225 KB) imports as layout v2 and reaches a v2 worker out of band', async () => {
    await stepUp();
    const imp = await owner.req('POST', '/skills/imports', {
      kind: 'catalog',
      entryId: 'anthropic:skills/skill-creator',
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const view = imp.json<{
      id: string;
      blocked: boolean;
      layout: number;
      sourceKind: string;
      source: Record<string, string>;
      files: { path: string; size: number }[];
      limits: { maxFiles: number; maxTotalBytes: number };
    }>();
    expect(view).toMatchObject({
      blocked: false,
      layout: 2,
      sourceKind: 'catalog',
      source: { catalog: 'anthropic', repo: 'anthropics/skills', path: 'skills/skill-creator', commit },
      limits: { maxFiles: 64, maxTotalBytes: 512 * 1024 },
    });
    expect(view.files).toHaveLength(18);
    expect(
      (
        await owner.req('POST', '/skills/imports', { kind: 'catalog', entryId: 'anthropic:skills/nope' })
      ).json(),
    ).toMatchObject({ error: 'catalog_entry_not_found' });

    await stepUp();
    const pub = await owner.req('POST', `/skills/imports/${view.id}/publish`, {
      skillId: 'skill-creator',
      title: 'Skill creator',
      description: 'Create, evaluate and improve skills.',
      version: '1.0.0',
      runtimes: ['codex'],
      assign: { project: PROJECT },
    });
    expect(pub.statusCode, pub.body).toBe(201);
    expect(pub.json()).toMatchObject({
      version: {
        layout: 2,
        signer: 'panel',
        provenance: { kind: 'catalog', catalog: 'anthropic', repo: 'anthropics/skills', commit },
      },
      assignment: { project: PROJECT },
    });
    const skills = await viewer.req('GET', '/skills');
    expect(skills.json()).toMatchObject({
      layouts: { v1: { maxFiles: 32 }, v2: { maxFiles: 64, maxJobBytes: 640 * 1024 } },
    });

    // An older worker (no skills-layout-v2) is never chosen; the job says why.
    const oldDir = await tempDataDir(dirs);
    const oldId = await pairRealWorker(h, url, owner, secret, oldDir);
    const old = await startJobWorker(url, oldDir, {
      fileUrl,
      skillKeys: [panel.publicKey],
      panelSkillKeys: [panel.publicKey],
      fake: { skillDelivery: 'native', skillsRoot: await tempDataDir(dirs) },
    });
    workers.push(old);
    await expect.poll(() => h.app.fleetSessions.hasReported(oldId), { timeout: 15_000 }).toBe(true);
    const job = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(job.statusCode, job.body).toBe(201);
    const jobId = job.json<{ job: { id: string } }>().job.id;
    const codes = async () =>
      (await owner.req('GET', `/jobs/${jobId}`))
        .json<{ orchestration?: { schedule?: { reasons: { code: string }[] } } }>()
        .orchestration?.schedule?.reasons.map((r) => r.code) ?? [];
    // Only an older build: never chosen — the job is infeasible with a reason that says why (as for other features).
    await expect.poll(codes, { timeout: 20_000 }).toContain('skill_layout_unsupported');
    expect(old.adapter.deliveredSkills).toEqual([]);
    expect((await owner.req('GET', `/jobs/${jobId}`)).json<{ attempts: unknown[] }>().attempts).toEqual([]);

    // A worker with skills-layout-v2 takes it: the 225 KB skill exceeds the inline budget and is fetched by digest.
    const skillsRoot = await tempDataDir(dirs);
    const newDir = await tempDataDir(dirs);
    const newId = await pairRealWorker(h, url, owner, secret, newDir);
    const fresh = await startJobWorker(url, newDir, {
      fileUrl,
      skillKeys: [panel.publicKey],
      panelSkillKeys: [panel.publicKey],
      features: ['skills-layout-v2'],
      fake: { skillDelivery: 'native', skillsRoot },
    });
    workers.push(fresh);
    await expect.poll(() => h.app.fleetSessions.hasReported(newId), { timeout: 15_000 }).toBe(true);
    const job2 = await owner.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(job2.statusCode, job2.body).toBe(201);
    const job2Id = job2.json<{ job: { id: string } }>().job.id;
    await expect
      .poll(
        async () =>
          ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
            (await owner.req('GET', `/jobs/${job2Id}`)).json<{ job: { state: string } }>().job.state,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    const final = await owner.req('GET', `/jobs/${job2Id}`);
    expect(final.json<{ job: { state: string } }>().job.state, final.body.slice(0, 3000)).toBe('SUCCEEDED');
    const delivered = fresh.adapter.deliveredSkills.at(-1);
    expect(delivered?.skills.map((s) => s.id)).toEqual(['skill-creator']);
    const got = delivered?.skills[0]?.files ?? [];
    expect(got).toHaveLength(18);
    // Byte for byte what the catalog served (LICENSE moved into resources/, as the importer does).
    for (const [p, content] of Object.entries(fx.files)) {
      const path = p === 'LICENSE.txt' ? 'resources/LICENSE.txt' : p;
      expect(got.find((f) => f.path === path)?.content, path).toBe(content);
    }
    const onDisk = await readFile(
      join(delivered?.dir ?? '', 'skill-creator', 'eval-viewer', 'viewer.html'),
      'utf8',
    );
    expect(onDisk).toBe(fx.files['eval-viewer/viewer.html']);
    // The issue was audited with the deferred delivery; no refused file read.
    const issue = await h.db.pool.query<{ metadata: { deferred?: number } }>(
      `SELECT metadata FROM audit_events WHERE action = 'skill.issue' AND target = $1`,
      [`job:${job2Id}`],
    );
    expect(issue.rows.at(-1)?.metadata.deferred).toBe(1);
    expect(await auditCount('skill.file.read', 'denied')).toBe(0);
    // Files are only served for a skill pinned to that job, by its manifest hash.
    const pin = await h.db.pool.query<{ manifest_sha256: string }>(
      'SELECT manifest_sha256 FROM job_skill_pins WHERE job_id = $1',
      [job2Id],
    );
    const sha = pin.rows[0]?.manifest_sha256 ?? '';
    const slice = await h.app.skills.fileSlice(job2Id, sha, 'SKILL.md', 0, 1024);
    expect(slice?.data.toString('utf8')).toBe(fx.files['SKILL.md']?.slice(0, 1024));
    expect(slice?.eof).toBe(false);
    expect(await h.app.skills.fileSlice(job2Id, 'f'.repeat(64), 'SKILL.md', 0, 1024)).toBeNull();
    expect(await h.app.skills.fileSlice(jobId, sha, 'SKILL.md', 0, 1024)).toBeNull();
    expect(await h.app.skills.fileSlice(job2Id, sha, 'nope.md', 0, 1024)).toBeNull();
  });
});
