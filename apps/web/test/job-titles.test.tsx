// p15-job-titles (docs/design/p15-job-titles.md): the job page heading shows the job's short title and lets people who
// may start jobs rename it inline (one line, ≤ 60 characters); the job detail carries the title (older masters: derived
// from the prompt here).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseJobDetail } from '../src/api/jobs';
import { JobTitleHeading } from '../src/diyalog/job/JobHeader';
import { I18nProvider } from '../src/i18n/I18nProvider';

const wrap = (ui: ReactNode, locale: 'tr' | 'en' = 'tr') =>
  render(<I18nProvider locale={locale}>{ui}</I18nProvider>);

describe('job title heading', () => {
  it('shows the title without a pencil when the viewer may not rename', () => {
    wrap(<JobTitleHeading title="SampleWebApp: Coolify deploy dalı hazırla" />);
    expect(screen.getByTestId('dy-job-title').textContent).toBe('SampleWebApp: Coolify deploy dalı hazırla');
    expect(screen.queryByTestId('dy-job-title-edit')).toBeNull();
  });

  it('renames inline: validates 60 characters, Enter saves, Escape cancels', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(() => Promise.resolve());
    wrap(
      <JobTitleHeading
        title="Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY…"
        onRename={onRename}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Başlığı düzenle' }));
    const input = screen.getByLabelText('İş başlığı');
    await user.clear(input);
    await user.type(input, 'x'.repeat(61));
    expect(screen.getByText('Başlık en fazla 60 karakter olabilir (şu an 61).')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Kaydet' }).disabled).toBe(true);
    await user.clear(input);
    await user.type(input, '  SampleWebApp: Coolify deploy dalı hazırla {Enter}');
    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('SampleWebApp: Coolify deploy dalı hazırla');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-job-title-form')).toBeNull();
    });
    // Escape leaves without saving.
    await user.click(screen.getByRole('button', { name: 'Başlığı düzenle' }));
    fireEvent.keyDown(screen.getByLabelText('İş başlığı'), { key: 'Escape' });
    expect(screen.queryByTestId('dy-job-title-form')).toBeNull();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('says why a rename failed (English)', async () => {
    const user = userEvent.setup();
    wrap(<JobTitleHeading title="Old" onRename={() => Promise.reject(new Error('forbidden'))} />, 'en');
    await user.click(screen.getByRole('button', { name: 'Edit title' }));
    await user.clear(screen.getByLabelText('Job title'));
    await user.type(screen.getByLabelText('Job title'), 'New title{Enter}');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The title was not saved: forbidden',
    );
  });
});

describe('job detail title', () => {
  const base = {
    id: '7c1e09ab-0000-4000-8000-000000000001',
    project: 'p',
    state: 'QUEUED',
    version: 1,
    leaseEpoch: 0,
    createdBy: { type: 'user', id: 'u1' },
    createdAt: '2026-10-22T10:00:00.000Z',
    stateChangedAt: '2026-10-22T10:00:00.000Z',
  };
  const shell = { transitions: [], attempts: [], leases: [], approvals: [], dependsOn: [], dependents: [] };

  it('uses the master title and source', () => {
    const d = parseJobDetail({
      ...shell,
      job: {
        ...base,
        title: 'Kısa başlık',
        titleSource: 'edited',
        spec: { prompt: 'Uzun açıklama. Devamı' },
      },
    });
    expect(d.job).toMatchObject({ title: 'Kısa başlık', titleSource: 'edited' });
  });

  it('derives one for an older master (no title field)', () => {
    const d = parseJobDetail({
      ...shell,
      job: { ...base, spec: { prompt: '## Görev\n- Landing sayfasını yeniden tasarla\n- Testleri ekle' } },
    });
    expect(d.job).toMatchObject({ title: 'Landing sayfasını yeniden tasarla', titleSource: 'derived' });
  });
});
