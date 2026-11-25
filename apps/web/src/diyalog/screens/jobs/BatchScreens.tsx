import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../../../api/client';
import { listProjects, type Project } from '../../../api/directory';
import {
  type BatchPreflight,
  type BatchState,
  getJobBatch,
  type JobBatch,
  listJobBatches,
  preflightJobBatch,
  submitJobBatch,
} from '../../../api/jobBatches';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { MAX_THREAD_PROJECTS } from '../../../api/chatKnowledge';
import { DyCheck, DyChoice, DyInput, DyTextarea } from '../kit';
import { DyButton, DyButtonLink, EmptyLine, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import type { Tone } from '../../tone';

/**
 * p18-multi-project W5 (docs/design/p18-multi-project.md §2.4): job fan-out batches — "aynı işi şu projelerde yap".
 * `/jobs/batches` lists the caller's batches, `/jobs/batches/new` submits one (projects, title, prompt, runtime →
 * "Kontrol et" shows per project whether it can run and why not → submit), `/jobs/batches/:id` shows each project's
 * job (state, pull request, cost) or why it was refused, and the total cost.
 */

const TONE: Readonly<Record<BatchState, Tone>> = {
  running: 'teal',
  done: 'green',
  failed: 'red',
  refused: 'amber',
};

const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;

/** A refusal code's words (an unknown code: the fallback). */
function refusalText(words: Readonly<Record<string, string>>, code: string, fallback: string): string {
  return Object.hasOwn(words, code) ? (words[code] ?? fallback) : fallback;
}

function asApiError(err: unknown): ApiError | null {
  return err instanceof ApiError ? err : null;
}

function jobTone(state: string): Tone {
  if (state === 'SUCCEEDED') return 'green';
  if (state === 'FAILED' || state === 'CANCELLED' || state === 'LOST') return 'red';
  if (state === 'AWAITING_APPROVAL' || state === 'PAUSED' || state === 'BLOCKED') return 'amber';
  return 'teal';
}

export function BatchListScreen(): ReactNode {
  const t = useT().multiProject.batch;
  const f = useFormat();
  const [items, setItems] = useState<JobBatch[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setError(null);
    listJobBatches().then(setItems, (err: unknown) => {
      setError(asApiError(err));
      setItems([]);
    });
  }, []);
  useEffect(load, [load]);
  return (
    <ScreenFrame
      title={t.title}
      purpose={t.sub}
      back={{ to: '/jobs', label: useT().nav.jobs }}
      actions={
        <DyButtonLink to="/jobs/batches/new" variant="primary" icon="plus">
          {t.new}
        </DyButtonLink>
      }
      testId="dy-batches"
    >
      <ErrorLine error={error} what={t.title} onRetry={load} />
      <Panel title={t.title} flush>
        {items === null ? (
          <SkeletonRows label={t.loading} />
        ) : items.length === 0 ? (
          <EmptyLine testId="dy-batches-empty">{t.empty}</EmptyLine>
        ) : (
          <Rows label={t.title}>
            {items.map((b) => (
              <Row
                key={b.id}
                flipKey={b.id}
                testId="dy-batch-row"
                title={
                  <Link to={`/jobs/batches/${encodeURIComponent(b.id)}`} className="font-bold text-dy-ink">
                    {b.title}
                  </Link>
                }
                meta={`${t.counts(b.counts)} · ${b.members.map((m) => m.project).join(', ')}`}
                trail={
                  <span className="flex items-center gap-2">
                    <Pill tone={TONE[b.state]}>{t.states[b.state]}</Pill>
                    <span className="text-[0.75rem] text-dy-muted">{f.relative(b.createdAt)}</span>
                  </span>
                }
              />
            ))}
          </Rows>
        )}
      </Panel>
    </ScreenFrame>
  );
}

export function BatchScreen(props: { readonly batchId: string }): ReactNode {
  const t = useT().multiProject;
  const f = useFormat();
  const [b, setB] = useState<JobBatch | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => {
    setError(null);
    getJobBatch(props.batchId).then(setB, (err: unknown) => {
      setError(asApiError(err));
    });
  }, [props.batchId]);
  useEffect(load, [load]);
  // Running jobs move on: a light refresh while anything runs.
  useEffect(() => {
    if (b?.state !== 'running') return;
    const timer = window.setInterval(load, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [b?.state, load]);
  const tb = t.batch;
  return (
    <ScreenFrame
      title={b?.title ?? tb.title}
      back={{ to: '/jobs/batches', label: tb.back }}
      live={b?.state === 'running' ? 'live' : undefined}
      facts={
        b === null ? null : (
          <span className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
            <Pill tone={TONE[b.state]}>{tb.states[b.state]}</Pill>
            <span data-testid="dy-batch-counts">{tb.counts(b.counts)}</span>
            <span>
              {`${tb.cost}: `}
              <b className="font-dy-mono text-dy-ink" data-testid="dy-batch-cost">
                {b.costUsd === null ? tb.costUnknown : f.usd(b.costUsd)}
              </b>
            </span>
            <span>{tb.created({ when: f.dateTime(b.createdAt) })}</span>
            <span>{tb.source[b.source]}</span>
            {b.threadId === null ? null : (
              <Link to={`/chat/${encodeURIComponent(b.threadId)}`} className="font-bold text-dy-teal-ink">
                {tb.openChat}
              </Link>
            )}
          </span>
        )
      }
      testId="dy-batch"
    >
      <ErrorLine error={error} what={tb.title} onRetry={load} />
      {b === null ? (
        error === null ? (
          <SkeletonRows label={tb.loading} />
        ) : null
      ) : (
        <>
          <Panel title={tb.project} flush testId="dy-batch-members">
            <Rows label={tb.project}>
              {b.members.map((m) => (
                <Row
                  key={m.project}
                  flipKey={m.project}
                  testId="dy-batch-member"
                  title={<span className="font-bold">{m.project}</span>}
                  meta={
                    m.refusal !== null
                      ? `${refusalText(t.refusals, m.refusal.code, t.refusals.refused)} — ${m.refusal.message}`
                      : m.job === null
                        ? tb.hidden
                        : (m.job.title ?? m.jobId ?? '')
                  }
                  trail={
                    m.job === null ? (
                      m.refusal === null ? null : (
                        <Pill tone="amber">
                          {refusalText(t.refusals, m.refusal.code, t.refusals.refused)}
                        </Pill>
                      )
                    ) : (
                      <span className="flex flex-wrap items-center gap-2">
                        <Pill tone={jobTone(m.job.state)}>{m.job.state}</Pill>
                        {m.job.costUsd === null ? null : (
                          <span className="font-dy-mono text-[0.75rem] text-dy-muted">
                            {f.usd(m.job.costUsd)}
                          </span>
                        )}
                        {m.job.pullRequest === null ? null : (
                          <a
                            href={m.job.pullRequest}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-[0.8125rem] font-bold text-dy-teal-ink"
                          >
                            {tb.pr}
                          </a>
                        )}
                        <Link to={m.job.link} className="text-[0.8125rem] font-bold text-dy-teal-ink">
                          {tb.openJob}
                        </Link>
                      </span>
                    )
                  }
                />
              ))}
            </Rows>
          </Panel>
          <Panel title={tb.prompt}>
            <p className="m-0 text-[0.875rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{b.prompt}</p>
            <p className="m-0 mt-2 text-[0.8125rem] text-dy-muted">
              {`${tb.runtime}: `}
              <span className="font-dy-mono">{b.runtime}</span>
            </p>
          </Panel>
        </>
      )}
    </ScreenFrame>
  );
}

export function BatchNewScreen(): ReactNode {
  const t = useT().multiProject;
  const tf = t.batch.form;
  const sayError = useErrorText();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntime] = useState<string>('claude-code');
  const [check, setCheck] = useState<BatchPreflight | null>(null);
  const [busy, setBusy] = useState<'check' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listProjects().then(setProjects, (err: unknown) => {
      setError(sayError(err));
      setProjects([]);
    });
  }, []);
  // Any change makes the last check stale.
  useEffect(() => {
    setCheck(null);
  }, [chosen, title, prompt, runtime]);
  const body = { projects: chosen, spec: { title: title.trim(), prompt: prompt.trim(), runtime } };
  const complete = chosen.length > 0 && body.spec.title !== '' && body.spec.prompt !== '';
  async function run(kind: 'check' | 'submit'): Promise<void> {
    setBusy(kind);
    setError(null);
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
  }
  return (
    <ScreenFrame
      title={tf.title}
      back={{ to: '/jobs/batches', label: t.batch.back }}
      width="narrow"
      testId="dy-batch-new"
    >
      <div className="grid gap-4">
        <fieldset className="m-0 grid gap-2 border-0 p-0" data-testid="dy-batch-projects">
          <legend className="mb-1 text-[0.8125rem] font-bold">{tf.projects}</legend>
          <p className="m-0 text-[0.78125rem] text-dy-muted">{tf.projectsHint}</p>
          {projects === null ? (
            <SkeletonRows label={t.thread.loading} rows={2} />
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {projects.map((p) => (
                <DyCheck
                  key={p.id}
                  label={p.name === p.id ? p.id : `${p.name} (${p.id})`}
                  checked={chosen.includes(p.id)}
                  disabled={!chosen.includes(p.id) && chosen.length >= MAX_THREAD_PROJECTS}
                  onChange={(v) => {
                    setChosen((prev) => (v ? [...prev, p.id] : prev.filter((x) => x !== p.id)));
                  }}
                />
              ))}
            </div>
          )}
        </fieldset>
        <DyInput
          label={tf.jobTitle}
          value={title}
          maxLength={200}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
        <DyTextarea
          label={tf.prompt}
          hint={tf.promptHint}
          value={prompt}
          maxLength={32_000}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
        />
        <DyChoice
          label={tf.runtime}
          value={runtime}
          options={RUNTIMES.map((r) => [r, r] as const)}
          onChange={setRuntime}
        />
        {check === null ? null : <BatchCheck check={check} />}
        {error === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <DyButton
            variant="secondary"
            busy={busy === 'check'}
            disabled={!complete || busy !== null}
            onClick={() => void run('check')}
            data-testid="dy-batch-check-button"
          >
            {busy === 'check' ? tf.checking : tf.check}
          </DyButton>
          <DyButton
            variant="primary"
            busy={busy === 'submit'}
            disabled={!complete || busy !== null || (check !== null && check.ready.length === 0)}
            onClick={() => void run('submit')}
            data-testid="dy-batch-submit"
          >
            {busy === 'submit' ? tf.submitting : tf.submit({ n: check?.ready.length ?? chosen.length })}
          </DyButton>
          {chosen.length === 0 ? <span className="text-[0.8125rem] text-dy-muted">{tf.pickTwo}</span> : null}
          <DyButtonLink to="/jobs/batches" variant="ghost">
            {tf.cancel}
          </DyButtonLink>
        </div>
      </div>
    </ScreenFrame>
  );
}

/** The preflight of a batch: per project ready (or waiting, and why) or refused with its reason. */
export function BatchCheck(props: { readonly check: BatchPreflight }): ReactNode {
  const t = useT().multiProject;
  const tf = t.batch.form;
  const { check } = props;
  return (
    <Panel title={tf.check} flush testId="dy-batch-check">
      <Rows label={tf.check}>
        {check.ready.map((r) => (
          <Row
            key={r.project}
            title={<span className="font-bold">{r.name}</span>}
            meta={[r.repository ?? t.cards.jobBatch.workspace, ...r.waits].join(' · ')}
            trail={
              <Pill tone={r.waits.length > 0 ? 'amber' : 'green'}>
                {r.waits.length > 0 ? tf.waits : tf.ready}
              </Pill>
            }
          />
        ))}
        {check.refused.map((r) => (
          <Row
            key={r.project}
            title={<span className="font-bold">{r.project}</span>}
            meta={r.message}
            trail={<Pill tone="red">{refusalText(t.refusals, r.code, tf.refused)}</Pill>}
          />
        ))}
      </Rows>
    </Panel>
  );
}
