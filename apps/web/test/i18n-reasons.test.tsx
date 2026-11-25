// p14-i18n-reasons (i18n Phase 4): reasons are said from their code + params through the `reasons` catalog of
// @remyral/i18n in the reader's language. New producers (scheduler, master fleet view, worker JOB_RESULT) send
// `params.cause`; the English text decides only for reasons recorded before this release (LEGACY fallback).
import { render, screen } from '@testing-library/react';
import { messagesFor, reasonCodes, reasonVariants } from '@remyral/i18n';
import { REASON_CAUSES } from '@remyral/protocol/reasons';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { parseRunErrors, transitionReasonParams, type JobDetail } from '../src/api/jobs';
import { DyReason } from '../src/diyalog/common/notices';
import { jobAuthOf } from '../src/diyalog/screens/machines/tabs/runtimes-auth';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { describeReason, KNOWN_REASON_CODES, legacyReasonCause, reasonParamsField } from '../src/lib/reasons';

const ctx = { workerId: 'w1', workerName: 'pc', runtime: 'claude-code' };

describe('new producers: the sentence comes from code + params (no English text needed)', () => {
  it('runtime_not_authenticated + cause login_wait (scheduler)', () => {
    const p = { cause: 'login_wait', until: '2026-10-18T08:30:00.000Z' };
    // The message carries no English hint at all: only the cause decides.
    const tr = describeReason('runtime_not_authenticated', ctx, { locale: 'tr', params: p });
    expect(tr.cause).toBe('login_wait');
    expect(tr.sentence).toBe(
      'Claude Code pc makinesinde yeniden giriş bekliyor — iş bekler ve sen yeniden giriş yapınca kendiliğinden başlar.',
    );
    expect(tr.action).toEqual({ label: 'Yeniden giriş yap', href: '/machines?worker=w1&section=remote-ops' });
    const en = describeReason('runtime_not_authenticated', ctx, { locale: 'en', params: p });
    expect(en.sentence).toBe(
      'Claude Code needs a login on pc — the job waits and starts by itself once you log in again.',
    );
    expect(en.action?.label).toBe('Log in again');
  });

  it('not_authenticated + cause no_job_auth / job_auth_secret_ref (master fleet view): configuration is the fix', () => {
    const none = describeReason('not_authenticated: not authenticated', ctx, {
      locale: 'tr',
      params: { cause: 'no_job_auth' },
    });
    expect(none.sentence).toBe(
      'pc makinesinde Claude Code işleri için bir kimlik doğrulama yöntemi seçilmemiş, bu yüzden işler abonelik oturumunu kullanmıyor.',
    );
    expect(none.action).toEqual({
      label: 'Yapılandırmayı aç',
      href: '/machines?worker=w1&section=configuration',
    });
    const key = describeReason('not_authenticated', ctx, { params: { cause: 'job_auth_secret_ref' } });
    expect(key.sentence).toBe(
      'Claude Code jobs on pc use an API key that is not available there, not its subscription login.',
    );
    expect(key.action?.label).toBe('Open configuration');
  });

  it('login_refresh_contention + cause run_again (worker JOB_RESULT) vs the bare code of a login report', () => {
    const lost = describeReason('login_refresh_contention: x', ctx, {
      locale: 'tr',
      params: { cause: 'run_again' },
    });
    expect(lost.sentence).toBe(
      'pc makinesinde başka bir Claude Code süreci o anda aynı girişi yeniliyordu, bu yüzden bu çalışma başlayamadı. Giriş sağlam — işi yeniden çalıştır.',
    );
    const report = describeReason('login_refresh_contention', ctx, { locale: 'en' });
    expect(report.cause).toBeNull();
    expect(report.sentence).toContain('Two Claude Code runs on pc refreshed the shared subscription login');
  });

  it('params win over the text; an unknown cause says the default sentence (never the message)', () => {
    const r = describeReason(
      'not_authenticated: not authenticated: no sign-in method is configured for jobs on this machine',
      ctx,
      { params: { cause: 'job_auth_secret_ref' } },
    );
    expect(r.cause).toBe('job_auth_secret_ref');
    const unknown = describeReason('login_expired: whatever', ctx, { params: { cause: 'brand_new_cause' } });
    expect(unknown.cause).toBeNull();
    expect(unknown.sentence).toBe('The Claude Code login on pc has expired.');
  });

  it('a plain code needs no params, in both languages; unknown codes stay raw', () => {
    expect(describeReason('offline', { workerName: 'pc' }, { locale: 'tr' }).sentence).toBe(
      'pc makinesi çevrim dışı.',
    );
    expect(describeReason('offline', { workerName: 'pc' }).sentence).toBe('pc is offline.');
    // Glossary: "makine", not "worker", in Turkish copy (was "fazla eski bir worker").
    expect(describeReason('mcp_unsupported', { workerName: 'pc' }, { locale: 'tr' }).sentence).toBe(
      'pc makinesi dış MCP sunucularıyla iş almak için fazla eski bir sürüm çalıştırıyor. Makineyi güncelle.',
    );
    const raw = describeReason('frobnicator_jammed: jammed', ctx, { locale: 'tr' });
    expect(raw.known).toBe(false);
    expect(raw.sentence).toBe('frobnicator_jammed: jammed');
  });
});

describe('old workers / history: the LEGACY text fallback (removable next release)', () => {
  it('reads the variant from the English text only when no cause came', () => {
    expect(
      legacyReasonCause('login_refresh_contention', 'the login itself was not changed - run the job again'),
    ).toBe('run_again');
    expect(legacyReasonCause('login_expired', 'another process was refreshing it at the same time')).toBe(
      'shared_refresh_race',
    );
    expect(
      legacyReasonCause('runtime_not_authenticated', 'Codex needs a login on w1 — waiting (until 2026'),
    ).toBe('login_wait');
    expect(
      legacyReasonCause('not_authenticated', 'jobs on this machine use an API key (secret-ref) that'),
    ).toBe('job_auth_secret_ref');
    expect(legacyReasonCause('offline', 'anything')).toBeNull();
    const old = describeReason(
      'login_refresh_contention: another runtime process of the same subscription login was refreshing it at the same moment, so this run could not start; the login itself was not changed - run the job again',
      ctx,
      { locale: 'tr' },
    );
    expect(old.cause).toBe('run_again');
    expect(old.sentence).toContain('Giriş sağlam — işi yeniden çalıştır.');
  });
});

describe('the catalog matches the protocol', () => {
  it('every REASON_CAUSES cause has a variant in TR and EN, and nothing else has variants', () => {
    for (const locale of ['tr', 'en'] as const) {
      const t = messagesFor(locale);
      for (const [code, causes] of Object.entries(REASON_CAUSES))
        expect(reasonVariants(t, code).sort(), `${locale} ${code}`).toEqual([...causes].sort());
      for (const code of reasonCodes(t))
        if (!Object.hasOwn(REASON_CAUSES, code)) expect(reasonVariants(t, code), code).toEqual([]);
    }
    expect(reasonCodes(messagesFor('en')).sort()).toEqual([...KNOWN_REASON_CODES].sort());
  });

  it('API params are bounded (client-safe primitives only)', () => {
    expect(reasonParamsField({ cause: 'run_again', n: 2 })).toEqual({ params: { cause: 'run_again', n: 2 } });
    expect(reasonParamsField({ 'bad key': 'x', cause: 'y'.repeat(201), ok: true })).toEqual({});
    expect(reasonParamsField(null)).toEqual({});
    expect(reasonParamsField(['cause'])).toEqual({});
  });
});

describe('job failures: the attempt’s JOB_RESULT error params reach the failing step', () => {
  const orchestration = {
    runs: [
      { attemptId: 'a1', resultError: { code: 'login_refresh_contention', params: { cause: 'run_again' } } },
      { attemptId: 'a2', resultError: null },
      { attemptId: 'a3', resultError: { code: 'run_failed' } },
    ],
  };
  it('parses runs[].resultError and matches a step by attempt and code', () => {
    const runErrors = parseRunErrors(orchestration);
    expect(runErrors).toEqual([
      { attemptId: 'a1', code: 'login_refresh_contention', params: { cause: 'run_again' } },
      { attemptId: 'a3', code: 'run_failed' },
    ]);
    const detail: Pick<JobDetail, 'runErrors'> = { runErrors };
    expect(
      transitionReasonParams(detail, { reason: 'login_refresh_contention: another …', attemptId: 'a1' }),
    ).toEqual({ cause: 'run_again' });
    // Another attempt, another code, an older master (no attempt id): no params.
    expect(
      transitionReasonParams(detail, { reason: 'login_refresh_contention: x', attemptId: 'a3' }),
    ).toBeUndefined();
    expect(transitionReasonParams(detail, { reason: 'run_failed: x', attemptId: 'a1' })).toBeUndefined();
    expect(
      transitionReasonParams(detail, { reason: 'login_refresh_contention: x', attemptId: null }),
    ).toBeUndefined();
    expect(parseRunErrors(undefined)).toEqual([]);
  });
});

describe('rendering', () => {
  const frame = (ui: ReactNode, locale: 'tr' | 'en'): ReturnType<typeof render> =>
    render(
      <MemoryRouter>
        <I18nProvider locale={locale}>{ui}</I18nProvider>
      </MemoryRouter>,
    );

  it('DyReason speaks the user’s language and uses the params', () => {
    frame(<DyReason reason="not_authenticated" context={ctx} params={{ cause: 'no_job_auth' }} />, 'en');
    expect(
      screen.getByText(
        'No sign-in method is chosen for Claude Code jobs on pc, so jobs do not use its subscription login.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open configuration' })).toBeTruthy();
  });

  it('DyReason in Turkish by default', () => {
    frame(<DyReason reason="runtime_not_installed: codex missing" context={{ runtime: 'codex' }} />, 'tr');
    expect(screen.getByText('Codex bu makinede kurulu değil.')).toBeTruthy();
  });

  it('the machine’s job auth comes from the cell’s cause (text only for an older master)', () => {
    const cell = {
      runtime: 'claude-code',
      status: 'not_authenticated',
      version: '2.1',
      reason: 'not authenticated',
    };
    expect(jobAuthOf(null, 'claude-code', { ...cell, params: { cause: 'no_job_auth' } })).toBe('none');
    expect(jobAuthOf(null, 'claude-code', { ...cell, params: { cause: 'job_auth_secret_ref' } })).toBe(
      'secret-ref',
    );
    expect(jobAuthOf(null, 'claude-code', cell)).toBe('unknown');
    expect(
      jobAuthOf(null, 'claude-code', {
        ...cell,
        reason: 'not authenticated: no sign-in method is configured for jobs on this machine',
      }),
    ).toBe('none');
  });
});
