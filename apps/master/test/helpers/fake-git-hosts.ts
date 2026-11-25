import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * p16-git-providers: local fakes of the parts of GitLab REST v4 and Bitbucket Cloud REST 2.0 the platform uses, backed
 * by a REAL bare git repository (branches, commits, merge bases, diffs and merges are real git), served over loopback
 * HTTP. Every request is recorded (method, path, whether it was authenticated) for assertions; tokens are checked.
 */

const SHA = /^[0-9a-f]{40}$/;

/** A string field of an untrusted JSON body (anything else: the default). */
const txt = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);

/** git on a bare repository (no system / global config). */
export class BareGit {
  constructor(readonly dir: string) {}

  run(args: readonly string[], input?: string): string {
    return execFileSync('git', [...args], {
      cwd: this.dir,
      env: {
        PATH: process.env.PATH,
        HOME: this.dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Host Bot',
        GIT_AUTHOR_EMAIL: 'bot@host.test',
        GIT_COMMITTER_NAME: 'Host Bot',
        GIT_COMMITTER_EMAIL: 'bot@host.test',
      },
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  tryRun(args: readonly string[]): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.run(args) };
    } catch (err) {
      const e = err as { stdout?: string | Buffer };
      return { ok: false, out: String(e.stdout ?? '').trim() };
    }
  }

  head(branch: string): string | null {
    const r = this.tryRun(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return r.ok && SHA.test(r.out) ? r.out : null;
  }

  resolve(rev: string): string | null {
    const r = this.tryRun(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return r.ok && SHA.test(r.out) ? r.out : null;
  }

  mergeBase(a: string, b: string): string | null {
    const r = this.tryRun(['merge-base', a, b]);
    return r.ok && SHA.test(r.out) ? r.out : null;
  }

  commit(sha: string): {
    sha: string;
    parents: string[];
    name: string;
    email: string;
    date: string;
    message: string;
  } {
    const out = this.run(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', sha]);
    const [h, p, name, email, date, ...msg] = out.split('\u0000');
    return {
      sha: h ?? '',
      parents: (p ?? '').split(' ').filter((x) => x !== ''),
      name: name ?? '',
      email: email ?? '',
      date: date ?? '',
      message: msg.join('\u0000'),
    };
  }

  /** Commits reachable from `head` but not `exclude`, newest first. */
  log(head: string, exclude: string | null, max = 200): string[] {
    const args = [
      'rev-list',
      `--max-count=${String(max)}`,
      head,
      ...(exclude === null ? [] : [`^${exclude}`]),
    ];
    const out = this.run(args);
    return out === '' ? [] : out.split('\n');
  }

  /** Changed files `from` → `to` (rename detection on), with numstat counts and per-file patch. */
  diff(
    from: string,
    to: string,
  ): { status: string; path: string; old: string; add: number; del: number; patch: string }[] {
    const names = this.run(['diff', '--name-status', '-M', from, to]);
    if (names === '') return [];
    const nums = new Map<string, { add: number; del: number }>();
    for (const line of this.run(['diff', '--numstat', '-M', from, to]).split('\n')) {
      const [a, d, ...rest] = line.split('\t');
      const path = rest
        .join('\t')
        .replace(/^.*=> /, '')
        .replace(/[{}]/g, '');
      nums.set(path, { add: Number(a) || 0, del: Number(d) || 0 });
    }
    return names.split('\n').map((line) => {
      const parts = line.split('\t');
      const code = (parts[0] ?? 'M')[0] ?? 'M';
      const path = parts[parts.length - 1] ?? '';
      const old = parts.length === 3 ? (parts[1] ?? path) : path;
      const n = nums.get(path) ?? { add: 0, del: 0 };
      const patch = this.run(['diff', '-M', from, to, '--', ...(old === path ? [path] : [old, path])])
        .split('\n')
        .filter(
          (l) =>
            !l.startsWith('diff --git') &&
            !l.startsWith('index ') &&
            !l.startsWith('---') &&
            !l.startsWith('+++'),
        )
        .join('\n');
      return {
        status: code === 'A' ? 'added' : code === 'D' ? 'removed' : code === 'R' ? 'renamed' : 'modified',
        path,
        old,
        add: n.add,
        del: n.del,
        patch,
      };
    });
  }

  /** Test merge of `head` into `base`: the merged tree, or the conflicting paths. */
  mergeTree(base: string, head: string): { tree: string } | { conflicts: string[] } {
    const r = this.tryRun(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head]);
    const lines = r.out.split('\n').filter((l) => l !== '');
    if (r.ok) return { tree: lines[0] ?? '' };
    return { conflicts: [...new Set(lines.slice(1))] };
  }

  commitTree(tree: string, parents: readonly string[], message: string): string {
    return this.run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], message);
  }

  setBranch(branch: string, sha: string): void {
    this.run(['update-ref', `refs/heads/${branch}`, sha]);
  }

  deleteBranch(branch: string): void {
    this.run(['update-ref', '-d', `refs/heads/${branch}`]);
  }
}

interface Recorded {
  method: string;
  path: string;
  authed: boolean;
}

abstract class FakeHost {
  server: Server | null = null;
  port = 0;
  readonly requests: Recorded[] = [];
  /** Status checks per commit sha (test-provided). */
  readonly statuses = new Map<string, Record<string, unknown>[]>();

  constructor(readonly git: BareGit) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: unknown = null;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw !== '') {
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            body = null;
          }
        }
        try {
          this.handle(req, res, body);
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'error' }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === null) resolve();
      else
        this.server.close(() => {
          resolve();
        });
    });
  }

  protected abstract handle(req: IncomingMessage, res: ServerResponse, body: unknown): unknown;

  protected send(
    res: ServerResponse,
    status: number,
    json?: unknown,
    headers: Record<string, string> = {},
  ): true {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(json === undefined ? '' : JSON.stringify(json));
    return true;
  }
}

// ------------------------------------------------------------------------------------------------ GitLab

export interface FakeGitLabToken {
  id: number;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  active: boolean;
}

export interface FakeMr {
  iid: number;
  source: string;
  target: string;
  title: string;
  description: string;
  state: 'opened' | 'merged' | 'closed';
  mergeCommit: string | null;
  squashCommit: string | null;
  notes: { id: number; body: string }[];
}

export class FakeGitLab extends FakeHost {
  readonly tokens = new Map<string, FakeGitLabToken>();
  readonly mrs: FakeMr[] = [];
  /** The repository this fake serves (`group/project`). */
  projectPath = 'acme/app';
  groups = new Set(['acme']);
  /** The next N single-MR reads answer `checking` (GitLab computes mergeability asynchronously). */
  checkingReads = 0;
  /** Merges answer 401 (a protected branch the token may not merge). */
  refuseMerge = false;
  readonly created: string[] = [];
  #nextId = 100;

  addToken(scopes: string[], expiresAt: string | null = '2027-06-30'): string {
    const token = `glpat-${randomBytes(10).toString('hex')}`;
    this.#nextId += 1;
    this.tokens.set(token, { id: this.#nextId, name: 'remyral', scopes, expiresAt, active: true });
    return token;
  }

  #project(): Record<string, unknown> {
    return {
      id: 7,
      path_with_namespace: this.projectPath,
      http_url_to_repo: `https://git.example.test/${this.projectPath}.git`,
      web_url: `https://git.example.test/${this.projectPath}`,
      default_branch: 'main',
      visibility: 'private',
      archived: false,
    };
  }

  #mrJson(m: FakeMr, decide: boolean): Record<string, unknown> {
    const sha = this.git.head(m.source);
    let detailed = 'mergeable';
    let conflicts = false;
    if (m.state === 'opened') {
      if (decide && this.checkingReads > 0) {
        this.checkingReads -= 1;
        detailed = 'checking';
      } else {
        const base = this.git.head(m.target);
        const t = base === null || sha === null ? { conflicts: [] } : this.git.mergeTree(base, sha);
        if ('conflicts' in t) {
          detailed = 'conflict';
          conflicts = true;
        }
      }
    } else {
      detailed = 'not_open';
    }
    return {
      iid: m.iid,
      title: m.title,
      description: m.description,
      state: m.state,
      source_branch: m.source,
      target_branch: m.target,
      sha,
      web_url: `https://git.example.test/${this.projectPath}/-/merge_requests/${String(m.iid)}`,
      detailed_merge_status: detailed,
      merge_status: conflicts ? 'cannot_be_merged' : 'can_be_merged',
      has_conflicts: conflicts,
      merge_commit_sha: m.mergeCommit,
      squash_commit_sha: m.squashCommit,
    };
  }

  #commitJson(sha: string): Record<string, unknown> {
    const c = this.git.commit(sha);
    return {
      id: c.sha,
      short_id: c.sha.slice(0, 11),
      title: c.message.split('\n', 1)[0],
      message: c.message,
      parent_ids: c.parents,
      author_name: c.name,
      author_email: c.email,
      authored_date: c.date,
    };
  }

  protected handle(req: IncomingMessage, res: ServerResponse, body: unknown): unknown {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    const token = String(req.headers['private-token'] ?? '');
    const t = this.tokens.get(token);
    this.requests.push({ method, path: url.pathname + url.search, authed: t !== undefined });
    if (t === undefined || !t.active) return this.send(res, 401, { message: '401 Unauthorized' });
    const path = url.pathname.replace(/^\/api\/v4/, '');
    const q = url.searchParams;
    const b = (body ?? {}) as Record<string, unknown>;

    if (path === '/personal_access_tokens/self' && method === 'GET') {
      return this.send(res, 200, {
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        expires_at: t.expiresAt,
        active: true,
        revoked: false,
      });
    }
    const groupRotate = /^\/(projects|groups)\/([^/]+)\/access_tokens\/self\/rotate$/.exec(path);
    if (groupRotate !== null && method === 'POST') {
      if (!t.scopes.includes('api') && !t.scopes.includes('self_rotate'))
        return this.send(res, 403, { message: '403 Forbidden' });
      this.tokens.delete(token);
      const next = this.addToken(t.scopes, q.get('expires_at'));
      const nt = this.tokens.get(next);
      return this.send(res, 200, {
        id: nt?.id,
        name: t.name,
        scopes: t.scopes,
        expires_at: q.get('expires_at'),
        active: true,
        token: next,
      });
    }
    const group = /^\/groups\/([^/]+)(\/projects)?$/.exec(path);
    if (group !== null && method === 'GET') {
      const g = decodeURIComponent(group[1] ?? '');
      if (!this.groups.has(g)) return this.send(res, 404, { message: '404 Group Not Found' });
      if (group[2] === undefined) return this.send(res, 200, { id: 3, full_path: g });
      const all = [
        this.#project(),
        ...this.created.map((p) => ({ ...this.#project(), path_with_namespace: p })),
      ];
      const s = q.get('search') ?? '';
      return this.send(
        res,
        200,
        all.filter((p) => String(p.path_with_namespace).includes(s)),
      );
    }
    const ns = /^\/namespaces\/([^/]+)$/.exec(path);
    if (ns !== null && method === 'GET') {
      const g = decodeURIComponent(ns[1] ?? '');
      return this.groups.has(g)
        ? this.send(res, 200, { id: 3, full_path: g })
        : this.send(res, 404, { message: '404' });
    }
    if (path === '/projects' && method === 'POST') {
      const name = txt(b.name, '');
      const full = `acme/${name}`;
      if (full === this.projectPath || this.created.includes(full))
        return this.send(res, 400, { message: { name: ['has already been taken'] } });
      this.created.push(full);
      return this.send(res, 201, {
        ...this.#project(),
        path_with_namespace: full,
        http_url_to_repo: `https://git.example.test/${full}.git`,
      });
    }
    const proj = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (proj === null) return this.send(res, 404, { message: '404 Not Found' });
    const projectId = decodeURIComponent(proj[1] ?? '');
    if (projectId !== this.projectPath) return this.send(res, 404, { message: '404 Project Not Found' });
    const rest = proj[2] ?? '';

    if (rest === '' && method === 'GET') return this.send(res, 200, this.#project());
    const branch = /^\/repository\/branches\/(.+)$/.exec(rest);
    if (branch !== null) {
      const name = decodeURIComponent(branch[1] ?? '');
      const head = this.git.head(name);
      if (method === 'DELETE') {
        if (head === null) return this.send(res, 404, { message: '404 Branch Not Found' });
        this.git.deleteBranch(name);
        return this.send(res, 204);
      }
      if (head === null) return this.send(res, 404, { message: '404 Branch Not Found' });
      return this.send(res, 200, {
        name,
        commit: this.#commitJson(head),
        protected: name === 'main',
        developers_can_push: false,
      });
    }
    if (rest === '/repository/branches' && method === 'POST') {
      const name = q.get('branch') ?? '';
      const ref = q.get('ref') ?? '';
      if (this.git.head(name) !== null) return this.send(res, 400, { message: 'Branch already exists' });
      const sha = this.git.resolve(ref);
      if (sha === null) return this.send(res, 400, { message: 'Invalid reference name' });
      this.git.setBranch(name, sha);
      return this.send(res, 201, { name, commit: this.#commitJson(sha) });
    }
    if (rest === '/repository/merge_base' && method === 'GET') {
      const refs = q.getAll('refs[]');
      const mb = refs.length === 2 ? this.git.mergeBase(refs[0] ?? '', refs[1] ?? '') : null;
      return mb === null
        ? this.send(res, 400, { message: 'invalid refs' })
        : this.send(res, 200, this.#commitJson(mb));
    }
    if (rest === '/repository/compare' && method === 'GET') {
      const from = this.git.resolve(q.get('from') ?? '');
      const to = this.git.resolve(q.get('to') ?? '');
      if (from === null || to === null) return this.send(res, 404, { message: '404 Ref Not Found' });
      const mb = this.git.mergeBase(from, to) ?? from;
      const commits = this.git.log(to, from).map((s) => this.#commitJson(s)); // newest first
      const diffs = this.git.diff(mb, to).map((d) => ({
        old_path: d.old,
        new_path: d.path,
        new_file: d.status === 'added',
        deleted_file: d.status === 'removed',
        renamed_file: d.status === 'renamed',
        diff: d.patch,
        too_large: false,
        collapsed: false,
      }));
      return this.send(res, 200, { commits, diffs, compare_timeout: false, compare_same_ref: from === to });
    }
    const statuses = /^\/repository\/commits\/([0-9a-f]{40})\/statuses$/.exec(rest);
    if (statuses !== null && method === 'GET')
      return this.send(res, 200, this.statuses.get(statuses[1] ?? '') ?? []);
    const commit = /^\/repository\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (commit !== null && method === 'GET') {
      const sha = this.git.resolve(commit[1] ?? '');
      return sha === null
        ? this.send(res, 404, { message: '404 Commit Not Found' })
        : this.send(res, 200, this.#commitJson(sha));
    }
    if (rest === '/repository/commits' && method === 'GET') {
      const head = this.git.resolve(q.get('ref_name') ?? 'main');
      if (head === null) return this.send(res, 404, { message: '404' });
      return this.send(
        res,
        200,
        this.git.log(head, null, Number(q.get('per_page') ?? 20)).map((s) => this.#commitJson(s)),
      );
    }
    if (rest === '/merge_requests' && method === 'GET') {
      const list = this.mrs.filter(
        (m) =>
          (q.get('state') === null || m.state === q.get('state')) &&
          (q.get('source_branch') === null || m.source === q.get('source_branch')) &&
          (q.get('target_branch') === null || m.target === q.get('target_branch')),
      );
      return this.send(
        res,
        200,
        list.map((m) => this.#mrJson(m, false)),
      );
    }
    if (rest === '/merge_requests' && method === 'POST') {
      const source = txt(b.source_branch, '');
      if (this.mrs.some((m) => m.state === 'opened' && m.source === source)) {
        return this.send(res, 409, {
          message: ['Another open merge request already exists for this source branch'],
        });
      }
      const m: FakeMr = {
        iid: this.mrs.length + 1,
        source,
        target: txt(b.target_branch, ''),
        title: txt(b.title, ''),
        description: txt(b.description, ''),
        state: 'opened',
        mergeCommit: null,
        squashCommit: null,
        notes: [],
      };
      this.mrs.push(m);
      return this.send(res, 201, this.#mrJson(m, false));
    }
    const mr = /^\/merge_requests\/(\d+)(\/merge|\/notes)?$/.exec(rest);
    if (mr !== null) {
      const m = this.mrs.find((x) => x.iid === Number(mr[1]));
      if (m === undefined) return this.send(res, 404, { message: '404 Not found' });
      if (mr[2] === undefined && method === 'GET') return this.send(res, 200, this.#mrJson(m, true));
      if (mr[2] === undefined && method === 'PUT') {
        if (typeof b.title === 'string') m.title = b.title;
        if (typeof b.description === 'string') m.description = b.description;
        return this.send(res, 200, this.#mrJson(m, false));
      }
      if (mr[2] === '/notes' && method === 'GET') return this.send(res, 200, m.notes);
      if (mr[2] === '/notes' && method === 'POST') {
        const note = { id: 900 + m.notes.length, body: txt(b.body, '') };
        m.notes.push(note);
        return this.send(res, 201, note);
      }
      if (mr[2] === '/merge' && method === 'PUT') {
        if (this.refuseMerge) return this.send(res, 401, { message: '401 Unauthorized' });
        if (m.state !== 'opened') return this.send(res, 405, { message: '405 Method Not Allowed' });
        const head = this.git.head(m.source);
        if (typeof b.sha === 'string' && b.sha !== head) {
          return this.send(res, 409, { message: 'SHA does not match HEAD of source branch' });
        }
        const base = this.git.head(m.target);
        if (head === null || base === null) return this.send(res, 405, { message: '405 Method Not Allowed' });
        const t = this.git.mergeTree(base, head);
        if (!('tree' in t)) return this.send(res, 405, { message: '405 Method Not Allowed' });
        if (b.squash === true) {
          m.squashCommit = this.git.commitTree(t.tree, [base], txt(b.squash_commit_message, m.title));
          this.git.setBranch(m.target, m.squashCommit);
        } else {
          m.mergeCommit = this.git.commitTree(t.tree, [base, head], txt(b.merge_commit_message, m.title));
          this.git.setBranch(m.target, m.mergeCommit);
        }
        m.state = 'merged';
        return this.send(res, 200, this.#mrJson(m, false));
      }
    }
    return this.send(res, 404, { message: '404 Not Found' });
  }
}

// ------------------------------------------------------------------------------------------------ Bitbucket

export interface FakePr {
  id: number;
  source: string;
  target: string;
  title: string;
  description: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  mergeCommit: string | null;
  comments: { id: number; raw: string }[];
}

export class FakeBitbucket extends FakeHost {
  readonly tokens = new Set<string>();
  readonly prs: FakePr[] = [];
  workspace = 'acme';
  slug = 'app';
  projectKey = 'WEB';
  /** Branch restrictions (glob patterns). */
  restrictions: { kind: string; pattern: string }[] = [{ kind: 'push', pattern: 'main' }];
  /** Merges answer 202 with a task-status link; the task finishes on the next poll. */
  asyncMerge = false;
  /** The next N mergeability reads answer PENDING. */
  pendingChecks = 0;
  #tasks = new Map<string, { pr: FakePr; done: boolean }>();
  readonly created: string[] = [];

  addToken(): string {
    const token = `ATCTT3x${randomBytes(12).toString('hex')}`;
    this.tokens.add(token);
    return token;
  }

  #root(): string {
    return `/2.0/repositories/${this.workspace}/${this.slug}`;
  }

  #commitJson(sha: string): Record<string, unknown> {
    const c = this.git.commit(sha);
    return {
      hash: c.sha,
      message: c.message,
      date: c.date,
      author: { raw: `${c.name} <${c.email}>` },
      parents: c.parents.map((p) => ({ hash: p })),
    };
  }

  #prJson(p: FakePr): Record<string, unknown> {
    const head = this.git.head(p.source);
    return {
      id: p.id,
      title: p.title,
      state: p.state,
      summary: { raw: p.description },
      source: { branch: { name: p.source }, commit: { hash: (head ?? '').slice(0, 12) } },
      destination: {
        branch: { name: p.target },
        commit: { hash: (this.git.head(p.target) ?? '').slice(0, 12) },
      },
      merge_commit: p.mergeCommit === null ? null : { hash: p.mergeCommit.slice(0, 12) },
      links: {
        html: { href: `https://bitbucket.org/${this.workspace}/${this.slug}/pull-requests/${String(p.id)}` },
      },
    };
  }

  #repoJson(full = `${this.workspace}/${this.slug}`): Record<string, unknown> {
    return {
      full_name: full,
      is_private: true,
      mainbranch: { name: 'main' },
      project: { key: this.projectKey },
      links: { html: { href: `https://bitbucket.org/${full}` } },
    };
  }

  #merge(p: FakePr, body: Record<string, unknown>): { ok: true } | { status: number; message: string } {
    const head = this.git.head(p.source);
    const base = this.git.head(p.target);
    if (head === null || base === null || p.state !== 'OPEN')
      return { status: 400, message: 'cannot be merged' };
    const t = this.git.mergeTree(base, head);
    if (!('tree' in t))
      return { status: 400, message: 'You can’t merge until you resolve all merge conflicts.' };
    const message = txt(body.message, p.title);
    const sha =
      body.merge_strategy === 'squash'
        ? this.git.commitTree(t.tree, [base], message)
        : this.git.commitTree(t.tree, [base, head], message);
    this.git.setBranch(p.target, sha);
    p.mergeCommit = sha;
    p.state = 'MERGED';
    return { ok: true };
  }

  protected handle(req: IncomingMessage, res: ServerResponse, body: unknown): unknown {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    const auth = req.headers.authorization ?? '';
    const authed = auth.startsWith('Bearer ') && this.tokens.has(auth.slice(7));
    this.requests.push({ method, path: url.pathname + url.search, authed });
    if (!authed) return this.send(res, 401, { type: 'error', error: { message: 'Unauthorized' } });
    const q = url.searchParams;
    const b = (body ?? {}) as Record<string, unknown>;
    const path = url.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}');

    if (path === `/2.0/repositories/${this.workspace}` && method === 'GET') {
      const all = [this.#repoJson(), ...this.created.map((c) => this.#repoJson(c))];
      return this.send(res, 200, { values: all, pagelen: 100 });
    }
    if (path === `/2.0/workspaces/${this.workspace}/projects/${this.projectKey}` && method === 'GET') {
      return this.send(res, 200, { key: this.projectKey });
    }
    const createRepo = new RegExp(`^/2\\.0/repositories/${this.workspace}/([a-z0-9._-]+)$`).exec(path);
    if (createRepo !== null && createRepo[1] !== this.slug) {
      const full = `${this.workspace}/${createRepo[1] ?? ''}`;
      if (method === 'GET') {
        return this.created.includes(full)
          ? this.send(res, 200, this.#repoJson(full))
          : this.send(res, 404, { error: { message: 'not found' } });
      }
      if (method === 'POST') {
        this.created.push(full);
        return this.send(res, 200, this.#repoJson(full));
      }
    }
    if (!path.startsWith(this.#root()))
      return this.send(res, 404, { error: { message: 'Repository not found' } });
    const rest = path.slice(this.#root().length);

    if (rest === '' && method === 'GET') return this.send(res, 200, this.#repoJson());
    if (rest === '/refs/branches' && method === 'POST') {
      const name = txt(b.name, '');
      const target = txt((b.target as Record<string, unknown> | undefined)?.hash, '');
      if (this.git.head(name) !== null) return this.send(res, 400, { error: { message: 'exists' } });
      const sha = this.git.resolve(target);
      if (sha === null) return this.send(res, 400, { error: { message: 'bad target' } });
      this.git.setBranch(name, sha);
      return this.send(res, 201, { name, target: this.#commitJson(sha) });
    }
    const branch = /^\/refs\/branches\/(.+)$/.exec(rest);
    if (branch !== null) {
      const name = (branch[1] ?? '').split('/').map(decodeURIComponent).join('/');
      const head = this.git.head(name);
      if (head === null) return this.send(res, 404, { error: { message: 'Branch not found' } });
      if (method === 'DELETE') {
        this.git.deleteBranch(name);
        return this.send(res, 204);
      }
      return this.send(res, 200, { name, target: this.#commitJson(head) });
    }
    const commit = /^\/commit\/([0-9a-f]{7,40})(\/statuses)?$/.exec(rest);
    if (commit !== null && method === 'GET') {
      const sha = this.git.resolve(commit[1] ?? '');
      if (sha === null) return this.send(res, 404, { error: { message: 'Commit not found' } });
      if (commit[2] !== undefined) return this.send(res, 200, { values: this.statuses.get(sha) ?? [] });
      return this.send(res, 200, this.#commitJson(sha));
    }
    const commits = /^\/commits\/(.+)$/.exec(rest);
    if (commits !== null && method === 'GET') {
      const head = this.git.resolve((commits[1] ?? '').split('/').map(decodeURIComponent).join('/'));
      if (head === null) return this.send(res, 404, { error: { message: 'not found' } });
      const exclude = q.get('exclude');
      const list = this.git.log(head, exclude, Number(q.get('pagelen') ?? 30));
      return this.send(res, 200, { values: list.map((s) => this.#commitJson(s)) });
    }
    const mb = /^\/merge-base\/([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(rest);
    if (mb !== null && method === 'GET') {
      const base = this.git.mergeBase(mb[1] ?? '', mb[2] ?? '');
      return base === null
        ? this.send(res, 404, { error: { message: 'no merge base' } })
        : this.send(res, 200, this.#commitJson(base));
    }
    const ds = /^\/(diffstat|diff)\/([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(rest);
    if (ds !== null && method === 'GET') {
      // Bitbucket's order: <changes>..<other side>; topic=true diffs from their merge base.
      const changes = ds[2] ?? '';
      const other = ds[3] ?? '';
      const from = q.get('topic') === 'false' ? other : (this.git.mergeBase(changes, other) ?? other);
      if (ds[1] === 'diff') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(this.git.run(['diff', '-M', from, changes]));
        return;
      }
      const values = this.git.diff(from, changes).map((d) => ({
        status: d.status,
        lines_added: d.add,
        lines_removed: d.del,
        old: d.status === 'added' ? null : { path: d.old },
        new: d.status === 'removed' ? null : { path: d.path },
      }));
      return this.send(res, 200, { values });
    }
    if (rest === '/branch-restrictions' && method === 'GET') {
      return this.send(res, 200, {
        values: this.restrictions.map((r, i) => ({
          id: i + 1,
          kind: r.kind,
          pattern: r.pattern,
          branch_match_kind: 'glob',
        })),
      });
    }
    if (rest === '/pullrequests' && method === 'GET') {
      const filter = q.get('q') ?? '';
      const src = /source\.branch\.name = "([^"]*)"/.exec(filter)?.[1];
      const dst = /destination\.branch\.name = "([^"]*)"/.exec(filter)?.[1];
      const list = this.prs.filter(
        (p) =>
          (q.get('state') === null || p.state === q.get('state')) &&
          (src === undefined || p.source === src) &&
          (dst === undefined || p.target === dst),
      );
      return this.send(res, 200, { values: list.map((p) => this.#prJson(p)) });
    }
    if (rest === '/pullrequests' && method === 'POST') {
      const branchOf = (side: unknown): unknown =>
        ((side as Record<string, unknown> | undefined)?.branch as Record<string, unknown> | undefined)?.name;
      const src = txt(branchOf(b.source), '');
      const dst = txt(branchOf(b.destination), 'main');
      const p: FakePr = {
        id: this.prs.length + 1,
        source: src,
        target: dst,
        title: txt(b.title, ''),
        description: txt(b.description, ''),
        state: 'OPEN',
        mergeCommit: null,
        comments: [],
      };
      this.prs.push(p);
      return this.send(res, 201, this.#prJson(p));
    }
    const pr = /^\/pullrequests\/(\d+)(\/[a-z/-]+)?(\/[A-Za-z0-9{}_-]+)?$/.exec(rest);
    if (pr !== null) {
      const p = this.prs.find((x) => x.id === Number(pr[1]));
      if (p === undefined) return this.send(res, 404, { error: { message: 'not found' } });
      const sub = `${pr[2] ?? ''}${pr[3] ?? ''}`;
      if (sub === '' && method === 'GET') return this.send(res, 200, this.#prJson(p));
      if (sub === '' && method === 'PUT') {
        if (typeof b.title === 'string') p.title = b.title;
        if (typeof b.description === 'string') p.description = b.description;
        return this.send(res, 200, this.#prJson(p));
      }
      if (sub === '/mergeability/checks' && method === 'GET') {
        let status = 'PASSED';
        if (this.pendingChecks > 0) {
          this.pendingChecks -= 1;
          status = 'PENDING';
        } else {
          const head = this.git.head(p.source);
          const base = this.git.head(p.target);
          if (head !== null && base !== null && 'conflicts' in this.git.mergeTree(base, head))
            status = 'FAILED';
        }
        return this.send(res, 200, {
          values: [
            { type: 'pullrequest_state_check', status: 'PASSED', blocking: false },
            { type: 'git_mergeability_check', status, blocking: status !== 'PASSED' },
          ],
        });
      }
      if (sub === '/conflicts' && method === 'GET') {
        const head = this.git.head(p.source) ?? '';
        const base = this.git.head(p.target) ?? '';
        // Bitbucket redirects to the repository's file conflicts for the pull request's spec.
        return this.send(res, 302, undefined, {
          location: `${this.#root()}/file-conflicts/${head}..${base}`,
        });
      }
      if (sub === '/comments' && method === 'GET') {
        return this.send(res, 200, {
          values: p.comments.map((c) => ({
            id: c.id,
            content: { raw: c.raw },
            links: { html: { href: `c${String(c.id)}` } },
          })),
        });
      }
      if (sub === '/comments' && method === 'POST') {
        const c = {
          id: 500 + p.comments.length,
          raw: txt((b.content as Record<string, unknown> | undefined)?.raw, ''),
        };
        p.comments.push(c);
        return this.send(res, 201, {
          id: c.id,
          content: { raw: c.raw },
          links: { html: { href: `c${String(c.id)}` } },
        });
      }
      if (sub === '/merge' && method === 'POST') {
        if (this.asyncMerge) {
          const task = `{${randomBytes(6).toString('hex')}}`;
          this.#tasks.set(task, { pr: p, done: false });
          return this.send(
            res,
            202,
            { task_id: task },
            {
              location: `https://api.bitbucket.org${this.#root()}/pullrequests/${String(p.id)}/merge/task-status/${task}`,
            },
          );
        }
        const out = this.#merge(p, b);
        if ('status' in out)
          return this.send(res, out.status, { type: 'error', error: { message: out.message } });
        return this.send(res, 200, this.#prJson(p));
      }
      const task = /^\/merge\/task-status\/(.+)$/.exec(sub);
      if (task !== null && method === 'GET') {
        const t = this.#tasks.get(task[1] ?? '');
        if (t === undefined) return this.send(res, 400, { error: { message: 'unknown task' } });
        if (!t.done) {
          t.done = true;
          const out = this.#merge(t.pr, { merge_strategy: 'merge_commit', message: t.pr.title });
          if ('status' in out) return this.send(res, 400, { error: { message: out.message } });
        }
        return this.send(res, 200, { task_status: 'SUCCESS', merge_result: this.#prJson(t.pr) });
      }
    }
    const fc = /^\/file-conflicts\/([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(rest);
    if (fc !== null && method === 'GET') {
      const t = this.git.mergeTree(fc[2] ?? '', fc[1] ?? '');
      return this.send(res, 200, {
        values:
          'conflicts' in t
            ? t.conflicts.map((path) => ({ path, scenario: 'content', message: 'conflict' }))
            : [],
      });
    }
    return this.send(res, 404, { error: { message: 'Resource not found' } });
  }
}

/**
 * A fetch that sends the hosted providers' real host names to the local fakes: `https://<gitlabHost>` → the GitLab
 * fake, `https://api.bitbucket.org` → the Bitbucket fake. Everything else is refused (no real network in tests).
 */
export function hostFetch(
  map: Readonly<Record<string, string>>,
): (input: string, init: RequestInit) => Promise<Response> {
  return (input, init) => {
    const u = new URL(input);
    const target = map[u.origin];
    if (target === undefined) return Promise.reject(new Error(`no fake for ${u.origin}`));
    return fetch(`${target}${u.pathname}${u.search}`, init);
  };
}
