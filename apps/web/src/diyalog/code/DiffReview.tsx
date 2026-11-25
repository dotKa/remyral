import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  addCompareComment,
  addReviewComment,
  compareFile,
  compareRefs,
  compareRequestChanges,
  type CompareReviewTarget,
  deleteCompareComment,
  deleteReviewComment,
  type FilePair,
  getJobReview,
  getJobReviewFile,
  listCompareComments,
  listReviewComments,
  type RejectedHunk,
  requestChanges,
  type ReviewComment,
  type ReviewFile,
  updateCompareComment,
  updateReviewComment,
} from '../../api/code';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';
import { usePhoneSheet } from '../floating';
import { DyIcon } from '../icons';
import { DyButton, DyButtonLink, EmptyLine, Pill, SkeletonRows } from '../screens/parts';
import type { LineRange } from './cm';
import { type DiffApi, DiffPane } from './CodeEditor';
import { addToChat } from './chatRef';
import { computeHunks, type Hunk, hunkKey } from './hunks';

/**
 * p19-ide W1 (docs/design/p19-ide.md §5): the diff reviewer — a job's verified changes (base...head, the job page's
 * Değişiklikler and `/projects/:id/code/jobs/:jobId`) or two refs compared (`/projects/:id/code/compare`). Per file:
 * side by side (MergeView) or inline (unified; the phone default), the changed hunks with "Yorum yaz", "Reddet" and
 * "Sohbete ekle", selected lines with the same actions, and the comment threads. "Değişiklik iste" sends the open
 * threads, the rejected hunks and a note to the job (a message to its agent, or a follow-up job); the master re-reads
 * the rejected lines itself. Nothing here writes to a branch.
 *
 * p18-last-gaps: a compare view has comments too (anchored to its refs and the commits it shows); its "Değişiklik iste"
 * goes where the master says — the job whose branch the head is, a new job on an open pull request's branch, or it is
 * disabled with the reason.
 */

/** The comment writes of one review (a job's, or a compare view's). */
interface CommentApi {
  add(input: {
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly startLine: number;
    readonly endLine: number;
    readonly body: string;
    readonly parentId?: string;
  }): Promise<unknown>;
  update(id: string, body: { readonly body?: string; readonly resolved?: boolean }): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export type ReviewTarget =
  | { readonly kind: 'job'; readonly jobId: string; readonly project: string }
  | { readonly kind: 'compare'; readonly project: string; readonly base: string; readonly head: string };

interface Loaded {
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly ReviewFile[];
  readonly truncated: boolean;
  readonly supported: boolean;
}

type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

const MODE_KEY = 'remyral.diffMode';

const rangeText = (a: number, b: number): string => (a === b ? String(a) : `${String(a)}-${String(b)}`);

function storedMode(): 'side' | 'inline' | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'side' || v === 'inline' ? v : null;
  } catch {
    return null;
  }
}

/** The new side's lines of a hunk, else its old side's (a pure deletion). */
function hunkLines(h: Hunk): { side: 'old' | 'new'; start: number; end: number } | null {
  if (h.newStart !== null && h.newEnd !== null) return { side: 'new', start: h.newStart, end: h.newEnd };
  if (h.oldStart !== null && h.oldEnd !== null) return { side: 'old', start: h.oldStart, end: h.oldEnd };
  return null;
}

export function DiffReview(props: {
  readonly target: ReviewTarget;
  /** Operator: comments and "Değişiklik iste". */
  readonly canReview: boolean;
  /** Embedded in the job page: a link to the full-screen reviewer. */
  readonly fullScreenLink?: boolean | undefined;
  /** p19-ide W4: the file to show first (`?path=` of an assistant's "Aç" card); ignored when it did not change. */
  readonly initialPath?: string | undefined;
}): ReactNode {
  const all = useT();
  const t = all.code;
  const sayError = useErrorText();
  const phone = usePhoneSheet();
  const { target } = props;
  const isJob = target.kind === 'job';
  const key = target.kind === 'job' ? `job:${target.jobId}` : `cmp:${target.base}...${target.head}`;
  const [review, setReview] = useState<Load<Loaded>>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<Load<FilePair> | null>(null);
  const [mode, setMode] = useState<'side' | 'inline'>(() => storedMode() ?? (phone ? 'inline' : 'side'));
  const [filter, setFilter] = useState('');
  const [comments, setComments] = useState<Load<ReviewComment[]>>({ kind: 'loading' });
  const [rejected, setRejected] = useState<ReadonlyMap<string, RejectedHunk>>(new Map());
  const [selection, setSelection] = useState<{ side: 'old' | 'new'; range: LineRange } | null>(null);
  const [draft, setDraft] = useState<{ side: 'old' | 'new'; start: number; end: number } | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{
    mode: 'message' | 'job';
    jobId: string | null;
    pull?: boolean;
  } | null>(null);
  // p18-last-gaps: where a compare view's review goes (read with its comments).
  const [reviewTo, setReviewTo] = useState<CompareReviewTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diff = useRef<DiffApi | null>(null);

  useEffect(() => {
    let live = true;
    setReview({ kind: 'loading' });
    const read: Promise<Loaded> =
      target.kind === 'job'
        ? getJobReview(target.jobId)
        : compareRefs(target.project, target.base, target.head).then((c) => ({
            baseSha: c.mergeBase,
            headSha: c.headSha,
            files: c.files,
            truncated: c.truncated,
            supported: true,
          }));
    read.then(
      (value) => {
        if (!live) return;
        setReview({ kind: 'ready', value });
        setSelected(
          (cur) =>
            cur ??
            value.files.find((f) => f.path === props.initialPath)?.path ??
            value.files[0]?.path ??
            null,
        );
      },
      (err: unknown) => {
        if (live) setReview({ kind: 'error', error: err });
      },
    );
    return () => {
      live = false;
    };
    // `key` names the target.
  }, [key]);

  const reloadComments = useCallback(() => {
    const read: Promise<ReviewComment[]> =
      target.kind === 'job'
        ? listReviewComments(target.jobId)
        : listCompareComments(target.project, target.base, target.head).then((out) => {
            setReviewTo(out.target);
            return out.comments;
          });
    read.then(
      (value) => {
        setComments({ kind: 'ready', value });
      },
      (err: unknown) => {
        setComments({ kind: 'error', error: err });
      },
    );
  }, [target]);
  useEffect(() => {
    reloadComments();
    // Once per target.
  }, [key]);

  const loaded = review.kind === 'ready' ? review.value : null;
  const file = loaded?.files.find((f) => f.path === selected) ?? null;
  const api = useMemo((): CommentApi | null => {
    if (target.kind === 'job')
      return {
        add: (input) => addReviewComment(target.jobId, input),
        update: (id, body) => updateReviewComment(target.jobId, id, body),
        remove: (id) => deleteReviewComment(target.jobId, id),
      };
    if (loaded === null) return null;
    const anchor = {
      base: target.base,
      head: target.head,
      baseSha: loaded.baseSha,
      headSha: loaded.headSha,
    };
    return {
      add: (input) => addCompareComment(target.project, { ...anchor, ...input }),
      update: (id, body) => updateCompareComment(target.project, id, body),
      remove: (id) => deleteCompareComment(target.project, id),
    };
  }, [target, loaded]);

  useEffect(() => {
    if (loaded === null || file === null || !loaded.supported) {
      setPair(null);
      return;
    }
    let live = true;
    setPair({ kind: 'loading' });
    setSelection(null);
    setDraft(null);
    const read =
      target.kind === 'job'
        ? getJobReviewFile(target.jobId, file.path, file.previousPath)
        : compareFile(target.project, loaded.baseSha, loaded.headSha, file.path, file.previousPath);
    read.then(
      (value) => {
        if (live) setPair({ kind: 'ready', value });
      },
      (err: unknown) => {
        if (live) setPair({ kind: 'error', error: err });
      },
    );
    return () => {
      live = false;
    };
  }, [loaded, file, key]);

  const p = pair?.kind === 'ready' ? pair.value : null;
  const textual =
    p !== null &&
    (p.old.state === 'text' || p.old.state === 'absent') &&
    (p.new.state === 'text' || p.new.state === 'absent');
  const hunks = useMemo(
    () => (p === null || !textual ? [] : computeHunks(p.old.text ?? '', p.new.text ?? '')),
    [p, textual],
  );
  const files = (loaded?.files ?? []).filter(
    (f) => filter === '' || f.path.toLowerCase().includes(filter.toLowerCase()),
  );
  const commentList = comments.kind === 'ready' ? comments.value : [];
  const openThreads = commentList.filter((c) => c.parentId === null && !c.resolved).length;

  const chooseMode = (m: 'side' | 'inline'): void => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Storage off: the choice lasts for this page.
    }
  };

  const toChat = (side: 'old' | 'new', start: number, end: number): void => {
    if (loaded === null || file === null) return;
    addToChat(
      {
        project: target.project,
        source: 'repo',
        ref: side === 'old' ? loaded.baseSha : loaded.headSha,
        path: side === 'old' ? (file.previousPath ?? file.path) : file.path,
        startLine: start,
        endLine: end,
      },
      t.chat,
    );
  };

  const toggleReject = (h: Hunk): void => {
    if (file === null) return;
    const k = hunkKey(file.path, h);
    setRejected((cur) => {
      const next = new Map(cur);
      if (next.has(k)) next.delete(k);
      else
        next.set(k, {
          path: file.path,
          ...(file.previousPath === null ? {} : { previousPath: file.previousPath }),
          oldStart: h.oldStart,
          oldEnd: h.oldEnd,
          newStart: h.newStart,
          newEnd: h.newEnd,
        });
      return next;
    });
  };

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      const body = {
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        ...(rejected.size === 0 ? {} : { hunks: [...rejected.values()] }),
      };
      if (target.kind === 'job') {
        const out = await requestChanges(target.jobId, body);
        setSent({ mode: out.mode, jobId: out.jobId });
      } else {
        const out = await compareRequestChanges(target.project, {
          base: target.base,
          head: target.head,
          ...body,
        });
        setSent({ mode: out.mode, jobId: out.jobId, pull: out.target === 'pull' });
      }
      setNote('');
      setRejected(new Map());
      reloadComments();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setSending(false);
    }
  };

  if (review.kind === 'loading') return <SkeletonRows label={t.diff.loading} rows={3} />;
  if (review.kind === 'error')
    return (
      <DyNotice tone="neutral" testId="code-review-unavailable">
        {sayError(review.error)}
      </DyNotice>
    );
  const r = review.value;
  const fileComments = file === null ? [] : commentList.filter((c) => c.path === file.path);

  return (
    <div className="grid gap-3" data-testid="code-review">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t.diff.mode}
          className="inline-flex rounded-[9px] border border-dy-line-2 p-0.5"
        >
          {(['side', 'inline'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                chooseMode(m);
              }}
              className={cx(
                'inline-flex min-h-8 items-center gap-1 rounded-[7px] px-2.5 text-[0.8125rem]',
                mode === m ? 'bg-dy-ink font-bold text-dy-card' : 'text-dy-muted',
              )}
            >
              <DyIcon name={m === 'side' ? 'layoutLr' : 'layoutTb'} className="size-3.5" />
              {m === 'side' ? t.diff.side : t.diff.inline}
            </button>
          ))}
        </div>
        <span className="font-dy-mono text-[0.75rem] text-dy-muted">{`${r.baseSha.slice(0, 7)} → ${r.headSha.slice(0, 7)}`}</span>
        {props.fullScreenLink === true && target.kind === 'job' ? (
          <DyButtonLink
            className="ml-auto"
            icon="layoutLr"
            to={`/projects/${encodeURIComponent(target.project)}/code/jobs/${encodeURIComponent(target.jobId)}`}
          >
            {t.diff.fullScreen}
          </DyButtonLink>
        ) : null}
      </div>
      {!r.supported ? <DyNotice tone="amber">{t.diff.unsupported}</DyNotice> : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
        <details open={!phone} className="min-w-0 rounded-[12px] border border-dy-line bg-dy-card lg:block">
          <summary className="cursor-pointer list-none border-b border-dy-line px-3 py-2 text-[0.8125rem] font-bold">
            {`${t.diff.files} (${String(r.files.length)})`}
          </summary>
          <div className="grid gap-1.5 p-2">
            <input
              type="search"
              value={filter}
              aria-label={t.diff.filter}
              placeholder={t.diff.filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
              className="min-h-8 rounded-[8px] border border-dy-line-2 bg-dy-card px-2 text-[0.8125rem]"
            />
            {r.files.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.diff.noFiles}</p>
            ) : files.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.diff.noMatch}</p>
            ) : (
              <ul
                className="m-0 grid max-h-[60vh] list-none gap-0.5 overflow-auto p-0"
                aria-label={t.diff.files}
              >
                {files.map((f) => {
                  const n = commentList.filter((c) => c.path === f.path && c.parentId === null).length;
                  const status: Readonly<Record<string, string>> = t.diff.status;
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        aria-current={f.path === selected ? 'true' : undefined}
                        onClick={() => {
                          setSelected(f.path);
                        }}
                        className={cx(
                          'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded-[7px] px-2 py-1 text-left text-[0.78125rem] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
                          f.path === selected && 'bg-dy-teal-soft text-dy-teal-ink',
                        )}
                        data-testid="code-review-file"
                      >
                        <span className="truncate font-dy-mono" translate="no">
                          {f.path}
                        </span>
                        <span className="font-dy-mono tabular-nums">
                          <span className="text-dy-green">{`+${String(f.additions)}`}</span>{' '}
                          <span className="text-dy-red-ink">{`−${String(f.deletions)}`}</span>
                        </span>
                        <span className="text-[0.75rem] text-dy-muted">
                          {status[f.status] ?? f.status}
                          {n > 0 ? ` · ${t.comments.count({ n })}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {r.truncated ? <p className="m-0 text-[0.75rem] text-dy-muted">{t.diff.truncated}</p> : null}
          </div>
        </details>

        <section className="grid min-w-0 content-start gap-2" aria-label={file?.path ?? t.diff.files}>
          {file === null ? null : (
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="m-0 min-w-0 truncate font-dy-mono text-[0.84375rem] font-bold" translate="no">
                {file.path}
              </h3>
              {file.previousPath === null ? null : (
                <span className="text-[0.75rem] text-dy-muted">
                  {t.diff.renamedFrom({ path: file.previousPath })}
                </span>
              )}
            </div>
          )}
          {pair === null ? null : pair.kind === 'loading' ? (
            <SkeletonRows label={t.diff.fileLoading} rows={2} />
          ) : pair.kind === 'error' ? (
            <DyNotice tone="red">{`${t.diff.fileFailed} ${sayError(pair.error)}`}</DyNotice>
          ) : !textual ? (
            <DyNotice tone="neutral" testId="code-review-summary">
              {t.diff.summary({
                old: t.diff.side_state[pair.value.old.state],
                new: t.diff.side_state[pair.value.new.state],
              })}
            </DyNotice>
          ) : (
            <>
              <DiffPane
                old={pair.value.old.text ?? ''}
                new={pair.value.new.text ?? ''}
                path={pair.value.path}
                mode={mode}
                labels={{
                  old: t.diff.oldLabel({ path: pair.value.path }),
                  new: t.diff.newLabel({ path: pair.value.path }),
                }}
                onSelect={setSelection}
                apiRef={diff}
                className="max-h-[70vh] min-h-[14rem] overflow-auto rounded-[10px] border border-dy-line [&_.cm-mergeView]:max-h-[70vh]"
              />
              {selection === null ? null : (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-[10px] border border-dy-line bg-dy-sunk px-3 py-2"
                  data-testid="code-review-selection"
                >
                  <span className="text-[0.8125rem]">
                    {t.diff.selection({
                      range: rangeText(selection.range.start, selection.range.end),
                      side: selection.side === 'old' ? t.diff.sideOld : t.diff.sideNew,
                    })}
                  </span>
                  {props.canReview ? (
                    <DyButton
                      icon="pen"
                      onClick={() => {
                        setDraft({
                          side: selection.side,
                          start: selection.range.start,
                          end: selection.range.end,
                        });
                      }}
                    >
                      {t.diff.comment}
                    </DyButton>
                  ) : null}
                  <DyButton
                    icon="msg"
                    onClick={() => {
                      toChat(selection.side, selection.range.start, selection.range.end);
                    }}
                  >
                    {t.chat.add}
                  </DyButton>
                </div>
              )}
              <section aria-label={t.diff.hunks} className="grid gap-1.5">
                <h4 className="m-0 text-[0.8125rem] font-bold">{t.diff.hunks}</h4>
                {hunks.length === 0 ? (
                  <p className="m-0 text-[0.8125rem] text-dy-muted">{t.diff.noHunks}</p>
                ) : (
                  <ol className="m-0 grid list-none gap-1 p-0">
                    {hunks.map((h) => {
                      const at = hunkLines(h);
                      if (at === null) return null;
                      const isRejected = file !== null && rejected.has(hunkKey(file.path, h));
                      return (
                        <li
                          key={h.index}
                          data-testid="code-hunk"
                          className={cx(
                            'flex flex-wrap items-center gap-2 rounded-[9px] border border-dy-line px-2.5 py-1.5 text-[0.8125rem]',
                            isRejected && 'border-dy-red bg-dy-red-soft',
                          )}
                        >
                          <button
                            type="button"
                            className="min-w-0 text-left underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                            onClick={() => {
                              diff.current?.goToLine(at.side, at.start);
                            }}
                          >
                            {t.diff.hunk({ n: h.index + 1, range: rangeText(at.start, at.end) })}
                          </button>
                          <span className="font-dy-mono tabular-nums">
                            <span className="text-dy-green">{`+${String(h.added)}`}</span>{' '}
                            <span className="text-dy-red-ink">{`−${String(h.removed)}`}</span>
                          </span>
                          {isRejected ? <Pill tone="red">{t.diff.rejected}</Pill> : null}
                          <span className="ml-auto flex flex-wrap gap-1.5">
                            {props.canReview ? (
                              <>
                                <DyButton
                                  icon="pen"
                                  onClick={() => {
                                    setDraft({ side: at.side, start: at.start, end: at.end });
                                  }}
                                >
                                  {t.diff.comment}
                                </DyButton>
                                <DyButton
                                  variant={isRejected ? 'secondary' : 'danger'}
                                  aria-pressed={isRejected}
                                  aria-label={
                                    isRejected
                                      ? t.diff.undoReject({ n: h.index + 1 })
                                      : t.diff.rejectLabel({ n: h.index + 1 })
                                  }
                                  onClick={() => {
                                    toggleReject(h);
                                  }}
                                >
                                  {isRejected ? t.diff.rejected : t.diff.reject}
                                </DyButton>
                              </>
                            ) : null}
                            <DyButton
                              icon="msg"
                              onClick={() => {
                                toChat(at.side, at.start, at.end);
                              }}
                            >
                              {t.chat.add}
                            </DyButton>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </>
          )}

          {file !== null && api !== null ? (
            <Comments
              api={api}
              path={file.path}
              list={fileComments}
              failed={comments.kind === 'error'}
              canReview={props.canReview}
              draft={draft}
              onDraftDone={() => {
                setDraft(null);
              }}
              reload={reloadComments}
            />
          ) : null}
        </section>
      </div>

      {props.canReview ? (
        <section
          aria-labelledby="code-request-title"
          className="grid gap-2 rounded-[12px] border border-dy-line bg-dy-sunk p-3"
          data-testid="code-request"
        >
          <h3 id="code-request-title" className="m-0 text-[0.9375rem] font-bold">
            {t.request.title}
          </h3>
          {isJob ? <p className="m-0 text-[0.8125rem] text-dy-muted">{t.request.sub}</p> : null}
          {/* p18-last-gaps: a compare view says where its review goes (or why it cannot go anywhere). */}
          {isJob || reviewTo === null ? null : reviewTo.mode === 'job' ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="code-request-target">
              {t.request.compare.job({ branch: reviewTo.branch ?? reviewTo.jobId.slice(0, 8) })}{' '}
              <Link to={`/jobs/${encodeURIComponent(reviewTo.jobId)}`} className="font-bold underline">
                {t.request.compare.openTargetJob}
              </Link>
            </p>
          ) : reviewTo.mode === 'pull' ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="code-request-target">
              {t.request.compare.pull({ number: reviewTo.number, branch: reviewTo.headBranch })}
            </p>
          ) : (
            <DyNotice tone="amber" testId="code-request-target">
              {(t.request.compare.none as Readonly<Record<string, string>>)[reviewTo.reason] ??
                t.request.compare.none.no_target}
            </DyNotice>
          )}
          <label className="grid gap-1 text-[0.8125rem] font-bold">
            {t.request.note}
            <textarea
              value={note}
              maxLength={4000}
              rows={2}
              placeholder={t.request.notePlaceholder}
              onChange={(e) => {
                setNote(e.target.value);
              }}
              className="rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-2 text-[0.875rem] font-normal"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <DyButton
              variant="primary"
              icon="send"
              busy={sending}
              disabled={
                (openThreads === 0 && rejected.size === 0 && note.trim() === '') ||
                (!isJob && (reviewTo === null || reviewTo.mode === 'none'))
              }
              onClick={() => void send()}
            >
              {t.request.send}
            </DyButton>
            <span className="text-[0.8125rem] text-dy-muted" data-testid="code-request-summary">
              {t.request.summary({ comments: openThreads, hunks: rejected.size })}
            </span>
          </div>
          {sent === null ? null : (
            <DyNotice tone="green" live testId="code-request-sent">
              {sent.mode === 'message'
                ? t.request.sentMessage
                : sent.pull === true
                  ? t.request.compare.sentPull
                  : t.request.sentJob}{' '}
              {sent.jobId === null ? null : (
                <Link to={`/jobs/${encodeURIComponent(sent.jobId)}`} className="font-bold underline">
                  {t.request.openJob}
                </Link>
              )}
            </DyNotice>
          )}
          {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
        </section>
      ) : null}
    </div>
  );
}

function Comments(props: {
  readonly api: CommentApi;
  readonly path: string;
  readonly list: readonly ReviewComment[];
  readonly failed: boolean;
  readonly canReview: boolean;
  readonly draft: { side: 'old' | 'new'; start: number; end: number } | null;
  readonly onDraftDone: () => void;
  readonly reload: () => void;
}): ReactNode {
  const t = useT().code;
  const sayError = useErrorText();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roots = props.list.filter((c) => c.parentId === null);
  const side = (s: 'old' | 'new'): string => (s === 'old' ? t.diff.sideOld : t.diff.sideNew);

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.reload();
      return true;
    } catch (err) {
      setError(sayError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t.comments.title} className="grid gap-2" data-testid="code-comments">
      <h4 className="m-0 text-[0.8125rem] font-bold">{`${t.comments.title} (${String(roots.length)})`}</h4>
      {props.failed ? <p className="m-0 text-[0.8125rem] text-dy-red-ink">{t.comments.failed}</p> : null}
      {props.draft === null ? null : (
        <form
          className="grid gap-1.5 rounded-[10px] border border-dy-line bg-dy-card p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            const d = props.draft;
            if (d === null || body.trim() === '') return;
            void run(() =>
              props.api.add({
                path: props.path,
                side: d.side,
                startLine: d.start,
                endLine: d.end,
                body: body.trim(),
              }),
            ).then((ok) => {
              if (ok) {
                setBody('');
                props.onDraftDone();
              }
            });
          }}
        >
          <label className="grid gap-1 text-[0.8125rem] font-bold">
            {t.comments.newOn({
              where: t.comments.where({
                range: rangeText(props.draft.start, props.draft.end),
                side: side(props.draft.side),
              }),
            })}
            <textarea
              value={body}
              maxLength={4000}
              rows={3}
              placeholder={t.comments.placeholder}
              onChange={(e) => {
                setBody(e.target.value);
              }}
              className="rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-2 text-[0.875rem] font-normal"
            />
          </label>
          <span className="flex gap-1.5">
            <DyButton type="submit" variant="primary" busy={busy} disabled={body.trim() === ''}>
              {t.comments.save}
            </DyButton>
            <DyButton onClick={props.onDraftDone}>{t.comments.cancel}</DyButton>
          </span>
        </form>
      )}
      {roots.length === 0 ? (
        <EmptyLine>{t.comments.none}</EmptyLine>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {roots.map((c) => (
            <Thread
              key={c.id}
              root={c}
              replies={props.list.filter((x) => x.parentId === c.id)}
              canReview={props.canReview}
              busy={busy}
              side={side}
              run={run}
              api={props.api}
            />
          ))}
        </ul>
      )}
      {error === null ? null : <DyNotice tone="red">{error}</DyNotice>}
    </section>
  );
}

function Thread(props: {
  readonly root: ReviewComment;
  readonly replies: readonly ReviewComment[];
  readonly canReview: boolean;
  readonly busy: boolean;
  readonly side: (s: 'old' | 'new') => string;
  readonly run: (fn: () => Promise<unknown>) => Promise<boolean>;
  readonly api: CommentApi;
}): ReactNode {
  const t = useT().code.comments;
  const { root } = props;
  const [reply, setReply] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; body: string } | null>(null);
  const one = (c: ReviewComment): ReactNode => (
    <div className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-dy-muted">
        <span className="font-bold text-dy-ink">{c.author.name ?? t.unknownAuthor}</span>
        {c.sentAt === null ? null : <Pill tone="teal">{t.sent}</Pill>}
      </span>
      {edit?.id === c.id ? (
        <form
          className="grid gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const b = edit.body.trim();
            if (b === '') return;
            void props
              .run(() => props.api.update(c.id, { body: b }))
              .then((ok) => {
                if (ok) setEdit(null);
              });
          }}
        >
          <textarea
            aria-label={t.body}
            value={edit.body}
            maxLength={4000}
            rows={2}
            onChange={(e) => {
              setEdit({ id: c.id, body: e.target.value });
            }}
            className="rounded-[9px] border border-dy-line-2 bg-dy-card px-2 py-1 text-[0.875rem]"
          />
          <span className="flex gap-1.5">
            <DyButton type="submit" variant="primary" busy={props.busy}>
              {t.save}
            </DyButton>
            <DyButton
              onClick={() => {
                setEdit(null);
              }}
            >
              {t.cancel}
            </DyButton>
          </span>
        </form>
      ) : (
        <p className="m-0 text-[0.875rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
      )}
      {props.canReview && edit?.id !== c.id ? (
        <span className="flex flex-wrap gap-2 text-[0.75rem]">
          {c.mine ? (
            <button
              type="button"
              className="text-dy-muted underline"
              onClick={() => {
                setEdit({ id: c.id, body: c.body });
              }}
            >
              {t.edit}
            </button>
          ) : null}
          {c.mine ? (
            <button
              type="button"
              className="text-dy-red-ink underline"
              onClick={() => void props.run(() => props.api.remove(c.id))}
            >
              {t.delete}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
  return (
    <li
      className={cx(
        'grid gap-2 rounded-[10px] border border-dy-line bg-dy-card p-2.5',
        root.resolved && 'opacity-70',
      )}
      data-testid="code-thread"
    >
      <span className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-dy-muted">
        <span className="font-dy-mono">
          {t.where({ range: rangeText(root.startLine, root.endLine), side: props.side(root.side) })}
        </span>
        {root.outdated ? <Pill tone="amber">{t.outdated}</Pill> : null}
        {root.resolved ? <Pill tone="green">{t.resolved}</Pill> : null}
      </span>
      {one(root)}
      {props.replies.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-2 border-l-2 border-dy-line p-0 pl-2.5">
          {props.replies.map((r) => (
            <li key={r.id}>{one(r)}</li>
          ))}
        </ul>
      )}
      {props.canReview ? (
        reply === null ? (
          <span className="flex flex-wrap gap-1.5">
            <DyButton
              onClick={() => {
                setReply('');
              }}
            >
              {t.reply}
            </DyButton>
            <DyButton
              onClick={() => void props.run(() => props.api.update(root.id, { resolved: !root.resolved }))}
            >
              {root.resolved ? t.reopen : t.resolve}
            </DyButton>
          </span>
        ) : (
          <form
            className="grid gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const b = reply.trim();
              if (b === '') return;
              void props
                .run(() =>
                  props.api.add({
                    path: root.path,
                    side: root.side,
                    startLine: root.startLine,
                    endLine: root.endLine,
                    body: b,
                    parentId: root.id,
                  }),
                )
                .then((ok) => {
                  if (ok) setReply(null);
                });
            }}
          >
            <textarea
              aria-label={t.replyLabel}
              value={reply}
              maxLength={4000}
              rows={2}
              onChange={(e) => {
                setReply(e.target.value);
              }}
              className="rounded-[9px] border border-dy-line-2 bg-dy-card px-2 py-1 text-[0.875rem]"
            />
            <span className="flex gap-1.5">
              <DyButton type="submit" variant="primary" busy={props.busy} disabled={reply.trim() === ''}>
                {t.reply}
              </DyButton>
              <DyButton
                onClick={() => {
                  setReply(null);
                }}
              >
                {t.cancel}
              </DyButton>
            </span>
          </form>
        )
      ) : null}
    </li>
  );
}
