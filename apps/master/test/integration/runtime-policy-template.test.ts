import {
  RuntimeKind,
  RuntimePolicyDocument,
  runtimePolicyHash,
  runtimePolicyIssues,
} from '@remyral/protocol';
import { RUNTIME_PINS } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { legacyRuntimePolicyDocument } from '../../src/runtime-policy/service.js';
import { catalogPolicyIssues } from '../../src/models/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface TemplateBody {
  document: RuntimePolicyDocument;
  documentHash: string;
}

/** p5-runtime-policy-ui: GET /runtime-policies/template and the panel's "Create default policy" flow. */
describeIntegration('runtime policy template (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  const dirs: string[] = [];
  const running: RunningWorker[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
  });
  afterAll(async () => {
    for (const w of running) await w.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  it('is a valid document at exactly the worker pins, readable by every console role, stable', async () => {
    const res = await viewer.req('GET', '/runtime-policies/template');
    expect(res.statusCode).toBe(200);
    const body = res.json<TemplateBody>();
    const doc = RuntimePolicyDocument.parse(body.document);
    expect(runtimePolicyIssues(doc)).toEqual([]);
    expect(await catalogPolicyIssues(h.db.pool, doc)).toEqual([]);
    expect(body.documentHash).toBe(runtimePolicyHash(doc));
    // Every runtime the master knows, at the pin the worker build compares against.
    expect(Object.keys(doc.runtimes).sort()).toEqual([...RuntimeKind.options].sort());
    for (const runtime of RuntimeKind.options) {
      const rule = doc.runtimes[runtime];
      expect(rule?.version).toBe(RUNTIME_PINS[runtime].version);
      expect(rule).toMatchObject({
        allowUnpinned: false,
        allowUnverified: false,
        modelProfiles: [],
        defaultProfile: null,
      });
      expect(rule?.authModes).toEqual(['secret-ref', 'local-login']);
    }
    expect(doc.projectProfiles).toEqual({});
    // Nothing stored by reading it; the same answer twice.
    const again = await admin.req('GET', '/runtime-policies/template');
    expect(again.json<TemplateBody>().documentHash).toBe(body.documentHash);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM runtime_policies')).rows[0]).toEqual({
      n: 0,
    });
  });

  it('creates "default" from the template once (a second create conflicts) and delivers it to a worker', async () => {
    const dataDir = await tempDataDir(dirs);
    const workerId = await pairRealWorker(h, url, admin, secret, dataDir);
    const worker = await runRealWorker(url, dataDir, { runtimePolicy: true });
    running.push(worker);
    await expect.poll(() => h.app.workerHub.isConnected(workerId)).toBe(true);

    const tpl = (await admin.req('GET', '/runtime-policies/template')).json<TemplateBody>();
    // The panel's first live run: Claude Code with allowUnverified.
    const claude = tpl.document.runtimes['claude-code'];
    if (claude === undefined) throw new Error('template lacks claude-code');
    const document: RuntimePolicyDocument = {
      ...tpl.document,
      runtimes: { ...tpl.document.runtimes, 'claude-code': { ...claude, allowUnverified: true } },
    };
    await stepUp();
    const created = await admin.req('PUT', '/runtime-policies/default', {
      document,
      stage: 'all',
      expectedVersion: 0,
      changeNote: 'first live run: allow unverified Claude Code',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: 'default', activeVersion: 1, canaryVersion: null });

    // Double click / second tab: the same create again is refused, nothing duplicated.
    const twice = await admin.req('PUT', '/runtime-policies/default', {
      document,
      stage: 'all',
      expectedVersion: 0,
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ error: string }>().error).toBe('version_conflict');
    const versions = await admin.req('GET', '/runtime-policies/default/versions');
    expect(versions.json<{ items: { version: number }[] }>().items.map((v) => v.version)).toEqual([1]);

    // The unassigned worker belongs to "default" and applies exactly this version.
    await expect.poll(() => worker.policies?.policy?.version).toBe(1);
    const applied = worker.policies?.policy;
    expect(applied?.name).toBe('default');
    expect(applied?.document.runtimes['claude-code']).toMatchObject({
      version: RUNTIME_PINS['claude-code'].version,
      allowUnverified: true,
    });
    // This harness worker does not advertise version-catalog-v1, so it gets the legacy form (no pin modes).
    expect(applied?.documentHash).toBe(runtimePolicyHash(legacyRuntimePolicyDocument(document)));

    // The name of the template route is not a policy name.
    await stepUp();
    const reserved = await admin.req('PUT', '/runtime-policies/template', {
      document,
      stage: 'all',
      expectedVersion: 0,
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json<{ issues: { path: string; code: string }[] }>().issues).toContainEqual({
      path: 'name',
      code: 'reserved',
    });
  });
});
