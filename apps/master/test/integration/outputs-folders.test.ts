import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatMentions } from '../../src/chat/mentions.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { OutputsService } from '../../src/outputs/service.js';
import { OutputFolders } from '../../src/outputs/folders.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const P = 'fold';
const OTHER = 'folq';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface Folder {
  id: string;
  scope: string;
  project: string | null;
  parentId: string | null;
  depth: number;
  name: string;
  itemCount: number;
  childCount: number;
  writable: boolean;
  ancestors?: { id: string; name: string }[];
}
interface Node {
  project: string | null;
  path: string;
  kind: string;
  label: string;
  count: number | null;
  hasChildren: boolean;
}

/** Entry names → bytes of a stored-only ZIP. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let cd = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const size = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const local = buf.readUInt32LE(cd + 42);
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, Buffer.from(buf.subarray(start, start + size)));
    cd += 46 + nameLen;
  }
  return out;
}

/**
 * p8-outputs-folders: the automatic tree, own folders (project / personal), links, folder ZIPs, `@` mentions of
 * folders and jobs that file their outputs — against a real master (Postgres, Redis).
 */
describeIntegration('outputs folders (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let owner: Client;
  let op: Client;
  let op2: Client;
  let viewer: Client;
  let outsider: Client;
  let ownerId: string;
  let opId: string;
  let viewerId: string;
  let jobA: string;
  let jobOther: string;
  const secrets = new Map<string, string>();
  const jobs = () =>
    new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });

  async function login(name: string, role: 'owner' | 'operator' | 'viewer', projects: string[] | null) {
    const id = await h.createUser(name, PW, role);
    if (projects !== null && role !== 'owner') await h.grant(id, projects, role);
    const { secret } = await enroll(h, name, PW);
    secrets.set(name, secret);
    return { id, client: await fullLogin(h, name, PW, secret) };
  }

  async function job(project: string, actor: JobActor, prompt = 'Folder fixture'): Promise<string> {
    const { job: j } = await jobs().create({
      project,
      actor,
      submit: true,
      spec: {
        runtime: 'codex',
        prompt,
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
    await succeed(j.id);
    return j.id;
  }

  async function succeed(jobId: string, state = 'SUCCEEDED'): Promise<void> {
    await h.db.pool.query(
      `UPDATE jobs SET state = $3, state_changed_at = $2, version = version + 1 WHERE id = $1`,
      [jobId, h.clock.now(), state],
    );
  }

  async function artifact(jobId: string, name: string, body: string, mediaType = 'text/markdown') {
    const content = Buffer.from(body);
    const id = `ws-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)}`;
    await h.db.pool.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind, redacted,
                                  content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, $9)`,
      [randomUUID(), jobId, id, name, mediaType, content.length, sha(content), content, h.clock.now()],
    );
    return `file:${jobId}:${id}`;
  }

  async function folder(c: Client, body: Record<string, unknown>): Promise<Folder> {
    const res = await c.req('POST', '/outputs/folders', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function tree(c: Client, query: string): Promise<{ nodes: Node[]; total: number }> {
    const res = await c.req('GET', `/outputs/tree${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function keysIn(c: Client, folderId: string): Promise<string[]> {
    const res = await c.req('GET', `/outputs?folder=${folderId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res
      .json<{ items: { key: string }[] }>()
      .items.map((i) => i.key)
      .sort();
  }

  async function audits(action: string, outcome = 'success'): Promise<number> {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND outcome = $2',
      [action, outcome],
    );
    return rows[0]?.n ?? 0;
  }

  let fileReport: string;
  let fileIndex: string;
  let fileCss: string;
  let fileOther: string;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    ({ id: ownerId, client: owner } = await login('owner.f', 'owner', null));
    ({ id: opId, client: op } = await login('op.f', 'operator', [P]));
    ({ client: op2 } = await login('op.f2', 'operator', [P]));
    ({ id: viewerId, client: viewer } = await login('viewer.f', 'viewer', [P]));
    ({ client: outsider } = await login('op.fout', 'operator', [OTHER]));
    const actor: JobActor = { type: 'user', id: ownerId };
    jobA = await job(P, actor, 'Build the shop\nwith details');
    jobOther = await job(OTHER, actor);
    fileReport = await artifact(jobA, 'report.md', '# Report\n');
    fileIndex = await artifact(jobA, 'site/index.html', '<h1>Shop</h1>', 'text/plain');
    fileCss = await artifact(jobA, 'site/css/app.css', 'h1{}', 'text/plain');
    fileOther = await artifact(jobOther, 'secret.md', 'other\n');
  });

  afterAll(async () => {
    await h.stop();
  });

  describe('automatic tree', () => {
    it('lists My folders and visible projects at the root; nothing of other projects', async () => {
      const root = await tree(op, '');
      expect(root.nodes.map((n) => [n.kind, n.project])).toEqual([
        ['personal', null],
        ['project', P],
      ]);
      const out = await tree(outsider, '');
      expect(out.nodes.some((n) => n.project === P)).toBe(false);
      expect((await outsider.req('GET', `/outputs/tree?project=${P}`)).statusCode).toBe(404);
    });

    it('a project has Folders, Sites, Notes and its jobs; a job its out/ directories', async () => {
      const proj = await tree(viewer, `?project=${P}`);
      expect(proj.nodes.slice(0, 3).map((n) => n.kind)).toEqual(['folders', 'sites', 'notes']);
      const jobNode = proj.nodes.find((n) => n.kind === 'job');
      expect(jobNode).toMatchObject({
        path: `job:${jobA}`,
        label: 'Build the shop',
        count: 3,
        hasChildren: true,
      });
      const dirs = await tree(viewer, `?project=${P}&path=${encodeURIComponent(`job:${jobA}`)}`);
      expect(dirs.nodes).toEqual([
        expect.objectContaining({
          kind: 'dir',
          label: 'site',
          path: `job:${jobA}/site`,
          count: 2,
          hasChildren: true,
        }),
      ]);
      const sub = await tree(viewer, `?project=${P}&path=${encodeURIComponent(`job:${jobA}/site`)}`);
      expect(sub.nodes.map((n) => [n.label, n.count, n.hasChildren])).toEqual([['css', 1, false]]);
      expect(
        (await viewer.req('GET', `/outputs/tree?project=${P}&path=${encodeURIComponent('job:../x')}`))
          .statusCode,
      ).toBe(400);
    });

    it('the right pane filters files below a directory', async () => {
      const res = await viewer.req('GET', `/outputs?job=${jobA}&path=site`);
      expect(res.statusCode, res.body).toBe(200);
      expect(
        res
          .json<{ items: { key: string }[] }>()
          .items.map((i) => i.key)
          .sort(),
      ).toEqual([fileCss, fileIndex].sort());
    });

    it('p15-chat-cards-scroll: a job filter names the primary output (the report)', async () => {
      const res = await viewer.req('GET', `/outputs?job=${jobA}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ items: { key: string; name: string }[]; primaryOutputId: string | null }>();
      expect(body.primaryOutputId).toBe(body.items.find((i) => i.name === 'report.md')?.key);
      const all = await viewer.req('GET', `/outputs?project=${P}`);
      expect(all.json<Record<string, unknown>>()).not.toHaveProperty('primaryOutputId');
    });

    it('a tree node downloads as one ZIP with its structure', async () => {
      const res = await viewer.req('POST', '/outputs/zip', { project: P, tree: `job:${jobA}` });
      expect(res.statusCode, res.body).toBe(200);
      const entries = unzip(res.rawPayload);
      expect([...entries.keys()].sort()).toEqual(
        ['MANIFEST.txt', 'report.md', 'site/css/app.css', 'site/index.html'].sort(),
      );
      const dir = unzip(
        (await viewer.req('POST', '/outputs/zip', { project: P, tree: `job:${jobA}/site` })).rawPayload,
      );
      expect([...dir.keys()].sort()).toEqual(['MANIFEST.txt', 'css/app.css', 'index.html']);
      const whole = unzip((await viewer.req('POST', '/outputs/zip', { project: P, tree: '' })).rawPayload);
      expect(whole.has(`${jobA.slice(0, 8)}/site/index.html`)).toBe(true);
      expect((await viewer.req('POST', '/outputs/zip', { project: P, tree: 'sites' })).statusCode).toBe(409);
      expect((await outsider.req('POST', '/outputs/zip', { project: P, tree: '' })).statusCode).toBe(404);
    });
  });

  describe('project folders', () => {
    let reports: Folder;

    it('operators create, viewers read but cannot write (audited), outsiders see nothing', async () => {
      reports = await folder(op, { scope: 'project', project: P, name: 'Reports', tags: ['weekly'] });
      expect(reports).toMatchObject({ scope: 'project', project: P, depth: 1, writable: true });
      const denied = await viewer.req('POST', '/outputs/folders', {
        scope: 'project',
        project: P,
        name: 'Nope',
      });
      expect(denied.statusCode).toBe(403);
      expect(await audits('outputs.folder.create', 'denied')).toBeGreaterThan(0);
      const list = await viewer.req('GET', `/outputs/folders?project=${P}`);
      expect(list.json<{ items: Folder[] }>().items).toEqual([
        expect.objectContaining({ id: reports.id, writable: false }),
      ]);
      expect((await outsider.req('GET', `/outputs/folders/${reports.id}`)).statusCode).toBe(404);
      expect((await outsider.req('GET', `/outputs?folder=${reports.id}`)).statusCode).toBe(404);
      expect((await viewer.req('DELETE', `/outputs/folders/${reports.id}`)).statusCode).toBe(403);
      const dup = await op2.req('POST', '/outputs/folders', {
        scope: 'project',
        project: P,
        name: 'reports',
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json<{ error: string }>().error).toBe('folder_name_taken');
      const bad = await op.req('POST', '/outputs/folders', { scope: 'project', project: P, name: 'a/b' });
      expect(bad.statusCode).toBe(400);
    });

    it('links items (not moves): an item can be in several folders; foreign and invented keys are refused', async () => {
      const add = await op.req('POST', `/outputs/folders/${reports.id}/items`, {
        project: P,
        keys: [fileReport, fileIndex, `file:${jobA}:ws-made-up`],
      });
      expect(add.statusCode, add.body).toBe(200);
      expect(add.json()).toEqual({ added: 2, already: 0, refused: [`file:${jobA}:ws-made-up`] });
      const again = await op.req('POST', `/outputs/folders/${reports.id}/items`, {
        project: P,
        keys: [fileReport],
      });
      expect(again.json()).toMatchObject({ added: 0, already: 1 });
      const second = await folder(op2, { scope: 'project', project: P, name: 'Shop' });
      await op2.req('POST', `/outputs/folders/${second.id}/items`, { project: P, keys: [fileReport] });
      expect(await keysIn(viewer, reports.id)).toEqual([fileIndex, fileReport].sort());
      const inFolders = await viewer.req(
        'GET',
        `/outputs/item-folders?project=${P}&key=${encodeURIComponent(fileReport)}`,
      );
      expect(
        inFolders
          .json<{ items: Folder[] }>()
          .items.map((f) => f.name)
          .sort(),
      ).toEqual(['Reports', 'Shop']);
      const foreign = await op.req('POST', `/outputs/folders/${reports.id}/items`, {
        project: OTHER,
        keys: [fileOther],
      });
      expect(foreign.statusCode).toBe(409);
      // The item itself is untouched and still listed in Outputs.
      const removed = await op.req('POST', `/outputs/folders/${second.id}/items/remove`, {
        project: P,
        keys: [fileReport],
      });
      expect(removed.json()).toEqual({ removed: 1 });
      const all = await viewer.req('GET', `/outputs?key=${encodeURIComponent(fileReport)}`);
      expect(all.json<{ total: number }>().total).toBe(1);
      expect(await audits('outputs.folder.link')).toBeGreaterThan(0);
      expect(await audits('outputs.folder.unlink')).toBe(1);
    });

    it('nests at most 6 levels; moves refuse cycles and depth overflow; delete keeps the items', async () => {
      const chain: Folder[] = [];
      let parent: string | null = null;
      for (let i = 1; i <= 6; i += 1) {
        const f = await folder(op, { scope: 'project', project: P, name: `L${String(i)}`, parentId: parent });
        expect(f.depth).toBe(i);
        chain.push(f);
        parent = f.id;
      }
      const tooDeep = await op.req('POST', '/outputs/folders', {
        scope: 'project',
        project: P,
        name: 'L7',
        parentId: parent,
      });
      expect(tooDeep.json<{ error: string }>().error).toBe('folder_too_deep');
      const l1 = chain[0]?.id ?? '';
      const l3 = chain[2]?.id ?? '';
      const cycle = await op.req('PATCH', `/outputs/folders/${l1}`, { parentId: l3 });
      expect(cycle.json<{ error: string }>().error).toBe('folder_cycle');
      // L1 holds 6 levels: under Reports (depth 1) it would reach 7.
      const overflow = await op.req('PATCH', `/outputs/folders/${l1}`, { parentId: reports.id });
      expect(overflow.json<{ error: string }>().error).toBe('folder_too_deep');
      // Moving L3 (4 levels) under Reports works and re-depths the subtree.
      const moved = await op.req('PATCH', `/outputs/folders/${l3}`, { parentId: reports.id, name: 'Moved' });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json<Folder>()).toMatchObject({ depth: 2, name: 'Moved', parentId: reports.id });
      const leaf = await op.req('GET', `/outputs/folders/${chain[5]?.id ?? ''}`);
      expect(leaf.json<Folder>()).toMatchObject({ depth: 5 });
      expect(leaf.json<Folder>().ancestors?.map((a) => a.name)).toEqual(['Reports', 'Moved', 'L4', 'L5']);
      await op.req('POST', `/outputs/folders/${l3}/items`, { project: P, keys: [fileCss] });
      const del = await op.req('DELETE', `/outputs/folders/${l3}`);
      expect(del.json()).toEqual({ folders: 4, links: 1 });
      expect(
        (await op.req('GET', `/outputs?key=${encodeURIComponent(fileCss)}`)).json<{ total: number }>().total,
      ).toBe(1);
      expect(await audits('outputs.folder.move')).toBe(1);
    });

    it('a folder downloads as a ZIP with its sub-folders', async () => {
      const sub = await folder(op, { scope: 'project', project: P, name: 'Assets', parentId: reports.id });
      await op.req('POST', `/outputs/folders/${sub.id}/items`, { project: P, keys: [fileCss] });
      const res = await viewer.req('POST', '/outputs/zip', { folder: reports.id });
      expect(res.statusCode, res.body).toBe(200);
      expect([...unzip(res.rawPayload).keys()].sort()).toEqual(
        ['Assets/site/css/app.css', 'MANIFEST.txt', 'report.md', 'site/index.html'].sort(),
      );
      expect((await outsider.req('POST', '/outputs/zip', { folder: reports.id })).statusCode).toBe(404);
    });

    it('enforces the folder and link limits', async () => {
      await h.db.pool.query(
        "INSERT INTO projects (id, name, created_at) VALUES ('limitp', 'limitp', now()) ON CONFLICT (id) DO NOTHING",
      );
      await h.db.pool.query(
        `INSERT INTO output_folders (scope, project, depth, name, created_at, updated_at)
         SELECT 'project', 'limitp', 1, 'f' || g, now(), now() FROM generate_series(1, 500) g`,
      );
      const full = await owner.req('POST', '/outputs/folders', {
        scope: 'project',
        project: 'limitp',
        name: 'x',
      });
      expect(full.json<{ error: string }>().error).toBe('too_many_folders');
      const big = await folder(op, { scope: 'project', project: P, name: 'Big' });
      await h.db.pool.query(
        `INSERT INTO output_folder_links (folder_id, project, item_key, source, added_at)
         SELECT $1, $2, 'site:pages:fill' || g || ':preview', 'user', now() FROM generate_series(1, 1000) g`,
        [big.id, P],
      );
      const over = await op.req('POST', `/outputs/folders/${big.id}/items`, {
        project: P,
        keys: [fileReport],
      });
      expect(over.json<{ error: string }>().error).toBe('too_many_links');
    });
  });

  describe('personal folders', () => {
    let mine: Folder;

    it('belong to their creator only — other operators and the owner account get a 404', async () => {
      mine = await folder(viewer, { scope: 'personal', name: 'Reading list' });
      expect(mine).toMatchObject({ scope: 'personal', project: null, writable: true });
      const add = await viewer.req('POST', `/outputs/folders/${mine.id}/items`, {
        project: P,
        keys: [fileReport],
      });
      expect(add.json()).toMatchObject({ added: 1 });
      for (const c of [op2, owner]) {
        expect((await c.req('GET', `/outputs/folders/${mine.id}`)).statusCode).toBe(404);
        expect((await c.req('GET', `/outputs?folder=${mine.id}`)).statusCode).toBe(404);
        expect((await c.req('PATCH', `/outputs/folders/${mine.id}`, { name: 'x' })).statusCode).toBe(404);
        expect((await c.req('POST', '/outputs/zip', { folder: mine.id })).statusCode).toBe(404);
        const listed = await c.req('GET', `/outputs/folders?project=${P}`);
        expect(listed.json<{ items: Folder[] }>().items.some((f) => f.id === mine.id)).toBe(false);
      }
      expect((await tree(viewer, '?path=personal')).nodes.map((n) => n.label)).toEqual(['Reading list']);
      expect((await tree(op2, '?path=personal')).nodes).toEqual([]);
      expect((await op2.req('GET', `/outputs/tree?path=folder:${mine.id}`)).statusCode).toBe(404);
    });

    it('cannot take items the creator cannot read; a lost membership hides the items, the folder stays', async () => {
      const foreign = await viewer.req('POST', `/outputs/folders/${mine.id}/items`, {
        project: OTHER,
        keys: [fileOther],
      });
      expect(foreign.statusCode).toBe(404);
      await h.db.pool.query('DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2', [
        viewerId,
        P,
      ]);
      expect(await keysIn(viewer, mine.id)).toEqual([]);
      expect((await viewer.req('GET', `/outputs/folders/${mine.id}`)).statusCode).toBe(200);
      await h.grant(viewerId, [P], 'viewer');
      expect(await keysIn(viewer, mine.id)).toEqual([fileReport]);
    });
  });

  describe('@ mentions of folders', () => {
    it('the picker finds readable folders; resolution as the sender now, others dropped', async () => {
      const shared = await folder(op, { scope: 'project', project: P, name: 'Launch kit', note: 'Ship it' });
      await op.req('POST', `/outputs/folders/${shared.id}/items`, { project: P, keys: [fileReport] });
      const personal = await folder(op, { scope: 'personal', name: 'Launch private' });
      const pick = await viewer.req('GET', '/chat/mentions?q=Launch&type=folder');
      expect(pick.statusCode, pick.body).toBe(200);
      expect(pick.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([shared.id]);
      const mine = await op.req('GET', '/chat/mentions?q=Launch&type=folder');
      expect(
        mine
          .json<{ items: { id: string }[] }>()
          .items.map((i) => i.id)
          .sort(),
      ).toEqual([shared.id, personal.id].sort());

      const outputs = new OutputsService({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        liveRetentionDays: null,
      });
      const folders = new OutputFolders({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        outputs,
      });
      const mentions = new ChatMentions({ db: h.db.pool, outputs: () => outputs, folders: () => folders });
      const asViewer = await loadSubject(h.db.pool, { id: viewerId, role: 'viewer' });
      const r = await mentions.resolve(
        asViewer,
        [
          { type: 'folder', id: shared.id },
          { type: 'folder', id: personal.id },
        ],
        96 * 1024,
      );
      expect(r.chips).toEqual([{ type: 'folder', id: shared.id, project: P, label: 'Launch kit' }]);
      expect(r.dropped).toEqual([{ type: 'folder', id: personal.id, reason: 'not_visible' }]);
      expect(r.blocks[0]).toContain('REMYRAL-DATA');
      expect(r.blocks[0]).toContain('Ship it');
      expect(r.blocks[0]).toContain(fileReport);
      const asOutsider = await loadSubject(h.db.pool, {
        id: (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'op.fout'")).rows[0]
          ?.id as string,
        role: 'operator',
      });
      expect(
        (await mentions.resolve(asOutsider, [{ type: 'folder', id: shared.id }], 96 * 1024)).dropped,
      ).toHaveLength(1);
    });
  });

  describe('jobs that file their outputs', () => {
    const spec = () => ({
      runtime: 'codex',
      prompt: 'Make the report',
      repository: {
        url: 'https://example.com/acme/repo.git',
        baseRef: 'main',
        workBranch: `rac/f-${randomUUID().slice(0, 6)}`,
      },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      sourceTrust: 'trusted',
      limits: { maxDurationSec: 600 },
    });

    it('checks the folder at creation and links the outputs when the job ends', async () => {
      const target = await folder(op, { scope: 'project', project: P, name: 'Job outputs' });
      const res = await op.req('POST', '/jobs', { project: P, spec: spec(), outputFolderId: target.id });
      expect(res.statusCode, res.body).toBe(201);
      const jobId = res.json<{ job: { id: string }; outputFolderId: string }>().job.id;
      expect(res.json<{ outputFolderId: string }>().outputFolderId).toBe(target.id);
      const key = await artifact(jobId, 'out/summary-table.md', '| a |\n');
      await h.app.outputFolders.linkTick();
      expect(await keysIn(op, target.id)).toEqual([]); // still running
      await succeed(jobId);
      expect(await h.app.outputFolders.linkTick()).toBe(1);
      expect(await keysIn(op, target.id)).toEqual([key]);
      expect(await audits('outputs.folder.autolink')).toBe(1);
      await h.app.outputFolders.linkTick(); // idempotent, nothing pending
      const { rows } = await h.db.pool.query<{ outcome: string; linked: number }>(
        'SELECT outcome, linked FROM job_output_folders WHERE job_id = $1',
        [jobId],
      );
      expect(rows[0]).toEqual({ outcome: 'linked', linked: 1 });
    });

    it('refuses folders the creator cannot write, and re-checks at link time', async () => {
      const otherPersonal = await folder(op2, { scope: 'personal', name: 'Not yours' });
      expect(
        (await op.req('POST', '/jobs', { project: P, spec: spec(), outputFolderId: otherPersonal.id }))
          .statusCode,
      ).toBe(404);
      const foreign = await folder(outsider, { scope: 'project', project: OTHER, name: 'Elsewhere' });
      expect(
        (await op.req('POST', '/jobs', { project: P, spec: spec(), outputFolderId: foreign.id })).statusCode,
      ).toBe(404);
      const ownPersonal = await folder(op, { scope: 'personal', name: 'My job outputs' });
      const shared = await folder(op, { scope: 'project', project: P, name: 'Shared job outputs' });
      const viaPersonal = await op.req('POST', '/jobs', {
        project: P,
        spec: spec(),
        outputFolderId: ownPersonal.id,
      });
      expect(viaPersonal.statusCode, viaPersonal.body).toBe(201);
      const viaShared = await op.req('POST', '/jobs', {
        project: P,
        spec: spec(),
        outputFolderId: shared.id,
      });
      const sharedJob = viaShared.json<{ job: { id: string } }>().job.id;
      await artifact(sharedJob, 'late.md', 'x\n');
      await succeed(sharedJob);
      // The requester lost the operator role before the job ended: nothing is linked, the refusal is audited.
      await h.grant(opId, [P], 'viewer');
      await h.app.outputFolders.linkTick();
      expect(await keysIn(op2, shared.id)).toEqual([]);
      const { rows } = await h.db.pool.query<{ outcome: string }>(
        'SELECT outcome FROM job_output_folders WHERE job_id = $1',
        [sharedJob],
      );
      expect(rows[0]?.outcome).toBe('refused');
      expect(await audits('outputs.folder.autolink', 'denied')).toBeGreaterThan(0);
      await h.grant(opId, [P], 'operator');
    });

    it('an automation job target files each run’s outputs (checked when saved)', async () => {
      const target = await folder(owner, { scope: 'project', project: P, name: 'Nightly' });
      h.clock.advance(30_000);
      expect(
        (await owner.req('POST', '/auth/step-up', { code: h.code(secrets.get('owner.f') ?? '') })).statusCode,
      ).toBe(200);
      const bad = await owner.req('POST', '/automations', {
        project: P,
        name: 'nightly bad',
        trigger: { kind: 'cron', cron: '0 0 1 1 *' },
        target: { kind: 'job', spec: spec(), outputFolderId: randomUUID() },
      });
      expect(bad.statusCode).toBe(404);
      const res = await owner.req('POST', '/automations', {
        project: P,
        name: 'nightly',
        trigger: { kind: 'cron', cron: '0 0 1 1 *' },
        target: { kind: 'job', spec: spec(), outputFolderId: target.id },
      });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json<{ automation: { id: string } }>().automation.id;
      const detail = await owner.req('GET', `/automations/${id}`);
      expect(detail.json<{ targetSpec: { outputFolderId: string } }>().targetSpec.outputFolderId).toBe(
        target.id,
      );
      const run = await owner.req('POST', `/automations/${id}/run`);
      expect(run.statusCode, run.body).toBe(202);
      const jobId = run.json<{ jobId: string }>().jobId;
      const { rows } = await h.db.pool.query<{ folder_id: string; via: string }>(
        'SELECT folder_id::text AS folder_id, via FROM job_output_folders WHERE job_id = $1',
        [jobId],
      );
      expect(rows[0]).toEqual({ folder_id: target.id, via: 'automation' });
      const key = await artifact(jobId, 'nightly.md', 'ok\n');
      await succeed(jobId);
      await h.app.outputFolders.linkTick();
      expect(await keysIn(owner, target.id)).toEqual([key]);
    });
  });
});
