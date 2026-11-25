import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ApiError } from '../../../../api/client';
import { listProjects, type Project } from '../../../../api/directory';
import { type CredentialView, listCredentials } from '../../../../api/vault';
import {
  credentialCovers,
  dryRunTemplate,
  type InstantiateResult,
  instantiateTemplate,
  listWorkflowTemplates,
  originHost,
  SMTP_PRESET_HOSTS,
  TEMPLATE_RUNTIMES,
  type TemplateDryRun,
  type TemplatePlaceholder,
  type WorkflowTemplate,
} from '../../../../api/workflowTemplates';
import { toApiError } from '../../../../components/ui';
import { useLocale, useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { DyApiError, DyChoice, DyInput, DyNotice } from '../../kit';
import { DyButton, ErrorLine, Panel, SkeletonRows } from '../../parts';
import { ScreenFrame } from '../../ScreenFrame';
import { WORKFLOW_NAME } from '../model';
import { canDefine } from '../WorkflowsScreen';
import { TemplateGraph } from './TemplateGraph';
import { AttachResult, AttachTargets } from './AttachParts';
import { PRIVILEGED_ACTIONS, templateFeatures, templateText } from './templateText';

/**
 * p14-workflow-engine 14.5 (docs/design/p14-workflow-engine.md §20): `/workflows/templates/:id` — create a workflow
 * from a template in three steps: 1) the project (one the user may define workflows in) and the workflow name; 2) the
 * template's placeholders by kind — service origins, vault credentials of the right kind (with the addresses they are
 * bound to; values never reach the browser or the master), e-mail addresses, the schedule, the runtime; 3) a dry run
 * on the master (the document validated like any definition), then "Oluştur" saves version 1 (network / code nodes:
 * admin + step-up, retried after the code) and opens the editor. Nothing runs.
 */

const MAIL = /^[^@\s<>",;()\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

type Values = Readonly<Record<string, string>>;

function originOk(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.username === '' &&
      u.password === '' &&
      (u.pathname === '/' || u.pathname === '') &&
      u.search === '' &&
      u.hash === '' &&
      !/\/.+/.test(v.replace(/^https?:\/\//, ''))
    );
  } catch {
    return false;
  }
}

/** The client-side problem of one value (the master checks everything again), or null. */
export function valueProblem(
  p: TemplatePlaceholder,
  raw: string | undefined,
  w: ReturnType<typeof useT>['workflowGallery']['wizard'],
): string | null {
  const v = (raw ?? '').trim();
  if (v === '') return p.required ? w.requiredMissing : null;
  switch (p.kind) {
    case 'origin':
      return originOk(v) ? null : w.originBad;
    case 'email':
      return MAIL.test(v) ? null : w.emailBad;
    case 'path':
      return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,2047}$/.test(v) && !v.includes('//') && !v.includes('..')
        ? null
        : w.pathBad;
    case 'text':
      return v.length > 200 || v.includes('{{') || v.includes('}}') ? w.textBad : null;
    case 'choice':
      return (p.options ?? []).includes(v) ? null : w.requiredMissing;
    case 'number': {
      const n = Number(v);
      const min = p.min ?? Number.MIN_SAFE_INTEGER;
      const max = p.max ?? Number.MAX_SAFE_INTEGER;
      return Number.isFinite(n) && n >= min && n <= max
        ? null
        : w.numberBad({ min: String(p.min ?? '—'), max: String(p.max ?? '—') });
    }
    default:
      return null;
  }
}

function initialValues(tpl: WorkflowTemplate): Record<string, string> {
  return Object.fromEntries(tpl.placeholders.map((p) => [p.key, p.default ?? '']));
}

function PlaceholderField(props: {
  readonly placeholder: TemplatePlaceholder;
  readonly label: string;
  readonly hint: string | undefined;
  readonly value: string;
  readonly values: Values;
  readonly placeholders: readonly TemplatePlaceholder[];
  readonly credentials: readonly CredentialView[] | null;
  readonly showError: boolean;
  readonly onChange: (v: string) => void;
}): ReactNode {
  const w = useT().workflowGallery.wizard;
  const p = props.placeholder;
  const problem = props.showError ? valueProblem(p, props.value, w) : null;
  const label = `${props.label} (${p.required ? w.required : w.optional})`;
  if (p.kind === 'credential') {
    const list = (props.credentials ?? []).filter((c) => c.kind === p.credentialKind && c.state === 'active');
    const fromValue = p.hostFrom === null ? null : (props.values[p.hostFrom] ?? '');
    const from = p.hostFrom === null ? undefined : props.placeholders.find((x) => x.key === p.hostFrom);
    // An SMTP provider names its server; its credential may be bound to `host` or `host:port`.
    const smtpHost =
      from?.kind === 'smtpProvider' && fromValue !== null ? SMTP_PRESET_HOSTS[fromValue] : undefined;
    const target =
      smtpHost !== undefined
        ? { host: smtpHost, port: null }
        : fromValue === null || fromValue === ''
          ? null
          : originHost(fromValue);
    const covers = (allowed: readonly string[] | null): boolean =>
      target !== null &&
      (credentialCovers(allowed, target) ||
        (smtpHost !== undefined && (allowed ?? []).some((a) => a.startsWith(`${smtpHost}:`))));
    const chosen = list.find((c) => c.id === props.value);
    let warn: string | null = null;
    if (target !== null) {
      if (chosen !== undefined && !covers(chosen.allowedHosts))
        warn = w.credentialNotBound({ host: target.host });
      else if (chosen === undefined && !list.some((c) => covers(c.allowedHosts)))
        warn = w.credentialNoneBound({ host: target.host });
    }
    const options: (readonly [string, string])[] = [
      ['', w.credentialPick],
      ...list.map((c) => [c.id, `${c.name} (${c.id})`] as const),
    ];
    return (
      <div className="grid gap-1" data-testid={`placeholder-${p.key}`}>
        <DyChoice
          label={label}
          value={props.value}
          options={options}
          error={problem}
          hint={
            chosen?.allowedHosts == null
              ? (props.hint ?? (list.length === 0 ? w.credentialNone : undefined))
              : w.credentialHosts({ hosts: chosen.allowedHosts.join(', ') })
          }
          onChange={props.onChange}
        />
        {warn === null ? null : (
          <p className="m-0 text-[0.78125rem] text-dy-amber-ink" data-testid={`placeholder-${p.key}-warn`}>
            {warn}
          </p>
        )}
        {list.length === 0 || warn !== null ? (
          <Link
            to="/settings/credentials"
            className="text-[0.8125rem] font-bold text-dy-teal-ink underline underline-offset-2"
          >
            {w.credentialAdd}
          </Link>
        ) : null}
      </div>
    );
  }
  const choices =
    p.options ??
    (p.kind === 'smtpProvider'
      ? Object.keys(SMTP_PRESET_HOSTS)
      : p.kind === 'runtime'
        ? TEMPLATE_RUNTIMES
        : null);
  if ((p.kind === 'smtpProvider' || p.kind === 'runtime' || p.kind === 'choice') && choices !== null) {
    return (
      <div data-testid={`placeholder-${p.key}`}>
        <DyChoice
          label={label}
          value={props.value}
          options={[...(p.required ? [] : [['', w.choose] as const]), ...choices.map((o) => [o, o] as const)]}
          hint={props.hint}
          error={problem}
          onChange={props.onChange}
        />
      </div>
    );
  }
  return (
    <div data-testid={`placeholder-${p.key}`}>
      <DyInput
        label={label}
        value={props.value}
        hint={p.kind === 'cron' ? (props.hint ?? w.cronHint) : props.hint}
        error={problem}
        type={p.kind === 'email' ? 'email' : p.kind === 'number' ? 'number' : 'text'}
        inputMode={p.kind === 'origin' ? 'url' : undefined}
        min={p.min ?? undefined}
        max={p.max ?? undefined}
        placeholder={
          p.kind === 'origin' ? w.originPlaceholder : p.kind === 'path' ? w.pathPlaceholder : undefined
        }
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      />
    </div>
  );
}

export function TemplateWizard(props: { readonly id: string }): ReactNode {
  const t = useT();
  const g = t.workflowGallery;
  const w = g.wizard;
  const { locale } = useLocale();
  const stepUp = useStepUp();
  const navigate = useNavigate();
  const [tpl, setTpl] = useState<WorkflowTemplate | null | 'missing'>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [credentials, setCredentials] = useState<readonly CredentialView[] | null>(null);
  const [step, setStep] = useState(0);
  const [project, setProject] = useState('');
  const [name, setName] = useState(props.id.slice(0, 64));
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [dry, setDry] = useState<TemplateDryRun | null>(null);
  // p18-multi-project W4: "Başka projelere de ekle" — offer the new workflow and attach it there.
  const [attachTo, setAttachTo] = useState<string[]>([]);
  const [result, setResult] = useState<InstantiateResult | null>(null);
  const check = useSubmit();
  const act = useSubmit();

  const load = useCallback(() => {
    setError(null);
    listWorkflowTemplates().then(
      (l) => {
        const found = l.templates.find((x) => x.id === props.id);
        if (found === undefined) {
          setTpl('missing');
          return;
        }
        setTpl(found);
        setValues(initialValues(found));
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [props.id]);
  useEffect(() => {
    load();
    listProjects().then(
      (ps) => {
        setProjects(ps);
        const first = ps.find((p) => canDefine(ps, p.id));
        if (first !== undefined) setProject((cur) => (cur === '' ? first.id : cur));
      },
      () => {
        setProjects([]);
      },
    );
    // No vault.read (or the vault is off): the credential selects stay empty with the "add" link.
    listCredentials().then(setCredentials, () => {
      setCredentials([]);
    });
  }, [load]);

  const definable = useMemo(() => (projects ?? []).filter((p) => canDefine(projects, p.id)), [projects]);
  const body = useMemo(() => ({ project, name, values, locale }), [project, name, values, locale]);

  const runCheck = useCallback(
    (id: string) => {
      setDry(null);
      void check.run(async () => {
        setDry(await dryRunTemplate(id, body));
      });
    },
    [body],
  );

  if (tpl === null || projects === null) {
    return (
      <ScreenFrame
        title={g.title}
        back={{ to: '/workflows/templates', label: g.title }}
        testId="dy-template-wizard"
      >
        {error === null ? (
          <SkeletonRows label={g.loading} rows={4} />
        ) : (
          <ErrorLine error={error} what={g.what} onRetry={load} />
        )}
      </ScreenFrame>
    );
  }
  if (tpl === 'missing') {
    return (
      <ScreenFrame
        title={g.title}
        back={{ to: '/workflows/templates', label: g.title }}
        testId="dy-template-wizard"
      >
        <DyNotice tone="red" testId="template-missing">
          {w.notFound}
        </DyNotice>
      </ScreenFrame>
    );
  }

  const text = templateText(t, tpl.id);
  const kind = projects.find((p) => p.id === project)?.kind ?? null;
  const nameBad = !WORKFLOW_NAME.test(name);
  const problems = tpl.placeholders.map((p) => valueProblem(p, values[p.key], w));
  const valuesBad = problems.some((x) => x !== null);
  const f = templateFeatures(tpl.nodes.map((n) => n.type));
  const steps = [w.steps.where, w.steps.values, w.steps.review];
  const privileged = (dry?.privileged ?? tpl.requires).filter((a) =>
    (PRIVILEGED_ACTIONS as readonly string[]).includes(a),
  );
  const actionWord = (a: string): string =>
    (w.actions as Record<string, string | undefined>)[a.replace(/^workflows\.define\./, '')] ?? a;
  const labelOf = (key: string): string => text.placeholders[key]?.label ?? key;
  const issueLine = (i: { path: string; code: string }): string => {
    const m = /^values\.([A-Za-z0-9_]+)$/.exec(i.path);
    return m?.[1] === undefined ? `${i.path || '—'}: ${i.code}` : `${labelOf(m[1])}: ${i.code}`;
  };

  const go = (n: number): void => {
    setStep(n);
    if (n === 2) runCheck(tpl.id);
  };

  const create = (): void => {
    let made: InstantiateResult | null = null;
    const targets = attachTo.filter((p) => p !== project);
    void act
      .run(async () => {
        try {
          made = await stepUp.run(
            () => instantiateTemplate(tpl.id, targets.length === 0 ? body : { ...body, attachTo: targets }),
            w.stepUp,
          );
        } catch (err) {
          if (err instanceof StepUpCancelledError) return;
          throw err;
        }
      })
      .then((ok) => {
        const m: InstantiateResult | null = made;
        if (!ok || m === null) return;
        if (targets.length > 0) {
          setResult(m);
          return;
        }
        void navigate(`/workflows/${encodeURIComponent(m.id)}`, { state: { saved: m.version } });
      });
  };

  if (result !== null) {
    return (
      <ScreenFrame
        title={w.title({ name: text.name })}
        back={{ to: '/workflows/templates', label: g.title }}
        testId="dy-template-wizard"
        width="narrow"
      >
        <AttachResult result={result} />
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame
      title={w.title({ name: text.name })}
      purpose={text.description === '' ? undefined : text.description}
      back={{ to: '/workflows/templates', label: g.title }}
      testId="dy-template-wizard"
      width="narrow"
    >
      <ol className="m-0 mb-4 flex list-none flex-wrap gap-2 p-0" data-testid="wizard-steps">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={
              i === step
                ? 'rounded-full bg-dy-ink px-3 py-1 text-[0.8125rem] font-bold text-dy-card'
                : 'rounded-full bg-dy-sunk px-3 py-1 text-[0.8125rem] text-dy-muted'
            }
          >
            {`${String(i + 1)}. ${s}`}
          </li>
        ))}
      </ol>
      <p className="m-0 mb-3 text-[0.8125rem] text-dy-muted" aria-live="polite">
        {w.stepOf({ n: step + 1, total: steps.length })}
      </p>
      {step === 0 ? (
        <Panel title={w.steps.where} testId="wizard-where">
          <div className="grid gap-3 px-4 pt-2 pb-4">
            {definable.length === 0 ? (
              <DyNotice tone="amber">{w.noProject}</DyNotice>
            ) : (
              <DyChoice
                label={w.project}
                value={project}
                options={definable.map(
                  (p) => [p.id, p.name === p.id ? p.id : `${p.name} (${p.id})`] as const,
                )}
                onChange={(v) => {
                  setProject(v);
                }}
              />
            )}
            {kind === 'repository' && f.ai ? (
              <DyNotice tone="neutral" testId="wizard-repository-note">
                {w.repositoryNote}
              </DyNotice>
            ) : kind === 'workspace' ? (
              <DyNotice tone="teal" testId="wizard-workspace-note">
                {w.workspaceNote}
              </DyNotice>
            ) : null}
            <AttachTargets projects={projects} owner={project} chosen={attachTo} onChange={setAttachTo} />
            <DyInput
              label={w.name}
              value={name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              hint={w.nameHint}
              error={name !== '' && nameBad ? w.nameBad : null}
              onChange={(e) => {
                setName(e.target.value.trim());
              }}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <DyButton
                variant="primary"
                disabled={definable.length === 0 || project === '' || nameBad}
                onClick={() => {
                  go(1);
                }}
              >
                {w.next}
              </DyButton>
            </div>
          </div>
        </Panel>
      ) : null}
      {step === 1 ? (
        <Panel title={w.steps.values} testId="wizard-values">
          <div className="grid gap-3 px-4 pt-2 pb-4">
            <p className="m-0 text-[0.875rem] text-dy-muted">{w.valuesIntro}</p>
            {f.http || f.email || f.code ? <DyNotice tone="neutral">{w.machineNote}</DyNotice> : null}
            {tpl.placeholders.map((p) => (
              <PlaceholderField
                key={p.key}
                placeholder={p}
                label={labelOf(p.key)}
                hint={text.placeholders[p.key]?.hint}
                value={values[p.key] ?? ''}
                values={values}
                placeholders={tpl.placeholders}
                credentials={credentials}
                showError={touched}
                onChange={(v) => {
                  setValues((cur) => ({ ...cur, [p.key]: v }));
                }}
              />
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <DyButton
                variant="ghost"
                onClick={() => {
                  setStep(0);
                }}
              >
                {w.previous}
              </DyButton>
              <DyButton
                variant="primary"
                onClick={() => {
                  setTouched(true);
                  if (!valuesBad) go(2);
                }}
              >
                {w.next}
              </DyButton>
            </div>
          </div>
        </Panel>
      ) : null}
      {step === 2 ? (
        <Panel title={w.steps.review} testId="wizard-review">
          <div className="grid gap-3 px-4 pt-2 pb-4">
            <TemplateGraph template={tpl} />
            {check.busy ? <SkeletonRows label={w.checking} rows={1} /> : null}
            <DyApiError error={check.error} />
            {dry === null ? null : dry.valid ? (
              <DyNotice tone="teal" testId="wizard-valid">
                {w.valid}
              </DyNotice>
            ) : (
              <DyNotice tone="red" testId="wizard-issues">
                <b className="font-bold">{w.invalid}</b>
                <ul className="m-0 mt-1 list-disc pl-5">
                  {dry.issues.map((i, k) => (
                    <li key={`${i.path}-${i.code}-${String(k)}`} className="[overflow-wrap:anywhere]">
                      {issueLine(i)}
                    </li>
                  ))}
                </ul>
              </DyNotice>
            )}
            {privileged.length === 0 ? null : (
              <DyNotice tone="amber" testId="wizard-privileged">
                {w.privileged({ list: privileged.map(actionWord).join(', ') })}
              </DyNotice>
            )}
            <DyApiError error={act.error} />
            <div className="flex flex-wrap justify-between gap-2">
              <DyButton
                variant="ghost"
                onClick={() => {
                  setStep(1);
                }}
              >
                {w.previous}
              </DyButton>
              <div className="flex flex-wrap gap-2">
                <DyButton
                  icon="retry"
                  busy={check.busy}
                  onClick={() => {
                    runCheck(tpl.id);
                  }}
                >
                  {w.check}
                </DyButton>
                <DyButton
                  variant="primary"
                  icon="plus"
                  busy={act.busy}
                  disabled={dry?.valid !== true || act.blocked}
                  onClick={create}
                >
                  {w.create}
                </DyButton>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}
    </ScreenFrame>
  );
}
