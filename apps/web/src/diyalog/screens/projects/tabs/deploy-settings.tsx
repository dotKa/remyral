import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getUptimeSettings, putUptimeSettings, type UptimeSettings } from '../../../../api/uptime';
import {
  getVerifySettings,
  putVerifySettings,
  type VerifyMode,
  type VerifySettings,
  type VerifySettingsInput,
} from '../../../../api/verify';
import { RUNTIMES } from '../../../../screens/composer/draft';
import { useSubmit } from '../../../../screens/useSubmit';
import { sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { DyApiError, DyCheck, DyField, DyNotice, FormActions, FormGrid } from '../../forms';
import { DyButton, DySelect, Panel, SkeletonRows } from '../../parts';
import { useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy: "Uptime" (auto-monitor deployed sites; `PUT /projects/:id/uptime-
 * settings`, project admins, as the classic `UptimeSettingsSection`) and "Doğrulama ve sağlık" (verify-when-done
 * default, verifier runtime, test command, health check, screenshots, keyword, auto-rollback with its production
 * switch; saved through step-up as the classic `VerifySettingsSection`). Others read.
 */

export function UptimePanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const { project } = props;
  const t = useT().projectTabs.checks;
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<UptimeSettings | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);

  useEffect(() => {
    void loader.run(async () => {
      setData(await getUptimeSettings(project));
    });
  }, [project]);

  return (
    <Panel
      title="Uptime" // i18n-ignore: product term, the same in both languages
      sub={
        <>
          {t.uptimeSubA}
          <Link to="/uptime" className="font-medium text-dy-teal-ink underline underline-offset-2">
            Uptime{/* i18n-ignore: screen name */}
          </Link>
          {t.uptimeSubB}
        </>
      }
      testId="uptime-settings"
    >
      <div className="flex flex-col gap-3">
        <DyApiError error={loader.error} retryLeft={loader.retryLeft} />
        {data === null ? (
          loader.error === null ? (
            <SkeletonRows label={t.uptimeLoading} rows={1} />
          ) : null
        ) : props.canEdit ? (
          <DyCheck
            label={t.autoMonitor}
            hint={t.autoMonitorHint}
            checked={data.autoMonitor}
            disabled={saver.busy}
            testId="uptime-auto"
            onChange={(checked) => {
              if (saver.busy) return;
              setDone(null);
              void saver.run(async () => {
                setData(await putUptimeSettings(project, checked));
                setDone(checked ? t.autoOn : t.autoOff);
              });
            }}
          />
        ) : (
          <p className="m-0 text-[0.875rem]" data-testid="uptime-settings-current">
            {data.autoMonitor ? t.currentOn : t.currentOff}
          </p>
        )}
        <DyApiError error={saver.error} retryLeft={saver.retryLeft} />
      </div>
    </Panel>
  );
}

function toInput(s: VerifySettings): VerifySettingsInput {
  return {
    verifyDefault: s.verifyDefault,
    verifyRuntime: s.verifyRuntime,
    testCommand: s.testCommand,
    healthAfterDeploy: s.healthAfterDeploy,
    healthScreenshots: s.healthScreenshots,
    healthKeyword: s.healthKeyword,
    autoRollback: s.autoRollback,
    autoRollbackProduction: s.autoRollbackProduction,
  };
}

export function VerifyPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const { project, canEdit } = props;
  const t = useT().projectTabs.checks;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [form, setForm] = useState<VerifySettingsInput | null>(null);
  // p15-form-pattern: the loaded settings (edits are against them); the Deploy tab's bar saves the card.
  const [base, setBase] = useState<VerifySettingsInput | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loader.run(async () => {
      const v = toInput(await getVerifySettings(project));
      setForm(v);
      setBase(v);
    });
  }, [project]);

  const store = (): Promise<boolean> => {
    if (!canEdit || form === null) return Promise.resolve(false);
    return sectionSave(
      saver,
      async () => {
        const out = toInput(
          await putVerifySettings(project, {
            ...form,
            testCommand: form.testCommand?.trim() === '' ? null : (form.testCommand?.trim() ?? null),
            healthKeyword: form.healthKeyword?.trim() === '' ? null : (form.healthKeyword?.trim() ?? null),
            autoRollbackProduction: form.autoRollback && form.autoRollbackProduction,
          }),
        );
        setForm(out);
        setBase(out);
        setSaved(true);
      },
      t.verifyStepUp,
    );
  };
  const card = useCardForm({
    dirty: canEdit && form !== null && base !== null && !sameValue(form, base),
    busy: saver.busy,
    save: store,
    discard: () => {
      setForm(base);
    },
  });

  const set = <K extends keyof VerifySettingsInput>(k: K, v: VerifySettingsInput[K]) => {
    setSaved(false);
    setForm((f) => (f === null ? f : { ...f, [k]: v }));
  };

  return (
    <Panel title={t.verifyTitle} sub={t.verifySub} testId="verify-settings">
      <div className="flex flex-col gap-3">
        <DyApiError error={loader.error} retryLeft={loader.retryLeft} />
        {form === null ? (
          loader.error === null ? (
            <SkeletonRows label={t.verifyLoading} rows={2} />
          ) : null
        ) : (
          <form
            aria-label={t.verifyTitle}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canEdit) card.submit();
            }}
          >
            <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <FormGrid>
                <DySelect
                  label={t.verifyDefault}
                  value={form.verifyDefault}
                  options={(['off', 'report', 'gate'] as const).map((m) => [m, t.mode[m]] as const)}
                  onChange={(v) => {
                    set('verifyDefault', v as VerifyMode);
                  }}
                />
                <DySelect
                  label={t.verifyRuntime}
                  value={form.verifyRuntime ?? ''}
                  options={[['', t.ownRuntime], ...RUNTIMES.map((r) => [r, runtimeDisplayName(r)] as const)]}
                  onChange={(v) => {
                    set('verifyRuntime', v === '' ? null : v);
                  }}
                />
              </FormGrid>
              <DyField
                label={t.testCommand}
                mono
                hint={t.testCommandHint}
                value={form.testCommand ?? ''}
                maxLength={300}
                onChange={(v) => {
                  set('testCommand', v);
                }}
              />
              <DyCheck
                label={t.health}
                hint={t.healthHint}
                checked={form.healthAfterDeploy}
                disabled={!canEdit}
                onChange={(c) => {
                  set('healthAfterDeploy', c);
                }}
              />
              <DyCheck
                label={t.screenshots}
                hint={t.screenshotsHint}
                checked={form.healthScreenshots}
                disabled={!canEdit}
                onChange={(c) => {
                  set('healthScreenshots', c);
                }}
              />
              <DyField
                label={t.keyword}
                value={form.healthKeyword ?? ''}
                maxLength={100}
                onChange={(v) => {
                  set('healthKeyword', v);
                }}
              />
              <DyCheck
                label={t.autoRollback}
                hint={t.autoRollbackHint}
                checked={form.autoRollback}
                disabled={!canEdit}
                onChange={(c) => {
                  set('autoRollback', c);
                }}
              />
              {form.autoRollback ? (
                <DyCheck
                  label={t.production}
                  className="pl-6"
                  checked={form.autoRollbackProduction}
                  disabled={!canEdit}
                  onChange={(c) => {
                    set('autoRollbackProduction', c);
                  }}
                />
              ) : null}
            </fieldset>
            {canEdit ? (
              card.inScope ? null : (
                <FormActions>
                  <DyButton type="submit" variant="primary" busy={saver.busy}>
                    {t.save}
                  </DyButton>
                </FormActions>
              )
            ) : (
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.adminsOnly}</p>
            )}
            {saved ? (
              <DyNotice tone="green" live>
                {t.saved}
              </DyNotice>
            ) : null}
            <DyApiError error={saver.error} retryLeft={saver.retryLeft} />
          </form>
        )}
      </div>
    </Panel>
  );
}
