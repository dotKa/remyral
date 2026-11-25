import { randomUUID } from 'node:crypto';
import { JobSpec, verifyVaultScope } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assignPayload } from '../../src/orchestration/messages.js';
import { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { scopeVaultRefs } from '../../src/project-env/job-refs.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { jobSpec } from '../helpers/job-worker.js';

const PW = 'quartz-meadow-lantern-7';
const A = 'proj-a';
const B = 'proj-b';
const NOT_AVAILABLE = 'vault_credential_not_available';

/**
 * Job secret references (p19-project-env "Job-level references") against a real master: a `secret:vault-<id>` a job
 * names itself must be a `generic` credential its own project gives its jobs. An operator of project B cannot pull
 * project A's credential, a git or MCP-only credential or a code-loading variable into a job —
 * neither through POST /jobs nor through an automation (refused at write time, and a run whose binding was removed
 * since fails with the same issue) — while the project-env flow and the job's own re-mapping of a bound credential
 * keep working; the assignment re-checks and signs the allowed ids into `lease.vaultScope`.
 */
describeIntegration('job secret references (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let opB: Client;
  let opSecret = '';

  async function stepUp(client: Client, secret: string): Promise<void> {
    h.clock.advance(31_000);
    const res = await client.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function credential(id: string, kind: string, env: string): Promise<void> {
    await h.db.pool.query(
      `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
       VALUES ($1, $1, $2, $3, 1, 'active', now(), now())`,
      [id, kind, env],
    );
  }

  async function bind(project: string, ids: string[]): Promise<void> {
    await stepUp(owner, ownerSecret);
    const res = await owner.req('PUT', `/projects/${project}/env-credentials`, { credentialIds: ids });
    expect(res.statusCode, res.body).toBe(200);
  }

  const submit = (client: Client, secretRefs: Record<string, string>, over: Record<string, unknown> = {}) =>
    client.req('POST', '/jobs', { project: B, spec: jobSpec({ secretRefs, ...over }) });

  beforeAll(async () => {
    await h.start();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    for (const p of [A, B]) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())', [p]);
    }
    const opId = await h.createUser('oper.b', PW, 'operator');
    await h.grant(opId, [B], 'operator');
    ({ secret: opSecret } = await enroll(h, 'oper.b', PW));
    opB = await fullLogin(h, 'oper.b', PW, opSecret);

    await credential('a-db', 'generic', 'A_DATABASE_URL');
    await credential('b-db', 'generic', 'B_DATABASE_URL');
    await credential('b-git', 'git-https-token', 'REMYRAL_GIT_HTTPS_TOKEN');
    await credential('b-mcp', 'generic', 'MCP_TOKEN');
    await bind(A, ['a-db']);
    await bind(B, ['b-db']);
    // Bound directly in the database (the API refuses non-generic kinds): the kind is still checked at use.
    await h.db.pool.query(
      "INSERT INTO project_env_credentials (project, credential_id, created_at) VALUES ($1, 'b-git', now())",
      [B],
    );
  });

  afterAll(async () => {
    await h.stop();
  });

  it('only those who may change the bindings see the credentials that could be added', async () => {
    const res = await opB.req('GET', `/projects/${B}/env-credentials`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ credentials: { credentialId: string }[]; available: { id: string }[] }>();
    // The project's own bindings, nothing else (the list would name every generic credential of the panel).
    expect(body.credentials.map((c) => c.credentialId)).toContain('b-db');
    expect(body.available).toEqual([]);
    const admin = (await owner.req('GET', `/projects/${B}/env-credentials`)).json<{
      available: { id: string }[];
    }>();
    expect(admin.available.map((a) => a.id)).toContain('a-db');
  });

  it('POST /jobs: another project’s credential, other kinds and unsafe variables are refused (names only)', async () => {
    const refused: [string, Record<string, string>, Record<string, unknown>?][] = [
      ['A_DATABASE_URL', { A_DATABASE_URL: 'secret:vault-a-db' }],
      ['X', { X: 'worker:some-worker/secret:vault-a-db' }],
      ['X', { X: 'secret:VAULT-a-db' }],
      ['X', { X: 'secret:Vault-b-db' }],
      ['GIT', { GIT: 'secret:vault-b-git' }],
      ['MCP_TOKEN', { MCP_TOKEN: 'secret:vault-b-mcp' }],
      ['NOPE', { NOPE: 'secret:vault-does-not-exist' }],
      ['NODE_OPTIONS', { NODE_OPTIONS: 'secret:vault-b-db' }],
      ['ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'secret:vault-b-db' }],
      // An untrusted source never gets a vault credential, even a bound one.
      [
        'B_DATABASE_URL',
        { B_DATABASE_URL: 'secret:vault-b-db' },
        { sourceTrust: 'untrusted', sandboxProfile: 'container' },
      ],
    ];
    for (const [env, refs, over] of refused) {
      const res = await submit(opB, refs, over);
      expect(res.statusCode, `${JSON.stringify(refs)}: ${res.body}`).toBe(400);
      const body = res.json<{ error: string; message: string }>();
      expect(body.error).toBe('invalid_job');
      expect(body.message).toContain(`spec.secretRefs.${env}:${NOT_AVAILABLE}`);
    }
    // The same answer for an existing credential of another project and a missing one (no existence oracle).
    const other = (await submit(opB, { V: 'secret:vault-a-db' })).json<{ message: string }>().message;
    const missing = (await submit(opB, { V: 'secret:vault-zzz' })).json<{ message: string }>().message;
    expect(other).toBe(missing);
    // Not even the owner can name a credential project B does not give its jobs.
    expect((await submit(owner, { A_DATABASE_URL: 'secret:vault-a-db' })).statusCode).toBe(400);
    const { rows } = await h.db.pool.query('SELECT 1 FROM jobs WHERE project = $1', [B]);
    expect(rows).toHaveLength(0);
  });

  it('POST /jobs: a credential the project gives its jobs (re-mapped too) and worker-own secrets are accepted', async () => {
    const ok = await submit(opB, {
      B_DATABASE_URL: 'secret:vault-b-db',
      DATABASE_URL: 'secret:vault-b-db',
      MINE: 'secret:my-local-secret',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const plain = await submit(opB, {});
    expect(plain.statusCode, plain.body).toBe(201);
  });

  it('automations: refused at write time; a saved one whose binding was removed fails its run with the issue', async () => {
    await stepUp(opB, opSecret);
    const bad = await opB.req('POST', '/automations', {
      project: B,
      name: `refs ${randomUUID().slice(0, 6)}`,
      trigger: { kind: 'cron', cron: '0 0 1 1 *' },
      target: { kind: 'job', spec: jobSpec({ secretRefs: { A_DATABASE_URL: 'secret:vault-a-db' } }) },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json<{ message: string }>().message).toContain(
      `spec.secretRefs.A_DATABASE_URL:${NOT_AVAILABLE}`,
    );

    const saveGood = async (): Promise<string> => {
      await stepUp(opB, opSecret);
      const good = await opB.req('POST', '/automations', {
        project: B,
        name: `refs ${randomUUID().slice(0, 6)}`,
        trigger: { kind: 'cron', cron: '0 0 1 1 *' },
        target: { kind: 'job', spec: jobSpec({ secretRefs: { DATABASE_URL: 'secret:vault-b-db' } }) },
      });
      expect(good.statusCode, good.body).toBe(201);
      return good.json<{ automation: { id: string } }>().automation.id;
    };
    const running = await saveGood();
    const saved = await saveGood();
    const first = await opB.req('POST', `/automations/${running}/run`);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json<{ state: string; jobId: string | null }>()).toMatchObject({ state: 'running' });

    // The project stops giving the credential: the saved automation's next run fails visibly, with the variable.
    await bind(B, []);
    const second = await opB.req('POST', `/automations/${saved}/run`);
    expect(second.statusCode, second.body).toBe(202);
    const run = second.json<{ state: string; reason: string | null; jobId: string | null }>();
    expect(run.state).toBe('error');
    expect(run.jobId).toBeNull();
    expect(run.reason).toContain(`spec.secretRefs.DATABASE_URL:${NOT_AVAILABLE}`);
    await bind(B, ['b-db']);
  });

  it('assignment: refs re-checked (project bindings and the job’s own), allowed ids signed into lease.vaultScope', async () => {
    const spec = JobSpec.parse(
      jobSpec({
        secretRefs: {
          B_DATABASE_URL: 'secret:vault-b-db',
          A_DATABASE_URL: 'secret:vault-a-db',
          GIT: 'secret:vault-b-git',
          MINE: 'secret:my-local-secret',
        },
      }),
    );
    const scoped = await scopeVaultRefs(h.db.pool, B, spec);
    expect(scoped.vaultScope).toEqual(['b-db']);
    expect(scoped.dropped).toEqual(['A_DATABASE_URL', 'GIT']);
    expect(scoped.spec.secretRefs).toEqual({
      B_DATABASE_URL: 'secret:vault-b-db',
      MINE: 'secret:my-local-secret',
    });
    // Project A's job keeps project A's credential.
    expect((await scopeVaultRefs(h.db.pool, A, spec)).vaultScope).toEqual(['a-db']);

    const signer = LeaseSigner.ephemeral();
    const lease = {
      jobId: randomUUID(),
      attemptId: randomUUID(),
      workerId: 'w-1',
      epoch: 3,
      expiresAt: new Date(h.clock.now().getTime() + 60_000),
    };
    const payload = assignPayload(
      signer,
      { lease: lease as never, project: B, spec: scoped.spec, vaultScope: scoped.vaultScope },
      h.clock.now(),
    );
    const token = payload.lease.vaultScope ?? '';
    const ok = verifyVaultScope(token, signer.keys(), {
      jobId: lease.jobId,
      attemptId: lease.attemptId,
      workerId: 'w-1',
      epoch: 3,
    });
    expect(ok).toMatchObject({ ok: true, claims: { vault: ['b-db'] } });
    // Bound to its lease: another epoch or attempt does not verify.
    expect(verifyVaultScope(token, signer.keys(), { epoch: 4 })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyVaultScope(token, LeaseSigner.ephemeral().keys(), {})).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    // The variables the master withheld travel by name for the job's timeline.
    const withheld = assignPayload(
      signer,
      { lease: lease as never, project: B, spec: scoped.spec, secretRefsWithheld: scoped.dropped },
      h.clock.now(),
    );
    expect(withheld.execution?.secretRefsWithheld).toEqual(['A_DATABASE_URL', 'GIT']);
    // Without a scope (no input), nothing is added: the renewal path never carries one.
    const plain = assignPayload(signer, { lease: lease as never, project: B, spec }, h.clock.now());
    expect(plain.lease.vaultScope).toBeUndefined();
  });
});
