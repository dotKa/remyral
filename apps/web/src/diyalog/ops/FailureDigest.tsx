import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { type FailureDigest, getFailureDigest } from '../../api/autonomy';
import { useT } from '../../i18n/I18nProvider';
import { useResource } from '../job/resource';

/**
 * p15-auto-mode: "Son 24 saat: X başarısız · Y kendiliğinden düzeldi · Z senden bekliyor" above Senden bekleyenler,
 * linking to the failed jobs. Refreshed every minute; hidden until it loads (or when it cannot be read).
 */
export function FailureDigestLine(): ReactNode {
  const t = useT().autoMode.digest;
  const { data } = useResource<FailureDigest>((signal) => getFailureDigest({ signal }), 'digest', {
    poll: () => true,
    ms: 60_000,
  });
  if (data === null) return null;
  return (
    <p
      className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.875rem] text-dy-muted"
      data-testid="dy-failure-digest"
    >
      <span>{t.line({ failed: data.failed, healed: data.healed, waiting: data.waiting })}</span>
      {data.failed > 0 ? (
        <Link to="/jobs?state=FAILED" className="font-medium text-dy-teal-ink">
          {t.link}
        </Link>
      ) : null}
    </p>
  );
}
