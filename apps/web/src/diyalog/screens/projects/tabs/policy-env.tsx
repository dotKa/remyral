import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProjectEnv, type ProjectEnvSetting, putProjectEnv } from '../../../../api/projectEnv';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { FormActions } from '../../forms';
import { DyButton, DySelect, Panel, Row, Rows } from '../../parts';
import { LoadState, SaveResult } from './policy-common';

/**
 * p19-project-env (docs/design/p19-project-env.md): Projeler → Politika → "Ortam değişkenleri". The vault credentials
 * of kind "generic" this project gives its jobs as environment variables, with the machines holding each (jobs run
 * only there). Adding or removing one is an instant action (owners / admins, step-up, audited); everyone else reads.
 */
export function ProjectEnvPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().projectEnv;
  const stepUp = useStepUp();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project } = props;
  const [data, setData] = useState<ProjectEnvSetting | null>(null);
  const [pick, setPick] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      setData(await getProjectEnv(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = (ids: readonly string[]): void => {
    setDone(null);
    void saver.run(async () => {
      try {
        const d = await stepUp.run(() => putProjectEnv(project, ids), t.stepUp);
        setData(d);
        setPick('');
        setDone(t.saved);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  const bound = data?.credentials.map((c) => c.credentialId) ?? [];
  const chosen = pick !== '' ? pick : (data?.available[0]?.id ?? '');

  return (
    <Panel title={t.title} sub={t.sub} testId="project-env-panel">
      <div className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={loader.error} what={t.loading} onRetry={refresh} />
        {data === null ? null : (
          <>
            {data.credentials.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="project-env-none">
                {t.none}
              </p>
            ) : (
              <Rows label={t.listLabel} testId="project-env-list">
                {data.credentials.map((c) => (
                  <Row
                    key={c.credentialId}
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-dy-mono">{c.env}</span>
                        <span className="text-dy-muted [overflow-wrap:anywhere]">{c.name}</span>
                      </span>
                    }
                    meta={
                      <span className={c.machines.length === 0 ? 'text-dy-amber-ink' : undefined}>
                        {c.machines.length === 0 ? t.noMachine : t.machines({ names: c.machines.join(', ') })}
                      </span>
                    }
                    actions={
                      props.canEdit ? (
                        <DyButton
                          variant="ghost"
                          busy={saver.busy}
                          onClick={() => {
                            save(bound.filter((id) => id !== c.credentialId));
                          }}
                        >
                          {t.remove}
                        </DyButton>
                      ) : null
                    }
                  />
                ))}
              </Rows>
            )}
            {props.canEdit ? (
              data.available.length === 0 ? (
                <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="project-env-add-none">
                  {t.addNone}
                </p>
              ) : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  data-testid="project-env-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (chosen !== '') save([...bound, chosen]);
                  }}
                >
                  <DySelect
                    label={t.addLabel}
                    value={chosen}
                    className="min-w-[16rem] flex-1"
                    options={data.available.map((a) => [a.id, `${a.env} · ${a.name}`] as const)}
                    onChange={setPick}
                  />
                  <FormActions>
                    <DyButton type="submit" variant="primary" busy={saver.busy}>
                      {t.add}
                    </DyButton>
                  </FormActions>
                </form>
              )
            ) : null}
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.rule}</p>
            <Link to="/settings/credentials" className="text-[0.8125rem] font-medium text-dy-teal-ink">
              {t.manage}
            </Link>
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
