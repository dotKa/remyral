// p14-i18n-errors (i18n Phase 3, ADR-0053 §5): the master's error code + params said in the user's language in
// Diyalog; the master's English message for an unknown code (an older or newer master) and for a code a domain error
// reuses with its own sentence; the classic console keeps showing the master's message.
import { render, renderHook, screen } from '@testing-library/react';
import type { Locale } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ApiError, apiRequest, paramsOf } from '../src/api/client';
import { ApiErrorNotice } from '../src/components/ui';
import { DyApiError } from '../src/diyalog/common/notices';
import { useIdentityIssueText } from '../src/diyalog/screens/shared/GitIdentity';
import { errorText } from '../src/i18n/errors';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { DiyalogTextScope } from '../src/i18n/scope';
import { messagesFor } from '@remyral/i18n';
import { fakeFetch } from './helpers';

function inDiyalog(locale: Locale, ui: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nProvider locale={locale}>
        <DiyalogTextScope>{ui}</DiyalogTextScope>
      </I18nProvider>
    </MemoryRouter>,
  );
}

function inClassic(locale: Locale, ui: ReactNode) {
  return render(
    <MemoryRouter>
      <I18nProvider locale={locale}>{ui}</I18nProvider>
    </MemoryRouter>,
  );
}

const body = (error: string, message: string, params?: Record<string, unknown>) => ({
  error,
  message,
  ...(params === undefined ? {} : { params }),
});

const tooLarge = new ApiError(
  413,
  'attachment_too_large',
  'notes.md: larger than 2048 KiB.',
  null,
  [],
  body('attachment_too_large', 'notes.md: larger than 2048 KiB.', { name: 'notes.md', maxKib: 2048 }),
);

const shown = (): string => screen.getByTestId('api-error').textContent;

describe('master errors in Diyalog', () => {
  it('a code with params, in Turkish and in English', () => {
    const r = inDiyalog('tr', <DyApiError error={tooLarge} />);
    expect(shown()).toBe('notes.md: 2.048 KiB sınırından büyük.');
    r.unmount();
    inDiyalog('en', <DyApiError error={tooLarge} />);
    expect(shown()).toBe('notes.md: larger than 2,048 KiB.');
  });

  it('params.reason picks the variant of a shared code', () => {
    const e = new ApiError(
      404,
      'not_found',
      'Project not found.',
      null,
      [],
      body('not_found', 'Project not found.', { reason: 'project' }),
    );
    inDiyalog('tr', <DyApiError error={e} />);
    expect(shown()).toBe('Proje bulunamadı.');
  });

  it('a code without params is translated when its English sentence is the master’s message', () => {
    inDiyalog('tr', <DyApiError error={new ApiError(401, 'invalid_credentials', 'Invalid credentials.')} />);
    expect(shown()).toBe('Giriş bilgileri geçersiz.');
  });

  it('unknown code, unknown variant, missing value → the master’s message as it is', () => {
    const t = messagesFor('tr');
    expect(errorText(t, 'tr', new ApiError(409, 'brand_new', 'A newer master says this.'))).toBe(
      'A newer master says this.',
    );
    const variant = new ApiError(
      404,
      'not_found',
      'Gizmo not found.',
      null,
      [],
      body('not_found', 'Gizmo not found.', { reason: 'gizmo' }),
    );
    expect(errorText(t, 'tr', variant)).toBe('Gizmo not found.');
    const partial = new ApiError(
      413,
      'attachment_too_large',
      'a.md: larger than 1 KiB.',
      null,
      [],
      body('x', 'y', { name: 'a.md' }),
    );
    expect(errorText(t, 'tr', partial)).toBe('a.md: larger than 1 KiB.');
  });

  it('a code a domain error reuses with its own sentence keeps that sentence', () => {
    inDiyalog(
      'tr',
      <DyApiError error={new ApiError(409, 'conflict', 'This GitHub code was already used.')} />,
    );
    expect(shown()).toBe('This GitHub code was already used.');
  });

  it('the classic console stays English: the master’s message verbatim even for a Turkish user', () => {
    const r = inClassic('tr', <ApiErrorNotice error={tooLarge} retryLeft={0} />);
    expect(shown()).toBe('notes.md: larger than 2048 KiB.');
    r.unmount();
    inDiyalog('tr', <ApiErrorNotice error={tooLarge} retryLeft={0} />);
    expect(shown()).toBe('notes.md: 2.048 KiB sınırından büyük.');
  });
});

describe('the API client keeps params', () => {
  it('reads the primitive params of an error body', async () => {
    const f = fakeFetch({
      'GET /api/x': () => ({
        status: 413,
        body: body('attachment_too_large', 'notes.md: larger than 2048 KiB.', {
          name: 'notes.md',
          maxKib: 2048,
          nested: { no: 1 },
        }),
      }),
    });
    const err = await apiRequest('GET', '/x', (v) => v, { fetchImpl: f.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).params).toEqual({ name: 'notes.md', maxKib: 2048 });
    expect((err as ApiError).message).toBe('notes.md: larger than 2048 KiB.');
    expect(paramsOf({ params: 'nope' })).toEqual({});
  });
});

describe('git identity validation (no English text matching any more)', () => {
  it('says the protocol’s issue codes through the catalog, in both languages', () => {
    const wrap =
      (locale: Locale) =>
      ({ children }: { children: ReactNode }) => <I18nProvider locale={locale}>{children}</I18nProvider>;
    const tr = renderHook(() => useIdentityIssueText(), { wrapper: wrap('tr') }).result.current;
    expect(tr({ code: 'name_too_long', max: 100 })).toBe('Ad en çok 100 karakter olabilir.');
    expect(tr({ code: 'email_invalid' })).toBe('ad@ornek.example gibi bir e-posta adresi girin.');
    expect(tr(null)).toBeNull();
    const en = renderHook(() => useIdentityIssueText(), { wrapper: wrap('en') }).result.current;
    expect(en({ code: 'name_spaces' })).toBe('Name must not start or end with spaces.');
  });
});
