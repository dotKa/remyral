import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatMentions, MentionRefs } from '../../src/chat/mentions.js';
import { codeRefId } from '../../src/code/reference.js';
import { loadGitConfig } from '../../src/gitflow/config-store.js';
import { CodeService } from '../../src/code/service.js';
import type { BlobRead, GitProvider, TreeListing } from '../../src/gitflow/types.js';
import { classifyBlob, ProviderError } from '../../src/gitflow/types.js';
import { type JobActor, JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p19-ide W1 (docs/design/p19-ide.md "Implementation (W1)"): the code viewer and diff reviewer REST against a real
 * database, with an in-memory git provider (no network): rights (no read right → 404, viewer cannot comment → 403),
 * size / binary limits, redaction, comments CRUD, "Değişiklik iste" as a job message and as a follow-up job, and the
 * `code` chat reference re-read at send time (secrets filtered, rights re-checked, audited without the text).
 */
const PW = 'quartz-meadow-lantern-7';
const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

/** Files per commit; a missing path is "not found". */
const FILES: Record<string, Record<string, string | Buffer>> = {
  [BASE]: {
    'README.md': '# app\n',
    'src/app.ts': 'export const a = 1;\nexport const b = 2;\n',
  },
  [HEAD]: {
    'README.md': '# app\n',
    'src/app.ts': `export const a = 1;\nexport const b = 3;\nconst token = '${TOKEN}';\n`,
    'src/new.ts': 'export {};\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]),
    'big.txt': 'x'.repeat(1024 * 1024 + 10),
  },
};

class MemoryProvider implements GitProvider {
  readonly kind = 'git' as const;
  reads = 0;
  branchHead(b: string): Promise<string | null> {
    return Promise.resolve(b === 'main' ? BASE : b === 'feature' ? HEAD : null);
  }
  tree(sha: string, path: string): Promise<TreeListing | null> {
    this.reads += 1;
    const files = FILES[sha];
    if (files === undefined) return Promise.reject(new ProviderError('unknown commit', false, 404));
    const prefix = path === '' ? '' : `${path}/`;
    const names = new Map<string, 'file' | 'dir'>();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [first, ...more] = rest.split('/');
      if (first !== undefined) names.set(first, more.length > 0 ? 'dir' : 'file');
    }
    if (names.size === 0) return Promise.resolve(null);
    return Promise.resolve({
      entries: [...names].map(([name, kind]) => ({
        name,
        path: `${prefix}${name}`,
        kind,
        size: kind === 'file' ? Buffer.byteLength(files[`${prefix}${name}`] ?? '') : null,
      })),
      truncated: false,
    });
  }
  blob(sha: string, path: string, maxBytes: number): Promise<BlobRead | null> {
    this.reads += 1;
    const c = FILES[sha]?.[path];
    if (c === undefined) return Promise.resolve(null);
    const buf = typeof c === 'string' ? Buffer.from(c) : c;
    return Promise.resolve(classifyBlob(buf, buf.length, maxBytes));
  }
  commit(): never {
    throw new Error('unused');
  }
  compare(base: string, head: string) {
    return Promise.resolve({
      status: 'ahead' as const,
      mergeBase: base,
      commits: [],
      files:
        head === HEAD
          ? [{ path: 'src/app.ts', status: 'modified' as const, additions: 2, deletions: 1 }]
          : [],
      truncated: false,
    });
  }
  testMerge(): never {
    throw new Error('unused');
  }
  ensurePullRequest(): never {
    throw new Error('unused');
  }
  checks(): never {
    throw new Error('unused');
  }
  merge(): never {
    throw new Error('unused');
  }
  findMerge(): never {
    throw new Error('unused');
  }
  deleteBranch(): never {
    throw new Error('unused');
  }
}

describeIntegration('p19-ide W1: code viewer, diff review, chat code references', () => {
  let h: Harness;
  const provider = new MemoryProvider();
  let ownerId = '';
  let opId = '';
  let viewerId = '';
  let owner: Client;
  let op: Client;
  let viewer: Client;
  let outsider: Client;
  let jobId = '';
  let jobs: JobStore;

  beforeAll(async () => {
    h = new Harness();
    await h.start({ gitflow: { providers: () => provider } });
    ownerId = await h.createUser('owner.code', PW, 'owner');
    owner = await fullLogin(h, 'owner.code', PW, (await enroll(h, 'owner.code', PW)).secret);
    opId = await h.createUser('op.code', PW, 'operator');
    await h.grant(opId, ['alpha'], 'operator');
    op = await fullLogin(h, 'op.code', PW, (await enroll(h, 'op.code', PW)).secret);
    viewerId = await h.createUser('viewer.code', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    viewer = await fullLogin(h, 'viewer.code', PW, (await enroll(h, 'viewer.code', PW)).secret);
    const outsiderId = await h.createUser('viewer.beta', PW, 'viewer');
    await h.grant(outsiderId, ['beta'], 'viewer');
    outsider = await fullLogin(h, 'viewer.beta', PW, (await enroll(h, 'viewer.beta', PW)).secret);
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('alpha', 1, 'git', 'https://example.com/acme/app.git', 'main', 'merge', false, 1800, $1, $2)`,
      [ownerId, h.clock.now()],
    );
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const creator: JobActor = { type: 'user', id: opId };
    jobId = (
      await jobs.create({
        project: 'alpha',
        actor: creator,
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'Change b',
          repository: { url: 'https://example.com/acme/app.git', baseRef: 'main', workBranch: 'w/b' },
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 3600 },
        },
      })
    ).job.id;
    await h.db.pool.query(
      `INSERT INTO job_git (job_id, project, provider, target_branch, base_sha, branch, head_sha, verification, changes,
                            created_at, updated_at)
       VALUES ($1, 'alpha', 'git', 'main', $2, $3, $4, 'passed', $5, now(), now())`,
      [
        jobId,
        BASE,
        `rac/${jobId}/a1`,
        HEAD,
        JSON.stringify({
          commits: [],
          files: [
            { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 },
            { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 },
          ],
          totals: { files: 2, additions: 3, deletions: 1 },
          truncated: false,
        }),
      ],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  it('lists the source, a directory and files at a branch; redacts, caps and summarises', async () => {
    const src = await viewer.req('GET', '/projects/alpha/code');
    expect(src.statusCode, src.body).toBe(200);
    expect(src.json()).toMatchObject({ kind: 'repository', defaultBranch: 'main', supported: true });
    expect(src.json<{ branches: { jobId: string; headSha: string }[] }>().branches).toEqual([
      expect.objectContaining({ jobId, headSha: HEAD }),
    ]);

    const root = await viewer.req('GET', '/projects/alpha/code/tree?ref=feature');
    expect(root.statusCode, root.body).toBe(200);
    const t = root.json<{ sha: string; entries: { path: string; kind: string }[] }>();
    expect(t.sha).toBe(HEAD);
    // Directories first.
    expect(t.entries.map((e) => e.path)).toEqual(['src', 'big.txt', 'logo.png', 'README.md']);
    const sub = await viewer.req('GET', '/projects/alpha/code/tree?ref=feature&path=src');
    expect(sub.json<{ entries: unknown[] }>().entries).toHaveLength(2);

    const f = await viewer.req('GET', '/projects/alpha/code/file?ref=feature&path=src/app.ts');
    expect(f.statusCode, f.body).toBe(200);
    const file = f.json<{ text: string; redacted: boolean; language: string; ref: string }>();
    expect(file.text).not.toContain(TOKEN);
    expect(file.text).toContain('[REDACTED:');
    expect(file).toMatchObject({ redacted: true, language: 'typescript', ref: HEAD });

    const bin = await viewer.req('GET', `/projects/alpha/code/file?ref=${HEAD}&path=logo.png`);
    expect(bin.json()).toMatchObject({ state: 'binary', text: null, size: 7 });
    const big = await viewer.req('GET', `/projects/alpha/code/file?ref=${HEAD}&path=big.txt`);
    expect(big.json()).toMatchObject({ state: 'too_large', text: null });

    // Default ref is the base branch; immutable reads by sha are cached.
    const base = await viewer.req('GET', '/projects/alpha/code/file?path=src/app.ts');
    expect(base.json<{ text: string }>().text).toContain('b = 2');
    const before = provider.reads;
    await viewer.req('GET', '/projects/alpha/code/file?path=src/app.ts');
    expect(provider.reads).toBe(before);

    expect((await viewer.req('GET', '/projects/alpha/code/file?path=nope.ts')).statusCode).toBe(404);
    expect((await viewer.req('GET', '/projects/alpha/code/tree?ref=nope')).statusCode).toBe(404);
    expect((await viewer.req('GET', '/projects/alpha/code/file?path=../etc/passwd')).statusCode).toBe(400);
    expect((await viewer.req('GET', '/projects/alpha/code/tree?ref=-x')).statusCode).toBe(400);
  });

  it('hides the code of a project without a read right (404), also for job routes', async () => {
    for (const url of [
      '/projects/alpha/code',
      '/projects/alpha/code/tree',
      '/projects/alpha/code/file?path=README.md',
      `/jobs/${jobId}/review`,
      `/jobs/${jobId}/review/file?path=src/app.ts`,
      `/jobs/${jobId}/review/comments`,
    ]) {
      const r = await outsider.req('GET', url);
      expect(r.statusCode, url).toBe(404);
    }
  });

  it('serves the job review: files and both sides of a changed file; compare of two refs', async () => {
    const r = await viewer.req('GET', `/jobs/${jobId}/review`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ baseSha: BASE, headSha: HEAD, supported: true });
    const pair = await viewer.req('GET', `/jobs/${jobId}/review/file?path=src/app.ts`);
    const p = pair.json<{ old: { text: string; state: string }; new: { text: string } }>();
    expect(p.old.text).toContain('b = 2');
    expect(p.new.text).toContain('b = 3');
    expect(p.new.text).not.toContain(TOKEN);
    const added = await viewer.req('GET', `/jobs/${jobId}/review/file?path=src/new.ts`);
    expect(added.json()).toMatchObject({ old: { state: 'absent' }, new: { state: 'text' } });
    expect((await viewer.req('GET', `/jobs/${jobId}/review/file?path=README.md`)).statusCode).toBe(404);

    const cmp = await viewer.req('GET', '/projects/alpha/code/compare?base=main&head=feature');
    expect(cmp.json()).toMatchObject({ baseSha: BASE, headSha: HEAD, files: [{ path: 'src/app.ts' }] });
    const cf = await viewer.req(
      'GET',
      `/projects/alpha/code/compare/file?base=${BASE}&head=${HEAD}&path=src/app.ts`,
    );
    expect(cf.statusCode, cf.body).toBe(200);
  });

  it('comments: viewers read, operators write, authors edit and delete, anyone may resolve', async () => {
    const denied = await viewer.req('POST', `/jobs/${jobId}/review/comments`, {
      path: 'src/app.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'no',
    });
    expect(denied.statusCode).toBe(403);
    const c = await op.req('POST', `/jobs/${jobId}/review/comments`, {
      path: 'src/app.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'b must stay 2',
    });
    expect(c.statusCode, c.body).toBe(201);
    const comment = c.json<{ comment: { id: string; mine: boolean; commitSha: string; outdated: boolean } }>()
      .comment;
    expect(comment).toMatchObject({ mine: true, commitSha: HEAD, outdated: false });
    const reply = await owner.req('POST', `/jobs/${jobId}/review/comments`, {
      path: 'ignored.ts',
      side: 'old',
      startLine: 9,
      endLine: 9,
      body: 'agreed',
      parentId: comment.id,
    });
    expect(reply.statusCode, reply.body).toBe(201);
    // A reply sits on its thread's anchor.
    expect(reply.json()).toMatchObject({
      comment: { parentId: comment.id, path: 'src/app.ts', side: 'new' },
    });
    const replyId = reply.json<{ comment: { id: string } }>().comment.id;

    const list = await viewer.req('GET', `/jobs/${jobId}/review/comments`);
    expect(list.json<{ comments: unknown[] }>().comments).toHaveLength(2);

    // Only the author edits.
    expect(
      (await owner.req('PATCH', `/jobs/${jobId}/review/comments/${comment.id}`, { body: 'x' })).statusCode,
    ).toBe(403);
    const edited = await op.req('PATCH', `/jobs/${jobId}/review/comments/${comment.id}`, {
      body: 'b must stay 2!',
    });
    expect(edited.json()).toMatchObject({ comment: { body: 'b must stay 2!' } });
    // Owners delete any comment; the reply goes.
    expect((await owner.req('DELETE', `/jobs/${jobId}/review/comments/${replyId}`)).statusCode).toBe(204);
    expect((await op.req('DELETE', `/jobs/${jobId}/review/comments/${replyId}`)).statusCode).toBe(404);
    const resolved = await owner.req('PATCH', `/jobs/${jobId}/review/comments/${comment.id}`, {
      resolved: true,
    });
    expect(resolved.json()).toMatchObject({ comment: { resolved: true } });
    await owner.req('PATCH', `/jobs/${jobId}/review/comments/${comment.id}`, { resolved: false });
  });

  it('"Değişiklik iste": a message while the job will run, a follow-up job on its head once it ended', async () => {
    expect(
      (await viewer.req('POST', `/jobs/${jobId}/review/request-changes`, { note: 'x' })).statusCode,
    ).toBe(403);
    // The job is queued: the review waits for its agent as a job message.
    const msg = await op.req('POST', `/jobs/${jobId}/review/request-changes`, {
      note: 'Keep b at 2.',
      hunks: [{ path: 'src/app.ts', oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }],
    });
    expect(msg.statusCode, msg.body).toBe(200);
    expect(msg.json()).toMatchObject({ mode: 'message', comments: 1, jobId: null });
    const { rows: m } = await h.db.pool.query<{ text: string }>(
      'SELECT text FROM job_messages WHERE job_id = $1',
      [jobId],
    );
    expect(m).toHaveLength(1);
    const text = m[0]?.text ?? '';
    expect(text).toContain('Keep b at 2.');
    expect(text).toContain('src/app.ts:2 (after the change): b must stay 2!');
    // The rejected hunk's exact lines come from the provider, not the browser.
    expect(text).toContain('export const b = 2;');
    expect(text).toContain('export const b = 3;');
    const sent = await viewer.req('GET', `/jobs/${jobId}/review/comments`);
    expect(sent.json<{ comments: { sentAt: string | null }[] }>().comments[0]?.sentAt).not.toBeNull();

    // The job ended: a follow-up job starts from the verified head with the review in its prompt.
    await h.db.pool.query(`UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1`, [
      jobId,
    ]);
    const follow = await op.req('POST', `/jobs/${jobId}/review/request-changes`, {
      note: 'Rename a to alpha.',
    });
    expect(follow.statusCode, follow.body).toBe(200);
    const out = follow.json<{ mode: string; jobId: string }>();
    expect(out.mode).toBe('job');
    const { rows: j } = await h.db.pool.query<{ spec: { prompt: string; repository: { baseRef: string } } }>(
      'SELECT spec FROM jobs WHERE id = $1',
      [out.jobId],
    );
    expect(j[0]?.spec.repository.baseRef).toBe(HEAD);
    expect(j[0]?.spec.prompt).toContain('Rename a to alpha.');
    expect(j[0]?.spec.prompt).toContain(`continues job ${jobId}`);
    const { rows: a } = await h.db.pool.query<{ metadata: { mode: string } }>(
      // The service's own entries (the route's authz entry carries no mode).
      `SELECT metadata FROM audit_events WHERE action = 'code.review.request_changes' AND metadata ? 'mode' ORDER BY id`,
    );
    expect(a.map((x) => x.metadata.mode)).toEqual(['message', 'job']);
    // An empty review is refused.
    const { rows: c } = await h.db.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM code_review_comments',
    );
    for (const r of c) await owner.req('PATCH', `/jobs/${jobId}/review/comments/${r.id}`, { resolved: true });
    expect((await op.req('POST', `/jobs/${jobId}/review/request-changes`, {})).statusCode).toBe(400);
  });

  it('a code reference is re-read at send time as the sender: lines, redaction, rights, audit', async () => {
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const config = await loadGitConfig(h.db.pool, 'alpha');
    if (config === null) throw new Error('no config');
    const code = new CodeService({
      pool: h.db.pool,
      audit,
      providers: () => ({ providerFor: () => Promise.resolve({ provider, config }) }),
    });
    const mentions = new ChatMentions({ db: h.db.pool, code: () => code, audit });
    const id = codeRefId({ source: 'repo', ref: HEAD, startLine: 2, endLine: 3, path: 'src/app.ts' });
    const refs = MentionRefs.parse([{ type: 'code', id, project: 'alpha' }]);
    const subject = await loadSubject(h.db.pool, { id: viewerId, role: 'viewer' });
    const r = await mentions.resolve(subject, refs, 48 * 1024);
    expect(r.dropped).toEqual([]);
    expect(r.chips).toEqual([{ type: 'code', id, project: 'alpha', label: 'src/app.ts:2-3 · 2222222' }]);
    const block = r.blocks[0] ?? '';
    expect(block).toContain('REMYRAL-DATA');
    expect(block).toContain('export const b = 3;');
    expect(block).not.toContain('export const a = 1;');
    expect(block).not.toContain(TOKEN);
    expect(block).toContain('[REDACTED:');
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'code.reference.send'`,
    );
    expect(rows[0]?.metadata).toMatchObject({ path: 'src/app.ts', lines: '2-3', ref: HEAD });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('export');

    // No read right in the project: dropped like any other mention (no oracle).
    const outsiderId =
      (
        await h.db.pool.query<{ id: string }>(
          `SELECT id::text AS id FROM users WHERE username = 'viewer.beta'`,
        )
      ).rows[0]?.id ?? '';
    const other = await loadSubject(h.db.pool, { id: outsiderId, role: 'viewer' });
    expect((await mentions.resolve(other, refs, 48 * 1024)).dropped).toEqual([
      { type: 'code', id, reason: 'not_visible' },
    ]);
    // Lines past the end, an unknown file, a malformed id: dropped.
    for (const bad of [
      codeRefId({ source: 'repo', ref: HEAD, startLine: 90, endLine: 99, path: 'src/app.ts' }),
      codeRefId({ source: 'repo', ref: HEAD, startLine: 1, endLine: 1, path: 'nope.ts' }),
      `repo:${HEAD}:1-1:../x`,
    ]) {
      const d = await mentions.resolve(subject, [{ type: 'code', id: bad, project: 'alpha' }], 48 * 1024);
      expect(d.dropped, bad).toHaveLength(1);
    }
  });
});
