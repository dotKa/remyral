import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  idempotencyKey,
  type OpsAction,
  PAGES_PROJECT_NAME,
  previewOpsAction,
  requestOpsAction,
  type RequestableKind,
} from '../../../../api/deploy';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { DyApiError, DyCheck, DyField, DyNotice, FormActions, FormGrid } from '../../forms';
import { DyButton, DySelect, Panel } from '../../parts';
import { ReviewBox, reviewOf } from './deploy-diff';
import { kindLabel, resultTone, statusLabel } from './deploy-text';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy → "Yeni Pages projesi" and "Özel alan adı bağla", feature for feature
 * with the classic `PagesProjectCard` (p6-pages-create): İncele = `POST /deploy/actions/preview` (what the master
 * would create or change and the policy outcome; nothing stored), İste = `POST /deploy/actions`. "Bu projenin Pages
 * hedefi olarak kullan" / using an existing project are deploy-target changes: project admins only, with step-up.
 * Deleting a project or a domain is not offered (Cloudflare dashboard).
 */

type Json = Record<string, unknown>;
type Review = ReturnType<typeof reviewOf>;

export function ResultLine(props: {
  readonly action: OpsAction | null;
  readonly link?: string;
  /** Wording while it is executing / deploying (the site card: "adımlar çalışıyor" / "Cloudflare’e gönderildi"). */
  readonly running?: string;
}): ReactNode {
  const a = props.action;
  const all = useT().projectTabs;
  const t = all.pages;
  if (a === null) return null;
  return (
    <DyNotice
      tone={resultTone(a)}
      live
      action={
        <Link
          to={`/deploys/${encodeURIComponent(a.id)}`}
          className="text-[0.8125rem] font-bold text-current underline underline-offset-2"
        >
          {props.link ?? t.open}
        </Link>
      }
    >
      {kindLabel(all.deployText, a.kind)}
      {a.env === null ? '' : ` (${a.env})`}:{' '}
      {a.state === 'succeeded'
        ? t.done
        : props.running !== undefined && (a.state === 'deploying' || a.state === 'executing')
          ? props.running
          : statusLabel(all.deployText, a.state, a.policy.decision, a.policy.reason)}
      {a.error === null ? '' : ` — ${a.error}`}.
    </DyNotice>
  );
}

export function PagesPanel(props: {
  readonly project: string;
  /** deploy.targets.write: may make the new project this project's Pages target. */
  readonly canEdit: boolean;
  readonly currentTarget: string | null;
  /** The target and the further Pages projects (a domain may go to any of them). */
  readonly pagesProjects: readonly string[];
  readonly onChanged: () => void;
}): ReactNode {
  const stepUp = useStepUp();
  const t = useT().projectTabs.pages;
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [useAsTarget, setUseAsTarget] = useState(props.canEdit && props.currentTarget === null);
  const [adopt, setAdopt] = useState(false);
  const [domain, setDomain] = useState('');
  const choices = props.pagesProjects;
  const [domainProject, setDomainProject] = useState('');
  const domainTarget = choices.includes(domainProject) ? domainProject : (choices[0] ?? null);
  const [writeDns, setWriteDns] = useState(true);
  const [createReview, setCreateReview] = useState<Review | null>(null);
  const [domainReview, setDomainReview] = useState<Review | null>(null);
  const [createResult, setCreateResult] = useState<OpsAction | null>(null);
  const [domainResult, setDomainResult] = useState<OpsAction | null>(null);
  const create = useSubmit();
  const attach = useSubmit();

  const nameValid = PAGES_PROJECT_NAME.test(name);
  const nameError = name === '' || nameValid ? null : t.nameError;
  const createParams = (): Json => ({
    name,
    ...(branch.trim() === '' || branch.trim() === 'main' ? {} : { productionBranch: branch.trim() }),
    ...(useAsTarget ? { useAsTarget: true } : {}),
    ...(props.canEdit && adopt ? { ifExists: 'adopt' } : {}),
  });
  const domainParams = (): Json => ({
    domain: domain.trim(),
    ...(writeDns ? {} : { dns: 'skip' }),
    ...(domainTarget !== null && domainTarget !== props.currentTarget ? { pagesProject: domainTarget } : {}),
  });

  const review = async (
    kind: RequestableKind,
    params: Json,
    set: (r: Review | null) => void,
    s: ReturnType<typeof useSubmit>,
  ) => {
    set(null);
    await s.run(async () => {
      set(reviewOf(await previewOpsAction({ project: props.project, kind, params })));
    });
  };

  const requestCreate = async () => {
    setCreateResult(null);
    await create.run(async () => {
      const send = () =>
        requestOpsAction({
          project: props.project,
          kind: 'pages.create_project',
          params: createParams(),
          idempotencyKey: idempotencyKey('pages-create'),
        });
      try {
        const a =
          useAsTarget || (props.canEdit && adopt) ? await stepUp.run(send, t.targetStepUp) : await send();
        setCreateResult(a);
        setCreateReview(null);
        props.onChanged();
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  const requestDomain = async () => {
    setDomainResult(null);
    await attach.run(async () => {
      const a = await requestOpsAction({
        project: props.project,
        kind: 'pages.add_domain',
        params: domainParams(),
        idempotencyKey: idempotencyKey('pages-domain'),
      });
      setDomainResult(a);
      setDomainReview(null);
      props.onChanged();
    });
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-2" data-testid="pages-project-card">
      <Panel title={t.title} sub={t.sub}>
        <div className="flex flex-col gap-3">
          <FormGrid>
            <DyField
              label={t.name}
              value={name}
              mono
              error={nameError}
              hint={t.nameHint}
              onChange={(v) => {
                setName(v.trim().toLowerCase());
                setCreateReview(null);
              }}
            />
            <DyField
              label={t.branch}
              value={branch}
              mono
              hint={t.branchHint}
              onChange={(v) => {
                setBranch(v);
                setCreateReview(null);
              }}
            />
          </FormGrid>
          {props.canEdit ? (
            <div className="flex flex-col gap-1">
              <DyCheck
                label={t.useAsTarget}
                testId="pages-create-use-as-target"
                hint={
                  useAsTarget
                    ? props.currentTarget === null
                      ? t.useAsTargetNew
                      : t.useAsTargetReplace({ target: props.currentTarget })
                    : props.currentTarget === null
                      ? t.notTargetNew
                      : t.notTargetKeep({ target: props.currentTarget })
                }
                checked={useAsTarget}
                onChange={(v) => {
                  setUseAsTarget(v);
                  setCreateReview(null);
                }}
              />
              <DyCheck
                label={t.adopt}
                testId="pages-create-adopt"
                hint={t.adoptHint}
                checked={adopt}
                onChange={(v) => {
                  setAdopt(v);
                  setCreateReview(null);
                }}
              />
            </div>
          ) : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">
              {t.addedOther({ keep: props.currentTarget ?? '' })}
            </p>
          )}
          <FormActions>
            <DyButton
              icon="search"
              disabled={!nameValid || create.busy}
              onClick={() => void review('pages.create_project', createParams(), setCreateReview, create)}
            >
              {t.review}
            </DyButton>
            <DyButton
              variant="primary"
              disabled={!nameValid || createReview === null}
              busy={create.busy}
              onClick={() => void requestCreate()}
            >
              {t.request}
            </DyButton>
          </FormActions>
          {createReview === null ? null : (
            <ReviewBox diff={createReview.diff} policy={createReview.policy} testId="pages-review" />
          )}
          <DyApiError error={create.error} retryLeft={create.retryLeft} />
          <ResultLine action={createResult} />
        </div>
      </Panel>

      <Panel title={t.domainTitle} testId="pages-domain">
        {domainTarget === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">{t.noTarget}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {choices.length > 1 ? (
              <DySelect
                label={t.domainProject}
                value={domainTarget}
                options={choices.map(
                  (c) => [c, c === props.currentTarget ? t.isTarget({ name: c }) : c] as const,
                )}
                onChange={(v) => {
                  setDomainProject(v);
                  setDomainReview(null);
                }}
              />
            ) : null}
            <p className="m-0 text-[0.875rem] text-dy-muted">
              <span className="font-dy-mono text-dy-ink">{domainTarget}</span>
              {t.domainHint}
            </p>
            <DyField
              label={t.domain}
              value={domain}
              mono
              placeholder="www.example.com" // i18n-ignore: example domain
              onChange={(v) => {
                setDomain(v);
                setDomainReview(null);
              }}
            />
            <DyCheck
              label={t.writeDns}
              testId="pages-domain-dns"
              checked={writeDns}
              onChange={(v) => {
                setWriteDns(v);
                setDomainReview(null);
              }}
            />
            <FormActions>
              <DyButton
                icon="search"
                disabled={domain.trim() === '' || attach.busy}
                onClick={() => void review('pages.add_domain', domainParams(), setDomainReview, attach)}
              >
                {t.review}
              </DyButton>
              <DyButton
                variant="primary"
                disabled={domainReview === null}
                busy={attach.busy}
                onClick={() => void requestDomain()}
              >
                {t.request}
              </DyButton>
            </FormActions>
            {domainReview === null ? null : (
              <ReviewBox diff={domainReview.diff} policy={domainReview.policy} testId="pages-review" />
            )}
            <DyApiError error={attach.error} retryLeft={attach.retryLeft} />
            <ResultLine action={domainResult} />
          </div>
        )}
      </Panel>
    </div>
  );
}
