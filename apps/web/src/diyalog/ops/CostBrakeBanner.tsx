import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type CostBrake, getCostBrake } from '../../api/opsSafety';
import { useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';

/**
 * p16-ops-safety §4 (docs/design/p16-ops-safety.md): the cost brake band on the home page and in the chat — shown
 * while a spend ceiling is reached: red when the brake holds work (block mode), amber in warn-only mode. Every role
 * reads the brake (`quotas.read`); the details link goes to Ayarlar → Operasyon güvenliği (owners / admins).
 */
export function CostBrakeBanner(props: { readonly pollMs?: number; readonly className?: string }): ReactNode {
  const t = useT().opsSafety.banner;
  const [brake, setBrake] = useState<CostBrake | null>(null);
  const every = props.pollMs ?? 60_000;

  useEffect(() => {
    let live = true;
    const run = (): void => {
      getCostBrake().then(
        (b) => {
          if (live) setBrake(b);
        },
        () => undefined,
      );
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') run();
    }, every);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [every]);

  if (brake === null || brake.engaged.length === 0) return null;
  return (
    <DyNotice
      tone={brake.blocking ? 'red' : 'amber'}
      icon="gauge"
      title={brake.blocking ? t.blockingTitle : t.warnTitle}
      testId="dy-cost-brake-banner"
      className={props.className}
      action={
        <Link to="/settings/ops-safety?tab=brake" className="font-bold text-inherit underline">
          {t.details}
        </Link>
      }
    >
      {brake.blocking ? t.blocking : t.warn}
    </DyNotice>
  );
}
