import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  checkSimilar,
  type DuplicateHit,
  getJobRelated,
  getRelatedSettings,
  getWorkflowRunRelated,
  type JobRelated,
  type RelatedSettings,
  setRelatedSettings,
  type SolvedFailure,
} from '../../api/related';
import { useSubmit } from '../../screens/useSubmit';
import { DyApiError, DyCheck } from '../screens/forms';
import { useT } from '../../i18n/I18nProvider';
import { useNow } from '../../lib/now';
import { agoText } from '../common/time';
import { DyNotice } from '../common/notices';
import { useResource } from '../job/resource';
import { Panel, Pill } from '../screens/parts';

/**
 * p17-embeddings (docs/design/p17-embeddings.md §5): what the embedding index adds to the console — the job page's
 * "Benzer geçmiş işler" and "Benzer hata daha önce şöyle çözüldü", the same hint under an automation's last failure,
 * and the "Benzer bir kayıt var" warning before a job or an automation is created. Every part renders nothing when the
 * master has nothing to say (no provider, capture off, nothing similar enough) — never an error.
 */

function hrefOf(kind: 'job' | 'workflow_run', id: string): string {
  return kind === 'job' ? `/jobs/${encodeURIComponent(id)}` : `/jobs/workflows/${encodeURIComponent(id)}`;
}

/** The solved earlier failures (job page, automation last failure). */
export function SolvedFailures(props: { readonly items: readonly SolvedFailure[] }): ReactNode {
  const t = useT().related.solved;
  const now = useNow();
  const time = useT().screenKit.time;
  if (props.items.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-2.5 p-0" data-testid="dy-solved-failures">
      {props.items.map((f) => (
        <li key={`${f.failed.id}:${f.resolution.id}`} className="grid min-w-0 gap-1 text-[0.8125rem]">
          <p className="m-0 font-bold">{t.how[f.resolution.how]}</p>
          {f.resolution.summary === null ? null : (
            <p className="m-0 break-words text-dy-ink">{f.resolution.summary}</p>
          )}
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-dy-muted">
            <Link to={hrefOf(f.resolution.kind, f.resolution.id)} data-testid="dy-solved-fix">
              {t.open}
            </Link>
            <span aria-hidden="true">·</span>
            <Link to={hrefOf(f.failed.kind, f.failed.id)} data-testid="dy-solved-failure">
              {t.openFailure}
            </Link>
            <span>{agoText(f.failed.at, now, time)}</span>
            {f.failed.code === null ? null : <code className="text-[0.75rem]">{f.failed.code}</code>}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Job page side panels: similar past jobs, and (a failed job) how a similar failure was solved before. */
export function RelatedWorkPanels(props: { readonly jobId: string; readonly state: string }): ReactNode {
  const t = useT().related;
  const now = useNow();
  const time = useT().screenKit.time;
  const { data } = useResource<JobRelated>(
    (signal) => getJobRelated(props.jobId, { signal }),
    `${props.jobId}:${props.state}`,
  );
  if (data === null) return null;
  const given = new Set(data.givenToAgent ?? []);
  return (
    <>
      {data.failures.length === 0 ? null : (
        <Panel title={t.solved.title} testId="dy-job-solved">
          <div className="px-4 pb-4">
            <SolvedFailures items={data.failures} />
          </div>
        </Panel>
      )}
      {data.similar.length === 0 ? null : (
        <Panel title={t.similar.title} sub={t.similar.sub} testId="dy-job-similar">
          <ul className="m-0 grid list-none gap-2.5 px-4 pb-4" data-testid="dy-job-similar-list">
            {data.similar.map((s) => (
              <li key={s.jobId} className="grid min-w-0 gap-0.5 text-[0.8125rem]">
                <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to={hrefOf('job', s.jobId)} className="min-w-0 font-bold break-words">
                    {s.title}
                  </Link>
                  <Pill tone={s.state === 'SUCCEEDED' ? 'green' : s.state === 'FAILED' ? 'red' : 'neutral'}>
                    {t.similar.states[s.state] ?? s.state}
                  </Pill>
                  <span className="text-dy-muted">{agoText(s.finishedAt, now, time)}</span>
                  {given.has(s.jobId) ? (
                    <Pill tone="teal" title={t.similar.givenHint}>
                      {t.similar.given}
                    </Pill>
                  ) : null}
                </p>
                {s.summary === null ? null : <p className="m-0 break-words text-dy-muted">{s.summary}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

/** Under an automation's last failure: how a similar failure was solved before (its job or its workflow run). */
export function SolvedBefore(props: {
  readonly jobId: string | null;
  readonly workflowRunId: string | null;
}): ReactNode {
  const t = useT().related.solved;
  const [items, setItems] = useState<readonly SolvedFailure[]>([]);
  useEffect(() => {
    const ctl = new AbortController();
    const load =
      props.jobId !== null
        ? getJobRelated(props.jobId, { signal: ctl.signal }).then((r) => r.failures)
        : props.workflowRunId !== null
          ? getWorkflowRunRelated(props.workflowRunId, { signal: ctl.signal }).then((r) => r.failures)
          : Promise.resolve([]);
    load.then(
      (f) => {
        if (!ctl.signal.aborted) setItems(f);
      },
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [props.jobId, props.workflowRunId]);
  if (items.length === 0) return null;
  return (
    <DyNotice tone="teal" icon="checkc" title={t.title} className="mt-2" testId="last-failure-solved">
      <div className="mt-1.5">
        <SolvedFailures items={items} />
      </div>
    </DyNotice>
  );
}

/** How long typing pauses before the check runs (each check embeds one text on the master). */
const CHECK_DELAY_MS = 800;

/**
 * "Benzer bir kayıt var": shown before a job or an automation is created when the project already has a similar open
 * or recent job / a live automation. A warning only — it never blocks. `text` is the title / name and the prompt.
 */
export function SimilarRecordNotice(props: {
  readonly kind: 'job' | 'automation';
  readonly project: string;
  readonly text: string;
  readonly excludeId?: string | null | undefined;
  /** False: nothing is checked (e.g. the card is no longer open). */
  readonly enabled?: boolean | undefined;
}): ReactNode {
  const t = useT().related.duplicate;
  const [hits, setHits] = useState<readonly DuplicateHit[]>([]);
  const enabled = props.enabled !== false;
  const text = props.text.trim();
  useEffect(() => {
    if (!enabled || props.project === '' || text.length < 12) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      checkSimilar(
        props.kind,
        { project: props.project, text, excludeId: props.excludeId ?? null },
        { signal: ctl.signal },
      ).then(
        (r) => {
          if (!ctl.signal.aborted) setHits(r.items);
        },
        () => undefined,
      );
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [enabled, props.kind, props.project, text, props.excludeId]);
  if (!enabled || hits.length === 0) return null;
  return (
    <DyNotice tone="amber" title={t.title} testId="dy-similar-record">
      <p className="m-0">{props.kind === 'job' ? t.job : t.automation}</p>
      <ul className="m-0 mt-1 grid list-none gap-0.5 p-0">
        {hits.map((h) => (
          <li key={h.id}>
            <Link
              to={
                h.kind === 'job'
                  ? `/jobs/${encodeURIComponent(h.id)}`
                  : `/automations/${encodeURIComponent(h.id)}`
              }
              className="font-bold underline underline-offset-2"
              data-testid="dy-similar-record-link"
            >
              {h.title}
            </Link>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1 text-[0.8125rem]">{t.hint}</p>
    </DyNotice>
  );
}

/**
 * Projeler → Hafıza: whether this project's jobs get similar successful jobs as hints in their context (project admins
 * change it; everyone who reads the project sees it). Hidden until the setting is read.
 */
export function RelatedContextSetting(props: {
  readonly project: string;
  readonly isAdmin: boolean;
}): ReactNode {
  const t = useT().related.settings;
  const act = useSubmit();
  const { data, set } = useResource<RelatedSettings>(
    (signal) => getRelatedSettings(props.project, { signal }),
    props.project,
  );
  const [saved, setSaved] = useState(false);
  if (data === null) return null;
  const off = !data.platform.context;
  return (
    <Panel title={t.title} testId="dy-related-setting">
      <div className="grid gap-2 px-4 pb-4">
        <DyCheck
          label={t.label}
          hint={t.hint}
          checked={data.contextEnabled && !off}
          disabled={!props.isAdmin || off || act.busy}
          onChange={(v) => {
            setSaved(false);
            void act.run(async () => {
              set(
                await setRelatedSettings({
                  project: props.project,
                  contextEnabled: v,
                  expectedVersion: data.version,
                }),
              );
              setSaved(true);
            });
          }}
        />
        {off ? (
          <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="related-setting-off">
            {t.platformOff}
          </p>
        ) : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
        {saved ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" role="status">
            {t.saved}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
