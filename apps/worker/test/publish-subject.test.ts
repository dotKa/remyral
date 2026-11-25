import { describe, expect, it } from 'vitest';
import { publishAttempt, type PublishPort } from '../src/workspace/publish.js';
import type { CommitRequest, Workspace } from '../src/workspace/manager.js';

/** p15-job-titles (docs/design/p15-job-titles.md §5): the subject of the worker's publish commit. */
describe('publish commit subject', () => {
  const ws = { jobId: 'job-1', attemptId: 'att-1', epoch: 1, path: '/tmp/x' } as unknown as Workspace;

  async function messageOf(input: Parameters<typeof publishAttempt>[2]): Promise<string> {
    let seen: CommitRequest | null = null;
    const port: PublishPort = {
      commit: (_w, req) => {
        seen = req;
        return Promise.resolve('a'.repeat(40));
      },
      push: () => Promise.resolve({ sha: 'a'.repeat(40), branch: 'rac/job-1/att-1' } as never),
    };
    await publishAttempt(port, ws, input);
    return (seen as CommitRequest | null)?.message ?? '';
  }

  it('is the job title, with the summary and the job in the body', async () => {
    const m = await messageOf({
      summary: 'Fixed the redirect and added a test\nmore detail',
      jobPrompt: 'Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uzun açıklama…',
      jobTitle: 'SampleWebApp: Coolify deploy dalı hazırla',
    });
    const [subject, , body] = m.split('\n');
    expect(subject).toBe('SampleWebApp: Coolify deploy dalı hazırla');
    expect(body).toBe('Fixed the redirect and added a test');
    expect(m).toContain('Remyral job job-1, attempt att-1.');
  });

  it('keeps the older subject when the master sent no title', async () => {
    const m = await messageOf({ summary: 'Did it', jobPrompt: 'Long prompt line\nmore' });
    expect(m.startsWith('remyral: Did it\n\nJob job-1, attempt att-1.')).toBe(true);
    const fromPrompt = await messageOf({ summary: '', jobPrompt: 'Fix the login bug\nmore' });
    expect(fromPrompt.startsWith('remyral: Fix the login bug')).toBe(true);
  });

  it('never exceeds 72 characters in the subject', async () => {
    const m = await messageOf({ summary: '', jobPrompt: 'p', jobTitle: 'w'.repeat(60) });
    expect((m.split('\n')[0] ?? '').length).toBeLessThanOrEqual(72);
  });
});
