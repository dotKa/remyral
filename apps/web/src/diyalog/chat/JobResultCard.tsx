import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getJobAutonomy, type JobAutonomy } from '../../api/autonomy';
import { draftJobAction } from '../../api/chat';
import { getJobDeployOnSuccess, type JobDeployOnSuccess, safeHttpsUrl } from '../../api/deployOnSuccess';
import { getChanges, type JobChanges } from '../../api/gitflow';
import { getJobIntegration, type IntegrationView, safePullRequestUrl } from '../../api/integration';
import { getJob, type JobDetail, type PlatformOutcome } from '../../api/jobs';
import { getJobVerification, type JobVerification } from '../../api/verify';
import { getLogs } from '../../api/live';
import { fileUrl, listOutputs, type OutputItem } from '../../api/outputs';
import { listUsageCosts } from '../../api/usage';
import { getOutputReport, type OutputReport } from '../../api/workspaces';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { useDescribeReason } from '../../i18n/reasons';
import { machineName, useMachineNames } from '../../lib/machineDirectory';
import { costByJob, firstLine, jobDurationMs, RERUNNABLE } from '../../screens/job/format';
import { DyDialog } from '../DyDialog';
import { DyIcon, type IconName } from '../icons';
import { fixState } from '../job/AutoActivityPanel';
import { causeWords, platformPill, platformTitle } from '../job/platform';
import type { Tone } from '../tone';
import { OutputReportNotices } from '../job/details/OutputReport';
import { DyPopover } from '../Popover';
import { DyFileViewer, DySiteBundle } from '../screens/outputs/Preview';
import { DyImageGrid, DyLightbox, type LightboxImage } from '../screens/outputs/Lightbox';
import { DyMarkdown } from '../screens/outputs/shared';
import { type DyState, StateBadge } from '../StateBadge';
import { useChatActions } from './chatActions';
import { ContinueAfterTimeoutButton } from '../common/jobClock';

/**
 * p15-chat-cards-scroll: two bare links ("İşi aç", "Çıktılar") said too little about a finished job, so it gets a
 * compact card instead. A finished job's note in the Sohbet thread carries the job id (`meta.jobId`); this
 * card under the note's text reads the job fresh and shows, compactly:
 *
 *   header    kind, title, state chip (Bitti / Başarısız / Onay bekliyor …), duration, machine (display name), cost
 *   summary   the agent's own result summary, one or two lines (untrusted text: plain, never Markdown)
 *   actions   "Raporu aç" (the master's primary output) · "Çıktılar (N) ▾" (the first 5, "Tümünü gör →") · "İşi aç";
 *             a failure adds its reason and "Düzelt" (a fix request in the composer)
 *   details   (expanded) files changed, PR / merge state, the live address, the last log lines of a failure, the
 *             automatic retry / fix state (p15-auto-mode), "Yeniden çalıştır" (a run-again card in this chat)
 *
 * An output opens in a side drawer over the conversation with the Outputs screen's own previews — no navigation away.
 */

const PREVIEW_ITEMS = 5;
/** p20-chat-images: image outputs shown as thumbnails on the card itself (the last one "+N" when there are more). */
const CARD_IMAGES = 4;
const LOG_LINES = 5;

const STATE_OF: Readonly<Record<string, { readonly state: DyState; readonly word: StateWord }>> = {
  SUCCEEDED: { state: 'done', word: 'succeeded' },
  FAILED: { state: 'failed', word: 'failed' },
  LOST: { state: 'failed', word: 'failed' },
  CANCELLED: { state: 'cancelled', word: 'cancelled' },
  AWAITING_APPROVAL: { state: 'needs', word: 'awaiting' },
  PAUSED: { state: 'paused', word: 'paused' },
  QUEUED: { state: 'queued', word: 'queued' },
  DRAFT: { state: 'queued', word: 'queued' },
  BLOCKED: { state: 'queued', word: 'queued' },
  RETRY_WAIT: { state: 'queued', word: 'queued' },
};
type StateWord = 'succeeded' | 'failed' | 'cancelled' | 'awaiting' | 'running' | 'queued' | 'paused';

/** p19-verifier-jobs: a verifier outcome pill's tone as a badge state. */
const PILL_STATE: Readonly<Partial<Record<Tone, DyState>>> = {
  green: 'done',
  amber: 'needs',
  teal: 'running',
  neutral: 'cancelled',
};

interface Base {
  readonly detail: JobDetail;
  readonly outputs: {
    readonly items: readonly OutputItem[];
    readonly total: number;
    readonly primary: string | null;
  };
  readonly costUsd: number | null;
  /** p17-output-limits: the zip / not-returned facts of a workspace job (null: none, or not a workspace job). */
  readonly outputReport: OutputReport | null;
  /** p19-verifier-jobs: the job's automatic verification (null: none / unreadable). */
  readonly verification: JobVerification | null;
}

/** p19-verifier-jobs: a verification state as the outcome words of the platform verifier vocabulary. */
const VERIFY_OUTCOME: Readonly<Record<string, PlatformOutcome>> = {
  waiting: 'running',
  checking: 'running',
  verifying: 'running',
  passed: 'verified',
  warned: 'verified',
  failed: 'issues',
  error: 'unverifiable',
};

interface Extra {
  readonly changes: JobChanges | null;
  readonly integration: IntegrationView | null;
  readonly deploy: JobDeployOnSuccess | null;
  readonly autonomy: JobAutonomy | null;
  readonly log: readonly string[];
}

const settled = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);

/** The job's title: its own title (p15-job-titles) or the first line of its prompt. */
export function jobTitle(detail: JobDetail): string {
  const spec = detail.job.spec;
  if (typeof spec.title === 'string' && spec.title.trim() !== '') return spec.title.trim();
  return firstLine(typeof spec.prompt === 'string' ? spec.prompt : '') || detail.job.id.slice(0, 8);
}

function typeIcon(item: OutputItem): IconName {
  if (item.type === 'site') return 'globe';
  if (item.type === 'note') return 'msg';
  return 'file';
}

/** p22-timeout-continuity: what a job stopped by its time limit kept (the chat note's `meta.jobKept`). */
export interface JobKept {
  readonly branch: string;
  readonly files: number;
  readonly pushed: boolean;
  /** The machine that keeps it when it was not pushed. */
  readonly workerId: string | null;
}

/** The kept work a `job-result` note carries, or null. */
export function jobKeptOf(meta: unknown): JobKept | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const k = (meta as { jobKept?: unknown }).jobKept;
  if (typeof k !== 'object' || k === null) return null;
  const o = k as Record<string, unknown>;
  if (typeof o.branch !== 'string' || typeof o.files !== 'number') return null;
  return {
    branch: o.branch,
    files: Math.max(0, Math.round(o.files)),
    pushed: o.pushed === true,
    workerId: typeof o.workerId === 'string' ? o.workerId : null,
  };
}

export function JobResultCard(props: {
  readonly jobId: string;
  /** The summary the note carried (shown until the job is read; the job's own one wins). */
  readonly summary?: string | null | undefined;
  /** p20-job-clock: the note says it stopped on its time limit — "Aynı yerden devam et" up front. */
  readonly timedOut?: boolean | undefined;
  /** p22-timeout-continuity: the unfinished work its machine kept when the time ran out (`meta.jobKept`). */
  readonly kept?: JobKept | null | undefined;
}): ReactNode {
  const t = useT();
  const w = t.chat.jobResult;
  const f = useFormat();
  const sayError = useErrorText();
  const describe = useDescribeReason();
  const names = useMachineNames();
  const actions = useChatActions();
  const uid = useId();
  const { jobId } = props;
  const [base, setBase] = useState<Base | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [extra, setExtra] = useState<Extra | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<OutputItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const thumbs = useRef(new Map<number, HTMLButtonElement>());
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const signal = ctl.signal;
    void Promise.allSettled([
      getJob(jobId, { signal }),
      listOutputs({ job: jobId, limit: 50 }, { signal }),
      listUsageCosts({ job: jobId }, { signal }),
      getOutputReport(jobId, { signal }),
      getJobVerification(jobId, { signal }),
    ]).then(([d, o, c, r, v]) => {
      if (signal.aborted) return;
      if (d.status === 'rejected') {
        setError(sayError(d.reason));
        return;
      }
      const out = settled(o);
      const cost = settled(c);
      const jc = cost === null ? undefined : costByJob(cost).get(jobId);
      setBase({
        detail: d.value,
        outputs: {
          items: out?.items ?? [],
          total: out?.total ?? 0,
          primary: out?.primaryOutputId ?? null,
        },
        costUsd: jc === undefined || jc.subscription || jc.usd <= 0 ? null : jc.usd,
        outputReport: settled(r),
        verification: settled(v),
      });
    });
    return () => {
      ctl.abort();
    };
  }, [jobId, sayError]);

  const state = base?.detail.job.state ?? null;
  const failed = state === 'FAILED' || state === 'LOST';
  useEffect(() => {
    if (!expanded || base === null) return;
    const ctl = new AbortController();
    const signal = ctl.signal;
    void Promise.allSettled([
      getChanges(jobId, { signal }),
      getJobIntegration(jobId, { signal }),
      getJobDeployOnSuccess(jobId, { signal }),
      getJobAutonomy(jobId, { signal }),
      failed ? getLogs(jobId, { tail: true, limit: LOG_LINES }, { signal }) : Promise.resolve(null),
    ]).then(([ch, ig, dp, au, lg]) => {
      if (signal.aborted) return;
      const logs = settled(lg);
      setExtra({
        changes: settled(ch),
        integration: settled(ig),
        deploy: settled(dp),
        autonomy: settled(au),
        log: (logs?.items ?? [])
          .map((l) => l.text.replace(/\s+$/u, ''))
          .filter((l) => l !== '')
          .slice(-LOG_LINES),
      });
    });
    return () => {
      ctl.abort();
    };
  }, [expanded, base, jobId, failed]);

  // The outputs menu: focus its first item, close on an outside press.
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target !== null && !menu.current?.contains(target) && !menuButton.current?.contains(target))
        setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  if (error !== null)
    return (
      <p className="m-0 mt-1 text-[0.8125rem] text-dy-red-ink" role="alert" data-testid="job-result-error">
        {w.readError({ error })}
      </p>
    );
  if (base === null)
    return (
      <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted" role="status" data-testid="job-result-loading">
        {w.loading}
      </p>
    );

  const d = base.detail;
  const title = platformTitle(d.job.platform, jobTitle(d), t);
  const look = STATE_OF[d.job.state] ?? { state: 'running' as const, word: 'running' as const };
  // p19-verifier-jobs: a platform verifier's card shows its outcome; any job's card shows its verification's outcome.
  const platform = platformPill(d.job.platform, t);
  const vOutcome = base.verification === null ? undefined : VERIFY_OUTCOME[base.verification.state];
  const vCause = base.verification?.state === 'error' ? causeWords(base.verification.errorCause, t) : null;
  const ended = look.word === 'succeeded' || look.word === 'failed' || look.word === 'cancelled';
  const duration = f.duration(jobDurationMs({ ...d.job }, Date.now()));
  const worker = d.attempts.at(-1)?.workerId ?? null;
  const summary = (d.resultSummary ?? props.summary ?? '').trim();
  // p22-run-attention: done, but its agent said it could not (fully) do the task.
  const attention = d.job.state === 'SUCCEEDED' ? (d.resultAttention ?? null) : null;
  const primary = base.outputs.items.find((i) => i.key === base.outputs.primary) ?? null;
  const shown = base.outputs.items.slice(0, PREVIEW_ITEMS);
  // p20-chat-images: a finished job's image outputs (screenshots …) are visible in the conversation itself.
  const images = ended ? outputImages(base.outputs.items).map((x) => x.image) : [];
  const failure = failed ? failureText(d, describe) : null;
  const short = d.job.id.slice(0, 8);

  const openPreview = (item: OutputItem): void => {
    setMenuOpen(false);
    setPreview(item);
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      menuButton.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      setMenuOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const rerun = async (): Promise<void> => {
    if (actions === null) return;
    setBusy(true);
    setNotice(null);
    try {
      await draftJobAction(actions.threadId, { action: 'run_again', jobIds: [d.job.id] });
      setNotice(w.rerunDrafted);
      actions.reload();
    } catch (err) {
      setNotice(sayError(err));
    } finally {
      setBusy(false);
    }
  };

  const btn =
    'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-[9px] px-3 text-[0.8125rem] font-bold sm:min-h-8';
  const rerunButton =
    // p19-verifier-jobs: a platform verifier is never run again as ordinary work (its verification has a retry).
    actions !== null && platform === null && RERUNNABLE.has(d.job.state) ? (
      <button
        type="button"
        className={cx(btn, 'self-start border border-dy-line-2 text-dy-ink')}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => {
          void rerun();
        }}
        data-testid="job-result-rerun"
      >
        <DyIcon name="retry" className="size-4" />
        {w.rerun}
      </button>
    ) : null;
  // p22-timeout-continuity: a job stopped by its time limit is "Süre doldu" — not failed, not cancelled — and continues
  // from its kept work ("Aynı yerden devam et" up front; running it again from scratch stays under the details).
  const expired = props.timedOut === true && (failed || d.job.state === 'CANCELLED');
  const rerunUpFront = (failed || d.job.state === 'CANCELLED') && !expired;
  const kept = expired ? (props.kept ?? null) : null;
  const tc = t.timeLimits.clock;
  const facts: ReactNode[] = [];
  if (extra !== null) {
    const files = extra.changes?.totals.files ?? 0;
    if (files > 0) facts.push(<li key="files">{w.files({ n: files })}</li>);
    const ig = extra.integration;
    if (ig !== null) {
      const pr = ig.pullRequest === null ? null : safePullRequestUrl(ig.pullRequest.url);
      facts.push(
        <li key="merge">
          {w.merge({ state: t.jobCards.integration.states[ig.state] })}
          {ig.pullRequest === null ? null : (
            <>
              {' · '}
              {pr === null ? (
                w.pullRequest({ n: ig.pullRequest.number })
              ) : (
                <a href={pr} target="_blank" rel="noopener noreferrer" className="text-dy-teal-ink underline">
                  {w.pullRequest({ n: ig.pullRequest.number })}
                </a>
              )}
            </>
          )}
        </li>,
      );
    }
    const live = safeHttpsUrl(extra.deploy?.url ?? null);
    if (live !== null)
      facts.push(
        <li key="live">
          {w.live}:{' '}
          <a href={live} target="_blank" rel="noopener noreferrer" className="text-dy-teal-ink underline">
            {live}
          </a>
        </li>,
      );
  }
  const auto = extra?.autonomy ?? null;
  const a = t.autoMode.job;

  return (
    <article
      aria-label={title}
      data-testid="job-result-card"
      data-state={d.job.state}
      className="dy-m-result mt-2 flex min-w-0 max-w-[36rem] flex-col gap-1.5 rounded-[12px] border border-dy-line bg-dy-card px-3 py-2.5 shadow-dy"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[0.6875rem] font-bold tracking-[0.04em] text-dy-muted uppercase">
          {w.kind}
        </span>
        {platform === null && attention !== null ? (
          <StateBadge state="needs" label={w.attention} />
        ) : platform === null ? (
          <StateBadge
            state={expired ? 'stale' : look.state}
            label={expired ? tc.expired : w.states[look.word]}
          />
        ) : (
          <StateBadge state={PILL_STATE[platform.tone] ?? 'cancelled'} label={platform.label} />
        )}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${uid}-more`}
          aria-label={expanded ? w.collapse : w.expand}
          title={expanded ? w.collapse : w.expand}
          onClick={() => {
            setExpanded((v) => !v);
          }}
          data-testid="job-result-toggle"
          className="dy-press ml-auto grid size-11 shrink-0 place-items-center rounded-[8px] text-dy-muted sm:size-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
        >
          <DyIcon
            name="chev"
            className={cx(
              'size-4 transition-transform motion-reduce:transition-none',
              expanded ? '' : '-rotate-90',
            )}
          />
        </button>
      </div>
      <p className="m-0 line-clamp-2 text-[0.9375rem] font-bold [overflow-wrap:anywhere]">{title}</p>
      <p
        className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.78125rem] text-dy-muted"
        data-testid="job-result-facts"
      >
        {ended || look.word === 'running' ? (
          <span className="tabular-nums">{w.duration({ time: duration })}</span>
        ) : null}
        {worker === null ? null : <span>{w.machine({ name: machineName(names, worker) })}</span>}
        {base.costUsd === null ? null : (
          <span className="tabular-nums">{w.cost({ cost: f.usd(base.costUsd) })}</span>
        )}
      </p>
      {expired ? (
        <p
          className="m-0 text-[0.84375rem] text-dy-ink [overflow-wrap:anywhere]"
          data-testid="job-result-kept"
        >
          {kept === null
            ? tc.timedOut
            : kept.pushed
              ? tc.keptPushed({ files: kept.files, branch: kept.branch })
              : tc.keptLocal({
                  files: kept.files,
                  machine: kept.workerId === null ? '—' : machineName(names, kept.workerId),
                })}
        </p>
      ) : summary === '' ? null : (
        <p
          className="m-0 line-clamp-2 text-[0.84375rem] text-dy-ink [overflow-wrap:anywhere]"
          data-testid="job-result-summary"
        >
          {summary}
        </p>
      )}
      {attention === null ? null : (
        <p
          className="m-0 text-[0.84375rem] text-dy-amber-ink [overflow-wrap:anywhere]"
          data-testid="job-result-attention"
        >
          <b>{w.attentionKinds[attention.kind]}</b>
          {attention.note === '' ? null : <span> — {attention.note}</span>}
        </p>
      )}
      {vOutcome === undefined ? null : (
        <p
          className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]"
          data-testid="job-result-verification"
        >
          {t.verifierJobs.resultLine({ outcome: t.verifierJobs.outcome[vOutcome] })}
          {vCause === null ? null : ` · ${t.verifierJobs.couldNotRun({ cause: vCause })}`}
        </p>
      )}
      {failure === null || platform !== null || expired ? null : (
        <p
          className="m-0 text-[0.8125rem] text-dy-red-ink [overflow-wrap:anywhere]"
          data-testid="job-result-failure"
        >
          <span className="font-bold">{w.errorTitle}: </span>
          {failure}
        </p>
      )}
      {images.length === 0 ? null : (
        <ul
          aria-label={w.imagesLabel({ n: images.length })}
          className="m-0 grid list-none grid-cols-2 gap-1.5 p-0 sm:grid-cols-4"
          data-testid="job-result-images"
        >
          {images.slice(0, CARD_IMAGES).map((img, i) => {
            // The last tile covers the rest: "+N" counts it and the ones after it, and opens the lightbox at it.
            const more = i === CARD_IMAGES - 1 && images.length > CARD_IMAGES ? images.length - i : 0;
            return (
              <li key={img.src} className="min-w-0">
                <button
                  ref={(el) => {
                    if (el === null) thumbs.current.delete(i);
                    else thumbs.current.set(i, el);
                  }}
                  type="button"
                  onClick={() => {
                    setZoom(i);
                  }}
                  aria-label={more > 0 ? w.moreImagesLabel({ n: more }) : w.openImage({ name: img.name })}
                  title={img.name}
                  className="relative grid aspect-[4/3] min-h-11 w-full place-items-center overflow-hidden rounded-[8px] border border-dy-line bg-dy-sunk p-0 outline-none focus-visible:ring-2 focus-visible:ring-dy-teal"
                  data-testid="job-result-image"
                >
                  <img
                    src={img.src}
                    alt={img.name}
                    loading="lazy"
                    decoding="async"
                    className="block h-full w-full object-contain"
                  />
                  {more > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 grid place-items-center bg-dy-lightbox-ctl text-[0.9375rem] font-bold text-white"
                    >
                      {w.moreImages({ n: more })}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <DyLightbox
        images={images}
        index={zoom}
        onIndex={setZoom}
        wrap={false}
        returnFocus={(at) => thumbs.current.get(Math.min(at, CARD_IMAGES - 1)) ?? null}
        onClose={() => {
          setZoom(null);
        }}
      />
      <OutputReportNotices report={base.outputReport} compact jobId={d.job.id} />
      <div className="flex flex-wrap items-center gap-1.5">
        {primary === null ? null : (
          <button
            type="button"
            className={cx(btn, 'bg-dy-teal text-dy-on-fill')}
            onClick={() => {
              openPreview(primary);
            }}
            data-testid="job-result-report"
          >
            <DyIcon name="file" className="size-4" />
            {w.openReport}
          </button>
        )}
        {base.outputs.total === 0 ? null : (
          <>
            <button
              ref={menuButton}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? `${uid}-menu` : undefined}
              onClick={() => {
                setMenuOpen((v) => !v);
              }}
              className={cx(btn, 'border border-dy-line-2 bg-dy-card text-dy-ink')}
              data-testid="job-result-outputs"
            >
              {w.outputs({ n: base.outputs.total })}
              <DyIcon name="chev" className="size-3.5" />
            </button>
            <DyPopover
              open={menuOpen}
              anchorRef={menuButton}
              panelRef={menu}
              onDismiss={() => {
                setMenuOpen(false);
              }}
              id={`${uid}-menu`}
              role="menu"
              ariaLabel={w.outputsMenu}
              onKeyDown={onMenuKey}
              className="w-72 p-1"
              sheetClassName="p-2"
              testId="job-result-menu"
            >
              {shown.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    openPreview(item);
                  }}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[0.84375rem] outline-none focus-visible:bg-dy-sunk sm:min-h-9 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
                >
                  <DyIcon name={typeIcon(item)} className="size-4 shrink-0 text-dy-muted" />
                  <span className="min-w-0 flex-1 truncate">{item.title ?? item.name}</span>
                  <span className="shrink-0 text-[0.75rem] text-dy-faint">
                    {item.file?.sizeBytes != null ? f.bytes(item.file.sizeBytes) : w.types[item.type]}
                  </span>
                </button>
              ))}
              <Link
                role="menuitem"
                to={`/outputs?job=${encodeURIComponent(d.job.id)}`}
                className="flex min-h-11 items-center rounded-[8px] px-2.5 text-[0.84375rem] font-bold text-dy-teal-ink no-underline outline-none focus-visible:bg-dy-sunk sm:min-h-9"
              >
                {w.allOutputs}
              </Link>
            </DyPopover>
          </>
        )}
        <Link
          to={`/jobs/${encodeURIComponent(d.job.id)}`}
          className={cx(btn, 'text-dy-teal-ink underline underline-offset-2')}
        >
          {w.openJob}
        </Link>
        {failed && platform === null && actions !== null && !expired ? (
          <button
            type="button"
            className={cx(btn, 'border border-dy-red/40 text-dy-red-ink')}
            onClick={() => {
              actions.ask(w.fixAsk({ short, title }));
            }}
            data-testid="job-result-fix"
          >
            <DyIcon name="retry" className="size-4" />
            {w.fix}
          </button>
        ) : null}
        {/* p18-outputs-delivery: a failed / cancelled job offers "Yeniden çalıştır" right away (not under details). */}
        {rerunUpFront ? rerunButton : null}
      </div>
      {/* p20-job-clock: a job that stopped on its time limit continues from where it was (a longer limit). */}
      {expired && actions !== null ? (
        <ContinueAfterTimeoutButton jobId={d.job.id} continueSec={null} />
      ) : null}
      {notice === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted" role="status" data-testid="job-result-notice">
          {notice}
        </p>
      )}
      <div id={`${uid}-more`} hidden={!expanded} className="flex flex-col gap-2 border-t border-dy-line pt-2">
        {expanded && extra === null ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted" role="status">
            {w.loading}
          </p>
        ) : null}
        {facts.length === 0 ? null : (
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]" data-testid="job-result-more-facts">
            {facts}
          </ul>
        )}
        {auto === null ? null : (
          <>
            {auto.retry?.waiting === true ? (
              <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="job-result-retry">
                {a.retrying({ n: auto.retry.used, max: auto.retry.max })}
              </p>
            ) : null}
            {auto.fix?.fixJobId == null ? null : (
              <p className="m-0 text-[0.8125rem]" data-testid="job-result-autofix">
                {auto.fix.state === 'created'
                  ? a.fixOpened
                  : a.fixDone({ state: fixState(a, auto.fix.state) })}{' '}
                <Link to={`/jobs/${auto.fix.fixJobId}`} className="text-dy-teal-ink underline">
                  {a.fixLink}
                </Link>
              </p>
            )}
          </>
        )}
        {extra !== null && extra.log.length > 0 ? (
          <div>
            <p className="m-0 mb-1 text-[0.75rem] font-bold text-dy-muted">{w.logTitle}</p>
            <pre
              className="m-0 max-h-40 overflow-auto rounded-[8px] bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
              data-testid="job-result-log"
            >
              {extra.log.join('\n')}
            </pre>
          </div>
        ) : null}
        {rerunUpFront ? null : rerunButton}
      </div>
      <OutputDrawer
        item={preview}
        items={base.outputs.items}
        onClose={() => {
          setPreview(null);
        }}
      />
    </article>
  );
}

/** Why the job failed: its failing transition's reason in the reader's words (params from the attempt's error). */
function failureText(d: JobDetail, describe: ReturnType<typeof useDescribeReason>): string | null {
  const last = [...d.transitions]
    .reverse()
    .find((x) => (x.to === 'FAILED' || x.to === 'LOST') && x.reason !== null);
  if (last?.reason == null) return null;
  const params = d.runErrors?.find((e) => e.attemptId === last.attemptId)?.params ?? null;
  return describe(last.reason, {}, params).sentence;
}

/** One output previewed in a side sheet over the conversation (the Outputs screen's own previews). */
/** p15-workspace-retention: the images among a job's outputs, in order (the lightbox's sequence). */
export function outputImages(items: readonly OutputItem[]): { key: string; image: LightboxImage }[] {
  return items.flatMap((i) =>
    i.file !== null && i.file.preview === 'image' && i.file.download !== null && i.file.removed === null
      ? [
          {
            key: i.key,
            image: {
              src: fileUrl(i.file.download, true),
              name: i.title ?? i.name,
              download: fileUrl(i.file.download, false),
            },
          },
        ]
      : [],
  );
}

export function OutputDrawer(props: {
  readonly item: OutputItem | null;
  /** p15-workspace-retention: the job's other outputs (images: thumbnails + lightbox next / previous). */
  readonly items?: readonly OutputItem[];
  readonly onClose: () => void;
}): ReactNode {
  const w = useT().chat.jobResult;
  const item = props.item;
  const name = item === null ? '' : (item.title ?? item.name);
  const images = outputImages(props.items ?? (item === null ? [] : [item]));
  const at = item === null ? -1 : images.findIndex((x) => x.key === item.key);
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <DyDialog
      open={item !== null}
      onClose={props.onClose}
      size="sheet"
      title={w.previewTitle({ name })}
      testId="job-result-drawer"
    >
      {item === null ? null : (
        <div className="flex flex-col gap-3">
          <p className="m-0 flex flex-wrap gap-x-3 text-[0.8125rem]">
            {item.file?.download != null && item.file.removed === null ? (
              <a href={fileUrl(item.file.download, false)} className="text-dy-teal-ink underline" download>
                {w.download}
              </a>
            ) : null}
            <Link
              to={`/outputs?job=${encodeURIComponent(item.jobId ?? '')}&key=${encodeURIComponent(item.key)}`}
              className="text-dy-teal-ink underline"
            >
              {w.openInOutputs}
            </Link>
          </p>
          {item.file !== null ? (
            <DyFileViewer
              file={item.file}
              jobId={item.jobId}
              name={item.name}
              {...(at < 0 ? {} : { gallery: { images: images.map((x) => x.image), index: at } })}
            />
          ) : item.type === 'site' && item.jobId !== null ? (
            <DySiteBundle jobId={item.jobId} />
          ) : item.note !== null ? (
            <DyMarkdown source={item.note.body} />
          ) : null}
          {images.length > 1 ? (
            <>
              <DyImageGrid
                images={images.map((x) => x.image)}
                onOpen={(i) => {
                  setZoom(i);
                }}
              />
              <DyLightbox
                images={images.map((x) => x.image)}
                index={zoom}
                onIndex={setZoom}
                onClose={() => {
                  setZoom(null);
                }}
              />
            </>
          ) : null}
        </div>
      )}
    </DyDialog>
  );
}
