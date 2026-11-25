import { type MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoGitAuth } from '../../src/git-central/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'gc-proj';
const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

const READINESS = {
  checkedAt: '2026-10-22T10:00:00.000Z',
  git: { present: true, version: '2.47.1.windows.2', source: 'managed' },
  problems: [
    { code: 'global_credential_helper', severity: 'info', count: 1, helpers: ['manager'] },
    { code: 'os_store_github', severity: 'warning', fix: 'erase_github_credentials', count: 1 },
    { code: 'global_insteadof', severity: 'warning', fix: 'remove_github_insteadof', count: 1 },
  ],
  jobsIsolated: true,
};

/**
 * p15-git-central against a real master (Postgres, migration 0125) and a raw worker connection:
 *  - CAPABILITIES.gitReadiness is stored and shown (GET /workers/:id/git, GET /fleet/git);
 *  - the one-click fix (`git.fix`) needs git-central-v1, admin and step-up; it carries exactly the fixes the report
 *    names, its result updates the readiness; the fleet-wide fix sends one op per capable connected machine;
 *  - Projects → Repo repository credential: kind checks, pinned known_hosts, audit; ASSIGN_JOB gitAuth only to capable
 *    workers and, for untrusted sources, only read-only credentials.
 */
describeIntegration('central git (integration, p15-git-central)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';
  let seq = 0;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(features: string[], gitReadiness?: unknown): void {
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features,
          ...(gitReadiness === undefined ? {} : { gitReadiness }),
        },
        { workerId },
      ),
    );
  }

  async function command(kind: string): Promise<OpsCommand> {
    let cmd = await worker.next('OPS_COMMAND');
    while (cmd.payload.op.kind !== kind) cmd = await worker.next('OPS_COMMAND');
    return cmd;
  }

  const gitView = async () =>
    (await admin.req('GET', `/workers/${workerId}/git`)).json<{
      supported: boolean;
      readiness: { problems: { code: string }[] } | null;
      fixable: string[];
    }>();

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [PROJECT],
    );
    await h.grant(viewerId, [PROJECT], 'viewer');
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'GITC-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp();
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'GITC-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('Git card: readiness from CAPABILITIES; the fix needs the feature, admin and step-up and sends exactly the named fixes', async () => {
    capabilities(['remote-ops-v1']);
    await expect.poll(async () => (await gitView()).supported).toBe(false);
    await stepUp();
    const old = await admin.req('POST', `/workers/${workerId}/git/fix`, {});
    expect(old.statusCode).toBe(409);
    expect(old.json<{ error: string }>().error).toBe('nothing_to_fix');

    capabilities(['remote-ops-v1', 'git-central-v1'], READINESS);
    await expect
      .poll(async () => (await gitView()).fixable)
      .toEqual(['erase_github_credentials', 'remove_github_insteadof']);
    expect((await viewer.req('GET', `/workers/${workerId}/git`)).statusCode).toBe(200);
    expect((await viewer.req('POST', `/workers/${workerId}/git/fix`, {})).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await admin.req('POST', `/workers/${workerId}/git/fix`, {});
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up_required');

    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/git/fix`, {});
    expect(res.statusCode, res.body).toBe(200);
    const opId = res.json<{ id: string }>().id;
    const cmd = await command('git.fix');
    expect(cmd.payload.op).toEqual({
      kind: 'git.fix',
      fixes: ['erase_github_credentials', 'remove_github_insteadof'],
    });
    const after = { ...READINESS, problems: [READINESS.problems[0]] };
    worker.sendJson(
      worker.envelope(
        'OPS_UPDATE',
        {
          commandId: cmd.payload.commandId,
          seq: ++seq,
          kind: 'git.fix',
          state: 'succeeded',
          gitFix: {
            results: [
              { fix: 'erase_github_credentials', outcome: 'applied' },
              { fix: 'remove_github_insteadof', outcome: 'applied' },
            ],
            readiness: after,
          },
        },
        { workerId },
      ),
    );
    await expect
      .poll(
        async () =>
          (await admin.req('GET', `/workers/${workerId}/ops/${opId}`)).json<{ state: string }>().state,
      )
      .toBe('succeeded');
    await expect.poll(async () => (await gitView()).fixable).toEqual([]);
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'worker.ops.git.fix' AND outcome = 'success'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('fleet-wide fix: one op per capable connected machine with problems; others are skipped with a reason', async () => {
    capabilities(['remote-ops-v1', 'git-central-v1'], READINESS);
    await expect.poll(async () => (await gitView()).fixable.length).toBe(2);
    const fleet = await viewer.req('GET', '/fleet/git');
    expect(fleet.statusCode).toBe(200);
    expect(fleet.json<{ machines: { workerId: string }[] }>().machines.map((m) => m.workerId)).toContain(
      workerId,
    );
    expect((await viewer.req('POST', '/fleet/git/fix', {})).statusCode).toBe(403);
    await stepUp();
    const res = await admin.req('POST', '/fleet/git/fix', {});
    expect(res.statusCode, res.body).toBe(200);
    const results = res.json<{ results: { workerId: string; outcome: string; opId?: string }[] }>().results;
    expect(results.find((r) => r.workerId === workerId)).toMatchObject({ outcome: 'sent' });
    const cmd = await command('git.fix');
    expect(cmd.payload.op.kind).toBe('git.fix');
    // The viewer's refused attempt above is audited too (outcome denied); count the admin's fix.
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'fleet.git.fix' AND outcome = 'success'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('repository credential: kind and known_hosts checks, audit, and the assignment rules', async () => {
    await h.db.pool.query(
      `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ('deploy-key', 'Deploy key', 'git-ssh-key', 'REMYRAL_GIT_DEPLOY_KEY', 1, 'active', now(), now()),
              ('gl-token', 'GitLab token', 'git-https-token', 'REMYRAL_GIT_HTTPS_TOKEN', 1, 'active', now(), now()),
              ('api-key', 'API key', 'openai', 'OPENAI_API_KEY', 1, 'active', now(), now())`,
    );
    const initial = await viewer.req('GET', `/projects/${PROJECT}/git/credential`);
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toEqual({ project: PROJECT, credential: null, workers: [] });
    const put = (body: unknown, who: Client = admin) =>
      who.req('PUT', `/projects/${PROJECT}/git/credential`, body);
    expect(
      (await put({ kind: 'ssh-key', credentialId: 'deploy-key', access: 'write' }, viewer)).statusCode,
    ).toBe(403);
    await stepUp();
    const noHosts = await put({ kind: 'ssh-key', credentialId: 'deploy-key', access: 'write' });
    expect(noHosts.statusCode).toBe(422);
    expect(noHosts.json()).toMatchObject({ error: 'invalid_known_hosts', params: { reason: 'empty' } });
    const wrongKind = await put({
      kind: 'ssh-key',
      credentialId: 'api-key',
      access: 'write',
      knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
    });
    expect(wrongKind.statusCode).toBe(422);
    expect(wrongKind.json<{ error: string }>().error).toBe('credential_kind');
    const ok = await put({
      kind: 'ssh-key',
      credentialId: 'deploy-key',
      access: 'write',
      knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // The vault id only for those who may change it; a viewer sees the credential's name.
    const seen = (await viewer.req('GET', `/projects/${PROJECT}/git/credential`)).json<{
      credential: { credentialId: string; credentialName: string | null };
    }>();
    expect(seen.credential).toMatchObject({ credentialId: '', credentialName: 'Deploy key' });
    expect(
      (await admin.req('GET', `/projects/${PROJECT}/git/credential`)).json<{
        credential: { credentialId: string };
      }>().credential.credentialId,
    ).toBe('deploy-key');
    expect(ok.json()).toMatchObject({
      credential: {
        kind: 'ssh-key',
        credentialId: 'deploy-key',
        credentialName: 'Deploy key',
        access: 'write',
      },
    });
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'project.repo_credential.update' AND outcome = 'success'`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ after: { kind: 'ssh-key', knownHostsLines: 1 } });

    const capable = ['git-central-v1'];
    const trusted = { project: PROJECT, sourceTrust: 'trusted' };
    expect(await repoGitAuth(h.db.pool, trusted, capable)).toEqual({
      kind: 'ssh-key',
      credentialId: 'deploy-key',
      knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
    });
    expect(await repoGitAuth(h.db.pool, trusted, [])).toBeUndefined();
    // ADR-0010: an untrusted source gets no write credential …
    expect(
      await repoGitAuth(h.db.pool, { project: PROJECT, sourceTrust: 'untrusted' }, capable),
    ).toBeUndefined();
    await stepUp();
    const https = await put({
      kind: 'https-token',
      credentialId: 'gl-token',
      username: 'oauth2',
      access: 'read',
    });
    expect(https.statusCode, https.body).toBe(200);
    // … but a read-only one, for its checkout.
    expect(await repoGitAuth(h.db.pool, { project: PROJECT, sourceTrust: 'untrusted' }, capable)).toEqual({
      kind: 'https-token',
      credentialId: 'gl-token',
      username: 'oauth2',
    });
    await stepUp();
    const del = await admin.req('DELETE', `/projects/${PROJECT}/git/credential`);
    expect(del.statusCode).toBe(200);
    expect(del.json<{ credential: unknown }>().credential).toBeNull();
    expect(await repoGitAuth(h.db.pool, trusted, capable)).toBeUndefined();
  });
});
