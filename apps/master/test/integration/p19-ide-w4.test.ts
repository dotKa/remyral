import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ASSISTANT_COMMENT_PREFIX } from '../../src/chat/code-tools.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import type { BlobRead, GitProvider, TreeListing } from '../../src/gitflow/types.js';
import { classifyBlob, ProviderError } from '../../src/gitflow/types.js';
import { type JobActor, JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p19-ide W4 (docs/design/p19-ide.md §6, §9 W4) on real Postgres and the real card confirmation, with an in-memory git
 * provider (no network):
 *
 * - the code tools answer only a turn on a worker with `assistant-code-v1` (older worker: unavailable);
 * - read_code (a job's verified head, numbered lines, redacted), list_code (name search), open_code / open_diff ("Aç"
 *   cards with the master-built link);
 * - read_workspace_diff without Tam IDE configured: unavailable;
 * - draft_review_changes: an operator's card (`code.request_changes`, event chat.cards, a card by default); confirmed
 *   it stores the assistant's comments ("[Asistan] …") and starts the follow-up job of an ended job (audited
 *   `code.review.request_changes`); a viewer is refused, another project's member does not see the job.
 */
const PW = 'quartz-meadow-lantern-8';
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

describeIntegration('p19-ide W4: the assistant and the code viewer', { timeout: 300_000 }, () => {
  const h = new Harness();
  const provider = new MemoryProvider();
  let ownerId = '';
  let opId = '';
  let viewerId = '';
  let outsiderId = '';
  let op: Client;
  let opSecret = '';
  let jobId = '';

  beforeAll(async () => {
    await h.start({ gitflow: { providers: () => provider } });
    ownerId = await h.createUser('owner.w4', PW, 'owner');
    await fullLogin(h, 'owner.w4', PW, (await enroll(h, 'owner.w4', PW)).secret);
    opId = await h.createUser('op.w4', PW, 'operator');
    await h.grant(opId, ['alpha'], 'operator');
    opSecret = (await enroll(h, 'op.w4', PW)).secret;
    op = await fullLogin(h, 'op.w4', PW, opSecret);
    viewerId = await h.createUser('viewer.w4', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    outsiderId = await h.createUser('outsider.w4', PW, 'operator');
    await h.grant(outsiderId, ['beta'], 'operator');
    await h.db.pool.query(
      `INSERT INTO project_git_configs (project, version, provider, repository_url, base_branch, merge_method,
                                        require_ci, ci_timeout_sec, updated_by, updated_at)
       VALUES ('alpha', 1, 'git', 'https://example.com/acme/app.git', 'main', 'merge', false, 1800, $1, $2)`,
      [ownerId, h.clock.now()],
    );
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
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
    // The job has ended: "Değişiklik iste" starts a follow-up job.
    await h.db.pool.query(`UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1`, [
      jobId,
    ]);
  });
  afterAll(async () => {
    await h.stop();
  });

  const tools = (): ChatTools => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const app = h.app;
    return new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      opsTools: () => app.chatOpsTools,
      codeTools: () => app.chatCodeTools,
    } as unknown as ChatToolsDeps);
  };
  const ctx = async (userId: string, role: 'owner' | 'operator' | 'viewer', codeTools = true) => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    return {
      userId,
      subject: await loadSubject(h.db.pool, { id: userId, role }),
      threadId: (await store.createThread(userId, 'code')).id,
      turnId: randomUUID(),
      codeTools,
    };
  };

  it('an older worker gets "unavailable"; read_code reads the job’s head with numbered, redacted lines', async () => {
    const legacy = await tools().run(await ctx(opId, 'operator', false), 'read_code', {
      project: 'alpha',
      path: 'src/app.ts',
    });
    expect(!legacy.ok && legacy.code).toBe('unavailable');
    const c = await ctx(viewerId, 'viewer');
    const r = await tools().run(c, 'read_code', { project: 'alpha', path: 'src/app.ts', job: jobId });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = (r.ok ? r.data : {}) as { commit: string; lines: string; text: string };
    expect(d.commit).toBe(HEAD);
    expect(d.lines).toBe('1-3');
    expect(d.text).toContain('2| export const b = 3;');
    expect(d.text).not.toContain(TOKEN);
    const base = await tools().run(c, 'read_code', { project: 'alpha', path: 'src/app.ts' });
    expect(base.ok && (base.data as { commit: string }).commit).toBe(BASE);
    const hidden = await tools().run(await ctx(outsiderId, 'operator'), 'read_code', {
      project: 'alpha',
      path: 'src/app.ts',
    });
    expect(!hidden.ok && hidden.code).toBe('not_found');
  });

  it('list_code searches names; open_code / open_diff leave "Aç" cards', async () => {
    const c = await ctx(viewerId, 'viewer');
    const found = await tools().run(c, 'list_code', { project: 'alpha', ref: 'feature', query: 'new' });
    expect(found.ok && (found.data as { matches: { path: string }[] }).matches.map((m) => m.path)).toEqual([
      'src/new.ts',
    ]);
    const code = await tools().run(c, 'open_code', {
      project: 'alpha',
      path: 'src/app.ts',
      ref: 'feature',
      startLine: 2,
      endLine: 3,
    });
    expect(code.ok && code.codeCard).toMatchObject({ kind: 'code', sha: HEAD, startLine: 2, endLine: 3 });
    const diff = await tools().run(c, 'open_diff', { job: jobId, path: 'src/new.ts' });
    expect(diff.ok && diff.codeCard).toMatchObject({ kind: 'diff', project: 'alpha', job: jobId, files: 2 });
    expect(diff.ok && (diff.data as { link: string }).link).toBe(
      `/projects/alpha/code/jobs/${jobId}?path=src%2Fnew.ts`,
    );
  });

  it('read_workspace_diff: no workspace of the user is listed; an unknown workspace is not found', async () => {
    const c = await ctx(opId, 'operator');
    const list = await tools().run(c, 'read_workspace_diff', { project: 'alpha' });
    // Without IDE services the tool is unavailable; with them the operator has no workspace yet.
    if (list.ok) expect((list.data as { workspaces: unknown[] }).workspaces).toEqual([]);
    else expect(list.code).toBe('unavailable');
    const none = await tools().run(c, 'read_workspace_diff', { workspace: randomUUID() });
    expect(none.ok).toBe(false);
    expect(!none.ok && ['not_found', 'unavailable'].includes(none.code)).toBe(true);
  });

  it('draft_review_changes: an operator’s card; confirmed, comments are stored and a follow-up job starts', async () => {
    const viewer = await tools().run(await ctx(viewerId, 'viewer'), 'draft_review_changes', {
      job: jobId,
      note: 'x',
    });
    expect(!viewer.ok && viewer.code).toBe('forbidden');
    const outsider = await tools().run(await ctx(outsiderId, 'operator'), 'draft_review_changes', {
      job: jobId,
      note: 'x',
    });
    expect(!outsider.ok && outsider.code).toBe('not_found');

    const c = await ctx(opId, 'operator');
    const out = await tools().run(c, 'draft_review_changes', {
      job: jobId,
      note: 'Keep the exports stable.',
      comments: [{ path: 'src/app.ts', startLine: 2, body: 'b must stay 2.' }],
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const draftId = out.ok ? out.draft?.id : undefined;
    const { rows } = await h.db.pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM chat_drafts WHERE id = $1',
      [draftId ?? null],
    );
    expect(rows[0]?.payload).toMatchObject({
      target: 'admin',
      op: 'code.request_changes',
      event: 'chat.cards',
      jobId,
      headSha: HEAD,
    });
    h.clock.advance(31_000);
    expect((await op.req('POST', '/auth/step-up', { code: h.code(opSecret) })).statusCode).toBe(200);
    const confirmed = await op.req('POST', `/chat/drafts/${draftId ?? ''}/confirm`, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const { rows: comments } = await h.db.pool.query<{
      body: string;
      author_id: string;
      sent_at: Date | null;
    }>('SELECT body, author_id::text AS author_id, sent_at FROM code_review_comments WHERE job_id = $1', [
      jobId,
    ]);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(`${ASSISTANT_COMMENT_PREFIX}b must stay 2.`);
    expect(comments[0]?.author_id).toBe(opId);
    expect(comments[0]?.sent_at).not.toBeNull();
    const { rows: follow } = await h.db.pool.query<{
      spec: { prompt: string; repository: { baseRef: string } };
    }>(`SELECT spec FROM jobs WHERE id <> $1 AND project = 'alpha' ORDER BY created_at DESC LIMIT 1`, [
      jobId,
    ]);
    expect(follow[0]?.spec.repository.baseRef).toBe(HEAD);
    expect(follow[0]?.spec.prompt).toContain('Keep the exports stable.');
    expect(follow[0]?.spec.prompt).toContain('b must stay 2.');
    const { rows: audit } = await h.db.pool.query<{ metadata: { mode?: string } }>(
      `SELECT metadata FROM audit_events WHERE action = 'code.review.request_changes' AND metadata ? 'mode'`,
    );
    expect(audit.map((a) => a.metadata.mode)).toEqual(['job']);
  });
});
