import { type ReactNode, useEffect, useState } from 'react';
import { listProjects, type Project } from '../../../api/directory';
import {
  type BulkPatch,
  bulkWorkerConfig,
  CONFIG_RUNTIMES,
  type ConfigRuntime,
} from '../../../api/workerConfig';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { RuntimeMark } from '../../RuntimeMark';
import { DyApiError, DyCheck, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, Panel } from '../parts';
import { useT } from '../../../i18n/I18nProvider';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3): "Yapılandırmayı değiştir…" on the machine list in the Diyalog language — the classic
 * fleet bulk change (ADR-0015, screens/fleet/BulkConfigPanel.tsx): one patch (add / remove a project, replace the
 * allowed runtimes, set the parallelism, an optional note) applied to every selected machine, all or nothing,
 * always through step-up. Each changed machine gets its own configuration generation and audit event on the master.
 */
export function BulkConfig(props: {
  readonly workerIds: readonly string[];
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [projects, setProjects] = useState<Project[]>([]);
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [setRuntimes, setSetRuntimes] = useState(false);
  const [runtimes, setRuntimesList] = useState<ConfigRuntime[]>([]);
  const [parallel, setParallel] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();
  const stepUp = useStepUp();
  const t = useT().machines.bulk;

  useEffect(() => {
    listProjects().then(setProjects, () => undefined);
  }, []);

  const patch: BulkPatch = {
    ...(add === '' ? {} : { addProjects: [add] }),
    ...(remove === '' ? {} : { removeProjects: [remove] }),
    ...(setRuntimes ? { allowedRuntimes: runtimes } : {}),
    ...(parallel === '' ? {} : { maxParallelJobs: Number(parallel) }),
  };
  const empty = Object.keys(patch).length === 0;
  const options: (readonly [string, string])[] = [
    ['', t.keep],
    ...projects.map((p) => [p.id, p.id] as const),
  ];
  const n = props.workerIds.length;

  const apply = (): void => {
    void submit
      .run(async () => {
        try {
          await stepUp.run(async () => {
            const res = await bulkWorkerConfig({
              workerIds: props.workerIds,
              patch,
              ...(note.trim() === '' ? {} : { changeNote: note.trim() }),
            });
            const changed = res.filter((r) => r.changed).length;
            setDone(t.done({ changed, same: res.length - changed }));
          }, t.why({ n }));
        } catch (err) {
          if (!(err instanceof StepUpCancelledError)) throw err;
        }
      })
      .then((ok) => {
        if (ok) props.onDone();
      });
  };

  return (
    <div data-testid="bulk-config">
      <Panel title={t.title} count={t.count({ n })} sub={t.sub}>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <DySelect label={t.addProject} value={add} options={options} onChange={setAdd} />
            <DySelect label={t.removeProject} value={remove} options={options} onChange={setRemove} />
            <DyField
              label={t.parallel}
              type="number"
              inputMode="numeric"
              min={0}
              max={64}
              value={parallel}
              placeholder={t.parallelKeep}
              onChange={setParallel}
            />
          </div>
          <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
            <legend className="sr-only">{t.runtimesLegend}</legend>
            <DyCheck
              label={t.runtimes}
              hint={t.runtimesHint}
              checked={setRuntimes}
              onChange={setSetRuntimes}
            />
            {setRuntimes ? (
              <div className="flex flex-wrap gap-x-5 pl-[26px]">
                {CONFIG_RUNTIMES.map((r) => (
                  <DyCheck
                    key={r}
                    label={<RuntimeMark runtime={r} />}
                    checked={runtimes.includes(r)}
                    onChange={(on) => {
                      setRuntimesList(on ? [...runtimes, r] : runtimes.filter((x) => x !== r));
                    }}
                  />
                ))}
              </div>
            ) : null}
          </fieldset>
          <DyField label={t.note} value={note} placeholder={t.notePlaceholder} onChange={setNote} />
          {submit.error !== null && submit.error.issues.length > 0 ? (
            <DyNotice tone="red">
              <ul className="m-0 list-disc pl-4" data-testid="bulk-issues">
                {submit.error.issues.map((i) => (
                  <li key={`${i.path}-${i.code}`}>
                    <span className="font-dy-mono">{i.path}</span>: {i.code}
                  </li>
                ))}
              </ul>
            </DyNotice>
          ) : null}
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
          <FormActions>
            <DyButton variant="primary" disabled={empty} busy={submit.busy} onClick={apply}>
              {t.apply}
            </DyButton>
            <DyButton variant="ghost" onClick={props.onCancel}>
              {t.cancel}
            </DyButton>
          </FormActions>
        </div>
      </Panel>
    </div>
  );
}
