import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * p14-skill-catalogs: an in-memory api.github.com for one or more repositories at one commit each — default branch,
 * commit lookup by branch or SHA, trees by SHA (flat or `?recursive=1`) and blobs by their real git blob SHA (the
 * importer verifies them), plus raw.githubusercontent.com file contents by commit (p22-github-raw). Only the routes the
 * skill importer and the catalog reader use.
 */
export interface FakeRepo {
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  readonly files: Readonly<Record<string, string | Buffer>>;
}

const sha1 = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex');

export function gitBlobSha(b: Buffer): string {
  return createHash('sha1')
    .update(`blob ${String(b.length)}\u0000`)
    .update(b)
    .digest('hex');
}

export function fakeGitHubApi(repos: readonly FakeRepo[]) {
  const urls: string[] = [];
  const commits = new Map<string, string>();
  interface Node {
    readonly repoKey: string;
    readonly dir: string;
  }
  const trees = new Map<string, Node>();
  const blobs = new Map<string, Buffer>();
  const treeSha = (repoKey: string, dir: string) => sha1(`tree:${repoKey}:${dir}`);
  for (const r of repos) {
    const key = `${r.owner}/${r.repo}`;
    commits.set(key, sha1(`commit:${key}`));
    const dirs = new Set<string>(['']);
    for (const [path, content] of Object.entries(r.files)) {
      const b = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      blobs.set(gitBlobSha(b), b);
      const segs = path.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    for (const d of dirs) trees.set(treeSha(key, d), { repoKey: key, dir: d });
  }
  const repoOf = (key: string) => repos.find((r) => `${r.owner}/${r.repo}` === key);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = (url: string): Promise<Response> => {
    urls.push(url);
    const u = new URL(url);
    if (u.origin === 'https://raw.githubusercontent.com') {
      // p22-github-raw: file contents by commit SHA (the importer verifies them against the tree's blob SHA).
      const r = /^\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname);
      const key = r === null ? '' : `${decodeURIComponent(r[1] ?? '')}/${decodeURIComponent(r[2] ?? '')}`;
      const repo = repoOf(key);
      const path = (r?.[4] ?? '').split('/').map(decodeURIComponent).join('/');
      const content = repo?.files[path];
      if (r === null || commits.get(key) !== r[3] || content === undefined)
        return Promise.resolve(new Response('404: Not Found', { status: 404 }));
      return Promise.resolve(
        new Response(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), { status: 200 }),
      );
    }
    if (u.origin !== 'https://api.github.com') return Promise.resolve(json({ message: 'wrong host' }, 400));
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (m === null) return Promise.resolve(json({ message: 'Not Found' }, 404));
    const key = `${decodeURIComponent(m[1] ?? '')}/${decodeURIComponent(m[2] ?? '')}`;
    const repo = repoOf(key);
    const commit = commits.get(key);
    if (repo === undefined || commit === undefined)
      return Promise.resolve(json({ message: 'Not Found' }, 404));
    const rest = m[3] ?? '';
    const branch = repo.branch ?? 'main';
    if (rest === '') return Promise.resolve(json({ default_branch: branch }));
    const c = /^\/commits\/(.+)$/.exec(rest);
    if (c !== null) {
      const ref = decodeURIComponent(c[1] ?? '');
      if (ref !== branch && ref !== commit) return Promise.resolve(json({ message: 'No commit found' }, 404));
      return Promise.resolve(json({ sha: commit, commit: { tree: { sha: treeSha(key, '') } } }));
    }
    const t = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (t !== null) {
      const node = trees.get(t[1] ?? '');
      if (node === undefined || node.repoKey !== key)
        return Promise.resolve(json({ message: 'Not Found' }, 404));
      const recursive = u.searchParams.get('recursive') === '1';
      const prefix = node.dir === '' ? '' : `${node.dir}/`;
      const entries: Record<string, unknown>[] = [];
      const seenDirs = new Set<string>();
      for (const [path, content] of Object.entries(repo.files)) {
        if (!path.startsWith(prefix)) continue;
        const rel = path.slice(prefix.length);
        const segs = rel.split('/');
        for (let i = 1; i < segs.length; i++) {
          const d = segs.slice(0, i).join('/');
          if ((recursive || i === 1) && !seenDirs.has(d)) {
            seenDirs.add(d);
            entries.push({ path: d, mode: '040000', type: 'tree', sha: treeSha(key, `${prefix}${d}`) });
          }
        }
        if (!recursive && segs.length > 1) continue;
        const b = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        entries.push({ path: rel, mode: '100644', type: 'blob', sha: gitBlobSha(b), size: b.length });
      }
      return Promise.resolve(json({ truncated: false, tree: entries }));
    }
    const b = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (b !== null) {
      const bytes = blobs.get(b[1] ?? '');
      if (bytes === undefined) return Promise.resolve(json({ message: 'Not Found' }, 404));
      return Promise.resolve(json({ encoding: 'base64', content: bytes.toString('base64') }));
    }
    return Promise.resolve(json({ message: 'Not Found' }, 404));
  };
  return { fetch, urls, commitOf: (key: string) => commits.get(key) ?? '' };
}

/**
 * The `skill-creator` skill of github.com/anthropics/skills (Apache-2.0, LICENSE.txt included), fetched at commit
 * dbd4588f9e10 into test/fixtures/skill-creator.json: 18 files, ~225 KB, top-level `agents/` and `eval-viewer/`
 * folders — a real public skill that needs layout v2 and out-of-band delivery.
 */
export function skillCreatorFixture(): {
  readonly repo: string;
  readonly path: string;
  readonly commit: string;
  readonly files: Readonly<Record<string, string>>;
} {
  const raw = readFileSync(new URL('../fixtures/skill-creator.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as { repo: string; path: string; commit: string; files: Record<string, string> };
}
