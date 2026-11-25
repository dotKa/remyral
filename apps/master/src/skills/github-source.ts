import { createHash } from 'node:crypto';
import { MAX_SKILL_FILE_BYTES_V2 } from '@remyral/protocol';
import { MAX_IMPORT_RAW_BYTES, MAX_IMPORT_RAW_FILES, type RawImportFile } from './import-analysis.js';

/**
 * p14-skill-import (docs/design/p14-mcp-skills.md §3.3): reads one skill directory of a GitHub repository **pinned to a
 * commit**. The master only ever talks to the fixed host `api.github.com` (never a user-chosen URL): the URL a person
 * pastes is parsed into owner / repo / ref / path and nothing else of it is used.
 *
 * 1. `GET /repos/:o/:r/commits/:ref` → the commit SHA and its tree SHA (a 40-hex ref is used as is);
 * 2. walk the trees by SHA down to the directory (`GET /repos/:o/:r/git/trees/:sha`), then the directory's tree
 *    recursively;
 * 3. every blob by its SHA (`GET /repos/:o/:r/git/blobs/:sha`), checked against the git blob hash
 *    (`sha1("blob <len>\0" + bytes)`), so the bytes are exactly the commit's.
 *
 * Fetch rules (the version-feed rules of p13-fleet-tools): https only, `redirect: 'error'`, no cookies, 10 s per
 * request, ≤ 4 MiB per response, ≤ 80 requests per import. Public repositories need no credentials; for a private
 * repository the panel GitHub App's installation token (contents:read, that repository only) is used when the App is
 * installed there (`token` hook). Symlinks and submodules are reported, never followed.
 */
export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API = 'https://api.github.com';
/**
 * p22-github-raw: public file contents by commit SHA. Not counted against the REST API's 60 requests per hour for
 * unauthenticated callers (an import used to spend one API request per file). The bytes are still checked against the
 * tree's git blob hash, so this host cannot change what is imported; on any failure the API blob is read instead.
 */
export const GITHUB_RAW = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_REQUESTS = 80;

export class GitHubSourceError extends Error {
  constructor(
    readonly code:
      | 'github_url_invalid'
      | 'github_not_found'
      | 'github_rate_limited'
      | 'github_unavailable'
      | 'github_too_large'
      | 'github_integrity',
    message: string,
  ) {
    super(message);
    this.name = 'GitHubSourceError';
  }
}

export interface GitHubLocation {
  readonly owner: string;
  readonly repo: string;
  /** Branch, tag or commit; null = the default branch. */
  readonly ref: string | null;
  /** Directory inside the repository ('' = root). */
  readonly path: string;
  /** Candidate (ref, path) splits for refs containing '/', most likely first. */
  readonly candidates: readonly { readonly ref: string; readonly path: string }[];
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/;

/**
 * Parses `https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>]` (a `blob/…/SKILL.md` link points at its
 * directory). `ref` overrides the ref from the URL. Throws {@link GitHubSourceError} `github_url_invalid`.
 */
export function parseGitHubUrl(input: string, refOverride?: string | null): GitHubLocation {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new GitHubSourceError('github_url_invalid', 'Not a URL.');
  }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com')) {
    throw new GitHubSourceError('github_url_invalid', 'Only https://github.com/… links can be imported.');
  }
  if (u.username !== '' || u.password !== '' || u.port !== '') {
    throw new GitHubSourceError('github_url_invalid', 'The link must not carry credentials or a port.');
  }
  const parts = u.pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return '\u0000';
      }
    });
  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (
    owner === undefined ||
    repo === undefined ||
    !OWNER.test(owner) ||
    !REPO.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new GitHubSourceError('github_url_invalid', 'The link does not name a repository.');
  }
  if (rest.some((s) => !SEGMENT.test(s) || s === '..' || s === '.')) {
    throw new GitHubSourceError('github_url_invalid', 'The link contains an invalid path segment.');
  }
  const override =
    refOverride === undefined || refOverride === null || refOverride.trim() === ''
      ? null
      : refOverride.trim();
  if (override !== null && (!/^[A-Za-z0-9._/@+-]{1,200}$/.test(override) || override.includes('..'))) {
    throw new GitHubSourceError('github_url_invalid', 'Invalid ref.');
  }
  if (kind === undefined) {
    return {
      owner,
      repo,
      ref: override,
      path: '',
      candidates: override === null ? [] : [{ ref: override, path: '' }],
    };
  }
  if (kind !== 'tree' && kind !== 'blob') {
    throw new GitHubSourceError(
      'github_url_invalid',
      'Use a …/tree/<branch>/<folder> link of the skill folder.',
    );
  }
  if (rest.length === 0) throw new GitHubSourceError('github_url_invalid', 'The link names no branch.');
  let segs = rest;
  if (kind === 'blob') {
    // A file link: its directory is the skill.
    segs = rest.slice(0, -1);
    if (segs.length === 0) throw new GitHubSourceError('github_url_invalid', 'The link names no branch.');
  }
  if (override !== null) {
    // The ref was given separately: the URL's first segments that spell it are dropped.
    const refSegs = override.split('/');
    const matches = refSegs.every((s, i) => segs[i] === s);
    const path = (matches ? segs.slice(refSegs.length) : segs.slice(1)).join('/');
    return { owner, repo, ref: override, path, candidates: [{ ref: override, path }] };
  }
  const candidates: { ref: string; path: string }[] = [];
  for (let n = 1; n <= Math.min(3, segs.length); n++) {
    candidates.push({ ref: segs.slice(0, n).join('/'), path: segs.slice(n).join('/') });
  }
  return { owner, repo, ref: candidates[0]?.ref ?? null, path: candidates[0]?.path ?? '', candidates };
}

export interface GitHubSnapshot {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly commit: string;
  readonly path: string;
  readonly files: readonly RawImportFile[];
  /** Entries that were not read: symlinks, submodules, files over the per-file limit. */
  readonly skipped: readonly { readonly path: string; readonly size: number; readonly reason: string }[];
  /** Whether the panel GitHub App's token was used (private repository). */
  readonly authenticated: boolean;
}

/** p14-skill-catalogs: one skill folder of a catalog repository (paths relative to the folder). */
export interface GitHubListedSkill {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  /** SKILL.md text (null when it was too large or the request budget ran out). */
  readonly skillMd: string | null;
}

export interface GitHubListing {
  readonly ref: string;
  readonly commit: string;
  readonly skills: readonly GitHubListedSkill[];
  readonly truncated: boolean;
}

/** Skill folders one catalog source lists at most. */
export const MAX_CATALOG_SKILLS = 100;
/** GitHub requests of one catalog refresh (commit, tree walk, one SKILL.md blob per folder). */
export const MAX_CATALOG_REQUESTS = 120;

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number;
}

export class GitHubSkillSource {
  readonly #fetch: GitHubFetch;
  readonly #token: ((owner: string, repo: string) => Promise<string | null>) | null;

  constructor(deps: {
    readonly fetch: GitHubFetch;
    /** The panel GitHub App's read-only installation token for one repository, or null. */
    readonly token?: ((owner: string, repo: string) => Promise<string | null>) | null;
  }) {
    this.#fetch = deps.fetch;
    this.#token = deps.token ?? null;
  }

  async snapshot(loc: GitHubLocation): Promise<GitHubSnapshot> {
    const budget = { left: MAX_REQUESTS };
    const auth: { token: string | null; tried: boolean } = { token: null, tried: false };
    const api = async (path: string): Promise<unknown> => {
      const first = await this.#get(path, auth.token, budget);
      if (first.status === 404 && auth.token === null && !auth.tried && this.#token !== null) {
        // Perhaps private: retry once with the App's token if the App is installed on that repository.
        auth.tried = true;
        auth.token = await this.#token(loc.owner, loc.repo).catch(() => null);
        if (auth.token !== null) return this.#json(await this.#get(path, auth.token, budget), path);
      }
      return this.#json(first, path);
    };
    const base = `/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}`;

    let ref = loc.ref;
    let path = loc.path;
    if (ref === null) {
      const meta = obj(await api(base));
      const def = meta.default_branch;
      if (typeof def !== 'string' || def === '')
        throw new GitHubSourceError('github_not_found', 'No default branch.');
      ref = def;
    }
    // Resolve the ref (trying the candidate splits of a ref that contains '/').
    let commit: { sha: string; tree: string } | null = null;
    const tries = loc.candidates.length > 0 ? loc.candidates : [{ ref, path }];
    for (const c of tries) {
      try {
        commit = await this.#commit(api, base, c.ref);
        ref = c.ref;
        path = c.path;
        break;
      } catch (err) {
        if (!(err instanceof GitHubSourceError) || err.code !== 'github_not_found') throw err;
      }
    }
    if (commit === null) throw new GitHubSourceError('github_not_found', 'Branch, tag or commit not found.');

    // Walk down to the directory by tree SHAs.
    let treeSha = commit.tree;
    const segs = path === '' ? [] : path.split('/');
    for (const seg of segs) {
      const tree = await this.#tree(api, base, treeSha, false);
      const hit = tree.find((e) => e.path === seg && e.type === 'tree');
      if (hit === undefined)
        throw new GitHubSourceError('github_not_found', 'Folder not found at that commit.');
      treeSha = hit.sha;
    }
    const entries = await this.#tree(api, base, treeSha, true);
    const blobs = entries.filter((e) => e.type === 'blob' && e.mode !== '120000');
    const skipped: { path: string; size: number; reason: string }[] = [];
    for (const e of entries) {
      if (e.type === 'commit') skipped.push({ path: e.path, size: 0, reason: 'submodule' });
      else if (e.type === 'blob' && e.mode === '120000')
        skipped.push({ path: e.path, size: e.size ?? 0, reason: 'symlink' });
    }
    if (blobs.length > MAX_IMPORT_RAW_FILES) {
      throw new GitHubSourceError(
        'github_too_large',
        `The folder has ${String(blobs.length)} files (limit ${String(MAX_IMPORT_RAW_FILES)}).`,
      );
    }
    const files: RawImportFile[] = [];
    let total = 0;
    for (const e of blobs) {
      const size = e.size ?? 0;
      // Hidden files are dropped by the analysis anyway; do not spend requests on them.
      if (e.path.split('/').some((s) => s.startsWith('.'))) {
        files.push({ path: e.path, bytes: Buffer.alloc(0) });
        continue;
      }
      if (size > MAX_SKILL_FILE_BYTES_V2) {
        skipped.push({ path: e.path, size, reason: 'too_large' });
        continue;
      }
      total += size;
      if (total > MAX_IMPORT_RAW_BYTES)
        throw new GitHubSourceError('github_too_large', 'The folder is too large.');
      const bytes = await this.#blob(api, base, loc, commit.sha, prefixOf(path) + e.path, e, auth.token);
      files.push({ path: e.path, bytes });
    }
    return {
      owner: loc.owner,
      repo: loc.repo,
      ref,
      commit: commit.sha,
      path,
      files,
      skipped,
      authenticated: auth.token !== null,
    };
  }

  /**
   * p14-skill-catalogs: the skill folders of a catalog repository at one commit — every directory (≤ 3 levels below
   * `path`) holding a SKILL.md, with its file count, total size, the paths (for the layout fit) and the SKILL.md text
   * (read by blob SHA and checked against the git blob hash, ≤ 64 KiB). Same host, timeouts and caps as {@link snapshot};
   * at most {@link MAX_CATALOG_SKILLS} folders, {@link MAX_CATALOG_REQUESTS} requests.
   */
  async listing(input: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string | null;
    readonly path: string;
  }): Promise<GitHubListing> {
    const budget = { left: MAX_CATALOG_REQUESTS };
    const api = async (p: string): Promise<unknown> => this.#json(await this.#get(p, null, budget), p);
    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    let ref = input.ref;
    if (ref === null) {
      const def = obj(await api(base)).default_branch;
      if (typeof def !== 'string' || def === '')
        throw new GitHubSourceError('github_not_found', 'No default branch.');
      ref = def;
    }
    const commit = await this.#commit(api, base, ref);
    let treeSha = commit.tree;
    for (const seg of input.path === '' ? [] : input.path.split('/')) {
      const hit = (await this.#tree(api, base, treeSha, false)).find(
        (e) => e.path === seg && e.type === 'tree',
      );
      if (hit === undefined)
        throw new GitHubSourceError('github_not_found', 'Folder not found at that commit.');
      treeSha = hit.sha;
    }
    const entries = await this.#tree(api, base, treeSha, true);
    const blobs = entries.filter((e) => e.type === 'blob' && e.mode !== '120000');
    const dirs = blobs
      .filter((e) => /(^|\/)skill\.md$/i.test(e.path) && e.path.split('/').length <= 4)
      .map((e) => ({ dir: e.path.split('/').slice(0, -1).join('/'), md: e }))
      .filter((d) => !d.dir.split('/').some((s) => s.startsWith('.')))
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
      .slice(0, MAX_CATALOG_SKILLS);
    const skills: GitHubListedSkill[] = [];
    for (const d of dirs) {
      const prefix = d.dir === '' ? '' : `${d.dir}/`;
      const files = blobs
        .filter(
          (e) =>
            e.path.startsWith(prefix) &&
            !e.path
              .slice(prefix.length)
              .split('/')
              .some((s) => s.startsWith('.')),
        )
        .map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }));
      let skillMd: string | null = null;
      if ((d.md.size ?? 0) <= 64 * 1024 && budget.left > 0) {
        const bytes = await this.#blob(
          api,
          base,
          input,
          commit.sha,
          prefixOf(input.path) + d.md.path,
          d.md,
          null,
        );
        skillMd = bytes.toString('utf8');
      }
      skills.push({ dir: d.dir, files, skillMd });
    }
    return { ref, commit: commit.sha, skills, truncated: dirs.length >= MAX_CATALOG_SKILLS };
  }

  async #commit(
    api: (p: string) => Promise<unknown>,
    base: string,
    ref: string,
  ): Promise<{ sha: string; tree: string }> {
    const c = obj(await api(`${base}/commits/${ref.split('/').map(encodeURIComponent).join('/')}`));
    const sha = c.sha;
    const tree = obj(obj(c.commit).tree).sha;
    if (
      typeof sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(sha) ||
      typeof tree !== 'string' ||
      !/^[0-9a-f]{40}$/.test(tree)
    ) {
      throw new GitHubSourceError('github_unavailable', 'Unexpected commit response.');
    }
    return { sha, tree };
  }

  async #tree(
    api: (p: string) => Promise<unknown>,
    base: string,
    sha: string,
    recursive: boolean,
  ): Promise<TreeEntry[]> {
    const t = obj(await api(`${base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`));
    if (t.truncated === true)
      throw new GitHubSourceError('github_too_large', 'The folder tree is too large.');
    if (!Array.isArray(t.tree))
      throw new GitHubSourceError('github_unavailable', 'Unexpected tree response.');
    const out: TreeEntry[] = [];
    for (const raw of t.tree as unknown[]) {
      const e = obj(raw);
      if (
        typeof e.path !== 'string' ||
        typeof e.mode !== 'string' ||
        typeof e.type !== 'string' ||
        typeof e.sha !== 'string' ||
        !/^[0-9a-f]{40}$/.test(e.sha) ||
        e.path.split('/').some((s) => s === '' || s === '.' || s === '..') ||
        e.path.includes('\\') ||
        e.path.includes('\u0000')
      ) {
        throw new GitHubSourceError('github_unavailable', 'Unexpected tree entry.');
      }
      out.push({
        path: e.path,
        mode: e.mode,
        type: e.type,
        sha: e.sha,
        ...(typeof e.size === 'number' ? { size: e.size } : {}),
      });
    }
    return out;
  }

  /**
   * One file's bytes at the commit, checked against its git blob hash. Public (no token): the raw host first
   * ({@link GITHUB_RAW}), the API blob when that fails. With a token (a private repository): the API blob.
   */
  async #blob(
    api: (p: string) => Promise<unknown>,
    base: string,
    loc: { readonly owner: string; readonly repo: string },
    commit: string,
    fullPath: string,
    e: TreeEntry,
    token: string | null,
  ): Promise<Buffer> {
    if (token === null) {
      // Not counted in the API budget: the number of files is already capped (MAX_IMPORT_RAW_FILES).
      const raw = await this.#raw(loc, commit, fullPath, e.size ?? 0);
      if (raw !== null) {
        if (gitBlobSha(raw) !== e.sha)
          throw new GitHubSourceError('github_integrity', `Blob ${e.path} does not match its hash.`);
        return raw;
      }
    }
    const blob = obj(await api(`${base}/git/blobs/${e.sha}`));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitHubSourceError('github_unavailable', 'Unexpected blob encoding.');
    }
    const bytes = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64');
    if (gitBlobSha(bytes) !== e.sha)
      throw new GitHubSourceError('github_integrity', `Blob ${e.path} does not match its hash.`);
    return bytes;
  }

  /** The raw file at the commit, or null when the raw host did not give it (any status, error or size mismatch). */
  async #raw(
    loc: { readonly owner: string; readonly repo: string },
    commit: string,
    fullPath: string,
    size: number,
  ): Promise<Buffer | null> {
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    const url = `${GITHUB_RAW}/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}/${commit}/${fullPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    try {
      const res = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { 'user-agent': 'remyral-master (skill import)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length === size && bytes.length <= MAX_RESPONSE ? bytes : null;
    } catch {
      return null;
    }
  }

  async #get(path: string, token: string | null, budget: { left: number }): Promise<Response> {
    if (budget.left <= 0)
      throw new GitHubSourceError('github_too_large', 'Too many GitHub requests for one import.');
    budget.left -= 1;
    try {
      return await this.#fetch(`${GITHUB_API}${path}`, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'remyral-master (skill import)',
          'x-github-api-version': '2022-11-28',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GitHubSourceError('github_unavailable', 'GitHub could not be reached.');
    }
  }

  async #json(res: Response, path: string): Promise<unknown> {
    if (res.status === 404)
      throw new GitHubSourceError('github_not_found', 'Not found on GitHub (or private).');
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? '');
      const at = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
      throw new GitHubSourceError('github_rate_limited', `GitHub refused the request (rate limit)${at}.`);
    }
    if (!res.ok) {
      throw new GitHubSourceError(
        'github_unavailable',
        `GitHub answered HTTP ${String(res.status)} for ${path.split('?')[0] ?? ''}.`,
      );
    }
    const text = await readBounded(res);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubSourceError('github_unavailable', 'GitHub answered something that is not JSON.');
    }
  }
}

/** git's blob id of these bytes (`sha1("blob <len>\0" + bytes)`). */
function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\u0000`)
    .update(bytes)
    .digest('hex');
}

/** `dir/` for a non-empty directory path, '' for the root. */
function prefixOf(path: string): string {
  return path === '' ? '' : `${path}/`;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function readBounded(res: Response): Promise<string> {
  if (res.body === null) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_RESPONSE) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubSourceError('github_too_large', 'GitHub response too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
