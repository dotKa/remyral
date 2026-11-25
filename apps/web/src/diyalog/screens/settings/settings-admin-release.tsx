import { useErrorText } from '../../../i18n/errors';
import { type ChangeEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  abortReleaseUpload,
  type AttemptDiagnostics,
  getAttemptDiagnostics,
  promoteRelease,
  type ReleaseInfo,
} from '../../../api/releases';
import { cx, toApiError } from '../../../components/ui';
import {
  RELEASE_MAX_BYTES,
  type UploadOptions,
  type UploadProgress,
  UploadCancelledError,
  uploadReleaseInParts,
} from '../../../lib/releaseUpload';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { DyApiError, DyNotice } from '../forms';
import { DyButton, SkeletonRows } from '../parts';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Ayarlar → Worker sürümleri: the signed release upload and an update attempt's
 * diagnostics in the Diyalog language, feature for feature with the classic `ReleaseUploadControl` and
 * `AttemptDiagnosticsView`. The upload itself is the classic `uploadReleaseInParts` (hashing, ≤ 2 MiB parts with
 * retries, resume of the missing parts, cancel, step-up on start and complete); the master checks the signature.
 */

const MB = 1024 * 1024;
/** Errors after which the master still holds the upload (resume sends the missing parts) — the classic set. */
const RESUMABLE = new Set(['part_checksum_mismatch', 'upload_incomplete']);
const mb = (n: number): string => `${(n / MB).toFixed(1)} MB`;

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; file: File; progress: UploadProgress | null }
  | { kind: 'failed'; file: File; uploadId: string | null; message: string }
  | { kind: 'done'; file: File; release: ReleaseInfo }
  | { kind: 'rolledOut'; release: ReleaseInfo };

export function DyReleaseUpload(props: {
  readonly onChanged?: () => void | Promise<void>;
  /** Injectable for tests (part size, API, digest, sleep). */
  readonly uploadOptions?: Omit<UploadOptions, 'onProgress' | 'onStarted' | 'signal' | 'resumeId' | 'guard'>;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().settings.releases;
  const tu = t.upload;
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [rollError, setRollError] = useState<ApiError | null>(null);
  const [rolling, setRolling] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);
  const stepUp = useStepUp();
  const inputId = useId();

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const run = async (file: File, resumeId: string | null): Promise<void> => {
    const ctl = new AbortController();
    abort.current = ctl;
    uploadId.current = resumeId;
    setRollError(null);
    setState({ kind: 'uploading', file, progress: null });
    try {
      const release = await uploadReleaseInParts(file, {
        ...props.uploadOptions,
        signal: ctl.signal,
        resumeId,
        guard: (action) => stepUp.run(action, tu.guard),
        onStarted: (id) => {
          uploadId.current = id;
        },
        onProgress: (progress) => {
          if (!ctl.signal.aborted) setState({ kind: 'uploading', file, progress });
        },
      });
      setState({ kind: 'done', file, release });
      await props.onChanged?.();
    } catch (err) {
      if (err instanceof UploadCancelledError || ctl.signal.aborted) return;
      if (err instanceof StepUpCancelledError) {
        setState({
          kind: 'failed',
          file,
          uploadId: uploadId.current,
          message: tu.stepUpCancelled,
        });
        return;
      }
      const error = toApiError(err);
      const gone = [404, 409, 410, 413, 422, 503].includes(error.status) && !RESUMABLE.has(error.code);
      setState({ kind: 'failed', file, uploadId: gone ? null : uploadId.current, message: sayError(error) });
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file === undefined) return;
    if (file.size === 0 || file.size > RELEASE_MAX_BYTES) {
      setState({
        kind: 'failed',
        file,
        uploadId: null,
        message: tu.badSize({ name: file.name, size: mb(file.size), max: mb(RELEASE_MAX_BYTES) }),
      });
      return;
    }
    void run(file, null);
  };

  const cancel = async (): Promise<void> => {
    abort.current?.abort();
    const id = uploadId.current;
    uploadId.current = null;
    setState({ kind: 'idle' });
    if (id !== null) {
      try {
        await abortReleaseUpload(id);
      } catch {
        // Best effort: an abandoned upload expires on the master within an hour.
      }
    }
  };

  const rollOut = async (release: ReleaseInfo): Promise<void> => {
    setRolling(true);
    setRollError(null);
    try {
      await stepUp.run(
        () => promoteRelease(release.channel, release.version, 100),
        t.rollOutStepUp({ version: release.version, channel: release.channel }),
      );
      setState({ kind: 'rolledOut', release });
      await props.onChanged?.();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setRollError(toApiError(err));
    } finally {
      setRolling(false);
    }
  };

  const busy = state.kind === 'uploading';
  return (
    <div className="flex flex-col gap-3" data-testid="release-upload">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className={cx(
            'dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-ink bg-dy-ink px-3 text-[0.875rem] font-bold text-dy-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-dy-teal',
            busy ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
          )}
        >
          <DyIcon name="tray" className="size-4" />
          {tu.choose}
          <input
            id={inputId}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label={tu.fileLabel}
            disabled={busy}
            onChange={onFile}
          />
        </label>
        {busy ? (
          <DyButton
            variant="ghost"
            icon="xc"
            onClick={() => {
              void cancel();
            }}
          >
            {tu.cancel}
          </DyButton>
        ) : null}
      </div>

      {state.kind === 'uploading' ? <ProgressView file={state.file} progress={state.progress} /> : null}

      {state.kind === 'failed' ? (
        <DyNotice tone="red" live>
          <div className="flex flex-col gap-2" data-testid="release-upload-failed">
            <p className="m-0">{state.message}</p>
            {state.file.size === 0 || state.file.size > RELEASE_MAX_BYTES ? null : (
              <div className="flex flex-wrap gap-2">
                {state.uploadId !== null ? (
                  <>
                    <DyButton
                      icon="retry"
                      onClick={() => {
                        void run(state.file, state.uploadId);
                      }}
                    >
                      {tu.resume}
                    </DyButton>
                    <DyButton
                      variant="ghost"
                      onClick={() => {
                        void cancel();
                      }}
                    >
                      {tu.discard}
                    </DyButton>
                  </>
                ) : (
                  <DyButton
                    icon="retry"
                    onClick={() => {
                      void run(state.file, null);
                    }}
                  >
                    {tu.retry}
                  </DyButton>
                )}
              </div>
            )}
          </div>
        </DyNotice>
      ) : null}

      {state.kind === 'done' ? (
        <DyNotice
          tone="green"
          live
          action={
            <DyButton
              variant="primary"
              icon="rocket"
              busy={rolling}
              onClick={() => {
                void rollOut(state.release);
              }}
            >
              {tu.rollOutChannel({ channel: state.release.channel })}
            </DyButton>
          }
        >
          <p className="m-0" data-testid="release-upload-done">
            <b className="font-dy-mono">{state.release.version}</b>
            {tu.verifiedA}
            {tu.verifiedB({ channel: state.release.channel })}
          </p>
          <p className="m-0 mt-1 text-[0.78125rem]">{tu.rollOutHint({ channel: state.release.channel })}</p>
        </DyNotice>
      ) : null}

      {state.kind === 'rolledOut' ? (
        <DyNotice tone="green" live>
          {tu.rolledOut({ channel: state.release.channel, version: state.release.version })}
        </DyNotice>
      ) : null}

      <DyApiError error={rollError} />
    </div>
  );
}

function ProgressView(props: { readonly file: File; readonly progress: UploadProgress | null }): ReactNode {
  const p = props.progress;
  const t = useT().settings.releases;
  const total = p?.totalBytes ?? props.file.size;
  const sent = p?.sentBytes ?? 0;
  const pct = total === 0 ? 0 : Math.round((sent / total) * 100);
  const label =
    p === null || p.phase === 'hashing'
      ? t.upload.hashing
      : p.phase === 'verifying'
        ? t.upload.verifying
        : p.retry !== null
          ? t.upload.retrying({ part: p.retry.part + 1, parts: p.partCount, attempt: p.retry.attempt })
          : t.upload.part({ part: Math.min(p.partsDone + 1, p.partCount), parts: p.partCount });
  return (
    <div className="flex flex-col gap-1.5" data-testid="release-upload-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[0.8125rem]">
        <span className="min-w-0 truncate font-dy-mono">{props.file.name}</span>
        <span className="font-dy-mono text-dy-muted tabular-nums">{`${mb(sent)} / ${mb(total)}`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={t.upload.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={t.percent({ n: pct })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-dy-line"
      >
        <i
          className="block h-full rounded-full bg-dy-teal transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <p className="m-0 text-[0.78125rem] text-dy-muted" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

function Lines(props: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly testId: string;
}): ReactNode {
  if (props.lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="m-0 text-[0.78125rem] font-bold text-dy-muted">{props.title}</h4>
      <pre
        data-testid={props.testId}
        className="m-0 max-h-64 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2.5 font-dy-mono text-[0.75rem] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {props.lines.join('\n')}
      </pre>
    </div>
  );
}

/** Why an update attempt failed: the boot verdict and the redacted evidence (admin only; the master answers 403). */
export function DyAttemptDiagnostics(props: { readonly attemptId: string }): ReactNode {
  const t = useT().settings.releases.diag;
  const verdicts: Readonly<Record<string, string>> = t.verdict;
  const [d, setD] = useState<AttemptDiagnostics | null | undefined>(undefined);
  const load = useSubmit();
  useEffect(() => {
    void load.run(async () => {
      setD(await getAttemptDiagnostics(props.attemptId));
    });
  }, [props.attemptId]);
  if (load.error !== null) return <DyApiError error={load.error} retryLeft={load.retryLeft} />;
  if (d === undefined) return <SkeletonRows label={t.loading} rows={2} />;
  if (d === null)
    return (
      <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="attempt-diagnostics-none">
        {t.none}
      </p>
    );
  return (
    <div className="flex flex-col gap-3" data-testid="attempt-diagnostics">
      <p className="m-0 text-[0.875rem]">
        <span className="font-dy-mono font-bold">{d.verdict}</span> —{' '}
        {verdicts[d.verdict] ?? t.unknownVerdict}{' '}
        <span className="text-dy-muted">{d.collectedBy === 'updater' ? t.byUpdater : t.byWorker}</span>
      </p>
      <Lines title={t.restartErrors} lines={d.restartErrors} testId="diag-restart-errors" />
      <Lines title={t.bootLog} lines={d.bootLog} testId="diag-boot-log" />
      <Lines title={t.serviceOutput} lines={d.serviceOutput} testId="diag-service-output" />
      <Lines title={t.updaterLog} lines={d.updaterLog} testId="diag-updater-log" />
    </div>
  );
}
