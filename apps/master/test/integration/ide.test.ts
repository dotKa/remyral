import { randomUUID } from 'node:crypto';
import {
  IdeSpec,
  type LeaseKey,
  type MasterToWorker,
  verifyIdeControl,
  verifyIdeGit,
  verifyIdeStart,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ideCookieName } from '../../src/ide/access.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p19-ide W2 (ADR-0066) against a real master (Postgres) and a raw worker: the Kod tab state (not configured →
 * configured, machines with reasons), RBAC (viewer sees no IDE, outsider 404, another operator's workspace 404), the
 * `ide.start` step-up, signed IDE_START (read-only checkout, the IDE branch), capacity and the per-user rule,
 * IDE_STATUS → state, the one-time ticket → IDE origin cookie (single use, host-gated, revoked on stop), IDE_GIT push
 * round trip (signed, the push token only in IDE_GIT) and its audit, the bridge's events (reference → claim, terminal
 * audit, push → IDE_NOTICE), CAPABILITIES reconciliation, the idle sweep and delete.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'shop';
const IDE_HOST = 'ide.example.test';
const IDE_ORIGIN = `https://${IDE_HOST}`;
const h = new Harness();
let owner: Client;
let ownerSecret = '';
let operator: Client;
let operatorSecret = '';
let operatorId = '';
let operator2: Client;
let viewer: Client;
let outsider: Client;
let worker: RawWorker;
let workerId = '';
let leaseKeys: LeaseKey[] = [];

type Start = Extract<MasterToWorker, { type: 'IDE_START' }>;
type Control = Extract<MasterToWorker, { type: 'IDE_CONTROL' }>;
type Git = Extract<MasterToWorker, { type: 'IDE_GIT' }>;

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

function capabilities(
  workspaces: { workspaceId: string; revision: number; state: string; since: string }[],
  max = 2,
  over: { features?: string[]; ide?: Record<string, unknown> } = {},
): void {
  worker.sendJson(
    worker.envelope(
      'CAPABILITIES',
      {
        runtimes: [],
        sandboxProfiles: ['host-restricted'],
        maxParallelJobs: 1,
        tools: [],
        features: over.features ?? ['ide-v1'],
        ide: { available: true, serverVersion: '1.109.5', max, workspaces, ...over.ide },
      },
      { workerId },
    ),
  );
}

function status(workspaceId: string, p: Record<string, unknown>): void {
  worker.sendJson(
    worker.envelope(
      'IDE_STATUS',
      { workspaceId, revision: 1, at: new Date().toISOString(), ...p },
      { workerId },
    ),
  );
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function nextStart(id: string): Promise<Start> {
  for (;;) {
    const m = await worker.next('IDE_START', 10_000);
    if (m.payload.spec.workspaceId === id) return m;
  }
}

async function nextControl(id: string): Promise<Control> {
  for (;;) {
    const m = await worker.next('IDE_CONTROL', 10_000);
    if (m.payload.workspaceId === id) return m;
  }
}

async function audits(action: string): Promise<{ target: string; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{ target: string; metadata: Record<string, unknown> }>(
    'SELECT target, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

const ide = (path: string, extra: Record<string, string> = {}) =>
  h.app.inject({ method: 'GET', url: path, headers: { host: IDE_HOST, ...extra } });

describeIntegration('Tam IDE (integration, p19-ide W2)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await h.start({
      ide: { origin: IDE_ORIGIN },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW, 'owner');
    ownerSecret = (await enroll(h, 'owner1', PW)).secret;
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.db.pool.query(
      "INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now())",
      [PROJECT],
    );
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now())");
    operatorId = await h.createUser('oper1', PW, 'operator');
    await h.grant(operatorId, [PROJECT], 'operator');
    operatorSecret = (await enroll(h, 'oper1', PW)).secret;
    operator = await fullLogin(h, 'oper1', PW, operatorSecret);
    const op2 = await h.createUser('oper2', PW, 'operator');
    await h.grant(op2, [PROJECT], 'operator');
    operator2 = await fullLogin(h, 'oper2', PW, (await enroll(h, 'oper2', PW)).secret);
    const vw = await h.createUser('view1', PW, 'viewer');
    await h.grant(vw, [PROJECT], 'viewer');
    viewer = await fullLogin(h, 'view1', PW, (await enroll(h, 'view1', PW)).secret);
    const out = await h.createUser('oper3', PW, 'operator');
    await h.grant(out, ['other'], 'operator');
    outsider = await fullLogin(h, 'oper3', PW, (await enroll(h, 'oper3', PW)).secret);

    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'IDEW-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect(
      (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'IDEW-ABCD' })).statusCode,
    ).toBe(200);
    const est = await worker.next('SESSION_ESTABLISHED');
    leaseKeys = [...(est.payload.leaseKeys ?? [])];
    // The raw client says darwin in HELLO; this machine is a Linux one for the IDE.
    await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"linux"') WHERE id = $1`, [
      workerId,
    ]);
    capabilities([]);
    await waitFor(async () => {
      const r = await h.db.pool.query<{ ok: boolean }>(
        `SELECT features ? 'ide-v1' AS ok FROM workers WHERE id = $1`,
        [workerId],
      );
      return r.rows[0]?.ok === true;
    });
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('the Kod tab state: machines with reasons, a viewer cannot use it, an outsider does not see the project', async () => {
    const res = await operator.req('GET', `/projects/${PROJECT}/ide`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      configured: boolean;
      canUse: boolean;
      machines: { id: string; available: boolean }[];
    }>();
    expect(body.configured).toBe(true);
    expect(body.canUse).toBe(true);
    expect(body.machines.find((m) => m.id === workerId)).toMatchObject({ available: true });
    const v = (await viewer.req('GET', `/projects/${PROJECT}/ide`)).json<{
      canUse: boolean;
      machines: unknown[];
    }>();
    expect(v).toMatchObject({ canUse: false, machines: [] });
    expect((await viewer.req('POST', `/projects/${PROJECT}/ide/workspaces`, { name: 'x' })).statusCode).toBe(
      403,
    );
    expect((await outsider.req('GET', `/projects/${PROJECT}/ide`)).statusCode).toBe(404);
    expect(
      (await outsider.req('POST', `/projects/${PROJECT}/ide/workspaces`, { name: 'x' })).statusCode,
    ).toBe(404);
  });

  it('W2b: a macOS machine needs the platforms release, then the machine’s own reason (code + OS) is shown', async () => {
    type M = {
      id: string;
      available: boolean;
      reason: string | null;
      detailCode: string | null;
      platform: string | null;
    };
    const machineOf = async (): Promise<M | undefined> =>
      (await operator.req('GET', `/projects/${PROJECT}/ide`))
        .json<{ machines: M[] }>()
        .machines.find((m) => m.id === workerId);
    await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"darwin"') WHERE id = $1`, [
      workerId,
    ]);
    expect(await machineOf()).toMatchObject({
      available: false,
      reason: 'platform_update',
      platform: 'darwin',
    });
    capabilities([], 2, {
      features: ['ide-v1', 'ide-platforms-v1'],
      ide: {
        available: false,
        reason: 'macOS: Tam IDE runs only under the Seatbelt sandbox',
        reasonCode: 'seatbelt_required',
        serverVersion: '4.143.1',
        serverKind: 'code-server',
      },
    });
    const m = await waitFor(async () => {
      const x = await machineOf();
      return x?.reason === 'unavailable' ? x : null;
    });
    expect(m).toMatchObject({ detailCode: 'seatbelt_required', platform: 'darwin', available: false });
    capabilities([], 2, { features: ['ide-v1', 'ide-platforms-v1'], ide: { serverKind: 'code-server' } });
    await waitFor(async () => (await machineOf())?.available === true);
    // Back to the Linux machine of the other steps.
    await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"linux"') WHERE id = $1`, [
      workerId,
    ]);
    capabilities([]);
    await waitFor(async () => (await machineOf())?.available === true);
  });

  let wsId = '';

  it('create needs the ide.start code, then sends a signed IDE_START and lists the workspace', async () => {
    h.clock.advance(11 * 60_000); // past the 10-minute step-up window, inside the 30-minute session idle limit
    const refused = await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, { name: 'draft' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp(operator, operatorSecret);
    expect(
      (await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, { name: 'Bad Name' })).statusCode,
    ).toBe(400);
    const res = await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, {
      name: 'draft',
      worker: workerId,
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json<{ workspace: { id: string; state: string; source: string; branch: string | null } }>()
      .workspace;
    expect(ws).toMatchObject({ state: 'pending', source: 'files', branch: null });
    wsId = ws.id;
    const start = await nextStart(wsId);
    const spec = IdeSpec.parse(start.payload.spec);
    expect(spec).toMatchObject({
      projectId: PROJECT,
      userId: operatorId,
      name: 'draft',
      source: { kind: 'files', seed: null },
      memoryMb: 4096,
      idleMinutes: 30,
      sandboxProfile: 'host-restricted',
    });
    expect(start.payload.gitToken).toBeUndefined();
    expect(
      verifyIdeStart(
        { workerId, revision: start.payload.revision, issuedAt: start.payload.issuedAt, spec },
        start.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    // The same name again is refused; the owner of another workspace does not see this one.
    expect(
      (await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, { name: 'draft', worker: workerId }))
        .statusCode,
    ).toBe(409);
    expect((await operator2.req('GET', `/ide/workspaces/${wsId}`)).statusCode).toBe(404);
    const created = await audits('ide.workspace.create');
    expect(created.at(-1)).toMatchObject({ target: `ide:${wsId}` });
  });

  it('IDE_STATUS moves the state; one running IDE per user and machine', async () => {
    status(wsId, { state: 'running', startedAt: h.clock.now().toISOString(), streams: 0 });
    await waitFor(async () => {
      const r = await operator.req('GET', `/ide/workspaces/${wsId}`);
      return r.json<{ workspace: { state: string } }>().workspace.state === 'running';
    });
    await stepUp(operator, operatorSecret);
    const second = await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, {
      name: 'second',
      worker: workerId,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe('ide_user_machine');
  });

  it('opens the IDE origin with a one-time ticket: cookie, single use, host-gated', async () => {
    const res = await operator.req('POST', `/ide/workspaces/${wsId}/open`, {});
    expect(res.statusCode).toBe(200);
    const { url } = res.json<{ url: string }>();
    expect(url.startsWith(`${IDE_ORIGIN}/_ide/enter?w=${wsId}&t=`)).toBe(true);
    const path = url.slice(IDE_ORIGIN.length);
    // Not on the console host.
    expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    const enter = await ide(path);
    expect(enter.statusCode).toBe(302);
    expect(enter.headers.location).toBe(`/w/${wsId}/`);
    const set = String(enter.headers['set-cookie']);
    expect(set).toContain(`${ideCookieName(wsId)}=`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    // Spent.
    expect((await ide(path)).statusCode).toBe(403);
    expect((await audits('ide.open')).at(-1)).toMatchObject({ target: `ide:${wsId}` });
    // No console route on the IDE host.
    expect((await ide('/auth/session')).statusCode).toBe(404);
    // Another user cannot open someone else's workspace.
    expect((await operator2.req('POST', `/ide/workspaces/${wsId}/open`, {})).statusCode).toBe(404);
  });

  it('a bridge reference reaches the owner’s composer once; a terminal open is audited', async () => {
    worker.sendJson(
      worker.envelope(
        'IDE_EVENT',
        {
          kind: 'reference',
          workspaceId: wsId,
          eventId: randomUUID(),
          at: new Date().toISOString(),
          path: 'notes/a.md',
          startLine: 3,
          endLine: 7,
        },
        { workerId },
      ),
    );
    worker.sendJson(
      worker.envelope(
        'IDE_EVENT',
        {
          kind: 'terminal.open',
          workspaceId: wsId,
          eventId: randomUUID(),
          at: new Date().toISOString(),
          name: 'bash',
        },
        { workerId },
      ),
    );
    const refs = await waitFor(async () => {
      const r = (await operator.req('POST', '/me/ide/references/claim', {})).json<{
        references: { project: string; id: string; label: string }[];
      }>();
      return r.references.length > 0 ? r.references : null;
    });
    expect(refs).toEqual([
      { project: PROJECT, id: `ide:${wsId}:3-7:notes/a.md`, label: 'notes/a.md:3-7 · IDE' },
    ]);
    expect((await operator.req('POST', '/me/ide/references/claim', {})).json()).toEqual({ references: [] });
    expect((await operator2.req('POST', '/me/ide/references/claim', {})).json()).toEqual({ references: [] });
    await waitFor(async () => (await audits('ide.terminal.open')).length > 0);
  });

  it('a files workspace has nothing to push; reconciliation stops an unwanted live IDE and removes an unknown one', async () => {
    const push = await operator.req('POST', `/ide/workspaces/${wsId}/push`, { message: 'x' });
    expect(push.statusCode).toBe(409);
    const unknown = randomUUID();
    capabilities([
      { workspaceId: wsId, revision: 1, state: 'running', since: new Date().toISOString() },
      { workspaceId: unknown, revision: 1, state: 'running', since: new Date().toISOString() },
    ]);
    const removal = await nextControl(unknown);
    expect(removal.payload.op).toBe('remove');
    expect(
      verifyIdeControl(
        { workerId, workspaceId: unknown, op: 'remove', issuedAt: removal.payload.issuedAt },
        removal.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
  });

  it('stop revokes the IDE cookies and sends a signed stop; the idle sweep stops a forgotten one', async () => {
    const open = await operator.req('POST', `/ide/workspaces/${wsId}/open`, {});
    const path = open.json<{ url: string }>().url.slice(IDE_ORIGIN.length);
    const enter = await ide(path);
    const cookie = String(enter.headers['set-cookie']).split(';')[0] ?? '';
    const stop = await operator.req('POST', `/ide/workspaces/${wsId}/stop`, {});
    expect(stop.statusCode).toBe(200);
    const control = await nextControl(wsId);
    expect(control.payload.op).toBe('stop');
    const after = await ide(`/w/${wsId}/`, { cookie });
    expect(after.statusCode).toBe(401);
    status(wsId, { state: 'stopped', stopReason: 'requested' });
    await waitFor(async () => (await audits('ide.workspace.stop')).length > 0);

    // Start again (code), report it running, then nobody uses it for longer than its idle time.
    await stepUp(operator, operatorSecret);
    expect((await operator.req('POST', `/ide/workspaces/${wsId}/start`, {})).statusCode).toBe(200);
    await nextStart(wsId);
    status(wsId, { state: 'running', lastActivityAt: h.clock.now().toISOString() });
    await waitFor(async () => {
      const r = await operator.req('GET', `/ide/workspaces/${wsId}`);
      return r.json<{ workspace: { state: string } }>().workspace.state === 'running';
    });
    h.clock.advance(31 * 60_000);
    expect(await h.app.ide.sweep()).toBe(1);
    expect((await nextControl(wsId)).payload.op).toBe('stop');
    expect((await audits('ide.workspace.idle_stop')).at(-1)).toMatchObject({ target: `ide:${wsId}` });
    // 31 idle minutes also ended the console session: sign in again for the next cases.
    operator = await fullLogin(h, 'oper1', PW, operatorSecret);
  });

  it('delete sends a signed remove and the workspace is gone', async () => {
    const del = await operator.req('DELETE', `/ide/workspaces/${wsId}`);
    expect(del.statusCode).toBe(204);
    expect((await nextControl(wsId)).payload.op).toBe('remove');
    expect((await operator.req('GET', `/ide/workspaces/${wsId}`)).statusCode).toBe(404);
    status(wsId, { state: 'removed' });
    await waitFor(async () => (await audits('ide.workspace.delete')).length > 0);
  });

  it('a repository workspace: IDE branch, read-only checkout, push through IDE_GIT with its own token', async () => {
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('repo1', 'repo1', now())");
    await h.grant(operatorId, ['repo1'], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
         require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('repo1', 1, 'git', 'https://git.example.test/acme/repo1.git', 'main', 'merge', false, 600, $1, now())`,
      [operatorId],
    );
    await stepUp(operator, operatorSecret);
    // The earlier workspace was stopped, so the machine is free for this user again.
    const res = await operator.req('POST', '/projects/repo1/ide/workspaces', {
      name: 'fix',
      worker: workerId,
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json<{ workspace: { id: string; branch: string } }>().workspace;
    expect(ws.branch).toBe('remyral/ide/oper1/fix');
    const start = await nextStart(ws.id);
    expect(start.payload.spec.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://git.example.test/acme/repo1.git',
      baseRef: 'main',
      branch: 'remyral/ide/oper1/fix',
    });
    status(ws.id, { state: 'running' });
    await waitFor(async () => {
      const r = await operator.req('GET', `/ide/workspaces/${ws.id}`);
      return r.json<{ workspace: { state: string } }>().workspace.state === 'running';
    });
    const pushing = operator.req('POST', `/ide/workspaces/${ws.id}/push`, { message: 'fix it' });
    const git: Git = await worker.next('IDE_GIT', 10_000);
    expect(git.payload).toMatchObject({ workspaceId: ws.id, op: 'push', message: 'fix it' });
    expect(
      verifyIdeGit(
        {
          workerId,
          workspaceId: ws.id,
          requestId: git.payload.requestId,
          op: 'push',
          message: 'fix it',
          issuedAt: git.payload.issuedAt,
        },
        git.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    worker.sendJson(
      worker.envelope(
        'IDE_GIT_RESULT',
        {
          requestId: git.payload.requestId,
          workspaceId: ws.id,
          status: 'ok',
          branch: 'remyral/ide/oper1/fix',
          head: 'c'.repeat(40),
          committed: true,
          pushed: true,
          changedFiles: 0,
          ahead: 0,
        },
        { workerId },
      ),
    );
    const out = (await pushing).json<{ status: string; head: string; committed: boolean }>();
    expect(out).toMatchObject({ status: 'ok', head: 'c'.repeat(40), committed: true });
    expect((await audits('ide.git.push')).at(-1)).toMatchObject({ target: `ide:${ws.id}` });

    // The bridge's push asks the master, which pushes as the owner and answers with IDE_NOTICE.
    const eventId = randomUUID();
    worker.sendJson(
      worker.envelope(
        'IDE_EVENT',
        {
          kind: 'push',
          workspaceId: ws.id,
          eventId,
          at: new Date().toISOString(),
          message: 'again',
          pullRequest: false,
        },
        { workerId },
      ),
    );
    const git2: Git = await worker.next('IDE_GIT', 10_000);
    worker.sendJson(
      worker.envelope(
        'IDE_GIT_RESULT',
        { requestId: git2.payload.requestId, workspaceId: ws.id, status: 'refused', reason: 'secret_found' },
        { workerId },
      ),
    );
    const notice = await worker.next('IDE_NOTICE', 10_000);
    expect(notice.payload).toMatchObject({ eventId, status: 'refused' });
    expect(notice.payload.message).toContain('gizli');
  });
});
