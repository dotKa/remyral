import { FakeAssistantEngine } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { FakeGitHub } from '../helpers/fake-github.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p15-github-create-repo against a real master (Postgres) and the fake GitHub over HTTP:
 * - organization path: installation token with exactly administration:write + metadata:read, POST /orgs/{org}/repos,
 *   README + .gitignore template, linked to the project (provider github, installation, keyRef panel, base branch);
 * - personal path: "GitHub hesabını yetkilendir" (state CSRF, always-fresh step-up, code exchange with the client
 *   secret), POST /user/repos with the user token, PUT /user/installations/{id}/repositories/{repo_id};
 * - token refresh when the user token expires (single-use refresh token, under a row lock) and the expired case;
 * - the fine-grained token fallback; names that exist (seen and unseen by the token) refused, useExisting links;
 * - guards: owner ambiguity, missing permission, project already linked, RBAC, idempotency;
 * - no token or client secret in DB rows, audit, logs or responses;
 * - the assistant's create_repository through the real transport (acts at once, exists → no card, propose → card).
 */
const PW = 'quartz-harbor-lantern-58';
const CONSOLE = 'https://console.example.test';

const gh = new FakeGitHub();

describeIntegration(
  'GitHub repositories opened by Remyral (integration, p15-github-create-repo)',
  { timeout: 240_000 },
  () => {
    const h = new Harness(Date.now());
    let owner: Client;
    let ownerSecret = '';
    let operator: Client;
    const bodies: string[] = [];

    async function call(c: Client, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
      const res = await c.req(method, url, body);
      bodies.push(res.body);
      return res;
    }
    async function stepUp(): Promise<void> {
      h.clock.advance(30_000);
      const res = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
      expect(res.statusCode, res.body).toBe(200);
    }
    async function audits(action: string) {
      const { rows } = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        'SELECT outcome, metadata FROM audit_events WHERE action = $1 ORDER BY id',
        [action],
      );
      return rows;
    }
    async function project(id: string): Promise<void> {
      await h.db.pool.query(
        'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
        [id],
      );
    }
    const create = async (body: Record<string, unknown>) => {
      await stepUp();
      return call(owner, 'POST', '/integrations/github/repositories', body);
    };

    beforeAll(async () => {
      const base = await gh.start();
      gh.now = () => h.clock.now().getTime();
      gh.strictRepoTokens = true;
      await h.start({ gitflow: { githubApiUrl: base, githubWebUrl: base, consoleOrigin: CONSOLE } });
      await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      for (const p of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) await project(p);
      const op = await h.createUser('oper1', PW, 'operator');
      await h.grant(op, ['alpha'], 'operator');
      const o = await enroll(h, 'oper1', PW);
      operator = await fullLogin(h, 'oper1', PW, o.secret);

      // Connect the panel App (p5-github-connect) and its installations: the owner's personal account (selected
      // repositories, administration accepted), an organization that may create, and one that may not.
      const admin = { contents: 'write', metadata: 'read', pull_requests: 'write', administration: 'write' };
      gh.users.push({
        login: 'monaDev',
        id: 1001,
        repos: [
          { owner: 'monaDev', name: 'old-repo', id: 501 },
          { owner: 'monaDev', name: 'hidden', id: 502 },
        ],
      });
      const personal = gh.users[0]?.repos[0];
      gh.installations.push(
        {
          id: 777,
          account: 'monaDev',
          selection: 'selected',
          repos: personal === undefined ? [] : [personal],
          permissions: admin,
        },
        {
          id: 888,
          account: 'acme-labs',
          accountType: 'Organization',
          selection: 'selected',
          repos: [],
          permissions: admin,
        },
        {
          id: 999,
          account: 'nope-org',
          accountType: 'Organization',
          selection: 'all',
          repos: [],
          permissions: { contents: 'write', metadata: 'read' },
        },
      );
      await stepUp();
      const start = await owner.req('POST', '/integrations/github/manifest', { target: 'user' });
      expect(start.statusCode, start.body).toBe(200);
      const state =
        new URL(start.json<{ formPath: string }>().formPath, CONSOLE).searchParams.get('state') ?? '';
      gh.codes.add('manifest-code');
      const done = await owner.req('POST', '/integrations/github/manifest/complete', {
        code: 'manifest-code',
        state,
      });
      expect(done.statusCode, done.body).toBe(200);
      const sync = await owner.req('POST', '/integrations/github/installations/sync', {});
      expect(sync.statusCode, sync.body).toBe(200);
      // p17-chat-github: installations are used only once accepted in the panel.
      for (const i of sync.json<{ installations: { installationId: number }[] }>().installations) {
        const a = await owner.req('PUT', `/integrations/github/installations/${String(i.installationId)}`, {
          accepted: true,
        });
        expect(a.statusCode, a.body).toBe(200);
      }
    });
    afterAll(async () => {
      await h.stop();
      await gh.stop();
    });

    it('options: per installation the method or why not; admins only', async () => {
      const res = await call(owner, 'GET', '/integrations/github/repo-options');
      expect(res.statusCode, res.body).toBe(200);
      const o = res.json<{
        owners: { login: string; method: string | null; blocked: string | null }[];
        canAuthorize: boolean;
      }>();
      expect(o.canAuthorize).toBe(true);
      expect(o.owners.map((x) => [x.login, x.method, x.blocked])).toEqual([
        ['acme-labs', 'installation', null],
        ['monaDev', null, 'user_authorization_missing'],
        ['nope-org', null, 'administration_missing'],
      ]);
      expect((await operator.req('GET', '/integrations/github/repo-options')).statusCode).toBe(403);
      expect(
        (await operator.req('POST', '/integrations/github/repositories', { name: 'x' })).statusCode,
      ).toBe(403);
    });

    it('organization: installation token for administration only, README + .gitignore, linked to the project', async () => {
      const before = gh.tokenRequests.length;
      const res = await create({
        owner: 'acme-labs',
        name: 'svc',
        description: 'Service',
        gitignoreTemplate: 'Node',
        project: 'alpha',
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        created: true,
        fullName: 'acme-labs/svc',
        cloneUrl: 'https://github.com/acme-labs/svc.git',
        defaultBranch: 'main',
        private: true,
        method: 'installation',
        installationId: 888,
        project: 'alpha',
        linked: true,
        warnings: [],
      });
      expect(gh.created.at(-1)).toMatchObject({
        name: 'svc',
        private: true,
        auto_init: true,
        gitignore_template: 'Node',
        description: 'Service',
        owner: 'acme-labs',
        via: 'installation',
      });
      expect(gh.tokenRequests.slice(before)).toContainEqual({
        permissions: { administration: 'write', metadata: 'read' },
      });
      const cfg = await call(owner, 'GET', '/projects/alpha/git');
      expect(cfg.json<{ config: unknown }>().config).toMatchObject({
        provider: 'github',
        repositoryUrl: 'https://github.com/acme-labs/svc.git',
        baseBranch: 'main',
        github: { installationId: 888, keyRef: 'panel' },
      });
      expect((await audits('github.repo.create')).at(-1)).toMatchObject({
        outcome: 'success',
        metadata: {
          owner: 'acme-labs',
          name: 'svc',
          method: 'installation',
          project: 'alpha',
          linked: true,
          via: 'api',
        },
      });
      expect((await audits('project.git.update')).length).toBeGreaterThan(0);
    });

    it('refuses a name that exists, an installation without administration, an ambiguous owner, a linked project', async () => {
      const created = gh.created.length;
      const dup = await create({ owner: 'acme-labs', name: 'svc' });
      expect(dup.statusCode).toBe(409);
      // The console says it in the reader's language: the sentence's values travel as params.
      expect(dup.json()).toMatchObject({
        error: 'github_repo_exists',
        params: { repo: 'acme-labs/svc', url: 'https://github.com/acme-labs/svc' },
      });
      expect(dup.body).toContain('https://github.com/acme-labs/svc');
      const nope = await create({ owner: 'nope-org', name: 'x1' });
      expect(nope.statusCode).toBe(409);
      expect(nope.json()).toMatchObject({ error: 'github_repo_permission_missing' });
      const linked = await create({ owner: 'acme-labs', name: 'svc2', project: 'alpha' });
      expect(linked.statusCode).toBe(409);
      expect(linked.json()).toMatchObject({ error: 'project_has_repository' });
      const badName = await create({ owner: 'acme-labs', name: 'has space' });
      expect(badName.statusCode).toBe(400);
      expect(gh.created.length).toBe(created);
    });

    let authorizeState = '';
    it('authorize the GitHub account: always-fresh step-up, state bound and single use, token stored encrypted', async () => {
      h.clock.advance(11 * 60_000);
      expect((await owner.req('POST', '/integrations/github/accounts/authorize')).statusCode).toBe(403);
      await stepUp();
      const res = await call(owner, 'POST', '/integrations/github/accounts/authorize');
      expect(res.statusCode, res.body).toBe(200);
      const url = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${gh.base}/login/oauth/authorize`);
      expect(url.searchParams.get('client_id')).toBe('Iv1.fake');
      expect(url.searchParams.get('redirect_uri')).toBe(`${CONSOLE}/settings/integrations/github/callback`);
      authorizeState = url.searchParams.get('state') ?? '';
      expect(authorizeState).toMatch(/^u\.[A-Za-z0-9_-]{43}$/);

      gh.oauthCodes.set('oc-1', 'monaDev');
      const forged = await call(owner, 'POST', '/integrations/github/accounts/authorize/complete', {
        code: 'oc-1',
        state: `u.${'A'.repeat(43)}`,
      });
      expect(forged.statusCode).toBe(400);
      expect(forged.json()).toMatchObject({ error: 'github_auth_state_invalid' });
      const ok = await call(owner, 'POST', '/integrations/github/accounts/authorize/complete', {
        code: 'oc-1',
        state: authorizeState,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        kind: 'app_user',
        login: 'monaDev',
        usable: true,
        appId: String(gh.appId),
      });
      expect(ok.json<{ accessExpiresAt: string | null }>().accessExpiresAt).not.toBeNull();
      expect(gh.oauthRequests.at(-1)).toMatchObject({ client_secret: gh.clientSecret, code: 'oc-1' });
      gh.oauthCodes.set('oc-2', 'monaDev');
      const replay = await call(owner, 'POST', '/integrations/github/accounts/authorize/complete', {
        code: 'oc-2',
        state: authorizeState,
      });
      expect(replay.statusCode).toBe(400);
      // Encrypted at rest.
      const rows = await h.db.pool.query<Record<string, unknown>>('SELECT * FROM github_user_tokens');
      const dump =
        JSON.stringify(rows.rows) + rows.rows.map((r) => (r.secrets as Buffer).toString('latin1')).join('');
      for (const t of [...gh.userTokens.keys(), ...gh.refreshTokens.keys()]) expect(dump).not.toContain(t);
    });

    it('personal account: created with the user token and added to the installation; owner must be named when several can', async () => {
      const amb = await create({ name: 'my-app' });
      expect(amb.statusCode).toBe(400);
      expect(amb.json()).toMatchObject({ error: 'github_owner_ambiguous' });
      const res = await create({ owner: 'monaDev', name: 'my-app', project: 'beta' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        method: 'app_user',
        fullName: 'monaDev/my-app',
        linked: true,
        installationId: 777,
        warnings: [],
      });
      expect(gh.created.at(-1)).toMatchObject({
        name: 'my-app',
        private: true,
        auto_init: true,
        via: 'app_user',
      });
      expect(gh.installationAdds.at(-1)).toMatchObject({ installationId: 777, login: 'monaDev' });
      expect(gh.installations.find((i) => i.id === 777)?.repos.some((r) => r.name === 'my-app')).toBe(true);
      expect(
        (await call(owner, 'GET', '/projects/beta/git')).json<{ config: unknown }>().config,
      ).toMatchObject({
        repositoryUrl: 'https://github.com/monaDev/my-app.git',
        github: { installationId: 777, keyRef: 'panel' },
      });
    });

    it('existing names: seen (useExisting links it) and unseen by the token (GitHub 422) both refused', async () => {
      const created = gh.created.length;
      const seen = await create({ owner: 'monaDev', name: 'old-repo' });
      expect(seen.statusCode).toBe(409);
      expect(seen.json()).toMatchObject({ error: 'github_repo_exists' });
      const unseen = await create({ owner: 'monaDev', name: 'hidden' });
      expect(unseen.statusCode).toBe(409);
      expect(unseen.json()).toMatchObject({ error: 'github_repo_exists' });
      const use = await create({ owner: 'monaDev', name: 'old-repo', useExisting: true, project: 'gamma' });
      expect(use.statusCode, use.body).toBe(201);
      expect(use.json()).toMatchObject({
        created: false,
        linked: true,
        cloneUrl: 'https://github.com/monaDev/old-repo.git',
      });
      expect(gh.created.length).toBe(created);
    });

    it('idempotency: the same key replays the first result', async () => {
      const key = 'repo-key-0001';
      const a = await create({ owner: 'acme-labs', name: 'idem', idempotencyKey: key });
      expect(a.statusCode, a.body).toBe(201);
      const n = gh.created.length;
      const b = await create({ owner: 'acme-labs', name: 'idem', idempotencyKey: key });
      expect(b.statusCode, b.body).toBe(200);
      expect(b.json()).toMatchObject({ replayed: true, fullName: 'acme-labs/idem' });
      expect(gh.created.length).toBe(n);
    });

    it('token refresh: an expired user token is refreshed once (single-use refresh token); a dead one asks to authorize again', async () => {
      h.clock.advance(8 * 3_600_000 + 60_000);
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      const res = await create({ owner: 'monaDev', name: 'after-refresh' });
      expect(res.statusCode, res.body).toBe(201);
      expect(gh.oauthRequests.at(-1)).toMatchObject({
        grant_type: 'refresh_token',
        client_secret: gh.clientSecret,
      });
      expect((await audits('github.user_token.refresh')).at(-1)?.outcome).toBe('success');

      gh.refreshTokens.clear();
      h.clock.advance(8 * 3_600_000 + 60_000);
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      const dead = await create({ owner: 'monaDev', name: 'after-expiry' });
      expect(dead.statusCode).toBe(409);
      expect(dead.json()).toMatchObject({ error: 'github_user_token_expired' });
      expect((await audits('github.user_token.refresh')).at(-1)?.outcome).toBe('failure');
      const opts = (await call(owner, 'GET', '/integrations/github/repo-options')).json<{
        owners: { login: string; blocked: string | null }[];
      }>();
      expect(opts.owners.find((o) => o.login === 'monaDev')?.blocked).toBe('user_authorization_expired');
    });

    it('fallback: a fine-grained personal access token (checked with GET /user) creates for the account', async () => {
      await stepUp();
      const bad = await call(owner, 'PUT', '/integrations/github/accounts/token', {
        token: 'ghp_classicclassicclassic00',
      });
      expect(bad.statusCode).toBe(400);
      const pat = `github_pat_${'A1b2'.repeat(10)}`;
      const unknown = await call(owner, 'PUT', '/integrations/github/accounts/token', { token: pat });
      expect(unknown.statusCode).toBe(400);
      gh.pats.set(pat, 'monaDev');
      const ok = await call(owner, 'PUT', '/integrations/github/accounts/token', { token: pat });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ kind: 'pat', login: 'monaDev', usable: true });
      const res = await create({ owner: 'monaDev', name: 'pat-repo', project: 'epsilon', private: false });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ method: 'pat', private: false, linked: true });
      expect(gh.created.at(-1)).toMatchObject({ via: 'pat', private: false });
      const dump = JSON.stringify((await h.db.pool.query('SELECT * FROM github_user_tokens')).rows);
      expect(dump).not.toContain(pat);
    });

    it('never stores, logs, audits or returns a token or the client secret', async () => {
      const audit = JSON.stringify((await h.db.pool.query('SELECT metadata FROM audit_events')).rows);
      const creations = JSON.stringify((await h.db.pool.query('SELECT * FROM github_repo_creations')).rows);
      const secrets = [gh.clientSecret, ...gh.userTokens.keys(), ...gh.pats.keys()];
      for (const s of secrets) {
        expect(audit).not.toContain(s);
        expect(creations).not.toContain(s);
        expect(h.logs.text).not.toContain(s);
        for (const b of bodies) expect(b).not.toContain(s);
      }
    });

    describe('the assistant (create_repository through the real transport)', () => {
      const engine = new FakeAssistantEngine();
      const dirs: string[] = [];
      let worker: RunningWorker | undefined;
      const tool = (name: string, input: Record<string, unknown>) =>
        `[[tool ${name} ${JSON.stringify(input)}]]`;

      async function thread(): Promise<string> {
        const r = await owner.req('POST', '/chat/threads', {});
        expect(r.statusCode, r.body).toBe(201);
        return r.json<{ id: string }>().id;
      }
      async function detail(id: string) {
        const r = await owner.req('GET', `/chat/threads/${id}`);
        return r.json<{
          messages: { seq: number; role: string; content: string }[];
          drafts: { id: string; kind: string; state: string; result: Record<string, unknown> | null }[];
          turn: unknown;
        }>();
      }
      async function ask(id: string, text: string): Promise<string> {
        const r = await owner.req('POST', `/chat/threads/${id}/messages`, { text });
        expect(r.statusCode, r.body).toBe(202);
        const seq = r.json<{ message: { seq: number } }>().message.seq;
        let last: string | undefined;
        await expect
          .poll(
            async () => {
              const d = await detail(id);
              last = d.messages
                .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
                .at(-1)?.content;
              return d.turn === null && last !== undefined;
            },
            { timeout: 20_000 },
          )
          .toBe(true);
        return last ?? '';
      }

      afterAll(async () => {
        await worker?.stop().catch(() => undefined);
        await removeDirs(dirs);
      });

      it('sets up the assistant machine', async () => {
        await h.setSecurityPolicy({ preset: 'serbest' });
        const url = await h.listen();
        const dataDir = await tempDataDir(dirs);
        const workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
        worker = await runRealWorker(url, dataDir, {
          capabilities: CAPS,
          assistant: { engine, clock: h.clock.now },
        });
        await stepUp();
        const s = await owner.req('PUT', '/chat/settings', {
          enabled: true,
          workerId,
          runtime: 'claude-code',
          modelProfile: null,
          expectedVersion: 1,
        });
        expect(s.statusCode, s.body).toBe(200);
        await expect
          .poll(
            async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available,
            { timeout: 20_000 },
          )
          .toBe(true);
      });

      it("the user's command opens and links the repository at once (audited as chat)", async () => {
        const t = await thread();
        const reply = await ask(
          t,
          tool('create_repository', { owner: 'acme-labs', name: 'chat-repo', project: 'delta' }),
        );
        expect(reply).toContain('executed');
        const d = (await detail(t)).drafts[0];
        expect(d).toMatchObject({ kind: 'github_repo', state: 'confirmed' });
        expect(gh.created.at(-1)).toMatchObject({ name: 'chat-repo', private: true });
        expect((await audits('github.repo.create')).at(-1)?.metadata).toMatchObject({
          via: 'chat',
          project: 'delta',
          linked: true,
        });
      });

      it('an existing name is refused without a card and names the repository; propose keeps a card', async () => {
        const t = await thread();
        const refused = await ask(t, tool('create_repository', { owner: 'acme-labs', name: 'chat-repo' }));
        expect(refused).toContain('already exists');
        expect((await detail(t)).drafts).toEqual([]);
        const t2 = await thread();
        await ask(
          t2,
          tool('create_repository', {
            owner: 'acme-labs',
            name: 'proposed-repo',
            project: 'zeta',
            propose: true,
          }),
        );
        const d = (await detail(t2)).drafts[0];
        expect(d).toMatchObject({ kind: 'github_repo', state: 'proposed' });
        expect(gh.created.some((c) => c.name === 'proposed-repo')).toBe(false);
        const ok = await owner.req('POST', `/chat/drafts/${d?.id ?? ''}/confirm`);
        expect(ok.statusCode, ok.body).toBe(200);
        expect(gh.created.some((c) => c.name === 'proposed-repo')).toBe(true);
      });
    });
  },
);
