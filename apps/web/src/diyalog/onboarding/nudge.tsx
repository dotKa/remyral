import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { OnboardingStep } from '../../api/selfhost';
import { useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';
import { DyButtonLink } from '../screens/parts';
import { useOnboarding } from './useOnboarding';

/**
 * p16-selfhost-onboarding §5: where the setup wizard is pointed to while it is not completed (owners only):
 * the home card ("Kurulumu tamamla · 3/8") and one line on the empty states of the key screens.
 */
export function DyOnboardingCard(): ReactNode {
  const t = useT().selfhost.nudge;
  const { data } = useOnboarding();
  if (data === null || !data.visible) return null;
  return (
    <DyNotice
      tone="teal"
      icon="flag"
      title={t.title}
      testId="dy-onboarding-card"
      action={
        <DyButtonLink to={`/onboarding?step=${data.current}`} variant="primary">
          {t.open}
        </DyButtonLink>
      }
    >
      {t.text(data.progress)}
    </DyNotice>
  );
}

/** An empty list's hint: the wizard step that fills it (nothing for non-owners or after completion). */
export function DyWizardHint(props: { readonly step: OnboardingStep }): ReactNode {
  const t = useT().selfhost.nudge;
  const { data } = useOnboarding();
  if (data === null || !data.visible) return null;
  return (
    <Link
      to={`/onboarding?step=${props.step}`}
      data-testid={`dy-wizard-hint-${props.step}`}
      className="text-[0.875rem] font-bold text-dy-teal-ink"
    >
      {t.empty}
    </Link>
  );
}
