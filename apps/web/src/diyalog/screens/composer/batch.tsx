import { type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Project } from '../../../api/directory';
import {
  type BatchPreflight,
  type BatchRequestBody,
  preflightJobBatch,
  submitJobBatch,
} from '../../../api/jobBatches';
import { MAX_THREAD_PROJECTS } from '../../../api/chatKnowledge';
import { useErrorText } from '../../../i18n/errors';
import { useT } from '../../../i18n/I18nProvider';
import { type Draft, promptHead } from '../../../screens/composer/draft';
import { ProjectChecks } from '../../common/ProjectChecks';
import { BatchCheck } from '../jobs/BatchScreens';
import { DyNotice } from '../kit';
import { DyButton } from '../parts';

/**
 * p18-leftovers (docs/design/p18-multi-project.md §10 "Leftovers"): the composer's "Projeler" — the job of this page in
 * other projects too, as a job fan-out batch (`POST /jobs/batches`, the W5 preflight and rules): one ordinary job per
 * project, each authorized and admitted in its own project. Only for a job that starts now; what a batch cannot carry
 * (input files, deploy when done, schedule, machine requirements) is named. The page's settings become the batch's
 * shared settings; the page's base branch is its own project's starting branch.
 */

export interface ComposerBatch {
  readonly extra: readonly string[];
  readonly setExtra: (next: string[]) => void;
  /** Other projects are picked and the draft can be a batch (a job, now). */
  readonly active: boolean;
  readonly check: BatchPreflight | null;
  readonly busy: 'check' | 'submit' | null;
  readonly error: string | null;
  readonly runCheck: () => void;
  readonly submit: () => void;
}

/** The batch request of the draft: the page's project first, then the picked ones. */
export function batchBody(draft: Draft, extra: readonly string[]): BatchRequestBody {
  const minutes = Number(draft.maxDurationMin);
  const base = draft.baseRef.trim();
  return {
    projects: [draft.project, ...extra.filter((p) => p !== draft.project)],
    spec: {
      title: (promptHead(draft.prompt) || draft.prompt.trim()).slice(0, 200),
      prompt: draft.prompt.trim(),
      runtime: draft.runtime,
      ...(draft.model.trim() === '' ? {} : { model: draft.model.trim() }),
      ...(draft.sandboxProfile === '' ? {} : { sandboxProfile: draft.sandboxProfile }),
      ...(draft.approvalPolicy === '' ? {} : { approvalPolicy: draft.approvalPolicy }),
      ...(Number.isFinite(minutes) && minutes >= 1 ? { maxDurationSec: Math.round(minutes * 60) } : {}),
    },
    ...(base === '' ? {} : { perProject: { [draft.project]: { baseRef: base } } }),
  };
}

export function useComposerBatch(draft: Draft): ComposerBatch {
  const t = useT().multiProject.composer;
  const sayError = useErrorText();
  const navigate = useNavigate();
  const [extra, setExtra] = useState<readonly string[]>([]);
  const [check, setCheck] = useState<BatchPreflight | null>(null);
  const [busy, setBusy] = useState<'check' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = extra.length > 0 && draft.mode === 'job' && draft.project !== '' && draft.when === 'now';
  const body = batchBody(draft, extra);
  const key = JSON.stringify(body);
  // Any change makes the last check stale.
  useEffect(() => {
    setCheck(null);
  }, [key]);
  // The page's own project is never one of the others.
  useEffect(() => {
    if (extra.includes(draft.project)) setExtra((prev) => prev.filter((p) => p !== draft.project));
  }, [draft.project, extra]);
  const run = (kind: 'check' | 'submit'): void => {
    if (body.spec.prompt === '') {
      setError(t.needPrompt);
      return;
    }
    setBusy(kind);
    setError(null);
    void (async () => {
      try {
        if (kind === 'check') setCheck(await preflightJobBatch(body));
        else {
          const out = await submitJobBatch(body);
          void navigate(`/jobs/batches/${encodeURIComponent(out.batchId)}`);
        }
      } catch (err) {
        setError(sayError(err));
      } finally {
        setBusy(null);
      }
    })();
  };
  return {
    extra,
    setExtra: (next) => {
      setExtra(next);
    },
    active,
    check,
    busy,
    error,
    runCheck: () => {
      run('check');
    },
    submit: () => {
      run('submit');
    },
  };
}

/** "Başka projelerde de çalıştır": the projects (operator+ in them) and, once picked, the batch's check. */
export function BatchProjectsField(props: {
  readonly draft: Draft;
  readonly projects: readonly Project[] | null;
  readonly batch: ComposerBatch;
}): ReactNode {
  const t = useT().multiProject;
  const tc = t.composer;
  const { draft, batch } = props;
  if (draft.mode !== 'job' || draft.project === '') return null;
  const others = (props.projects ?? []).filter((p) => p.id !== draft.project && p.myRole !== 'viewer');
  return (
    <div className="grid gap-2" data-testid="composer-batch">
      <ProjectChecks
        legend={tc.legend}
        hint={tc.hint}
        empty={tc.none}
        projects={others}
        chosen={batch.extra}
        onChange={batch.setExtra}
        max={MAX_THREAD_PROJECTS - 1}
        testId="composer-batch-projects"
      />
      {batch.extra.length === 0 ? null : draft.when !== 'now' ? (
        <DyNotice tone="amber">{tc.notNow}</DyNotice>
      ) : (
        <>
          <p className="m-0 text-[0.8125rem] font-bold text-dy-teal-ink" data-testid="composer-batch-count">
            {tc.count({ n: batch.extra.length + 1 })}
          </p>
          <DyNotice tone="amber">{tc.left}</DyNotice>
          <div>
            <DyButton
              variant="secondary"
              busy={batch.busy === 'check'}
              disabled={batch.busy !== null}
              onClick={batch.runCheck}
              data-testid="composer-batch-check"
            >
              {batch.busy === 'check' ? t.batch.form.checking : t.batch.form.check}
            </DyButton>
          </div>
          {batch.check === null ? null : <BatchCheck check={batch.check} />}
          {batch.error === null ? null : (
            <p
              role="alert"
              className="m-0 text-[0.8125rem] text-dy-red-ink"
              data-testid="composer-batch-error"
            >
              {batch.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
