import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { ChatAttachments } from '../../src/chat/attachments.js';
import { prepareChatInputs } from '../../src/chat/inputs.js';
import type { Queryable } from '../../src/db/pool.js';
import { HttpError } from '../../src/http/errors.js';
import {
  assertRepoInputsReady,
  repoInputsMachines,
  repoInputsUpdateError,
} from '../../src/jobs/repo-inputs.js';

/**
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): chat attachments, earlier outputs and continueFrom for
 * REPOSITORY projects — accepted once a machine advertises `repo-inputs-v1`, else a clear "update the machine"
 * refusal; the attachments note for assistants without `assistant-repo-inputs-v1`.
 */

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A Queryable answering by SQL fragment (first match wins); records every call. */
function fakeDb(answers: readonly (readonly [string, unknown[]])[]): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const hit = answers.find(([frag]) => sql.includes(frag));
      return Promise.resolve({ rows: hit?.[1] ?? [], rowCount: hit?.[1].length ?? 0 });
    },
  } as unknown as Queryable & { calls: Call[] };
}

const subject: Subject = { userId: 'u1', role: 'operator', memberships: new Map() };
const reasonOf = (err: unknown): unknown => (err instanceof HttpError ? err.params.reason : undefined);

describe('repo-inputs-v1 readiness', () => {
  it('counts approved, live machines that advertise repo-inputs-v1', async () => {
    const db = fakeDb([['FROM workers', [{ n: 2 }]]]);
    expect(await repoInputsMachines(db)).toBe(2);
    const call = db.calls[0];
    expect(call?.sql).toMatch(/features \? \$1/);
    expect(call?.sql).toMatch(/approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL/);
    expect(call?.params).toEqual(['repo-inputs-v1']);
    await expect(assertRepoInputsReady(db)).resolves.toBeUndefined();
  });

  it('none: 400 invalid_job, reason inputs_worker_update, "makine güncellenmeli"', async () => {
    const db = fakeDb([['FROM workers', [{ n: 0 }]]]);
    const err = await assertRepoInputsReady(db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 400, code: 'invalid_job' });
    expect(reasonOf(err)).toBe('inputs_worker_update');
    expect((err as HttpError).publicMessage).toContain('repo-inputs-v1');
    expect((err as HttpError).publicMessage).toContain('makine güncellenmeli');
    expect(repoInputsUpdateError().publicMessage).toBe((err as HttpError).publicMessage);
  });
});

describe('prepareChatInputs for repository projects', () => {
  it('no refs: nothing is read', async () => {
    const db = fakeDb([]);
    expect(await prepareChatInputs(db, subject, 'alpha', {})).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('a repository project without a repo-inputs-v1 machine is refused with the update message', async () => {
    const db = fakeDb([
      ['SELECT kind FROM projects', [{ kind: 'repository' }]],
      ['FROM workers', [{ n: 0 }]],
    ]);
    const err = await prepareChatInputs(db, subject, 'alpha', { chatAttachments: ['a'] }, 't').catch(
      (e: unknown) => e,
    );
    expect(reasonOf(err)).toBe('inputs_worker_update');
    expect((err as HttpError).publicMessage).toContain('makine güncellenmeli');
  });

  it('with such a machine the repository project gets past the kind check (then the usual source checks apply)', async () => {
    const db = fakeDb([
      ['SELECT kind FROM projects', [{ kind: 'repository' }]],
      ['FROM workers', [{ n: 1 }]],
      ['SELECT project FROM jobs', []],
    ]);
    const err = await prepareChatInputs(
      db,
      subject,
      'alpha',
      { continueFrom: '00000000-0000-4000-8000-000000000001' },
      't',
    ).catch((e: unknown) => e);
    // The source job is not visible → 404 like POST /jobs, never the old "workspace projects only" refusal.
    expect(err).toMatchObject({ statusCode: 404, code: 'job_not_found' });
    expect(db.calls.some((c) => c.sql.includes('SELECT project FROM jobs'))).toBe(true);
  });

  it('an unknown project kind keeps a refusal (inputs_project)', async () => {
    const db = fakeDb([['SELECT kind FROM projects', []]]);
    const err = await prepareChatInputs(db, subject, 'nope', { chatAttachments: ['a'] }, 't').catch(
      (e: unknown) => e,
    );
    expect(reasonOf(err)).toBe('inputs_project');
    expect(db.calls.some((c) => c.sql.includes('FROM workers'))).toBe(false);
  });
});

describe('the attachments note (assistant-repo-inputs-v1 gate)', () => {
  const atts = [
    {
      id: 'a1',
      kind: 'image' as const,
      name: 'shot.png',
      mediaType: 'image/png',
      sizeBytes: 10,
    },
  ];
  const svc = new ChatAttachments({} as unknown as ConstructorParameters<typeof ChatAttachments>[0]);
  const noteOf = (block: string | undefined): string =>
    /"note":\s*"((?:[^"\\]|\\.)*)"/.exec(block ?? '')?.[1] ?? '';

  it('an assistant with the rule gets the short note naming repository projects', async () => {
    const [block] = await svc.contextBlocks(atts as never, 1000, { repoInputsRule: true });
    const note = noteOf(block);
    expect(note).toContain('workspace or repository project');
    expect(note).not.toContain('outdated');
  });

  it('an older assistant is told explicitly that repository projects work now', async () => {
    const [block] = await svc.contextBlocks(atts as never, 1000);
    const note = noteOf(block);
    expect(note).toContain('workspace AND repository projects');
    expect(note).toContain('outdated');
    expect(note).toContain('Never refuse because the project is a repository project');
  });
});
