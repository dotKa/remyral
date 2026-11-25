import type { IdeGitResultPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { ProjectRole, Subject } from '../../src/authz/model.js';
import { ADMIN_ACTION_OF, adminAlwaysFresh, isOpsToolOp } from '../../src/chat/admin-actions.js';
import {
  ASSISTANT_COMMENT_PREFIX,
  ChatCodeTools,
  type ChatCodeToolsDeps,
  codeCardHref,
} from '../../src/chat/code-tools.js';
import type { CodeFile, CodeService, ReviewComment } from '../../src/code/service.js';
import type { TreeEntry } from '../../src/gitflow/types.js';
import { HttpError } from '../../src/http/errors.js';
import type { IdeWorkspaceView } from '../../src/ide/service.js';
import { adminOpEvent } from '../../src/security-policy/events.js';

/**
 * p19-ide W4 (docs/design/p19-ide.md §6, §9 W4): the assistant's code tools — read_code (numbered, capped lines),
 * list_code (directory / name search), read_workspace_diff (the IDE machine's diff, redacted), open_code / open_diff
 * ("Aç" cards, nothing navigates), draft_review_changes (an administration card `code.request_changes` → the console's
 * "Değişiklik iste" with the assistant's comments).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const OTHER_JOB = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const MAIN = 'a'.repeat(40);

const subject = (
  role: 'owner' | 'admin' | 'operator' | 'viewer',
  memberships: [string, ProjectRole][] = [],
): Subject => ({ userId: USER, role, memberships: new Map(memberships) });

const ctx = {
  subject: subject('admin'),
  actor: { userId: USER, ip: '10.0.0.1', userAgent: 'ua' },
  meta: { ip: '10.0.0.1', userAgent: 'ua' },
};

function db(over: { kind?: Record<string, string>; state?: string } = {}) {
  const kinds: Record<string, string> = { shop: 'repository', notes: 'workspace', ...over.kind };
  const gits: Record<string, Record<string, unknown>> = {
    [JOB]: {
      job_id: JOB,
      project: 'shop',
      verification: 'passed',
      base_sha: BASE,
      head_sha: HEAD,
      branch: 'agent/x',
      target_branch: 'main',
    },
    [OTHER_JOB]: {
      job_id: OTHER_JOB,
      project: 'secret',
      verification: 'passed',
      base_sha: BASE,
      head_sha: HEAD,
    },
  };
  return {
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT kind FROM projects')) {
        const k = kinds[String(params[0])];
        return Promise.resolve({ rows: k === undefined ? [] : [{ kind: k }] });
      }
      if (sql.includes('FROM job_git')) {
        const g = gits[String(params[0])];
        return Promise.resolve({ rows: g === undefined ? [] : [g] });
      }
      if (sql.includes('job_titles'))
        return Promise.resolve({ rows: [{ id: JOB, title_stored: 'Fix the cart', title_prompt: null }] });
      if (sql.includes('SELECT state::text AS state FROM jobs'))
        return Promise.resolve({ rows: [{ state: over.state ?? 'SUCCEEDED' }] });
      return Promise.resolve({ rows: [] });
    },
  };
}

const textFile = (text: string, ref = MAIN, path = 'src/app.ts'): CodeFile => ({
  project: 'shop',
  source: 'repo',
  ref,
  path,
  state: 'text',
  size: text.length,
  text,
  language: 'typescript',
  redacted: false,
});

const dir = (path: string, names: [string, 'file' | 'dir'][]): TreeEntry[] =>
  names.map(([name, kind]) => ({
    name,
    path: path === '' ? name : `${path}/${name}`,
    kind,
    size: kind === 'file' ? 10 : null,
  }));

interface Calls {
  file: unknown[][];
  added: unknown[][];
  requested: unknown[][];
}

function codeService(calls: Calls, over: Partial<Record<keyof CodeService, unknown>> = {}): CodeService {
  const trees: Record<string, TreeEntry[]> = {
    '': dir('', [
      ['src', 'dir'],
      ['docs', 'dir'],
      ['README.md', 'file'],
    ]),
    src: dir('src', [
      ['routes', 'dir'],
      ['app.ts', 'file'],
    ]),
    'src/routes': dir('src/routes', [['cart-route.ts', 'file']]),
    docs: dir('docs', [['routes.md', 'file']]),
  };
  const svc = {
    file: (project: string, ref: string | undefined, path: string) => {
      calls.file.push([project, ref, path]);
      if (path === 'missing.ts') return Promise.reject(new HttpError(404, 'code_not_found', 'No such file.'));
      const lines = Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1)}`).join('\n');
      return Promise.resolve(textFile(`${lines}\n`, ref === HEAD ? HEAD : MAIN, path));
    },
    tree: (_p: string, ref: string | undefined, path: string) =>
      Promise.resolve({
        sha: ref === HEAD ? HEAD : MAIN,
        path,
        entries: trees[path] ?? [],
        truncated: false,
      }),
    jobReview: (jobId: string) =>
      jobId === JOB
        ? Promise.resolve({
            jobId,
            project: 'shop',
            baseSha: BASE,
            headSha: HEAD,
            branch: 'agent/x',
            targetBranch: 'main',
            files: [
              { path: 'src/app.ts', previousPath: null, status: 'modified', additions: 3, deletions: 1 },
            ],
            truncated: false,
            supported: true,
          })
        : Promise.reject(new HttpError(404, 'review_unavailable', 'No verified changes.')),
    pullRequests: () =>
      Promise.resolve({
        supported: true,
        items: [
          { number: 7, title: 'Add cart', compare: { base: 'main', head: HEAD } },
          { number: 8, title: 'Fork PR', compare: null },
        ],
      }),
    compare: (_p: string, base: string, head: string) =>
      Promise.resolve({
        baseSha: BASE,
        headSha: head === HEAD ? HEAD : MAIN,
        mergeBase: BASE,
        files: [{ path: 'src/cart.ts', previousPath: null, status: 'added', additions: 9, deletions: 0 }],
        truncated: false,
        base,
      }),
    comments: () => Promise.resolve([] as ReviewComment[]),
    addComment: (...a: unknown[]) => {
      calls.added.push(a);
      return Promise.resolve({});
    },
    requestChanges: (...a: unknown[]) => {
      calls.requested.push(a);
      return Promise.resolve({
        mode: 'job',
        messageId: null,
        jobId: '55555555-5555-4555-8555-555555555555',
        comments: 2,
      });
    },
    ...over,
  };
  return svc as unknown as CodeService;
}

const view = (over: Partial<IdeWorkspaceView> = {}): IdeWorkspaceView =>
  ({
    id: WS,
    project: 'shop',
    userId: USER,
    username: 'ayse',
    workerId: 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    workerName: 'linux-1',
    workerConnected: true,
    name: 'fix',
    source: 'repository',
    branch: 'remyral/ide/ayse/fix',
    state: 'running',
    head: HEAD,
    ...over,
  }) as IdeWorkspaceView;

function tools(
  over: {
    code?: Partial<Record<keyof CodeService, unknown>>;
    ide?: ChatCodeToolsDeps['ide'];
    state?: string;
  } = {},
) {
  const calls: Calls = { file: [], added: [], requested: [] };
  const t = new ChatCodeTools({
    db: db(over.state === undefined ? {} : { state: over.state }) as unknown as ChatCodeToolsDeps['db'],
    code: () => codeService(calls, over.code),
    ...(over.ide === undefined ? {} : { ide: over.ide }),
  });
  return { t, calls };
}

describe('read_code (p19-ide W4)', () => {
  it('returns numbered lines of a range, pinned to the resolved commit', async () => {
    const { t, calls } = tools();
    const r = await t.read(subject('admin'), 'read_code', {
      project: 'shop',
      path: 'src/app.ts',
      ref: 'main',
      startLine: 9,
      endLine: 11,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = (r.ok ? r.data : {}) as Record<string, unknown>;
    expect(d).toMatchObject({ commit: MAIN, ref: 'main', lines: '9-11', totalLines: 1000, state: 'text' });
    expect(d.text).toBe(' 9| line 9\n10| line 10\n11| line 11');
    expect(calls.file[0]).toEqual(['shop', 'main', 'src/app.ts']);
  });

  it('cuts at 400 lines and says where to go on; past the end is invalid', async () => {
    const { t } = tools();
    const r = await t.read(subject('admin'), 'read_code', { project: 'shop', path: 'src/app.ts' });
    const d = (r.ok ? r.data : {}) as Record<string, unknown>;
    expect(d.lines).toBe('1-400');
    expect(String(d.more)).toContain('startLine 401');
    const past = await t.read(subject('admin'), 'read_code', {
      project: 'shop',
      path: 'a.ts',
      startLine: 5000,
    });
    expect(!past.ok && past.code).toBe('invalid');
  });

  it('job = the verified head; a job of another project, a hidden project and a workspace project are refused', async () => {
    const { t, calls } = tools();
    const r = await t.read(subject('admin'), 'read_code', { project: 'shop', path: 'src/app.ts', job: JOB });
    expect(r.ok).toBe(true);
    expect(calls.file.at(-1)).toEqual(['shop', HEAD, 'src/app.ts']);
    const other = await t.read(subject('admin'), 'read_code', {
      project: 'shop',
      path: 'a.ts',
      job: OTHER_JOB,
    });
    expect(!other.ok && other.code).toBe('not_found');
    const hidden = await t.read(subject('operator', [['other', 'operator']]), 'read_code', {
      project: 'shop',
      path: 'a.ts',
    });
    expect(!hidden.ok && hidden.code).toBe('not_found');
    const ws = await t.read(subject('admin'), 'read_code', { project: 'notes', path: 'a.ts' });
    expect(!ws.ok && ws.code).toBe('invalid');
    const missing = await t.read(subject('admin'), 'read_code', { project: 'shop', path: 'missing.ts' });
    expect(!missing.ok && missing.code).toBe('not_found');
    // A project viewer reads code.
    const viewer = await t.read(subject('viewer', [['shop', 'viewer']]), 'read_code', {
      project: 'shop',
      path: 'src/app.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(viewer.ok).toBe(true);
  });
});

describe('list_code (p19-ide W4)', () => {
  it('lists a directory, and searches names breadth-first', async () => {
    const { t } = tools();
    const root = await t.read(subject('admin'), 'list_code', { project: 'shop' });
    const d = (root.ok ? root.data : {}) as { entries: { path: string }[] };
    expect(d.entries.map((e) => e.path)).toEqual(['src', 'docs', 'README.md']);
    const found = await t.read(subject('admin'), 'list_code', { project: 'shop', query: 'ROUTE' });
    const f = (found.ok ? found.data : {}) as { matches: { path: string }[]; incomplete?: string };
    expect(f.matches.map((m) => m.path).sort()).toEqual([
      'docs/routes.md',
      'src/routes',
      'src/routes/cart-route.ts',
    ]);
    expect(f.incomplete).toBeUndefined();
  });
});

describe('open_code / open_diff (p19-ide W4)', () => {
  it('open_code leaves a card pinned to the commit; the link is the viewer at the lines', async () => {
    const { t } = tools();
    const r = await t.read(subject('admin'), 'open_code', {
      project: 'shop',
      path: 'src/app.ts',
      ref: 'main',
      startLine: 40,
      endLine: 58,
    });
    expect(r.ok && r.codeCard).toEqual({
      kind: 'code',
      project: 'shop',
      path: 'src/app.ts',
      sha: MAIN,
      refLabel: 'main',
      startLine: 40,
      endLine: 58,
    });
    expect(r.ok && (r.data as { link: string }).link).toBe(
      `/projects/shop/code?ref=${MAIN}&path=src%2Fapp.ts&L=40-58`,
    );
    const bad = await t.read(subject('admin'), 'open_code', { project: 'shop', path: 'a.ts', endLine: 3 });
    expect(!bad.ok && bad.code).toBe('invalid');
  });

  it('open_diff: a job, an open pull request, two refs; a file that did not change is refused', async () => {
    const { t } = tools();
    const job = await t.read(subject('admin'), 'open_diff', { job: JOB, path: 'src/app.ts' });
    expect(job.ok && job.codeCard).toMatchObject({
      kind: 'diff',
      project: 'shop',
      job: JOB,
      path: 'src/app.ts',
      files: 1,
    });
    expect(job.ok && job.codeCard !== undefined && codeCardHref(job.codeCard)).toBe(
      `/projects/shop/code/jobs/${JOB}?path=src%2Fapp.ts`,
    );
    const notChanged = await t.read(subject('admin'), 'open_diff', { job: JOB, path: 'README.md' });
    expect(!notChanged.ok && notChanged.code).toBe('invalid');
    const pr = await t.read(subject('admin'), 'open_diff', { project: 'shop', pr: 7 });
    expect(pr.ok && pr.codeCard).toMatchObject({
      kind: 'diff',
      base: 'main',
      head: HEAD,
      pr: 7,
      title: 'Add cart',
    });
    const fork = await t.read(subject('admin'), 'open_diff', { project: 'shop', pr: 8 });
    expect(!fork.ok && fork.code).toBe('unavailable');
    const cmp = await t.read(subject('admin'), 'open_diff', {
      project: 'shop',
      base: 'main',
      head: 'feature/x',
    });
    expect(cmp.ok && cmp.codeCard !== undefined && codeCardHref(cmp.codeCard)).toBe(
      '/projects/shop/code/compare?base=main&head=feature%2Fx',
    );
    const hidden = await t.read(subject('operator', [['other', 'operator']]), 'open_diff', { job: JOB });
    expect(!hidden.ok && hidden.code).toBe('not_found');
  });
});

describe('read_workspace_diff (p19-ide W4)', () => {
  const diff: IdeGitResultPayload = {
    requestId: '66666666-6666-4666-8666-666666666666',
    workspaceId: WS,
    status: 'ok',
    branch: 'remyral/ide/ayse/fix',
    head: HEAD,
    files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
    untracked: ['notes.md'],
    diff: `diff --git a/src/app.ts b/src/app.ts\n+const token = "ghp_${'a1B2'.repeat(9)}";\n`,
  };

  it('lists the caller’s workspaces, then returns the machine’s diff redacted', async () => {
    const seen: unknown[][] = [];
    const { t } = tools({
      ide: () => ({
        workspacesFor: () => Promise.resolve([view()]),
        workspaceDiff: (...a: unknown[]) => {
          seen.push(a);
          return Promise.resolve({ ok: true as const, workspace: view(), result: diff });
        },
      }),
    });
    const list = await t.read(subject('admin'), 'read_workspace_diff', { project: 'shop' });
    expect(list.ok && (list.data as { workspaces: { id: string }[] }).workspaces[0]?.id).toBe(WS);
    const r = await t.read(subject('admin'), 'read_workspace_diff', { workspace: WS, path: 'src/app.ts' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = (r.ok ? r.data : {}) as Record<string, unknown>;
    expect(d.untracked).toEqual(['notes.md']);
    expect(String(d.diff)).not.toContain('ghp_');
    expect(d.redacted).toBeDefined();
    expect(seen[0]?.[1]).toBe(WS);
    expect(seen[0]?.[2]).toBe('src/app.ts');
  });

  it('an unknown / foreign workspace is not found; an offline or older machine is unavailable', async () => {
    const { t } = tools({
      ide: () => ({
        workspacesFor: () => Promise.resolve([]),
        workspaceDiff: (_s: Subject, id: string) =>
          Promise.resolve(
            id === WS
              ? { ok: false as const, reason: 'machine_offline', message: 'The machine is not connected.' }
              : null,
          ),
      }),
    });
    const off = await t.read(subject('admin'), 'read_workspace_diff', { workspace: WS });
    expect(!off.ok && off.code).toBe('unavailable');
    const none = await t.read(subject('admin'), 'read_workspace_diff', {
      workspace: '77777777-7777-4777-8777-777777777777',
    });
    expect(!none.ok && none.code).toBe('not_found');
    const neither = await t.read(subject('admin'), 'read_workspace_diff', {});
    expect(!neither.ok && neither.code).toBe('invalid');
    const noIde = await tools().t.read(subject('admin'), 'read_workspace_diff', { workspace: WS });
    expect(!noIde.ok && noIde.code).toBe('unavailable');
  });
});

describe('draft_review_changes (p19-ide W4)', () => {
  it('is an administration card with the console action and no step-up of its own', () => {
    expect(isOpsToolOp('code.request_changes')).toBe(true);
    expect(ADMIN_ACTION_OF['code.request_changes']).toBe('code.review');
    expect(adminOpEvent('code.request_changes')).toBe('chat.cards');
    expect(adminAlwaysFresh({ target: 'admin', op: 'code.request_changes' })).toBe(false);
  });

  it('plans a card from the assistant’s comments on changed files', async () => {
    const { t } = tools();
    const plan = await t.plan(subject('operator', [['shop', 'operator']]), {
      job: JOB,
      note: 'Keep the API stable.',
      comments: [{ path: 'src/app.ts', startLine: 4, endLine: 6, body: 'Handle the empty cart.' }],
    });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    if (!plan.ok) return;
    expect(plan.project).toBe('shop');
    expect(plan.payload).toMatchObject({
      target: 'admin',
      op: 'code.request_changes',
      event: 'chat.cards',
      jobId: JOB,
      headSha: HEAD,
      note: 'Keep the API stable.',
      comments: [
        { path: 'src/app.ts', side: 'new', startLine: 4, endLine: 6, body: 'Handle the empty cart.' },
      ],
    });
    expect(plan.payload.cardOnly).toBeUndefined();
    expect(String(plan.describe.goesTo)).toContain('follow-up job');
  });

  it('refuses a viewer, a file that did not change, and an empty review', async () => {
    const { t } = tools();
    const viewer = await t.plan(subject('viewer', [['shop', 'viewer']]), { job: JOB, note: 'x' });
    expect(!viewer.ok && viewer.code).toBe('forbidden');
    const hidden = await t.plan(subject('operator', [['other', 'operator']]), { job: JOB, note: 'x' });
    expect(!hidden.ok && hidden.code).toBe('not_found');
    const wrong = await t.plan(subject('admin'), {
      job: JOB,
      comments: [{ path: 'README.md', startLine: 1, body: 'x' }],
    });
    expect(!wrong.ok && wrong.code).toBe('invalid');
    const empty = await t.plan(subject('admin'), { job: JOB });
    expect(!empty.ok && empty.code).toBe('invalid');
  });

  it('confirmed: stores the comments (marked as the assistant’s) and runs "Değişiklik iste"', async () => {
    const { t, calls } = tools();
    const out = await t.apply(
      {
        project: 'shop',
        jobId: JOB,
        headSha: HEAD,
        note: 'Keep the API stable.',
        comments: [
          { path: 'src/app.ts', side: 'new', startLine: 4, endLine: 6, body: 'Handle the empty cart.' },
        ],
      },
      ctx,
    );
    expect(calls.added).toHaveLength(1);
    expect(calls.added[0]?.[1]).toBe(JOB);
    expect(calls.added[0]?.[2]).toEqual({
      path: 'src/app.ts',
      side: 'new',
      startLine: 4,
      endLine: 6,
      body: `${ASSISTANT_COMMENT_PREFIX}Handle the empty cart.`,
    });
    expect(calls.requested[0]?.[2]).toEqual({ note: 'Keep the API stable.' });
    expect(out).toMatchObject({
      mode: 'job',
      jobId: '55555555-5555-4555-8555-555555555555',
      reviewedJob: JOB,
      commentsAdded: 1,
    });
  });

  it('a job whose changes moved since the card is not reviewed blind', async () => {
    const { t, calls } = tools();
    await expect(
      t.apply({ project: 'shop', jobId: JOB, headSha: BASE, comments: [] }, ctx),
    ).rejects.toMatchObject({ statusCode: 409, code: 'review_outdated' });
    expect(calls.added).toHaveLength(0);
    expect(calls.requested).toHaveLength(0);
  });
});

describe('IdeService.workspaceDiff (p19-ide W4)', () => {
  const ROW = {
    id: WS,
    project: 'shop',
    user_id: USER,
    username: 'ayse',
    worker_id: 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    worker_name: 'linux-1',
    name: 'fix',
    source_kind: 'repository',
    branch: 'remyral/ide/ayse/fix',
    base_ref: 'main',
    seed_job_id: null,
    spec: null,
    revision: 1,
    desired: 'running',
    state: 'running',
    detail: null,
    stop_reason: null,
    head: HEAD,
    memory_bytes: null,
    pull_request_url: null,
    started_at: null,
    last_activity_at: null,
    last_pushed_at: null,
    status_at: null,
    created_at: new Date(),
    stopped_at: null,
  };

  async function service(
    over: { features?: string[]; online?: boolean; row?: Record<string, unknown>; intruder?: boolean } = {},
  ) {
    const { IdeService } = await import('../../src/ide/service.js');
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    let svc: InstanceType<typeof IdeService> | null = null;
    const session = {
      workerId: ROW.worker_id,
      send: (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload });
        // The machine answers at once (another connected machine that learnt the request id answers first).
        queueMicrotask(() => {
          if (over.intruder === true) {
            svc?.onGitResult({ workerId: 'wrk_bbbbbbbbbbbbbbbbbbbbbbbbbb' } as never, {
              requestId: String(payload.requestId),
              workspaceId: String(payload.workspaceId),
              status: 'ok',
              branch: 'remyral/ide/ayse/fix',
              head: HEAD,
              files: [],
              untracked: [],
              diff: 'forged',
            });
          }
          svc?.onGitResult(session as never, {
            requestId: String(payload.requestId),
            workspaceId: String(payload.workspaceId),
            status: 'ok',
            branch: 'remyral/ide/ayse/fix',
            head: HEAD,
            files: [],
            untracked: [],
            diff: '',
          });
        });
        return Promise.resolve();
      },
    };
    svc = new IdeService({
      pool: {
        query: (sql: string) => {
          if (sql.includes('FROM ide_workspaces'))
            return Promise.resolve({ rows: [{ ...ROW, ...over.row }] });
          if (sql.includes('SELECT features FROM workers'))
            return Promise.resolve({ rows: [{ features: over.features ?? ['ide-v1', 'ide-diff-v1'] }] });
          return Promise.resolve({ rows: [] });
        },
      },
      clock: () => new Date('2026-10-29T10:00:00.000Z'),
      session: () => (over.online === false ? undefined : session),
      signer: { signIdeGit: (b: unknown) => ({ kid: 'k', signature: JSON.stringify(b) }) },
      origin: () => null,
    } as never);
    return { svc, sent };
  }

  it('sends a signed IDE_GIT diff with the path and returns the answer', async () => {
    const { svc, sent } = await service();
    const out = await svc.workspaceDiff(subject('operator', [['shop', 'operator']]), WS, 'src/app.ts');
    expect(out?.ok).toBe(true);
    expect(sent[0]?.type).toBe('IDE_GIT');
    expect(sent[0]?.payload).toMatchObject({ op: 'diff', path: 'src/app.ts', workspaceId: WS });
    // The path is part of the signed binding.
    expect(JSON.parse((sent[0]?.payload.signature as { signature: string }).signature)).toMatchObject({
      op: 'diff',
      path: 'src/app.ts',
    });
  });

  it('an answer from a machine the request was not sent to is ignored', async () => {
    const { svc } = await service({ intruder: true });
    const out = await svc.workspaceDiff(subject('operator', [['shop', 'operator']]), WS, undefined);
    expect(out?.ok).toBe(true);
    expect(out?.ok === true ? out.result.diff : null).toBe('');
  });

  it('someone else’s workspace is not found unless ide.manage; old / offline machines and files workspaces are refused', async () => {
    const other = await service({ row: { user_id: '99999999-9999-4999-8999-999999999999' } });
    expect(
      await other.svc.workspaceDiff(subject('operator', [['shop', 'operator']]), WS, undefined),
    ).toBeNull();
    expect((await other.svc.workspaceDiff(subject('admin'), WS, undefined))?.ok).toBe(true);
    const old = await service({ features: ['ide-v1'] });
    expect(await old.svc.workspaceDiff(subject('admin'), WS, undefined)).toMatchObject({
      ok: false,
      reason: 'machine_update',
    });
    expect(old.sent).toHaveLength(0);
    const off = await service({ online: false });
    expect(await off.svc.workspaceDiff(subject('admin'), WS, undefined)).toMatchObject({
      ok: false,
      reason: 'machine_offline',
    });
    const files = await service({ row: { source_kind: 'files' } });
    expect(await files.svc.workspaceDiff(subject('admin'), WS, undefined)).toMatchObject({
      ok: false,
      reason: 'no_repository',
    });
  });
});
