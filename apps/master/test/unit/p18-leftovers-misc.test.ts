import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { describe, expect, it } from 'vitest';
import { planNotice } from '../../src/chat/plan-notify.js';
import { CodeService, redactKeepingLines } from '../../src/code/service.js';
import { GitFlowService } from '../../src/gitflow/service.js';
import type { GitProvider, OpenPullRequest } from '../../src/gitflow/types.js';
import { planSearchText } from '../../src/search/chat-text.js';

/**
 * p18-leftovers items 4 and 6 (docs/design/p18-leftovers.md): the plan's "ready for review" notification and searchable
 * text; the code viewer's line-keeping redaction, a follow-up job's target branch and the Kod tab's open pull requests.
 */

const SHA = 'a'.repeat(40);

describe('plans: ready for review and the searchable text', () => {
  it('a new plan notifies its owner once (by plan), in their language', () => {
    const tr = planNotice(
      'ready',
      'tr',
      { planId: 'p1', title: 'Yayın planı' },
      { occurrence: 'v1', count: 4 },
    );
    expect(tr).toMatchObject({ severity: 'info', dedupeKey: 'chat.plan:p1:ready:v1' });
    expect(tr.title).toBe('Plan incelemeni bekliyor: Yayın planı');
    expect(tr.body).toContain('4 maddelik');
    const en = planNotice('ready', 'en', { planId: 'p1', title: 'Release plan' }, { occurrence: 'v1' });
    expect(en.title).toBe('Your plan is ready for review: Release plan');
  });

  it('title, goal, phases and items in order; never notes or answers', () => {
    const text = planSearchText({ title: 'Move the archive', goal: 'Files live in the new store' }, [
      { phase: 1, phaseTitle: 'Switch', position: 0, title: 'Point readers to the new store', detail: null },
      { phase: 0, phaseTitle: 'Prepare', position: 1, title: 'Copy the files', detail: 'Checksums too' },
      { phase: 0, phaseTitle: 'Prepare', position: 0, title: 'List the files', detail: '  ' },
    ]);
    expect(text).toBe(
      [
        'Move the archive',
        'Files live in the new store',
        '',
        'Prepare',
        '- List the files',
        '- Copy the files: Checksums too',
        '',
        'Switch',
        '- Point readers to the new store',
      ].join('\n'),
    );
  });
});

describe('code viewer: redaction keeps the line numbers', () => {
  const redactor = new Redactor({ rules: DEFAULT_RULES });
  it('a multi-line secret is masked line by line; single-line ones as before', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
      'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const text = ['const a = 1;', key, 'const b = 2;'].join('\n');
    const out = redactKeepingLines(redactor, text);
    const lines = out.split('\n');
    expect(lines).toHaveLength(text.split('\n').length);
    expect(lines[0]).toBe('const a = 1;');
    expect(lines[5]).toBe('const b = 2;');
    expect(out).not.toContain('MIIEow');
    for (const l of lines.slice(1, 5)) expect(l).toMatch(/\[REDACTED:/);
    // The plain redactor collapses the key into one marker (the old behaviour this replaces).
    expect(redactor.redact(text).split('\n').length).toBeLessThan(lines.length);
    expect(redactKeepingLines(redactor, 'nothing secret\nhere')).toBe('nothing secret\nhere');
  });
});

describe('a follow-up job keeps its original target branch', () => {
  const config = { baseBranch: 'main' } as never;
  it('an explicit targetBranch wins over a commit baseRef; otherwise as before', () => {
    const spec = (repository: Record<string, unknown>) => ({ spec: { repository } }) as never;
    expect(GitFlowService.targetBranch(spec({ baseRef: SHA, targetBranch: 'develop' }), config)).toBe(
      'develop',
    );
    expect(GitFlowService.targetBranch(spec({ baseRef: SHA }), config)).toBe('main');
    expect(GitFlowService.targetBranch(spec({ baseRef: 'release/2' }), config)).toBe('release/2');
    // A target that is itself a commit is ignored.
    expect(GitFlowService.targetBranch(spec({ baseRef: SHA, targetBranch: SHA }), config)).toBe('main');
  });
});

describe('the Kod tab’s open pull requests', () => {
  const pr = (over: Partial<OpenPullRequest>): OpenPullRequest => ({
    number: 1,
    title: 'Add billing',
    url: 'https://github.com/acme/app/pull/1',
    author: 'dev',
    draft: false,
    baseBranch: 'main',
    headBranch: 'feature/billing',
    headSha: SHA,
    sameRepository: true,
    updatedAt: '2026-10-28T10:00:00Z',
    ...over,
  });
  function service(list: OpenPullRequest[] | undefined) {
    let calls = 0;
    const provider = {
      kind: 'github',
      tree: () => Promise.resolve(null),
      blob: () => Promise.resolve(null),
      ...(list === undefined
        ? {}
        : {
            openPullRequests: () => {
              calls++;
              return Promise.resolve(list);
            },
          }),
    } as unknown as GitProvider;
    const svc = new CodeService({
      pool: { query: () => Promise.resolve({ rows: [] }) } as never,
      audit: { record: () => Promise.resolve() } as never,
      providers: () => ({
        providerFor: () => Promise.resolve({ provider, config: { baseBranch: 'main', version: 1 } as never }),
      }),
      clock: () => new Date('2026-10-28T12:00:00Z'),
    });
    return { svc, calls: () => calls };
  }

  it('each opens a compare of its base and head (a fork by its head commit); titles are redacted', async () => {
    const { svc, calls } = service([
      pr({}),
      pr({ number: 2, sameRepository: false, headBranch: 'main', headSha: 'b'.repeat(40) }),
      pr({ number: 3, sameRepository: false, headSha: null }),
      pr({ number: 4, title: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', url: 'javascript:alert(1)' }),
    ]);
    const out = await svc.pullRequests('acme');
    expect(out.supported).toBe(true);
    expect(out.items.map((i) => i.compare)).toEqual([
      { base: 'main', head: SHA },
      { base: 'main', head: 'b'.repeat(40) },
      null,
      { base: 'main', head: SHA },
    ]);
    expect(out.items[3]?.title).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out.items[3]?.url).toBeNull();
    // Cached for a minute.
    await svc.pullRequests('acme');
    expect(calls()).toBe(1);
  });

  it('a provider without a listing says so', async () => {
    expect(await service(undefined).svc.pullRequests('acme')).toEqual({ supported: false, items: [] });
  });
});
