import { describe, expect, it } from 'vitest';
import { causeText, reasonCode, UNVERIFIABLE_CAUSES, verifierFailureCause } from '../../src/verify/causes.js';
import { followCheckedJobs, platformMarker } from '../../src/verify/platform-marker.js';
import { platformJobTitle } from '../../src/verify/report-only.js';
import { verifierSpec } from '../../src/verify/verifier-job.js';

/** p19-verifier-jobs (docs/design/p19-verifier-jobs.md): titles, the platform marker and the could-not-run causes. */

const PROD_FAILURE =
  "GitCommandError: git fetch failed (exit 128): fatal: could not read Username for 'https://github.com': terminal prompts disabled";

describe('platform job titles', () => {
  it('names the checked thing, ≤ 60 characters, never the verifier prompt', () => {
    expect(platformJobTitle('verify', 'Bahar indirimi sayfası')).toBe('Doğrula: Bahar indirimi sayfası');
    expect(platformJobTitle('health', 'shop.example.com')).toBe('Sağlık kontrolü: shop.example.com');
    expect(platformJobTitle('integration-verify', 'Ödeme akışı')).toBe(
      'Entegrasyon doğrulaması: Ödeme akışı',
    );
    expect(platformJobTitle('verify', null)).toBe('Doğrula');
    expect(platformJobTitle('verify', ' \n ')).toBe('Doğrula');
    const long = platformJobTitle('verify', 'a very long job title that goes on and on well past the limit');
    expect(Array.from(long).length).toBeLessThanOrEqual(60);
    expect(long.startsWith('Doğrula: a very long')).toBe(true);
  });

  it('the verifier spec carries the title', () => {
    const spec = verifierSpec({
      project: 'genel',
      creator: 'u',
      parentSpec: { runtime: 'codex', sandboxProfile: 'container', approvalPolicy: 'ask-sensitive' },
      runtime: 'codex',
      priority: 0,
      purpose: 'verify',
      subject: 'Landing page',
      checklist: {
        type: 'site',
        jobId: '00000000-0000-4000-8000-000000000001',
        projectKind: 'workspace',
        siteDirectory: null,
        bundleInput: true,
        testCommand: null,
        browser: false,
      },
    });
    expect(spec.title).toBe('Doğrula: Landing page');
    expect(String(spec.prompt)).toContain('VERIFIER');
  });
});

describe('could-not-run causes', () => {
  it('the production failure (a private repository, no credential) is git_auth, said in plain words', () => {
    expect(reasonCode(PROD_FAILURE)).toBe('GitCommandError');
    const cause = verifierFailureCause('FAILED', { code: reasonCode(PROD_FAILURE), message: PROD_FAILURE });
    expect(cause).toBe('git_auth');
    expect(causeText(cause, 'github')).toBe('repo okunamadı (GitHub kimlik bilgisi yok)');
    expect(causeText(cause, null)).toBe('repo okunamadı (git kimlik bilgisi yok)');
  });

  it('other ends', () => {
    expect(verifierFailureCause('CANCELLED', null)).toBe('cancelled');
    expect(verifierFailureCause('LOST', null)).toBe('machine_lost');
    expect(verifierFailureCause('FAILED', null)).toBe('run_failed');
    expect(
      verifierFailureCause('FAILED', { code: 'max_duration_exceeded', message: 'max_duration_exceeded: x' }),
    ).toBe('timeout');
    expect(verifierFailureCause('FAILED', { code: null, message: 'the tests do not pass' })).toBe(
      'run_failed',
    );
    for (const c of UNVERIFIABLE_CAUSES) {
      expect(c).toMatch(/^[a-z_]{1,32}$/);
      expect(causeText(c, 'gitlab')).not.toBe('');
    }
  });
});

describe('platform marker', () => {
  const raw = (o: Record<string, unknown>) => ({
    purpose: 'verify',
    checkedJobId: 'c1',
    checkedTitle: 'T',
    verification: null,
    errorCause: null,
    health: null,
    ...o,
  });

  it('an ordinary job has none; odd values read as none', () => {
    expect(platformMarker(null, 'FAILED')).toBeNull();
    expect(platformMarker({ purpose: 'deploy' }, 'FAILED')).toBeNull();
  });

  it('the checked job’s verification decides the outcome, not the verifier’s own state', () => {
    expect(platformMarker(raw({ verification: 'passed' }), 'SUCCEEDED')?.outcome).toBe('verified');
    expect(platformMarker(raw({ verification: 'warned' }), 'SUCCEEDED')?.outcome).toBe('verified');
    expect(platformMarker(raw({ verification: 'failed' }), 'SUCCEEDED')?.outcome).toBe('issues');
    expect(platformMarker(raw({ verification: 'verifying' }), 'RUNNING')?.outcome).toBe('running');
    const error = platformMarker(raw({ verification: 'error', errorCause: 'git_auth' }), 'FAILED');
    expect(error).toEqual({
      purpose: 'verify',
      checkedJobId: 'c1',
      checkedTitle: 'T',
      outcome: 'unverifiable',
      errorCause: 'git_auth',
    });
  });

  it('without a record (integration verifier, a retried verification): the verifier’s own end', () => {
    const p = (state: string) =>
      platformMarker({ purpose: 'integration-verify', checkedJobId: null }, state)?.outcome;
    expect(p('FAILED')).toBe('unverifiable');
    expect(p('CANCELLED')).toBe('unverifiable');
    expect(p('QUEUED')).toBe('running');
    expect(p('SUCCEEDED')).toBeNull();
    expect(platformMarker({ purpose: 'health', health: 'failed' }, 'SUCCEEDED')?.outcome).toBe('issues');
  });
});

describe('plan items follow the checked job', () => {
  it('a linked verifier reads as the job it checks; other links are unchanged', () => {
    const rows = [
      { id: 'checked', state: 'SUCCEEDED', summary: 'done' },
      { id: 'plain', state: 'FAILED', summary: null },
    ];
    expect(
      followCheckedJobs(['verifier', 'plain', 'gone'], new Map([['verifier', 'checked']]), rows),
    ).toEqual([
      { id: 'verifier', state: 'SUCCEEDED', summary: 'done' },
      { id: 'plain', state: 'FAILED', summary: null },
    ]);
  });
});
