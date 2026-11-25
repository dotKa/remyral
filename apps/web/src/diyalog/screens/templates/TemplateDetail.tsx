import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  automateTemplate,
  duplicateTemplate,
  getTemplate,
  renderTemplate,
  setTemplateArchived,
  type Template,
  templateDiff,
  templateVersions,
  type TemplateVersion,
} from '../../../api/templates';
import { toApiError } from '../../../components/ui';
import { useNow } from '../../../lib/now';
import { runtimeName } from '../../../lib/reasons';
import {
  composerState,
  initialValues,
  toRequest,
  useRunnableProjects,
  type Values,
} from '../../../screens/templates/shared';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { APPROVAL_TR, CLASS_TR, SANDBOX_TR, VERIFY_TR } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { agoText, DyButton, DyButtonLink, ErrorLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { ScreenFrame, SegTabs } from '../ScreenFrame';
import { DiffBlock, Field, ParamFields, ScopePill, secText, SelectField, statsText } from './parts';
import { useT } from '../../../i18n/I18nProvider';
import { hasLibrary, LibraryPanel, LibraryPills } from './LibraryParts';

/**
 * p12-diyalog-w1: `/jobs/templates/:id` in the Diyalog language — run it (parameter form → the composer prefilled;
 * the person checks and submits there, the job is attributed to this version), turn it into an automation (step-up,
 * as on the classic page), its prompt and run settings, versions with a diff, duplicate, archive / restore, edit.
 */

const PROJECT_DEFAULT = 'proje varsayılanı';

function SettingsList(props: { readonly t: Template }): ReactNode {
  const d = props.t.current.defaults;
  const rows: [string, string][] = [
    ['Runtime', runtimeName(d.runtime)],
    ['Model', d.modelProfile ?? PROJECT_DEFAULT],
    [
      'Kum havuzu',
      d.sandboxProfile === undefined
        ? PROJECT_DEFAULT
        : (SANDBOX_TR[d.sandboxProfile]?.label ?? d.sandboxProfile),
    ],
    [
      'Onay',
      d.approvalPolicy === undefined
        ? PROJECT_DEFAULT
        : (APPROVAL_TR[d.approvalPolicy]?.label ?? d.approvalPolicy),
    ],
    [
      'Süre sınırı',
      d.limits?.maxDurationSec === undefined ? PROJECT_DEFAULT : secText(d.limits.maxDurationSec),
    ],
    [
      'Bitince yayınla',
      d.deployOnSuccess === undefined
        ? 'hayır'
        : `${d.deployOnSuccess.target === 'pages' ? 'Cloudflare Pages' : 'Coolify'} (${d.deployOnSuccess.env === 'production' ? 'canlı' : 'önizleme'})`,
    ],
    ['Bitince doğrula', d.verify === undefined ? PROJECT_DEFAULT : (VERIFY_TR[d.verify] ?? d.verify)],
    ['Sohbette haber ver', d.watch === true ? 'evet' : 'hayır'],
    ['Öncelik sınıfı', CLASS_TR[d.priorityClass ?? 'normal']],
  ];
  return <KeyValue rows={rows.map(([k, v]) => ({ k, v }))} />;
}

function RunPanel(props: { readonly t: Template; readonly here: string | undefined }): ReactNode {
  const sayError = useErrorText();
  const { t } = props;
  const lib = useT().multiProject.library;
  const navigate = useNavigate();
  const stepUp = useStepUp();
  const projects = useRunnableProjects();
  const [values, setValues] = useState<Values>(() => initialValues(t.current.parameters));
  // p18-multi-project W4: a shared template runs in a project it is shared to (the viewed one by default).
  const shared = t.scope === 'shared';
  const [project, setProject] = useState(shared ? (props.here ?? '') : (t.project ?? ''));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [automate, setAutomate] = useState(false);
  const [name, setName] = useState(`${t.title} (zamanlanmış)`.slice(0, 200));
  const [cron, setCron] = useState('0 3 * * *');
  const [created, setCreated] = useState<string | null>(null);
  const target = shared
    ? project === ''
      ? undefined
      : project
    : (t.project ?? (project === '' ? undefined : project));
  const active = t.state === 'active';
  const sharedProjects = (projects ?? []).filter(
    (p) => t.sharedTo.includes('*') || t.sharedTo.includes(p.id),
  );

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await renderTemplate(t.id, toRequest(t.current.parameters, values), target);
      void navigate('/jobs/new', { state: composerState(t, r) });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const schedule = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await stepUp.run(
        () =>
          automateTemplate(t.id, {
            ...(target === undefined ? {} : { project: target }),
            name: name.trim(),
            trigger: { kind: 'cron', cron: cron.trim() },
            values: toRequest(t.current.parameters, values),
          }),
        'Bir otomasyon bu şablonu senin adına, zamanında çalıştırır — güncel bir authenticator kodu gir.',
      );
      setCreated(out.automationId);
      setAutomate(false);
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Çalıştır"
      sub="Form, işlenmiş istem ve bu şablonun ayarlarıyla açılır; sen orada gönderene kadar hiçbir şey çalışmaz."
      testId="dy-template-run"
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {t.project === null ? (
          <SelectField
            label="Proje"
            value={project}
            testId="run-project"
            wrapClass="sm:max-w-xs"
            options={[['', 'Bir proje seç…'], ...(projects ?? []).map((p) => [p.id, p.name] as const)]}
            onChange={setProject}
            hint="Genel şablon: işin çalışacağı projeyi seç."
          />
        ) : shared ? (
          <SelectField
            label={lib.runProject}
            value={project}
            testId="run-project"
            wrapClass="sm:max-w-xs"
            options={[['', lib.choose], ...sharedProjects.map((p) => [p.id, p.name] as const)]}
            onChange={setProject}
            hint={lib.runHint}
          />
        ) : null}
        <ParamFields params={t.current.parameters} values={values} onChange={setValues} />
        {error === null ? null : (
          <p
            role="alert"
            className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
          >
            {sayError(error)}
          </p>
        )}
        {created === null ? null : (
          <p
            role="status"
            className="m-0 flex flex-wrap items-center gap-2 rounded-[10px] bg-dy-green-soft px-3.5 py-2 text-[0.875rem] text-dy-green"
          >
            <DyIcon name="checkc" className="size-4" />
            Otomasyon oluşturuldu.
            <Link
              className="font-bold text-dy-green underline"
              to={`/automations/${encodeURIComponent(created)}`}
            >
              Aç
            </Link>
          </p>
        )}
        {active ? null : (
          <p className="m-0 text-[0.84375rem] text-dy-amber-ink">
            Arşivlenmiş şablon çalıştırılamaz; önce geri yükle.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <DyButton
            type="submit"
            variant="primary"
            icon="send"
            busy={busy && !automate}
            disabled={!active || busy}
            data-testid="run-template"
          >
            Formda aç
          </DyButton>
          <DyButton
            icon="clock"
            aria-expanded={automate}
            aria-controls="dy-template-automate"
            disabled={!active || busy}
            onClick={() => {
              setAutomate((v) => !v);
            }}
          >
            Otomatikleştir…
          </DyButton>
        </div>
      </form>
      {automate ? (
        <form
          id="dy-template-automate"
          aria-label="Bu şablonu zamanla çalıştır"
          className="mt-4 grid gap-3 rounded-[12px] border border-dy-line bg-dy-sunk p-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void schedule();
          }}
        >
          <div>
            <h3 className="m-0 text-[0.9375rem] font-bold">Bu şablonu zamanla çalıştır</h3>
            <p className="m-0 mt-0.5 text-[0.8125rem] text-dy-muted">
              Yukarıdaki değerler her çalışmada aynı kalır. Saatler UTC.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Ad"
              value={name}
              maxLength={200}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <Field
              label="Cron (UTC)"
              mono
              value={cron}
              hint="örn. 0 3 * * * = her gün 03:00 UTC; diğer tetikleyiciler: Otomasyonlar → Yeni otomasyon"
              onChange={(e) => {
                setCron(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <DyButton
              type="submit"
              variant="primary"
              busy={busy}
              disabled={name.trim() === '' || cron.trim() === ''}
            >
              Otomasyon oluştur
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setAutomate(false);
              }}
            >
              Vazgeç
            </DyButton>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}

function Versions(props: { readonly t: Template; readonly here?: string | undefined }): ReactNode {
  const { t, here } = props;
  const now = useNow();
  const [items, setItems] = useState<TemplateVersion[] | null>(null);
  const [from, setFrom] = useState(Math.max(1, t.version - 1));
  const [to, setTo] = useState(t.version);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    templateVersions(t.id, {}, here).then(setItems, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [t.id, t.version, here]);
  useEffect(() => {
    if (from === to) {
      setDiff('');
      return;
    }
    setDiff(null);
    templateDiff(t.id, from, to, {}, here).then(setDiff, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [t.id, from, to, here]);
  const opts = (items ?? []).map((v) => [String(v.version), `v${String(v.version)}`] as const);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:items-start">
      <Panel title="Sürümler" count={String(t.version)} countLabel={`${String(t.version)} sürüm`} flush>
        <ErrorLine error={error} what="Sürümler" />
        {items === null ? (
          <SkeletonRows label="Sürümler yükleniyor" />
        ) : (
          <Rows label="Sürümler" testId="versions">
            {[...items].reverse().map((v) => (
              <Row
                key={v.version}
                testId="dy-version"
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-dy-mono tabular-nums">{`v${String(v.version)}`}</span>
                    {v.version === t.version ? (
                      <Pill tone="green" icon="check">
                        güncel
                      </Pill>
                    ) : null}
                  </span>
                }
                meta={
                  <>
                    <span>{agoText(v.createdAt, now)}</span>
                    {v.changeNote ? (
                      <span className="w-full [overflow-wrap:anywhere]">{v.changeNote}</span>
                    ) : null}
                  </>
                }
              />
            ))}
          </Rows>
        )}
      </Panel>
      <Panel title="Fark" testId="dy-template-diff">
        {opts.length > 1 ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <SelectField
                label="Şundan"
                value={String(from)}
                options={opts}
                onChange={(v) => {
                  setFrom(Number(v));
                }}
              />
              <SelectField
                label="Şuna"
                value={String(to)}
                options={opts}
                onChange={(v) => {
                  setTo(Number(v));
                }}
              />
            </div>
            {diff === null ? <SkeletonRows label="Fark yükleniyor" rows={2} /> : <DiffBlock diff={diff} />}
          </div>
        ) : (
          <p className="m-0 text-[0.875rem] text-dy-muted">Tek sürüm var; karşılaştırılacak bir şey yok.</p>
        )}
      </Panel>
    </div>
  );
}

function Loaded(props: {
  readonly t: Template;
  readonly here: string | undefined;
  readonly onChange: (t: Template) => void;
}): ReactNode {
  const sayError = useErrorText();
  const { t, here } = props;
  const lib = useT().multiProject.library;
  // p18-multi-project W4: a shared template is copied into the viewed project ("Projeye kopyala").
  const copyTo = t.scope === 'shared' ? (here ?? t.sharedTo.find((p) => p !== '*')) : undefined;
  const navigate = useNavigate();
  const now = useNow();
  const [busy, setBusy] = useState<'dup' | 'arch' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const act = async (kind: 'dup' | 'arch', fn: () => Promise<Template>, go?: boolean): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const out = await fn();
      if (go === true) void navigate(`/jobs/templates/${encodeURIComponent(out.id)}`);
      else props.onChange(out);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScreenFrame
      title={t.title}
      back={{ to: '/jobs/templates', label: 'Şablonlar' }}
      purpose={t.description === '' ? undefined : t.description}
      testId="dy-template"
      actions={
        <>
          {t.canEdit && t.state === 'active' ? (
            <DyButtonLink
              to={`/jobs/templates/${encodeURIComponent(t.id)}/edit`}
              variant="primary"
              icon="pen"
            >
              Düzenle
            </DyButtonLink>
          ) : null}
          <DyButton
            icon="copy"
            busy={busy === 'dup'}
            disabled={busy !== null}
            onClick={() => void act('dup', () => duplicateTemplate(t.id, {}, copyTo), true)}
          >
            Çoğalt
          </DyButton>
          {t.canEdit ? (
            <DyButton
              icon={t.state === 'active' ? 'tray' : 'retry'}
              busy={busy === 'arch'}
              disabled={busy !== null}
              onClick={() => void act('arch', () => setTemplateArchived(t.id, t.state === 'active'))}
            >
              {t.state === 'active' ? 'Arşivle' : 'Geri yükle'}
            </DyButton>
          ) : null}
        </>
      }
      facts={
        <>
          <ScopePill project={t.project} />
          <LibraryPills t={t} />
          <Pill tone="neutral">{`v${String(t.version)}`}</Pill>
          {t.state === 'archived' ? (
            <Pill tone="amber" icon="tray">
              Arşivde
            </Pill>
          ) : null}
          {t.tags.map((tag) => (
            <Pill key={tag} tone="neutral" icon="flag">
              {tag}
            </Pill>
          ))}
          <span className="text-[0.8125rem] text-dy-muted" data-testid="template-stats">
            {statsText(t.stats)}
          </span>
        </>
      }
    >
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 mb-4 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
        >
          {sayError(error)}
        </p>
      )}
      <SegTabs
        label="Şablon"
        items={[
          { id: 'run', label: 'Çalıştır' },
          { id: 'prompt', label: 'İstem ve ayarlar' },
          { id: 'versions', label: 'Sürümler', count: t.version },
          ...(hasLibrary(t, here) ? [{ id: 'library', label: lib.in }] : []),
        ]}
      >
        {(tab) =>
          tab === 'library' ? (
            <LibraryPanel t={t} here={here} onChange={props.onChange} />
          ) : tab === 'versions' ? (
            <Versions t={t} here={here} />
          ) : tab === 'prompt' ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
              <Panel title="İstem" sub="{{yer tutucular}} çalıştırırken alıntılanmış veri olarak doldurulur.">
                <pre
                  className="m-0 max-h-[32rem] overflow-auto rounded-[10px] bg-dy-sunk px-3 py-2.5 font-dy-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
                  data-testid="dy-template-prompt"
                >
                  {t.current.prompt}
                </pre>
              </Panel>
              <Panel
                title="Çalışma ayarları"
                sub={
                  t.stats.lastRunAt === null ? undefined : `Son çalışma ${agoText(t.stats.lastRunAt, now)}`
                }
              >
                <SettingsList t={t} />
              </Panel>
            </div>
          ) : (
            <RunPanel t={t} here={here} />
          )
        }
      </SegTabs>
    </ScreenFrame>
  );
}

export function TemplateDetail(props: { readonly id: string }): ReactNode {
  const [t, setT] = useState<Template | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // p18-multi-project W4: `?project=` — the project whose library the template is read in (a shared one, hiding).
  const search = useLocation().search;
  const here = new URLSearchParams(search).get('project') ?? undefined;
  const load = useCallback(() => {
    setError(null);
    getTemplate(props.id, {}, here).then(setT, (err: unknown) => {
      setError(toApiError(err));
    });
  }, [props.id, here]);
  useEffect(load, [load]);
  if (t === null)
    return (
      <ScreenFrame title="Şablon" back={{ to: '/jobs/templates', label: 'Şablonlar' }} testId="dy-template">
        {error === null ? (
          <SkeletonRows label="Şablon yükleniyor" />
        ) : (
          <ErrorLine error={error} what="Şablon" onRetry={load} />
        )}
      </ScreenFrame>
    );
  return <Loaded t={t} here={here} onChange={setT} />;
}
