import { useErrorText } from '../../../../i18n/errors';
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../../api/client';
import {
  DOMAIN_NAME,
  idempotencyKey,
  type OpsAction,
  PAGES_PROJECT_NAME,
  previewOpsAction,
  type PublishOptions,
  requestOpsAction,
} from '../../../../api/deploy';
import { listSiteUploads, refusalsOf, type SiteRefusal, type SiteUpload } from '../../../../api/siteUploads';
import { cx, toApiError } from '../../../../components/ui';
import { UploadCancelledError } from '../../../../lib/releaseUpload';
import {
  folderInput,
  planSite,
  type SitePlan,
  type SiteUploadProgress,
  typeOf,
  uploadSite,
} from '../../../../lib/siteUpload';
import { readZip, ZipError } from '../../../../lib/siteZip';
import {
  EMPTY_PUBLISH,
  NEW_PROJECT,
  needsPublish,
  publishOptions,
  type PublishState,
} from '../../../../screens/deploy/publish';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyIcon } from '../../../icons';
import { DyApiError, DyField, DyNotice, FormActions } from '../../forms';
import { agoText, DyButton, DySelect, Panel } from '../../parts';
import { ReviewBox, reviewOf } from './deploy-diff';
import { ResultLine } from './deploy-pages';
import { bytesText as bytesTr } from './deploy-text';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';

type SiteWords = Messages['projectTabs']['site'];

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy → "Site yükle", feature for feature with the classic `SiteUploadCard` +
 * `PublishFields` (p10-site-upload, ADR-0037; p10-publish-bundle): pick a folder or a .zip (unpacked here, never on
 * the master), see every file, the total and what would be refused before anything is sent; the chunked, resumable
 * upload (cancel, resume, start again) with the master's per-file refusals; recent ready uploads; then deploy or
 * publish (create the Pages project if missing → deploy → domain → CNAME, ONE approval) to preview / production after
 * a review. The same planning, upload and request code as classic; the site is never shown here.
 */

type Json = Record<string, unknown>;

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'planned'; plan: SitePlan; label: string }
  | { kind: 'uploading'; plan: SitePlan; label: string; progress: SiteUploadProgress | null }
  | {
      kind: 'failed';
      plan: SitePlan;
      label: string;
      message: string;
      uploadId: string | null;
      refused: SiteRefusal[];
    }
  | { kind: 'ready'; upload: SiteUpload };

/** Why the publish fields cannot be sent (classic `publishProblem`). */
export function publishProblem(t: SiteWords, s: PublishState, target: string | null): string | null {
  if (s.choice === '' && target === null) return t.pickProject;
  if (s.choice === NEW_PROJECT && !PAGES_PROJECT_NAME.test(s.newName.trim())) return t.badNewName;
  const d = s.domain.trim().toLowerCase();
  if (d !== '' && !DOMAIN_NAME.test(d)) return t.badDomain;
  return null;
}

/** One line that says what the chain will do (classic `chainSummary`). */
export function chainSummary(t: SiteWords, o: PublishOptions, target: string | null): string {
  const project = o.pagesProject ?? target ?? t.pagesTarget;
  const parts = [
    ...(o.createIfMissing === true ? [t.chainCreate({ project })] : []),
    t.chainDeploy({ project }),
    ...(o.domain === undefined ? [] : [t.chainDomain({ domain: o.domain, skip: o.dns === 'skip' })]),
  ];
  const s = parts.join(', ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function RefusedList(props: {
  readonly items: readonly { path: string; reason: string; rule?: string; line?: number }[];
}): ReactNode {
  const t = useT().projectTabs.site;
  if (props.items.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0 text-[0.8125rem]"
      data-testid="site-upload-refused"
    >
      {props.items.slice(0, 100).map((r, i) => (
        <li key={`${r.path}-${String(i)}`} className="[overflow-wrap:anywhere]">
          <span className="font-dy-mono">{r.path === '' ? '(site)' : r.path}</span>
          {r.line === undefined ? '' : t.line({ n: r.line })} — {r.reason}
          {r.rule === undefined ? '' : ` (${r.rule})`}
        </li>
      ))}
      {props.items.length > 100 ? <li>{t.more({ n: props.items.length - 100 })}</li> : null}
    </ul>
  );
}

function FileList(props: { readonly plan: SitePlan }): ReactNode {
  const { plan } = props;
  const t = useT().projectTabs.site;
  return (
    <div className="flex flex-col gap-2" data-testid="site-upload-plan">
      <p className="m-0 text-[0.875rem]">
        <b>{t.files({ n: plan.files.length })}</b> · {bytesTr(plan.totalBytes)}
        {plan.strippedRoot === null ? '' : t.strippedRoot({ dir: plan.strippedRoot })}
        {plan.skipped > 0 ? t.skipped({ n: plan.skipped }) : ''}
      </p>
      <div className="max-h-64 overflow-auto rounded-[10px] border border-dy-line">
        <table className="w-full border-collapse text-left text-[0.8125rem]">
          <caption className="sr-only">{t.caption}</caption>
          <thead className="sticky top-0 bg-dy-card">
            <tr className="text-dy-muted">
              <th scope="col" className="px-3 py-1.5 font-medium">
                {t.path}
              </th>
              <th scope="col" className="hidden px-3 py-1.5 font-medium sm:table-cell">
                {t.type}
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-medium">
                {t.size}
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.files.map((f) => (
              <tr key={f.path} className="border-t border-dy-line">
                <td className="px-3 py-1 font-dy-mono [overflow-wrap:anywhere]">{f.path}</td>
                <td className="hidden px-3 py-1 text-dy-muted sm:table-cell">{typeOf(f.path)}</td>
                <td className="px-3 py-1 text-right whitespace-nowrap tabular-nums">{bytesTr(f.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.refused.length > 0 ? (
        <DyNotice tone="amber" title={t.refused({ n: plan.refused.length })}>
          <RefusedList items={plan.refused} />
        </DyNotice>
      ) : null}
      {plan.problems.length > 0 ? (
        <DyNotice tone="red">
          {plan.problems.map((p) => (
            <p key={p} className="m-0">
              {p}
            </p>
          ))}
        </DyNotice>
      ) : null}
    </div>
  );
}

function Progress(props: {
  readonly progress: SiteUploadProgress | null;
  readonly total: number;
}): ReactNode {
  const p = props.progress;
  const t = useT().projectTabs.site;
  const total = p?.totalBytes ?? props.total;
  const sent = p?.sentBytes ?? 0;
  const pct = total === 0 ? 0 : Math.round((sent / total) * 100);
  const label =
    p === null || p.phase === 'hashing'
      ? t.hashing
      : p.phase === 'checking'
        ? t.checking
        : p.retry !== null
          ? t.retrying({ part: p.retry.part + 1, attempt: p.retry.attempt })
          : t.progress({ total: bytesTr(total), sent: bytesTr(sent) });
  return (
    <div className="flex flex-col gap-1.5" data-testid="site-upload-progress">
      <div
        role="progressbar"
        aria-label={t.progressLabel}
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

const PICK =
  'dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] font-medium text-dy-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-dy-teal';

export function SitePanel(props: {
  readonly project: string;
  /** The Pages projects a deploy may name: the target first, then the further ones. */
  readonly pagesProjects: readonly string[];
  readonly target: string | null;
  readonly onDeployed: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const all = useT();
  const t = all.projectTabs.site;
  const w = all.screenKit.time;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [pickError, setPickError] = useState<string | null>(null);
  const [publish, setPublish] = useState<PublishState>(EMPTY_PUBLISH);
  const [recent, setRecent] = useState<SiteUpload[]>([]);
  const [review, setReview] = useState<{
    env: 'preview' | 'production';
    kind: 'pages.deploy' | 'pages.publish';
    diff: Json;
    policy: { decision: string; reason: string };
  } | null>(null);
  const [result, setResult] = useState<OpsAction | null>(null);
  const deploy = useSubmit();
  const abort = useRef<AbortController | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // `webkitdirectory` is not in React's typings; set it on the element (as classic).
    folderRef.current?.setAttribute('webkitdirectory', '');
    folderRef.current?.setAttribute('directory', '');
    return () => abort.current?.abort();
  }, []);

  const loadRecent = () => {
    listSiteUploads(props.project).then(
      (items) => {
        setRecent(items.filter((u) => u.state === 'ready'));
      },
      () => undefined,
    );
  };
  useEffect(loadRecent, [props.project]);

  const target = props.target;
  const further = props.pagesProjects.filter((p) => p !== target);
  const options: PublishOptions = publishOptions(publish);
  const problem = publishProblem(t, publish, target);
  const kind = needsPublish(options) ? 'pages.publish' : 'pages.deploy';
  const busy = phase.kind === 'reading' || phase.kind === 'uploading';

  const reset = () => {
    setReview(null);
    setResult(null);
    deploy.clearError();
    setPickError(null);
  };

  const onFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    reset();
    if (list === null || list.length === 0) return;
    const input = folderInput(list);
    const first = input[0]?.path ?? '';
    setPhase({
      kind: 'planned',
      plan: planSite(input),
      label: first.includes('/') ? first.slice(0, first.indexOf('/')) : 'site',
    });
    e.target.value = '';
  };

  const onZip = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    reset();
    if (file === undefined) return;
    setPhase({ kind: 'reading' });
    void (async () => {
      try {
        const z = await readZip(file);
        const plan = planSite(z.entries.map((x) => ({ path: x.path, blob: x.blob })));
        setPhase({
          kind: 'planned',
          plan: {
            ...plan,
            refused: [...z.refused, ...plan.refused],
            skipped: plan.skipped + z.skipped.length,
          },
          label: file.name.replace(/\.zip$/i, '').slice(0, 200),
        });
      } catch (err) {
        setPhase({ kind: 'idle' });
        setPickError(err instanceof ZipError ? err.message : t.zipFailed);
      }
    })();
  };

  const send = async (plan: SitePlan, label: string, resumeId: string | null) => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    let started: string | null = resumeId;
    setPhase({ kind: 'uploading', plan, label, progress: null });
    try {
      const upload = await uploadSite(props.project, plan.files, {
        label,
        signal: ctrl.signal,
        resumeId,
        onStarted: (id) => {
          started = id;
        },
        onProgress: (p) => {
          setPhase({ kind: 'uploading', plan, label, progress: p });
        },
      });
      setPhase({ kind: 'ready', upload });
      loadRecent();
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setPhase({ kind: 'planned', plan, label });
        return;
      }
      const refused = refusalsOf(err);
      const api = toApiError(err);
      // A refused site was discarded by the master: start over (after fixing the files).
      const keep = err instanceof ApiError && api.code !== 'site_refused' && api.code !== 'upload_expired';
      setPhase({
        kind: 'failed',
        plan,
        label,
        message: sayError(api),
        uploadId: keep ? started : null,
        refused,
      });
    } finally {
      abort.current = null;
    }
  };

  const params = (upload: SiteUpload, env: 'preview' | 'production'): Json => ({
    uploadId: upload.id,
    env,
    ...options,
  });

  const doReview = async (upload: SiteUpload, env: 'preview' | 'production') => {
    setReview(null);
    setResult(null);
    await deploy.run(async () => {
      const r = reviewOf(
        await previewOpsAction({ project: props.project, kind, params: params(upload, env) }),
      );
      setReview({ env, kind, ...r });
    });
  };

  const doDeploy = async (
    upload: SiteUpload,
    env: 'preview' | 'production',
    k: 'pages.deploy' | 'pages.publish',
  ) => {
    await deploy.run(async () => {
      const a = await requestOpsAction({
        project: props.project,
        kind: k,
        params: params(upload, env),
        idempotencyKey: idempotencyKey('site-upload'),
      });
      setResult(a);
      setReview(null);
      props.onDeployed();
    });
  };

  const plan =
    phase.kind === 'planned' || phase.kind === 'uploading' || phase.kind === 'failed' ? phase.plan : null;
  const canSend = plan !== null && plan.problems.length === 0 && plan.files.length > 0;

  return (
    <Panel title={t.title} sub={t.sub} testId="site-upload-card">
      <div className="flex flex-col gap-4">
        {props.pagesProjects.length === 0 ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.noPages}</p>
        ) : null}
        {recent.length > 0 ? (
          <div className="flex flex-col gap-1.5" data-testid="site-upload-recent">
            <h3 className="m-0 text-[0.875rem] font-bold">{t.recent}</h3>
            <ul className="m-0 grid list-none gap-0 rounded-[10px] border border-dy-line p-0">
              {recent.map((u) => {
                const current = phase.kind === 'ready' && phase.upload.id === u.id;
                return (
                  <li
                    key={u.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dy-line px-3 py-2 first:border-t-0"
                  >
                    <DyIcon name="folder" className="size-4 shrink-0 text-dy-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium [overflow-wrap:anywhere]">{u.label ?? 'site'}</div>
                      <div className="text-[0.8125rem] text-dy-muted">
                        {t.recentLine({
                          n: u.fileCount,
                          size: bytesTr(u.totalBytes),
                          who: u.uploadedBy.username ?? u.uploadedBy.id,
                          ago: agoText(u.completedAt ?? u.createdAt, Date.now(), w),
                        })}
                        {u.lastDeployedAt === null ? '' : t.deployedBefore}
                      </div>
                    </div>
                    {current ? (
                      <span className="text-[0.8125rem] font-bold text-dy-teal-ink">{t.selected}</span>
                    ) : (
                      <DyButton
                        onClick={() => {
                          reset();
                          setPhase({ kind: 'ready', upload: u });
                        }}
                      >
                        {t.useUpload}
                      </DyButton>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <label className={cx(PICK, busy ? 'cursor-not-allowed opacity-55' : 'cursor-pointer')}>
            <DyIcon name="folder" className="size-4" />
            {t.pickFolder}
            <input
              ref={folderRef}
              type="file"
              multiple
              className="sr-only"
              aria-label={t.folderLabel}
              disabled={busy}
              onChange={onFolder}
              data-testid="site-upload-folder"
            />
          </label>
          <label className={cx(PICK, busy ? 'cursor-not-allowed opacity-55' : 'cursor-pointer')}>
            <DyIcon name="file" className="size-4" />
            {t.pickZip}
            <input
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label={t.zipLabel}
              disabled={busy}
              onChange={onZip}
              data-testid="site-upload-zip"
            />
          </label>
          {phase.kind === 'uploading' ? (
            <DyButton
              variant="ghost"
              onClick={() => {
                abort.current?.abort();
              }}
            >
              {t.cancel}
            </DyButton>
          ) : null}
        </div>
        {pickError === null ? null : (
          <DyNotice tone="red" live>
            {pickError}
          </DyNotice>
        )}
        {phase.kind === 'reading' ? <p className="m-0 text-[0.875rem] text-dy-muted">{t.reading}</p> : null}
        {plan !== null ? <FileList plan={plan} /> : null}
        {phase.kind === 'planned' ? (
          <FormActions>
            <DyButton
              variant="primary"
              icon="tray"
              disabled={!canSend}
              onClick={() => void send(phase.plan, phase.label, null)}
            >
              {t.upload({ n: phase.plan.files.length })}
            </DyButton>
          </FormActions>
        ) : null}
        {phase.kind === 'uploading' ? (
          <Progress progress={phase.progress} total={phase.plan.totalBytes} />
        ) : null}
        {phase.kind === 'failed' ? (
          <DyNotice tone="red" live testId="site-upload-failed">
            <div className="flex flex-col gap-2">
              <p className="m-0">{phase.message}</p>
              <RefusedList items={phase.refused} />
              <div className="flex flex-wrap gap-2">
                {phase.uploadId !== null ? (
                  <DyButton onClick={() => void send(phase.plan, phase.label, phase.uploadId)}>
                    {t.resume}
                  </DyButton>
                ) : null}
                {phase.refused.length === 0 ? (
                  <DyButton onClick={() => void send(phase.plan, phase.label, null)}>{t.restart}</DyButton>
                ) : null}
              </div>
            </div>
          </DyNotice>
        ) : null}
        {phase.kind === 'ready' ? (
          <div className="flex flex-col gap-3" data-testid="site-upload-ready">
            <DyNotice tone="green" live>
              {t.ready({ n: phase.upload.fileCount, size: bytesTr(phase.upload.totalBytes) })}
            </DyNotice>
            <div className="flex flex-col gap-3" data-testid="publish-fields">
              <DySelect
                label={t.project}
                value={publish.choice}
                options={[
                  ['', target === null ? t.choose : t.isTarget({ name: target })],
                  ...further.map((c) => [c, c] as const),
                  [NEW_PROJECT, t.newProject],
                ]}
                onChange={(c) => {
                  setPublish({ ...publish, choice: c });
                  setReview(null);
                }}
              />
              {publish.choice === NEW_PROJECT ? (
                <DyField
                  label={t.newName}
                  mono
                  value={publish.newName}
                  hint={t.newNameHint}
                  onChange={(v) => {
                    setPublish({ ...publish, newName: v });
                    setReview(null);
                  }}
                />
              ) : null}
              <DyField
                label={t.domain}
                mono
                placeholder="site.example.com" // i18n-ignore: example domain
                value={publish.domain}
                onChange={(v) => {
                  setPublish({ ...publish, domain: v });
                  setReview(null);
                }}
              />
              {publish.domain.trim() !== '' ? (
                <DySelect
                  label={t.dns}
                  value={publish.dns}
                  options={[
                    ['auto', t.dnsAuto],
                    ['skip', t.dnsSkip],
                  ]}
                  onChange={(d) => {
                    setPublish({ ...publish, dns: d === 'skip' ? 'skip' : 'auto' });
                    setReview(null);
                  }}
                />
              ) : null}
              {problem === null ? null : (
                <p className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">{problem}</p>
              )}
            </div>
            {kind === 'pages.publish' && problem === null ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="site-upload-chain">
                {chainSummary(t, options, target)}
                {t.oneRequest}
              </p>
            ) : null}
            <FormActions>
              <DyButton
                icon="search"
                disabled={problem !== null || deploy.busy}
                onClick={() => void doReview(phase.upload, 'preview')}
              >
                {t.reviewPreview}
              </DyButton>
              <DyButton
                icon="search"
                disabled={problem !== null || deploy.busy}
                onClick={() => void doReview(phase.upload, 'production')}
              >
                {t.reviewProduction}
              </DyButton>
            </FormActions>
            {review !== null ? (
              <ReviewBox diff={review.diff} policy={review.policy} testId="site-upload-review">
                <div>
                  <DyButton
                    variant={review.env === 'production' ? 'warn' : 'primary'}
                    icon="rocket"
                    busy={deploy.busy}
                    disabled={review.policy.decision === 'refused'}
                    onClick={() => void doDeploy(phase.upload, review.env, review.kind)}
                  >
                    {review.env === 'production'
                      ? review.kind === 'pages.publish'
                        ? t.requestProductionPublish
                        : t.requestProductionDeploy
                      : review.kind === 'pages.publish'
                        ? t.requestPreviewPublish
                        : t.requestPreviewDeploy}
                  </DyButton>
                </div>
              </ReviewBox>
            ) : null}
            <ResultLine
              action={result}
              link={t.openDeploy}
              running={result?.kind === 'pages.publish' ? t.stepsRunning : t.sentToCloudflare}
            />
          </div>
        ) : null}
        <DyApiError error={deploy.error} retryLeft={deploy.retryLeft} />
      </div>
    </Panel>
  );
}
