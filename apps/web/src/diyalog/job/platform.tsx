import type { Messages } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobPlatform } from '../../api/jobs';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { SOFT } from '../tone';
import type { JobStatePill } from './JobHeader';

/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md §4): a platform verifier job is shown as what it is — a
 * "Doğrulama" badge, the title from the job it checks ("Doğrula: <title>", in the reader's language) and the CHECKED
 * job's verification outcome (Doğrulandı / Doğrulama sorun buldu / Doğrulanamadı) instead of a generic "Başarısız".
 */

/** The state pill of a verifier: its outcome; null when the marker says nothing beyond the job's own state. */
export function platformPill(p: JobPlatform | null | undefined, m: Messages): JobStatePill | null {
  if (p === null || p === undefined || p.outcome === null) return null;
  const w = m.verifierJobs.outcome;
  switch (p.outcome) {
    case 'verified':
      return { tone: 'green', icon: 'checkc', label: w.verified };
    case 'issues':
      return { tone: 'amber', icon: 'shield', label: w.issues };
    case 'unverifiable':
      return { tone: 'neutral', icon: 'xc', label: w.unverifiable };
    case 'running':
      return { tone: 'teal', icon: 'retry', label: w.running };
  }
}

/** The verifier's title in the reader's language (the stored Turkish one when the checked job is unknown). */
export function platformTitle(p: JobPlatform | null | undefined, stored: string, m: Messages): string {
  if (p === null || p === undefined || p.checkedTitle === null) return stored;
  return m.verifierJobs.title[p.purpose]({ title: p.checkedTitle });
}

/** Why a verification could not run, in the reader's language (null: unknown cause). */
export function causeWords(cause: string | null | undefined, m: Messages): string | null {
  if (cause === null || cause === undefined) return null;
  const table = m.verifierJobs.cause as Readonly<Record<string, string>>;
  return Object.hasOwn(table, cause) ? (table[cause] ?? null) : null;
}

/** The "Doğrulama" badge (and, when known, a link to the checked job). */
export function PlatformBadge(props: {
  readonly platform: JobPlatform;
  readonly showChecked?: boolean;
  readonly className?: string;
}): ReactNode {
  const w = useT().verifierJobs;
  const p = props.platform;
  return (
    <span className={cx('inline-flex items-center gap-2', props.className)}>
      <span
        data-testid="platform-badge"
        title={w.badgeTitle}
        className={cx(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.75rem] font-bold whitespace-nowrap',
          SOFT.neutral,
        )}
      >
        <DyIcon name="checkc" className="size-3" />
        {w.badge}
      </span>
      {props.showChecked === true && p.checkedJobId !== null ? (
        <Link
          to={`/jobs/${encodeURIComponent(p.checkedJobId)}`}
          className="text-[0.8125rem] text-dy-teal-ink underline"
          data-testid="platform-checked-link"
        >
          {w.openChecked}
        </Link>
      ) : null}
    </span>
  );
}
