import { createVerify, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A local fake of the parts of GitHub the panel-connected App uses (p5-github-connect). Real HTTP on loopback:
 *
 * - `POST /app-manifests/{code}/conversions` (no auth) — the manifest flow's code exchange;
 * - App JWT endpoints (`GET /app`, `GET /app/installations`, `POST /app/installations/{id}/access_tokens`): the JWT
 *   signature is verified against the App's *current* public keys (a rotated-out key gets 401);
 * - installation-token endpoints (`GET /installation/repositories`, `GET /repos/{o}/{r}/branches/{b}`,
 *   `GET /repos/{o}/{r}/rules/branches/{b}`).
 *
 * Every request is recorded (method, path, auth kind) for assertions.
 */
export interface FakeRepo {
  readonly owner: string;
  readonly name: string;
  /** p15-github-create-repo: GitHub's numeric id (assigned when absent). */
  id?: number;
  readonly defaultBranch?: string;
  readonly private?: boolean;
  readonly archived?: boolean;
}

export interface FakeInstallation {
  readonly id: number;
  /** p17-chat-github: the App it belongs to (default: the main App). */
  readonly appId?: number;
  readonly account: string;
  readonly accountType?: 'User' | 'Organization';
  readonly selection?: 'all' | 'selected';
  readonly repos: FakeRepo[];
  /** p15-github-create-repo: permissions the installation accepted (GET /app/installations). */
  permissions?: Record<string, string>;
}

/**
 * p15-github-create-repo: a GitHub user (personal account) with its repositories (also those the App installation
 * does not include) — user access tokens (`ghu_`), refresh tokens (`ghr_`) and fine-grained tokens (`github_pat_`).
 */
export interface FakeUser {
  readonly login: string;
  readonly id: number;
  readonly repos: FakeRepo[];
}

export class FakeGitHub {
  readonly appId = 4242;
  readonly slug = 'remyral-console-example-test';
  readonly clientSecret = `cs_${randomBytes(20).toString('hex')}`;
  readonly webhookSecret = `wh_${randomBytes(20).toString('hex')}`;
  /** PEM of the App's first key (what the conversion returns). */
  readonly pem: string;
  /** Codes the conversion accepts (each once). */
  readonly codes = new Set<string>();
  readonly installations: FakeInstallation[] = [];
  /** `owner/repo/branch` → classic protection, ruleset rule types. */
  readonly protection = new Map<string, { classic: boolean; rules: string[] }>();
  readonly requests: { method: string; path: string; auth: 'none' | 'jwt' | 'token' | 'bad' }[] = [];
  /** Tokens handed out → installation id. */
  readonly tokens = new Map<string, number>();
  /** Last access-token request bodies. */
  readonly tokenRequests: unknown[] = [];
  /** Last `PATCH /app/hook/config` body (p6-automations). */
  hookConfig: Record<string, unknown> | null = null;
  // ------------------------------------------------------------------- p15-github-create-repo
  readonly users: FakeUser[] = [];
  /** OAuth codes the authorization redirect would carry → user login. */
  readonly oauthCodes = new Map<string, string>();
  /** Live user access tokens → login (with expiry), refresh tokens → login. */
  readonly userTokens = new Map<string, { login: string; expiresAt: number }>();
  readonly refreshTokens = new Map<string, string>();
  /** Fine-grained personal access tokens → login. */
  readonly pats = new Map<string, string>();
  /** Lifetime of user access tokens in seconds (GitHub: 8 hours); null = non-expiring tokens. */
  userTokenTtlSec: number | null = 28_800;
  /** Organization logins whose repositories exist outside the installation (name clash checks). */
  readonly orgRepos: FakeRepo[] = [];
  /** Installation tokens: refuse a repository the installation does not include (like GitHub). */
  strictRepoTokens = false;
  /** Last OAuth form bodies (assertions: client secret sent, grant types). */
  readonly oauthRequests: Record<string, string>[] = [];
  /** Clock of the fake (token expiry). */
  now: () => number = () => Date.now();
  #nextRepoId = 9000;
  readonly #keys: KeyObject[] = [];
  readonly #tokenPerms = new Map<string, Record<string, string>>();
  /** Repository creation requests (body + owner + how). */
  readonly created: Record<string, unknown>[] = [];
  /** PUT /user/installations/{id}/repositories/{repo_id} calls. */
  readonly installationAdds: { installationId: number; repoId: number; login: string }[] = [];
  #server: Server | null = null;
  base = '';
  /**
   * p17-chat-github: further Apps (one private App per account): a conversion code starting with `<prefix>` creates the App
   * registered under that prefix; its JWTs verify against its own key and see only its own installations.
   */
  readonly extraApps = new Map<
    number,
    {
      readonly slug: string;
      readonly owner: { readonly login: string; readonly type: 'User' | 'Organization' };
      readonly pem: string;
      readonly key: KeyObject;
      readonly webhookSecret: string;
      readonly codePrefix: string;
    }
  >();

  /** p17-chat-github: registers another App; conversion codes starting with `codePrefix` create it. */
  addApp(
    appId: number,
    slug: string,
    owner: { login: string; type: 'User' | 'Organization' },
    codePrefix: string,
  ): { pem: string; webhookSecret: string } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const webhookSecret = `wh_${randomBytes(20).toString('hex')}`;
    this.extraApps.set(appId, { slug, owner, pem, key: publicKey, webhookSecret, codePrefix });
    return { pem, webhookSecret };
  }

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.#keys.push(publicKey);
  }

  /** A new App key (as if generated on GitHub); returns its PEM. */
  newKey(): string {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#keys.push(publicKey);
    return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  /** The owner deletes the App's first key on GitHub (JWTs signed with it get 401). */
  revokeOriginalKey(): void {
    this.#keys.shift();
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          this.#handle(req, res, Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(500).end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.#server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    this.base = `http://127.0.0.1:${String(addr.port)}`;
    return this.base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server?.close(() => {
        resolve();
      });
    });
  }

  #json(res: ServerResponse, status: number, body: unknown): true {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    return true;
  }

  /** The App a JWT authenticates (null: none). */
  #jwtApp(header: string | undefined): number | null {
    const m = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(header ?? '');
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')) as { iss?: unknown };
    const extra = this.extraApps.get(Number(payload.iss));
    if (extra !== undefined) {
      return createVerify('RSA-SHA256')
        .update(`${m[1]}.${m[2]}`)
        .verify(extra.key, Buffer.from(m[3], 'base64url'))
        ? Number(payload.iss)
        : null;
    }
    return this.#jwtOk(header) ? this.appId : null;
  }

  #jwtOk(header: string | undefined): boolean {
    const m = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(header ?? '');
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return false;
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')) as { iss?: unknown };
    if (String(payload.iss) !== String(this.appId)) return false;
    return this.#keys.some((k) =>
      createVerify('RSA-SHA256')
        .update(`${m[1] ?? ''}.${m[2] ?? ''}`)
        .verify(k, Buffer.from(m[3] ?? '', 'base64url')),
    );
  }

  #installationOf(header: string | undefined): FakeInstallation | null {
    const m = /^Bearer (ghs_[A-Za-z0-9]+)$/.exec(header ?? '');
    const id = m?.[1] === undefined ? undefined : this.tokens.get(m[1]);
    return this.installations.find((i) => i.id === id) ?? null;
  }

  #installationJson(i: FakeInstallation) {
    return {
      id: i.id,
      app_id: i.appId ?? this.appId,
      account: { login: i.account, type: i.accountType ?? 'User' },
      repository_selection: i.selection ?? 'selected',
      permissions: i.permissions ?? { contents: 'write', metadata: 'read', pull_requests: 'write' },
      suspended_at: null,
      html_url: `${this.base}/settings/installations/${String(i.id)}`,
    };
  }

  #handle(req: IncomingMessage, res: ServerResponse, body: string): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const auth = req.headers.authorization;
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const slice = <T>(xs: T[]): T[] => xs.slice((page - 1) * perPage, page * perPage);
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (req.method === 'POST' && conv?.[1] !== undefined) {
      this.requests.push({ method: 'POST', path: '/app-manifests/:code/conversions', auth: 'none' });
      const code = decodeURIComponent(conv[1]);
      if (!this.codes.delete(code)) return this.#json(res, 404, { message: 'Not Found' });
      const other = [...this.extraApps].find(([, a]) => code.startsWith(a.codePrefix));
      if (other !== undefined) {
        const [id, a] = other;
        return this.#json(res, 201, {
          id,
          slug: a.slug,
          name: `Remyral ${a.owner.login}`,
          owner: a.owner,
          html_url: `${this.base}/apps/${a.slug}`,
          client_id: `Iv1.fake${String(id)}`,
          client_secret: `cs_${String(id)}`,
          webhook_secret: a.webhookSecret,
          pem: a.pem,
          permissions: {
            contents: 'write',
            pull_requests: 'write',
            checks: 'read',
            statuses: 'read',
            metadata: 'read',
          },
          events: [],
        });
      }
      return this.#json(res, 201, {
        id: this.appId,
        slug: this.slug,
        node_id: 'A_1',
        name: 'Remyral console.example.test',
        owner: { login: 'octo-org', type: 'User' },
        html_url: `${this.base}/apps/${this.slug}`,
        client_id: 'Iv1.fake',
        client_secret: this.clientSecret,
        webhook_secret: this.webhookSecret,
        pem: this.pem,
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          checks: 'read',
          statuses: 'read',
          metadata: 'read',
        },
        events: [],
      });
    }
    if (path === '/app' || path.startsWith('/app/')) {
      const jwtApp = this.#jwtApp(auth);
      const ok = jwtApp !== null;
      const mine = (i: FakeInstallation): boolean => (i.appId ?? this.appId) === jwtApp;
      this.requests.push({
        method: req.method ?? '',
        path: path.replace(/\d+/g, ':n'),
        auth: ok ? 'jwt' : 'bad',
      });
      if (!ok) return this.#json(res, 401, { message: 'Bad credentials' });
      if (req.method === 'GET' && path === '/app') {
        return this.#json(res, 200, {
          id: jwtApp,
          slug: this.extraApps.get(jwtApp)?.slug ?? this.slug,
          name: 'Remyral',
        });
      }
      if (req.method === 'PATCH' && path === '/app/hook/config') {
        // p6-automations: the master points the App webhook at itself with a fresh secret.
        this.hookConfig = JSON.parse(body || '{}') as Record<string, unknown>;
        const { secret: _secret, ...shown } = this.hookConfig;
        return this.#json(res, 200, { ...shown, secret: '********' });
      }
      if (req.method === 'GET' && path === '/app/installations') {
        return this.#json(
          res,
          200,
          slice(this.installations.filter(mine)).map((i) => this.#installationJson(i)),
        );
      }
      const tok = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (req.method === 'POST' && tok?.[1] !== undefined) {
        const inst = this.installations.find((i) => i.id === Number(tok[1]) && mine(i));
        if (inst === undefined) return this.#json(res, 404, { message: 'Not Found' });
        const req2 = JSON.parse(body || '{}') as {
          repositories?: string[];
          permissions?: Record<string, string>;
        };
        // Installations without declared permissions accept every request (the suites before p15-github-create-repo).
        const have = inst.permissions;
        for (const [k, v] of Object.entries(have === undefined ? {} : (req2.permissions ?? {}))) {
          const rank = (x: string | undefined) => (x === 'write' ? 2 : x === 'read' ? 1 : 0);
          if (rank(have?.[k]) < rank(v)) {
            return this.#json(res, 422, {
              message: `The permissions requested are not granted to this installation.`,
            });
          }
        }
        if (
          this.strictRepoTokens &&
          (inst.selection ?? 'selected') === 'selected' &&
          (req2.repositories ?? []).some((n) => !inst.repos.some((r) => r.name === n))
        ) {
          return this.#json(res, 422, {
            message:
              'There is at least one repository that does not exist or is not accessible to the parent installation.',
          });
        }
        this.tokenRequests.push(req2);
        const token = `ghs_${randomBytes(16).toString('hex')}`;
        this.tokens.set(token, inst.id);
        this.#tokenPerms.set(token, req2.permissions ?? {});
        return this.#json(res, 201, { token, expires_at: '2099-01-01T00:00:00Z' });
      }
      return this.#json(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && path === '/login/oauth/access_token') {
      return this.#oauth(res, body);
    }
    const user = this.#userOf(auth);
    if (user !== null) {
      this.requests.push({ method: req.method ?? '', path, auth: 'token' });
      return this.#userApi(req.method ?? '', path, user, body, res, auth ?? '');
    }
    if (/^Bearer gh[ur]_/.test(auth ?? '') || /^Bearer github_pat_/.test(auth ?? '')) {
      this.requests.push({ method: req.method ?? '', path, auth: 'bad' });
      return this.#json(res, 401, { message: 'Bad credentials' });
    }
    const inst = this.#installationOf(auth);
    this.requests.push({ method: req.method ?? '', path, auth: inst === null ? 'bad' : 'token' });
    if (inst === null) return this.#json(res, 401, { message: 'Bad credentials' });
    if (req.method === 'GET' && path === '/installation/repositories') {
      const repos = inst.repos.map((r) => ({
        full_name: `${r.owner}/${r.name}`,
        name: r.name,
        owner: { login: r.owner },
        private: r.private ?? true,
        archived: r.archived ?? false,
        default_branch: r.defaultBranch ?? 'main',
        clone_url: `https://github.com/${r.owner}/${r.name}.git`,
        html_url: `https://github.com/${r.owner}/${r.name}`,
      }));
      return this.#json(res, 200, { total_count: repos.length, repositories: slice(repos) });
    }
    const orgCreate = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (req.method === 'POST' && orgCreate?.[1] !== undefined) {
      const tokenPerms = this.#tokenPerms.get(/^Bearer (.+)$/.exec(auth ?? '')?.[1] ?? '') ?? {};
      if (tokenPerms.administration !== 'write' || inst.account !== orgCreate[1]) {
        return this.#json(res, 403, { message: 'Resource not accessible by integration' });
      }
      const b = JSON.parse(body || '{}') as Record<string, unknown>;
      const name = String(b.name);
      if (
        [...inst.repos, ...this.orgRepos].some(
          (r) => r.owner === inst.account && r.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return this.#json(res, 422, {
          message: 'Repository creation failed.',
          errors: [
            {
              resource: 'Repository',
              code: 'custom',
              field: 'name',
              message: 'name already exists on this account',
            },
          ],
        });
      }
      const repo: FakeRepo = {
        owner: inst.account,
        name,
        private: b.private !== false,
        id: this.#nextRepoId++,
        ...(b.auto_init === true ? {} : { defaultBranch: 'main' }),
      };
      this.created.push({ ...b, owner: inst.account, via: 'installation' });
      // A repository the installation itself created is part of it (GitHub adds it to a "selected" installation).
      inst.repos.push(repo);
      return this.#json(res, 201, this.#repoJson(repo));
    }
    const one = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && one?.[1] !== undefined && one[2] !== undefined) {
      const repo = inst.repos.find(
        (r) => r.owner === one[1] && r.name.toLowerCase() === (one[2] ?? '').toLowerCase(),
      );
      return repo === undefined
        ? this.#json(res, 404, { message: 'Not Found' })
        : this.#json(res, 200, this.#repoJson(repo));
    }
    const br = /^\/repos\/([^/]+)\/([^/]+)\/(branches|rules\/branches)\/(.+)$/.exec(path);
    if (req.method === 'GET' && br?.[1] !== undefined && br[2] !== undefined && br[4] !== undefined) {
      const repo = inst.repos.find((r) => r.owner === br[1] && r.name === br[2]);
      if (repo === undefined) return this.#json(res, 404, { message: 'Not Found' });
      const branch = decodeURIComponent(br[4]);
      if (branch !== (repo.defaultBranch ?? 'main'))
        return this.#json(res, 404, { message: 'Branch not found' });
      const p = this.protection.get(`${br[1]}/${br[2]}/${branch}`) ?? { classic: false, rules: [] };
      if (br[3] === 'branches') return this.#json(res, 200, { name: branch, protected: p.classic });
      return this.#json(
        res,
        200,
        p.rules.map((type) => ({ type, ruleset_source_type: 'Repository', ruleset_id: 1 })),
      );
    }
    return this.#json(res, 404, { message: 'Not Found' });
  }

  // ------------------------------------------------------------------- p15-github-create-repo helpers

  /** Issues a user access token (+ refresh token) for `login` as GitHub's token endpoint would. */
  issueUserToken(login: string): { access: string; refresh: string } {
    const access = `ghu_${randomBytes(16).toString('hex')}`;
    const refresh = `ghr_${randomBytes(16).toString('hex')}`;
    this.userTokens.set(access, {
      login,
      expiresAt:
        this.userTokenTtlSec === null ? Number.POSITIVE_INFINITY : this.now() + this.userTokenTtlSec * 1000,
    });
    this.refreshTokens.set(refresh, login);
    return { access, refresh };
  }

  #repoJson(r: FakeRepo) {
    if (r.id === undefined) r.id = this.#nextRepoId++;
    return {
      id: r.id,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner },
      private: r.private ?? true,
      default_branch: r.defaultBranch ?? 'main',
      clone_url: `https://github.com/${r.owner}/${r.name}.git`,
      html_url: `https://github.com/${r.owner}/${r.name}`,
    };
  }

  #userOf(header: string | undefined): FakeUser | null {
    const t = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
    const ut = this.userTokens.get(t);
    const login = ut !== undefined && ut.expiresAt > this.now() ? ut.login : this.pats.get(t);
    return login === undefined ? null : (this.users.find((u) => u.login === login) ?? null);
  }

  #oauth(res: ServerResponse, body: string): true {
    const f = Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
    this.oauthRequests.push(f);
    this.requests.push({ method: 'POST', path: '/login/oauth/access_token', auth: 'none' });
    if (f.client_id !== 'Iv1.fake' || f.client_secret !== this.clientSecret) {
      return this.#json(res, 200, { error: 'incorrect_client_credentials' });
    }
    let login: string | undefined;
    if (f.grant_type === 'refresh_token') {
      login = this.refreshTokens.get(f.refresh_token ?? '');
      if (login === undefined) return this.#json(res, 200, { error: 'bad_refresh_token' });
      // Refresh tokens are single use.
      this.refreshTokens.delete(f.refresh_token ?? '');
    } else {
      login = this.oauthCodes.get(f.code ?? '');
      if (login === undefined) return this.#json(res, 200, { error: 'bad_verification_code' });
      this.oauthCodes.delete(f.code ?? '');
    }
    const t = this.issueUserToken(login);
    return this.#json(res, 200, {
      access_token: t.access,
      token_type: 'bearer',
      scope: '',
      ...(this.userTokenTtlSec === null
        ? {}
        : {
            expires_in: this.userTokenTtlSec,
            refresh_token: t.refresh,
            refresh_token_expires_in: 15_897_600,
          }),
    });
  }

  #userApi(
    method: string,
    path: string,
    user: FakeUser,
    body: string,
    res: ServerResponse,
    auth: string,
  ): true {
    const isApp = /^Bearer ghu_/.test(auth);
    const inst = this.installations.find((i) => i.account === user.login);
    if (method === 'GET' && path === '/user') {
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(isApp ? {} : { 'github-authentication-token-expiration': '2099-01-01 00:00:00 UTC' }),
      });
      res.end(JSON.stringify({ login: user.login, id: user.id, type: 'User' }));
      return true;
    }
    const one = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === 'GET' && one?.[1] !== undefined && one[2] !== undefined) {
      // An App user token sees only what the installation includes; a token sees all of the user's repositories.
      const pool = isApp && (inst?.selection ?? 'selected') === 'selected' ? (inst?.repos ?? []) : user.repos;
      const repo = pool.find(
        (r) => r.owner === one[1] && r.name.toLowerCase() === (one[2] ?? '').toLowerCase(),
      );
      return repo === undefined
        ? this.#json(res, 404, { message: 'Not Found' })
        : this.#json(res, 200, this.#repoJson(repo));
    }
    if (method === 'POST' && path === '/user/repos') {
      if (isApp && (inst?.permissions ?? {}).administration !== 'write') {
        return this.#json(res, 403, { message: 'Resource not accessible by integration' });
      }
      const b = JSON.parse(body || '{}') as Record<string, unknown>;
      const name = String(b.name);
      if (user.repos.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        return this.#json(res, 422, {
          message: 'Repository creation failed.',
          errors: [
            {
              resource: 'Repository',
              code: 'custom',
              field: 'name',
              message: 'name already exists on this account',
            },
          ],
        });
      }
      const repo: FakeRepo = {
        owner: user.login,
        name,
        private: b.private !== false,
        id: this.#nextRepoId++,
      };
      user.repos.push(repo);
      this.created.push({ ...b, owner: user.login, via: isApp ? 'app_user' : 'pat' });
      return this.#json(res, 201, this.#repoJson(repo));
    }
    const add = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(path);
    if (method === 'PUT' && add?.[1] !== undefined && add[2] !== undefined) {
      const target = this.installations.find((i) => i.id === Number(add[1]));
      const repo = user.repos.find((r) => r.id === Number(add[2]));
      if (target === undefined || repo === undefined || target.account !== user.login) {
        return this.#json(res, 404, { message: 'Not Found' });
      }
      this.installationAdds.push({ installationId: target.id, repoId: repo.id ?? 0, login: user.login });
      if (!target.repos.includes(repo)) target.repos.push(repo);
      res.writeHead(204).end();
      return true;
    }
    return this.#json(res, 404, { message: 'Not Found' });
  }
}
