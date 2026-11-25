import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getSkillTrust,
  type ProjectSkillTrust,
  setSkillTrust,
  type SkillTrust,
} from '../../../../api/skills';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { useCardForm, useSectionSave } from '../../../formkit';
import { DyNotice } from '../../forms';
import { DyButton, Panel } from '../../parts';
import { LoadState, RadioCardGroup, SaveResult } from './policy-common';

/**
 * p14-skill-import (ADR-0054): Projeler → Politika → "Yetenek imzası". `offline-only` = no panel-signed (imported or
 * chat-written) skill version reaches this project's jobs; the master refuses to assign / deliver one and workers
 * (`skill-trust-v1`) refuse it as well. Owners / admins change it with step-up; everyone else reads. p15-form-pattern:
 * a section of the Politika tab's form (saved by the tab's bar).
 */
export function SkillTrustPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().skills.trust;
  const fmt = useFormat();
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project } = props;
  const [data, setData] = useState<ProjectSkillTrust | null>(null);
  const [choice, setChoice] = useState<SkillTrust>('any');
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      const d = await getSkillTrust(project);
      setData(d);
      setChoice(d.trust);
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = (): Promise<boolean> => {
    setDone(null);
    return sectionSave(
      saver,
      async () => {
        const d = await setSkillTrust(project, choice);
        setData(d);
        setChoice(d.trust);
        setDone(t.saved);
      },
      t.stepUp,
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && data !== null && choice !== data.trust,
    busy: saver.busy,
    save,
    discard: () => {
      if (data !== null) setChoice(data.trust);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="skill-trust-panel">
      <div className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={loader.error} what={t.loading} onRetry={refresh} />
        {data === null ? null : (
          <>
            <RadioCardGroup<SkillTrust>
              legend={t.legend}
              value={choice}
              disabled={!props.canEdit || saver.busy}
              testId="skill-trust-choice"
              onChange={setChoice}
              options={[
                { value: 'any', label: t.any, description: t.anyHint },
                { value: 'offline-only', label: t.offline, description: t.offlineHint },
              ]}
            />
            {data.trust === 'offline-only' && data.panelSignedAssignments.length > 0 ? (
              <DyNotice tone="amber">{t.skipped({ list: fmt.list(data.panelSignedAssignments) })}</DyNotice>
            ) : null}
            {props.canEdit && !card.inScope ? (
              <div>
                <DyButton
                  variant="primary"
                  icon="key"
                  busy={saver.busy}
                  disabled={choice === data.trust}
                  onClick={card.submit}
                >
                  {t.save}
                </DyButton>
              </div>
            ) : null}
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
