// p14-i18n-shell (i18n Phase 2): the shared texts Diyalog shows — the console's own error sentences, the 429 wait,
// the pager and the classic chat parts inside Sohbet rows — in Turkish and English; the classic console (no
// DiyalogTextScope) keeps today's English whatever the user's language.
import { render, screen } from '@testing-library/react';
import type { Locale } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import { ApiError, NETWORK_ERROR_MESSAGE } from '../src/api/client';
import { ApiErrorNotice, toApiError } from '../src/components/ui';
import { DyApiError, retryText } from '../src/diyalog/common/notices';
import { DyPager } from '../src/diyalog/common/pager';
import { StateBadge } from '../src/diyalog/StateBadge';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { DiyalogTextScope } from '../src/i18n/scope';
import { AttachmentTray } from '../src/screens/chat/Attachments';
import { CopyText } from '../src/screens/chat/markdown';
import { OutputsLink } from '../src/screens/chat/messageLinks';

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

const network = new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
const limited = new ApiError(429, 'rate_limited', 'Too many requests.', 65);

const outputsNote: ChatMessage = {
  id: 'm1',
  threadId: 't1',
  role: 'assistant',
  content: 'Deployed.',
  createdAt: '2026-10-20T10:00:00.000Z',
  meta: { notice: 'deploy-on-success', state: 'succeeded', jobId: '11111111-2222-4333-8444-555555555555' },
} as unknown as ChatMessage;

describe('shared error texts', () => {
  it('a network error and the catch-all speak the user language in Diyalog', () => {
    const { unmount } = inDiyalog('tr', <DyApiError error={network} />);
    expect(screen.getByTestId('api-error').textContent).toBe(
      'Sunucuya ulaşılamıyor. Bağlantını kontrol edip yeniden dene.',
    );
    unmount();
    inDiyalog('en', <DyApiError error={toApiError(new Error('boom'))} />);
    expect(screen.getByTestId('api-error').textContent).toBe('Something went wrong. Try again.');
  });

  it('the catch-all in Turkish; a master code from the catalog (p14-i18n-errors), an unknown one verbatim', () => {
    const { unmount } = inDiyalog('tr', <DyApiError error={toApiError('x')} />);
    expect(screen.getByTestId('api-error').textContent).toBe('Bir şeyler ters gitti. Yeniden dene.');
    unmount();
    const r = inDiyalog('tr', <DyApiError error={new ApiError(404, 'job_not_found', 'Job not found.')} />);
    expect(screen.getByTestId('api-error').textContent).toBe('İş bulunamadı.');
    r.unmount();
    inDiyalog('tr', <DyApiError error={new ApiError(404, 'brand_new', 'A newer master says this.')} />);
    expect(screen.getByTestId('api-error').textContent).toBe('A newer master says this.');
  });

  it('the 429 wait in both languages (Turkish output unchanged)', () => {
    const { unmount } = inDiyalog('tr', <DyApiError error={limited} retryLeft={65} />);
    expect(screen.getByTestId('retry-left').textContent).toBe('1 dk 05 sn sonra yeniden deneyebilirsin.');
    unmount();
    inDiyalog('en', <DyApiError error={limited} retryLeft={40} />);
    expect(screen.getByTestId('retry-left').textContent).toBe('You can try again in 40 s.');
    expect(retryText(65)).toBe('1 dk 05 sn sonra yeniden deneyebilirsin.');
  });

  it('the classic ApiErrorNotice stays English outside Diyalog, localized inside', () => {
    const { unmount } = inClassic('tr', <ApiErrorNotice error={limited} retryLeft={65} />);
    expect(screen.getByText('You can try again in 1 min 05 s.')).toBeTruthy();
    unmount();
    const r = inClassic('tr', <ApiErrorNotice error={network} retryLeft={0} />);
    expect(screen.getByTestId('api-error').textContent).toBe(NETWORK_ERROR_MESSAGE);
    r.unmount();
    inDiyalog('tr', <ApiErrorNotice error={limited} retryLeft={65} />);
    expect(screen.getByText('1 dk 05 sn sonra yeniden deneyebilirsin.')).toBeTruthy();
  });
});

describe('shared states', () => {
  const pager = {
    page: 2,
    pageSize: 25,
    count: 25,
    total: 1200,
    hasNext: true,
    onPrev: () => undefined,
    onNext: () => undefined,
    onPageSize: () => undefined,
    label: 'Liste',
  };

  it('the pager and a state badge in Turkish and English (numbers in the locale)', () => {
    const { unmount } = inDiyalog(
      'tr',
      <>
        <DyPager {...pager} />
        <StateBadge state="failed" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Sonraki sayfa' })).toBeTruthy();
    expect(screen.getByText(/26–50 \/ 1\.200/)).toBeTruthy();
    expect(screen.getByText('Başarısız')).toBeTruthy();
    unmount();
    inDiyalog(
      'en',
      <>
        <DyPager {...pager} />
        <StateBadge state="failed" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Next page' })).toBeTruthy();
    expect(screen.getByText(/26–50 \/ 1,200/)).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
  });
});

describe('classic chat parts inside Sohbet rows', () => {
  const tray = (
    <AttachmentTray
      items={[
        {
          key: 'k1',
          name: 'shot.png',
          kind: 'image',
          size: 10,
          state: 'preparing',
          previewUrl: null,
          error: null,
        } as never,
      ]}
      errors={[]}
      hint={null}
      onRemove={() => undefined}
    />
  );

  it('Turkish in the Diyalog scope', () => {
    inDiyalog(
      'tr',
      <>
        <CopyText text="x" label="Mesajı kopyala" />
        <OutputsLink m={outputsNote} />
        {tray}
      </>,
    );
    expect(screen.getByRole('button', { name: 'Mesajı kopyala' }).textContent).toBe('Kopyala');
    expect(screen.getByRole('link', { name: 'Çıktılar’da göster' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Eklenen dosyalar' })).toBeTruthy();
    expect(screen.getByText('Hazırlanıyor…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kaldır: shot.png' })).toBeTruthy();
  });

  it('English in the Diyalog scope', () => {
    inDiyalog(
      'en',
      <>
        <CopyText text="x" label="Copy message" />
        <OutputsLink m={outputsNote} />
        {tray}
      </>,
    );
    expect(screen.getByRole('button', { name: 'Copy message' }).textContent).toBe('Copy');
    expect(screen.getByRole('link', { name: 'Show in Outputs' })).toBeTruthy();
    expect(screen.getByText('Preparing…')).toBeTruthy();
  });

  it('the classic console keeps its English even for a Turkish user', () => {
    inClassic(
      'tr',
      <>
        <CopyText text="x" label="Copy message" />
        <OutputsLink m={outputsNote} />
        {tray}
      </>,
    );
    expect(screen.getByRole('button', { name: 'Copy message' }).textContent).toBe('Copy');
    expect(screen.getByRole('link', { name: 'Show in Outputs' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Attached files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove shot.png' })).toBeTruthy();
  });
});
