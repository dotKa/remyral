import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BitbucketProvider } from '../../src/gitflow/bitbucket-provider.js';
import {
  createHostRepository,
  listHostRepositories,
  rotateGitLabToken,
  testHostToken,
} from '../../src/gitflow/git-host-api.js';
import { GitLabProvider } from '../../src/gitflow/gitlab-provider.js';
import { bbqlString } from '../../src/gitflow/hosted-http.js';
import { ProviderError } from '../../src/gitflow/types.js';
import { BareGit, FakeBitbucket, FakeGitLab, hostFetch } from '../helpers/fake-git-hosts.js';

/**
 * p16-git-providers: the GitLab and Bitbucket providers against local fakes backed by a real bare repository — the
 * whole GitProvider surface the git flow and the merge pipeline use (heads, compare, MR / PR, test merge with real
 * conflicts, CI states, the sha-guarded merge, the trailer lookup, branch rules), plus the host API (test, rotation,
 * repositories, create).
 */

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.test',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.test',
};

let root: string;
let bare: BareGit;
let work: string;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...env, HOME: cwd }, encoding: 'utf8' }).trim();

/** A commit changing `file` on top of `from`, pushed as `branch`. */
async function commitOn(
  from: string,
  branch: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  git(work, 'fetch', '-q', bare.dir, '+refs/heads/*:refs/remotes/b/*');
  git(work, 'checkout', '-q', '-B', 'w', from);
  await writeFile(join(work, file), content);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', message);
  git(work, 'push', '-q', '-f', bare.dir, `w:refs/heads/${branch}`);
  return git(work, 'rev-parse', 'HEAD');
}

let base0: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rw-hosted-'));
  const dir = join(root, 'app.git');
  work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '--initial-branch=main', dir);
  bare = new BareGit(dir);
  git(root, 'init', '-q', '--initial-branch=main', work);
  await writeFile(join(work, 'README.md'), '# app\n');
  await writeFile(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'initial');
  git(work, 'push', '-q', dir, 'main');
  base0 = git(work, 'rev-parse', 'HEAD');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ATTEMPT = (n: string) => `rac/job-${n}/att-${n}`;

describe('GitLab provider (fake GitLab on a real repository)', () => {
  let fake: FakeGitLab;
  let token: string;
  let p: GitLabProvider;
  beforeAll(async () => {
    fake = new FakeGitLab(bare);
    const url = await fake.start();
    token = fake.addToken(['api']);
    p = new GitLabProvider({
      baseUrl: 'https://git.example.test',
      projectPath: 'acme/app',
      token: () => Promise.resolve(token),
      fetch: hostFetch({ 'https://git.example.test': url }),
      pollMs: 0,
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('reads heads, commits and compares through the merge base', async () => {
    const head = await commitOn(base0, ATTEMPT('1'), 'b.txt', 'new\n', 'add b\n\nRemyral-Attempt: att-1/1');
    expect(await p.branchHead('main')).toBe(base0);
    expect(await p.branchHead(ATTEMPT('1'))).toBe(head);
    expect(await p.branchHead('nope')).toBeNull();
    const c = await p.commit(head);
    expect(c.parents).toEqual([base0]);
    expect(c.message).toContain('Remyral-Attempt: att-1/1');
    const cmp = await p.compare(base0, head);
    expect(cmp).toMatchObject({ status: 'ahead', mergeBase: base0, truncated: false });
    expect(cmp.commits.map((x) => x.sha)).toEqual([head]);
    expect(cmp.files).toEqual([{ path: 'b.txt', status: 'added', additions: 1, deletions: 0 }]);
    expect((await p.compare(head, base0)).status).toBe('behind');
    expect((await p.compare(head, head)).status).toBe('identical');
    expect((await p.patch(base0, head, 10_000)).text).toContain('+new');
    expect(await p.defaultBranch()).toBe('main');
  });

  it('opens one merge request (idempotent, drafts by title), tests the merge and merges with the sha guard', async () => {
    const head = (await p.branchHead(ATTEMPT('1'))) ?? '';
    const input = { headBranch: ATTEMPT('1'), targetBranch: 'main', title: 'Add b', body: 'why' };
    const mr = await p.ensurePullRequest(input);
    expect(mr).toEqual({ number: 1, url: 'https://git.example.test/acme/app/-/merge_requests/1' });
    expect(await p.ensurePullRequest(input)).toEqual(mr);
    expect(fake.mrs).toHaveLength(1);

    fake.checkingReads = 1;
    const t = {
      targetBranch: 'main',
      headSha: head,
      headBranch: ATTEMPT('1'),
      baseAtStart: base0,
      pullRequest: mr,
    };
    // p22-output-delivery §1: while GitLab is still checking, the history answers (the head is a fast-forward of
    // main, so it merges cleanly) instead of "unknown"; the same without a merge request.
    expect((await p.testMerge(t)).state).toBe('clean');
    expect(await p.testMerge(t)).toEqual({ state: 'clean', baseSha: base0, headSha: head });
    expect((await p.testMerge({ ...t, pullRequest: null })).state).toBe('clean');

    // A moved head is refused by GitLab's sha check (and by the re-read before it).
    const moved = await p.merge({
      targetBranch: 'main',
      headSha: base0,
      headBranch: ATTEMPT('1'),
      method: 'merge',
      pullRequest: mr,
      title: 'Merge',
      message: 'm\n\nRemyral-Merge: req-1',
    });
    expect(moved).toMatchObject({ merged: false, reason: 'head_moved' });

    const out = await p.merge({
      targetBranch: 'main',
      headSha: head,
      headBranch: ATTEMPT('1'),
      method: 'merge',
      pullRequest: mr,
      title: 'Merge rac/job-1',
      message: 'Verified.\n\nRemyral-Merge: req-1',
    });
    expect(out.merged).toBe(true);
    const sha = out.merged ? out.sha : '';
    expect(bare.head('main')).toBe(sha);
    expect(bare.commit(sha).parents).toEqual([base0, head]);
    expect(await p.findMerge('main', 'req-1')).toBe(sha);
    expect(await p.findMerge('main', 'req-x')).toBeNull();
    expect((await p.testMerge({ ...t, baseAtStart: base0 })).state).toBe('clean');
    // The PUT carried the approved head as `sha`.
    expect(fake.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/merge_requests/1/merge'))).toBe(
      true,
    );
  });

  it('reports real conflicts (approximate files, both sides’ commits) and squash-merges a clean one', async () => {
    const main = bare.head('main') ?? '';
    const ours = await commitOn(main, ATTEMPT('2'), 'a.txt', 'ours\n', 'ours\n\nRemyral-Attempt: att-2/1');
    const theirs = await commitOn(main, 'main', 'a.txt', 'theirs\n', 'theirs');
    const mr = await p.ensurePullRequest({
      headBranch: ATTEMPT('2'),
      targetBranch: 'main',
      title: 'Ours',
      body: '',
    });
    const check = await p.testMerge({
      targetBranch: 'main',
      headSha: ours,
      headBranch: ATTEMPT('2'),
      baseAtStart: main,
      pullRequest: mr,
    });
    expect(check).toMatchObject({ state: 'conflicts', files: ['a.txt'], precision: 'approximate' });
    if (check.state === 'conflicts') {
      expect(check.headCommits.map((c) => c.sha)).toEqual([ours]);
      expect(check.baseCommits.map((c) => c.sha)).toEqual([theirs]);
    }
    const refused = await p.merge({
      targetBranch: 'main',
      headSha: ours,
      headBranch: ATTEMPT('2'),
      method: 'merge',
      pullRequest: mr,
      title: 't',
      message: 'm',
    });
    expect(refused).toMatchObject({ merged: false, reason: 'not_mergeable' });
    // A rewritten target is base_moved.
    const rewritten = await p.testMerge({
      targetBranch: 'main',
      headSha: ours,
      headBranch: ATTEMPT('2'),
      baseAtStart: ours,
      pullRequest: mr,
    });
    expect(rewritten.state).toBe('base_moved');

    const clean = await commitOn(theirs, ATTEMPT('3'), 'c.txt', 'c\n', 'c\n\nRemyral-Attempt: att-3/1');
    const mr3 = await p.ensurePullRequest({
      headBranch: ATTEMPT('3'),
      targetBranch: 'main',
      title: 'C',
      body: '',
    });
    const squashed = await p.merge({
      targetBranch: 'main',
      headSha: clean,
      headBranch: ATTEMPT('3'),
      method: 'squash',
      pullRequest: mr3,
      title: 'Squash C',
      message: 'Remyral-Merge: req-3',
    });
    expect(squashed.merged).toBe(true);
    if (squashed.merged) expect(bare.commit(squashed.sha).parents).toEqual([theirs]);
    expect(await p.findMerge('main', 'req-3')).toBe(squashed.merged ? squashed.sha : '');
  });

  it('maps GitLab commit statuses to CI states', async () => {
    const sha = bare.head('main') ?? '';
    expect((await p.checks(sha)).state).toBe('none');
    fake.statuses.set(sha, [{ name: 'test', status: 'running', target_url: 'https://ci/1' }]);
    expect((await p.checks(sha)).state).toBe('pending');
    fake.statuses.set(sha, [
      { name: 'test', status: 'success' },
      { name: 'lint', status: 'failed', allow_failure: true },
      { name: 'deploy', status: 'manual' },
    ]);
    expect((await p.checks(sha)).state).toBe('success');
    fake.statuses.set(sha, [{ name: 'test', status: 'failed' }]);
    const failed = await p.checks(sha);
    expect(failed).toMatchObject({ state: 'failure', checks: [{ name: 'test', conclusion: 'failure' }] });
  });

  it('branch rules: protection, delete with expected sha, create / fast-forward only platform branches', async () => {
    expect((await p.branchProtection('main')).state).toBe('protected');
    expect((await p.branchProtection(ATTEMPT('3'))).state).toBe('unprotected');
    expect((await p.branchProtection('nope')).state).toBe('missing');
    const main = bare.head('main') ?? '';
    expect(await p.updateBranch('int/abcd1234', base0, null)).toBe('updated');
    expect(await p.updateBranch('int/abcd1234', main, base0)).toBe('updated');
    expect(bare.head('int/abcd1234')).toBe(main);
    expect(await p.updateBranch('int/abcd1234', base0, main)).toBe('not_fast_forward');
    expect(await p.updateBranch('main', base0, main)).toBe('not_fast_forward');
    expect(await p.updateBranch('int/abcd1234', main, base0)).toBe('updated');
    expect(await p.updateBranch('int/abcd1234', base0, base0)).toBe('moved');
    expect(await p.deleteBranch('int/abcd1234', base0)).toBe('moved');
    expect(await p.deleteBranch('int/abcd1234', main)).toBe('deleted');
    expect(await p.deleteBranch('int/abcd1234', main)).toBe('absent');
  });

  it('comments once per marker and updates the merge request', async () => {
    const first = await p.issueComment(2, 'hello', '<!-- remyral:k1 -->');
    const again = await p.issueComment(2, 'hello', '<!-- remyral:k1 -->');
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, id: first.id });
    await p.updatePullRequest({ number: 2, url: '' }, { title: 'New title', body: 'New body' });
    expect(fake.mrs[1]?.title).toBe('New title');
  });

  it('host API: token test with scopes and expiry, scope mismatch, rotation, repositories, create', async () => {
    const f = hostFetch({ 'https://git.example.test': `http://127.0.0.1:${String(fake.port)}` });
    const target = {
      kind: 'gitlab' as const,
      baseUrl: 'https://git.example.test',
      tokenKind: 'group' as const,
      scope: 'acme',
    };
    const ok = await testHostToken(target, token, 'api', f);
    expect(ok).toMatchObject({ ok: true, code: 'ok', scopes: ['api'], expiresAt: '2027-06-30' });
    expect((await testHostToken({ ...target, scope: 'other' }, token, 'api', f)).code).toBe('scope_mismatch');
    expect((await testHostToken(target, 'glpat-wrong-token', 'api', f)).code).toBe('unauthorized');
    const readOnly = fake.addToken(['read_api']);
    expect(await testHostToken(target, readOnly, 'api', f)).toMatchObject({
      ok: false,
      code: 'missing_scopes',
      missingScopes: ['api'],
    });
    const push = fake.addToken(['write_repository']);
    expect((await testHostToken(target, push, 'push', f)).ok).toBe(true);

    const repos = await listHostRepositories(target, token, '', f);
    expect(repos.map((r) => r.fullPath)).toEqual(['acme/app']);
    const made = await createHostRepository(target, token, { name: 'site', private: true }, f);
    expect(made).toMatchObject({ fullPath: 'acme/site', created: true });
    expect((await createHostRepository(target, token, { name: 'app', private: true }, f)).created).toBe(
      false,
    );
    await expect(
      createHostRepository(
        { ...target, tokenKind: 'project', scope: 'acme/app' },
        token,
        { name: 'x', private: true },
        f,
      ),
    ).rejects.toMatchObject({ code: 'not_supported' });

    const rotated = await rotateGitLabToken(target, push === '' ? token : token, '2027-09-01', f);
    expect(rotated.token).not.toBe(token);
    expect(rotated.expiresAt).toBe('2027-09-01');
    expect((await testHostToken(target, token, 'api', f)).code).toBe('unauthorized');
    token = rotated.token;
    // Errors never carry the token.
    await expect(p.commit('0'.repeat(40))).rejects.toThrow(/HTTP 404/);
    try {
      await new GitLabProvider({
        baseUrl: 'https://git.example.test',
        projectPath: 'acme/app',
        token: () => Promise.resolve('glpat-secret-value'),
        fetch: f,
      }).commit(base0);
    } catch (err) {
      expect(String(err)).not.toContain('glpat-secret-value');
    }
  });
});

describe('Bitbucket provider (fake Bitbucket Cloud on a real repository)', () => {
  let fake: FakeBitbucket;
  let token: string;
  let p: BitbucketProvider;
  let f: ReturnType<typeof hostFetch>;
  beforeAll(async () => {
    fake = new FakeBitbucket(bare);
    const url = await fake.start();
    token = fake.addToken();
    f = hostFetch({ 'https://api.bitbucket.org': url });
    p = new BitbucketProvider({
      apiUrl: 'https://api.bitbucket.org',
      workspace: 'acme',
      repoSlug: 'app',
      token: () => Promise.resolve(token),
      fetch: f,
      pollMs: 0,
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('heads, commits, compare (diffstat in Bitbucket’s order) and the patch', async () => {
    const main = bare.head('main') ?? '';
    const head = await commitOn(
      main,
      ATTEMPT('b1'),
      'd.txt',
      'd1\nd2\n',
      'add d\n\nRemyral-Attempt: att-b1/1',
    );
    expect(await p.branchHead(ATTEMPT('b1'))).toBe(head);
    expect(await p.branchHead('nope')).toBeNull();
    expect((await p.commit(head)).author).toMatchObject({ name: 'dev', email: 'dev@example.test' });
    const cmp = await p.compare(main, head);
    expect(cmp).toMatchObject({ status: 'ahead', mergeBase: main });
    expect(cmp.commits.map((c) => c.sha)).toEqual([head]);
    expect(cmp.files).toEqual([{ path: 'd.txt', status: 'added', additions: 2, deletions: 0 }]);
    expect((await p.compare(head, main)).status).toBe('behind');
    expect((await p.patch(main, head, 10_000)).text).toContain('+d1');
    expect(await p.defaultBranch()).toBe('main');
  });

  it('pull request, mergeability checks, merge (sync and through the task-status link)', async () => {
    const main = bare.head('main') ?? '';
    const head = bare.head(ATTEMPT('b1')) ?? '';
    const input = { headBranch: ATTEMPT('b1'), targetBranch: 'main', title: 'Add d', body: 'why' };
    const pr = await p.ensurePullRequest(input);
    expect(pr).toEqual({ number: 1, url: 'https://bitbucket.org/acme/app/pull-requests/1' });
    expect(await p.ensurePullRequest(input)).toEqual(pr);
    fake.pendingChecks = 1;
    const t = {
      targetBranch: 'main',
      headSha: head,
      headBranch: ATTEMPT('b1'),
      baseAtStart: main,
      pullRequest: pr,
    };
    // p22-output-delivery §1: a pending mergeability check answers from history (a fast-forward: clean).
    expect((await p.testMerge(t)).state).toBe('clean');
    expect((await p.testMerge(t)).state).toBe('clean');
    const out = await p.merge({
      targetBranch: 'main',
      headSha: head,
      headBranch: ATTEMPT('b1'),
      method: 'merge',
      pullRequest: pr,
      title: 'Merge d',
      message: 'Remyral-Merge: req-b1',
    });
    expect(out.merged).toBe(true);
    if (out.merged) {
      expect(out.sha).toBe(bare.head('main'));
      expect(await p.findMerge('main', 'req-b1')).toBe(out.sha);
    }

    fake.asyncMerge = true;
    const main2 = bare.head('main') ?? '';
    const h2 = await commitOn(main2, ATTEMPT('b2'), 'e.txt', 'e\n', 'e\n\nRemyral-Attempt: att-b2/1');
    const pr2 = await p.ensurePullRequest({
      headBranch: ATTEMPT('b2'),
      targetBranch: 'main',
      title: 'E',
      body: '',
    });
    const queued = await p.merge({
      targetBranch: 'main',
      headSha: h2,
      headBranch: ATTEMPT('b2'),
      method: 'merge',
      pullRequest: pr2,
      title: 'Merge e',
      message: 'Remyral-Merge: req-b2',
    });
    fake.asyncMerge = false;
    expect(queued.merged).toBe(true);
    expect(fake.requests.some((r) => r.path.includes('/merge/task-status/'))).toBe(true);
  });

  it('conflicts are exact (the pull request’s file conflicts); statuses map to CI states', async () => {
    const main = bare.head('main') ?? '';
    const ours = await commitOn(
      main,
      ATTEMPT('b3'),
      'a.txt',
      'bb-ours\n',
      'ours\n\nRemyral-Attempt: att-b3/1',
    );
    await commitOn(main, 'main', 'a.txt', 'bb-theirs\n', 'theirs');
    const pr = await p.ensurePullRequest({
      headBranch: ATTEMPT('b3'),
      targetBranch: 'main',
      title: 'X',
      body: '',
    });
    const check = await p.testMerge({
      targetBranch: 'main',
      headSha: ours,
      headBranch: ATTEMPT('b3'),
      baseAtStart: main,
      pullRequest: pr,
    });
    expect(check).toMatchObject({ state: 'conflicts', files: ['a.txt'], precision: 'exact' });
    const refused = await p.merge({
      targetBranch: 'main',
      headSha: ours,
      headBranch: ATTEMPT('b3'),
      method: 'squash',
      pullRequest: pr,
      title: 't',
      message: 'm',
    });
    expect(refused).toMatchObject({ merged: false, reason: 'not_mergeable' });

    expect((await p.checks(ours)).state).toBe('none');
    fake.statuses.set(ours, [{ key: 'ci', name: 'Pipeline', state: 'INPROGRESS', url: 'https://ci' }]);
    expect((await p.checks(ours)).state).toBe('pending');
    fake.statuses.set(ours, [{ key: 'ci', state: 'SUCCESSFUL' }]);
    expect((await p.checks(ours)).state).toBe('success');
    fake.statuses.set(ours, [
      { key: 'ci', state: 'FAILED' },
      { key: 'b', state: 'SUCCESSFUL' },
    ]);
    expect((await p.checks(ours)).state).toBe('failure');
  });

  it('restrictions, branch updates, comments; host API test / repositories / create', async () => {
    expect(await p.branchProtection('main')).toMatchObject({ state: 'protected', rules: ['push'] });
    expect((await p.branchProtection(ATTEMPT('b3'))).state).toBe('unprotected');
    const main = bare.head('main') ?? '';
    expect(await p.updateBranch('int/bb000001', base0, null)).toBe('updated');
    expect(await p.updateBranch('int/bb000001', main, base0)).toBe('updated');
    expect(await p.updateBranch('main', base0, main)).toBe('not_fast_forward');
    expect(await p.deleteBranch('int/bb000001', main)).toBe('deleted');
    const c1 = await p.issueComment(1, 'hi', '<!-- m -->');
    expect((await p.issueComment(1, 'hi', '<!-- m -->')).created).toBe(false);
    expect(c1.created).toBe(true);

    const target = {
      kind: 'bitbucket' as const,
      baseUrl: 'https://api.bitbucket.org',
      tokenKind: 'repository' as const,
      scope: 'acme/app',
    };
    expect(await testHostToken(target, token, 'api', f)).toMatchObject({ ok: true, code: 'ok' });
    expect((await testHostToken({ ...target, scope: 'acme/other' }, token, 'api', f)).code).toBe(
      'scope_mismatch',
    );
    expect((await testHostToken(target, 'bad-token-xx', 'api', f)).code).toBe('unauthorized');
    const ws = { ...target, tokenKind: 'workspace' as const, scope: 'acme' };
    expect((await testHostToken(ws, token, 'api', f)).ok).toBe(true);
    expect((await listHostRepositories(target, token, '', f)).map((r) => r.cloneUrl)).toEqual([
      'https://bitbucket.org/acme/app.git',
    ]);
    expect((await createHostRepository(ws, token, { name: 'Site', private: true }, f)).fullPath).toBe(
      'acme/site',
    );
    await expect(createHostRepository(target, token, { name: 'x', private: true }, f)).rejects.toMatchObject({
      code: 'not_supported',
    });
    await expect(rotateGitLabToken(target, token, '2027-01-01', f)).rejects.toMatchObject({
      code: 'not_supported',
    });
  });
});

describe('Bitbucket query filters', () => {
  it('a branch name is a quoted BBQL string; quotes, backslashes and control characters are refused', async () => {
    expect(bbqlString('feature/x')).toBe('"feature/x"');
    for (const bad of ['x" OR state = "MERGED', 'a\\b', 'a\nb']) {
      expect(() => bbqlString(bad)).toThrow(ProviderError);
    }
    const sent: string[] = [];
    const p = new BitbucketProvider({
      apiUrl: 'https://api.bitbucket.org',
      workspace: 'acme',
      repoSlug: 'app',
      token: () => Promise.resolve('t'),
      fetch: (input) => {
        sent.push(input);
        return Promise.resolve(new Response('{"values":[]}', { status: 200 }));
      },
      pollMs: 0,
    });
    await expect(
      p.ensurePullRequest({
        headBranch: 'x" OR state = "MERGED',
        targetBranch: 'main',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(ProviderError);
    expect(sent).toHaveLength(0);
  });
});
