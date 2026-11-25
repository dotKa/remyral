import { fill, type Messages } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../../auth/AuthProvider';
import type { ApiError } from '../../../api/client';
import {
  buildReport,
  type DoctorOverview,
  type DoctorRun,
  downloadReport,
  type Finding,
  getDoctor,
  getMachineDoctor,
  getSupportSettings,
  putSupportSettings,
  type ReportPreview,
  requestMachineDoctor,
  runDoctor,
  SECTIONS,
  type Section,
  type SendResult,
  sendReport,
  type Severity,
  type Summary,
  type SupportSettings,
  type WorkerReport,
  type WorkerResult,
} from '../../../api/doctor';
import { saveWithLink } from '../../../api/download';
import { toApiError } from '../../../components/ui';
import { formatBytes } from '../../../screens/backupBytes';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DyTabs } from '../../formkit';
import type { IconName } from '../../icons';
import type { Tone } from '../../tone';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea, FormActions } from '../forms';
import { agoText, DyButton, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../parts';
import { toast } from '../../toast/store';

/**
 * p16-doctor (docs/design/p16-doctor.md §6): Ayarlar → Tanılama, owners and admins.
 *
 * - Doktor: "Tanılamayı çalıştır" (optionally every connected machine's doctor), the findings worst first with the
 *   suggested fix and a link to the page that fixes it, the passed checks on request, the last daily run.
 * - Makine doktorları: the machines' reports of the last run; "Doktoru çalıştır" asks one machine and follows it.
 * - Destek raporu: a description ("Destek kaydı oluştur"), the sections (job prompts never preselected), the log window;
 *   "Önizle" builds the redacted bundle and shows its exact files, sizes and summary; download the zip or send it by
 *   e-mail to the support address (step-up by the security policy, a copy to the user's own address on request).
 * - Destek ayarları: the support address and an optional SMTP server (owners change them; the password never comes back).
 */

type Words = Messages['doctor'];
const WORKER_DOCTOR_COMMAND = 'remyral-worker doctor --out doctor.zip';

const SEV: Readonly<Record<Severity, { tone: Tone; icon: IconName }>> = {
  error: { tone: 'red', icon: 'xc' },
  warning: { tone: 'amber', icon: 'shield' },
  info: { tone: 'neutral', icon: 'clock' },
  ok: { tone: 'green', icon: 'checkc' },
};

const key = (check: string): string => check.replaceAll('.', '_');

type Texts = Readonly<
  Record<string, Readonly<Record<string, { readonly text: string; readonly fix?: string }>>>
>;

/** The finding's text and fix in the user's language (check + code), else the master's English text. */
export function findingText(
  t: Words,
  f: Finding,
  side: 'master' | 'worker',
): { readonly text: string; readonly fix: string | null } {
  const by = (side === 'master' ? t.findings.master : t.findings.worker) as unknown as Texts;
  const common = t.findings.common as unknown as Readonly<Record<string, { text: string }>>;
  const entry =
    by[key(f.check)]?.[f.code] ??
    (f.code === 'check_failed' || f.code === 'more' ? common[f.code] : undefined);
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f.params ?? {})) params[k] = typeof v === 'boolean' ? String(v) : v;
  if (entry === undefined) return { text: f.message, fix: f.fix ?? null };
  const fix = 'fix' in entry && typeof entry.fix === 'string' ? fill(entry.fix, params) : (f.fix ?? null);
  return { text: fill(entry.text, params), fix: f.severity === 'ok' ? null : fix };
}

function checkTitle(t: Words, check: string): string {
  const titles = t.checks as unknown as Readonly<Record<string, string>>;
  return titles[key(check)] ?? check;
}

function SummaryPills(props: { readonly s: Summary }): ReactNode {
  const t = useT().doctor;
  return (
    <span className="inline-flex flex-wrap gap-1.5" data-testid="dy-doctor-summary">
      {props.s.error > 0 ? <Pill tone="red">{t.summary.error({ n: props.s.error })}</Pill> : null}
      {props.s.warning > 0 ? <Pill tone="amber">{t.summary.warning({ n: props.s.warning })}</Pill> : null}
      {props.s.info > 0 ? <Pill tone="neutral">{t.summary.info({ n: props.s.info })}</Pill> : null}
      <Pill tone="green">{t.summary.ok({ n: props.s.ok })}</Pill>
    </span>
  );
}

function DocsLink(props: { readonly docs: string | undefined }): ReactNode {
  const t = useT().doctor;
  const d = props.docs;
  if (d === undefined) return null;
  if (d.startsWith('/'))
    return (
      <Link to={d} className="text-[0.8125rem] font-bold text-dy-teal-ink">
        {t.run.open}
      </Link>
    );
  return <span className="font-dy-mono text-[0.75rem] text-dy-faint">{`${t.run.guide}: ${d}`}</span>;
}

function FindingRow(props: { readonly f: Finding; readonly side: 'master' | 'worker' }): ReactNode {
  const all = useT();
  const t = all.doctor;
  const s = SEV[props.f.severity];
  const { text, fix } = findingText(t, props.f, props.side);
  return (
    <li
      className="flex flex-col gap-1 border-b border-dy-line py-2.5 last:border-b-0"
      data-testid="dy-doctor-finding"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={s.tone} icon={s.icon}>
          {t.severity[props.f.severity]}
        </Pill>
        <span className="text-[0.875rem] font-bold">{checkTitle(t, props.f.check)}</span>
        <DocsLink docs={props.f.docs} />
      </div>
      <p className="m-0 text-[0.875rem]">{text}</p>
      {fix === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          <span className="font-bold">{`${t.run.fix}: `}</span>
          {fix}
        </p>
      )}
    </li>
  );
}

function Findings(props: {
  readonly findings: readonly Finding[];
  readonly side: 'master' | 'worker';
  readonly testId?: string;
}): ReactNode {
  const t = useT().doctor;
  const [passed, setPassed] = useState(false);
  const problems = props.findings.filter((f) => f.severity !== 'ok');
  const shown = passed ? props.findings : problems;
  return (
    <div data-testid={props.testId}>
      {problems.length === 0 ? (
        <DyNotice tone="green" icon="checkc">
          {t.run.allOk}
        </DyNotice>
      ) : null}
      {shown.length === 0 ? null : (
        <ul className="m-0 list-none p-0">
          {shown.map((f, i) => (
            <FindingRow
              key={`${f.check}:${f.code}:${f.subject ?? ''}:${String(i)}`}
              f={f}
              side={props.side}
            />
          ))}
        </ul>
      )}
      <DyButton
        variant="ghost"
        onClick={() => {
          setPassed((v) => !v);
        }}
      >
        {passed ? t.run.hidePassed : t.run.showPassed}
      </DyButton>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ doctor

function DoctorPanel(props: {
  readonly overview: DoctorOverview;
  readonly onRan: (run: DoctorRun) => void;
}): ReactNode {
  const all = useT();
  const t = all.doctor;
  const submit = useSubmit();
  const [machines, setMachines] = useState(true);
  const now = Date.now();
  const run = props.overview.latest;
  const daily = props.overview.latestDaily;
  return (
    <Panel title={t.run.title} sub={t.run.sub} testId="dy-doctor-run">
      <div className="flex flex-wrap items-center gap-3">
        <DyButton
          variant="primary"
          icon="retry"
          busy={submit.busy}
          data-testid="dy-doctor-run-button"
          onClick={() => {
            void submit.run(async () => {
              props.onRan(await runDoctor(machines));
            });
          }}
        >
          {t.run.button}
        </DyButton>
        <DyCheck
          label={t.run.machines}
          checked={machines}
          onChange={setMachines}
          testId="dy-doctor-machines"
        />
      </div>
      <DyApiError error={submit.error} />
      <p className="m-0 mt-2 text-[0.8125rem] text-dy-faint">
        {run === null
          ? t.run.never
          : t.run.last({ ago: agoText(run.startedAt, now, all.screenKit.time), kind: t.run.kinds[run.kind] })}
      </p>
      <p className="m-0 text-[0.8125rem] text-dy-faint" data-testid="dy-doctor-daily">
        {daily === null
          ? t.run.dailyNever
          : t.run.daily({ ago: agoText(daily.startedAt, now, all.screenKit.time), n: daily.newProblems })}
      </p>
      {run === null ? null : (
        <div className="mt-3 grid gap-2">
          <SummaryPills s={run.summary} />
          <Findings findings={run.findings} side="master" testId="dy-doctor-findings" />
        </div>
      )}
    </Panel>
  );
}

function MachineReport(props: { readonly r: WorkerReport }): ReactNode {
  const t = useT().doctor;
  return (
    <div className="grid gap-1">
      <p className="m-0 text-[0.8125rem] text-dy-muted">
        {t.machines.reportOf({
          version: props.r.workerVersion,
          platform: `${props.r.host.platform}/${props.r.host.arch}`,
        })}
      </p>
      <SummaryPills s={props.r.summary} />
      <Findings findings={props.r.findings} side="worker" />
    </div>
  );
}

function MachineRow(props: { readonly w: WorkerResult }): ReactNode {
  const t = useT().doctor;
  const submit = useSubmit();
  const [result, setResult] = useState<WorkerResult>(props.w);
  useEffect(() => {
    setResult(props.w);
  }, [props.w]);
  async function ask(): Promise<void> {
    const { opId, source } = await requestMachineDoctor(result.workerId);
    setResult({ ...result, state: 'pending', opId, source, report: null, reason: null });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 500 : 1500));
      const v = await getMachineDoctor(result.workerId, opId);
      if (v.report !== null) {
        setResult({ ...result, state: 'done', opId, source, report: v.report, reason: null });
        return;
      }
      if (['failed', 'refused', 'lost', 'cancelled'].includes(v.state)) {
        setResult({ ...result, state: 'failed', opId, source, report: null, reason: v.reason ?? v.state });
        return;
      }
    }
  }
  const tone: Tone =
    result.state === 'done'
      ? result.report !== null && result.report.summary.error > 0
        ? 'red'
        : result.report !== null && result.report.summary.warning > 0
          ? 'amber'
          : 'green'
      : result.state === 'failed'
        ? 'red'
        : 'neutral';
  return (
    <li className="grid gap-2 border-b border-dy-line py-3 last:border-b-0" data-testid="dy-doctor-machine">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{result.name}</span>
        <Pill tone={tone}>{t.machines.states[result.state]}</Pill>
        {result.source === 'diagnostics' ? (
          <span className="text-[0.75rem] text-dy-faint">{t.machines.older}</span>
        ) : null}
        <DyButton
          className="ml-auto"
          icon="retry"
          busy={submit.busy}
          disabled={result.state === 'offline'}
          onClick={() => {
            void submit.run(ask);
          }}
        >
          {t.machines.request}
        </DyButton>
      </div>
      <DyApiError error={submit.error} />
      {result.report === null ? null : <MachineReport r={result.report} />}
    </li>
  );
}

function MachinesPanel(props: { readonly run: DoctorRun | null }): ReactNode {
  const t = useT().doctor;
  const list = props.run?.workers ?? [];
  return (
    <Panel title={t.machines.title} sub={t.machines.sub} testId="dy-doctor-machines-panel">
      {list.length === 0 ? (
        <EmptyLine>{t.machines.none}</EmptyLine>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((w) => (
            <MachineRow key={w.workerId} w={w} />
          ))}
        </ul>
      )}
      <p className="m-0 mt-2 font-dy-mono text-[0.75rem] text-dy-faint">
        {t.machines.cli({ command: WORKER_DOCTOR_COMMAND })}
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ report

function ReportPanel(): ReactNode {
  const all = useT();
  const t = all.doctor.report;
  const fmt = useFormat();
  const stepUp = useStepUp();
  const build = useSubmit();
  const send = useSubmit();
  const dl = useSubmit();
  const [description, setDescription] = useState('');
  const [sections, setSections] = useState<ReadonlySet<Section>>(
    new Set(SECTIONS.filter((s) => s !== 'job_prompts')),
  );
  const [hours, setHours] = useState('24');
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [ccMe, setCcMe] = useState(false);
  const [sent, setSent] = useState<SendResult | null>(null);

  function toggle(s: Section, on: boolean): void {
    const next = new Set(sections);
    if (on) next.add(s);
    else next.delete(s);
    setSections(next);
  }

  function doBuild(): void {
    setSent(null);
    void build.run(async () => {
      setPreview(
        await buildReport({
          sections: SECTIONS.filter((s) => sections.has(s)),
          hours: Number(hours),
          description: description.trim() === '' ? null : description.trim(),
        }),
      );
    });
  }

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-doctor-report">
      <div className="grid gap-3">
        <DyTextarea
          label={t.description}
          hint={t.descriptionHint}
          value={description}
          maxLength={4000}
          onChange={setDescription}
          data-testid="dy-doctor-description"
        />
        <fieldset className="m-0 grid gap-1 border-0 p-0">
          <legend className="mb-1 text-[0.8125rem] font-bold">{t.sections}</legend>
          {SECTIONS.map((s) => (
            <DyCheck
              key={s}
              label={t.sectionNames[s]}
              checked={sections.has(s)}
              onChange={(v) => {
                toggle(s, v);
              }}
              hint={s === 'job_prompts' ? t.jobPromptsWarning : undefined}
              testId={`dy-doctor-section-${s}`}
            />
          ))}
        </fieldset>
        <DySelect
          label={t.hours}
          value={hours}
          onChange={setHours}
          options={[1, 6, 24, 48, 72].map((n) => [String(n), t.hoursValue({ n })] as const)}
          className="max-w-[16rem]"
        />
        <FormActions>
          <DyButton
            variant="primary"
            icon="search"
            busy={build.busy}
            disabled={sections.size === 0}
            data-testid="dy-doctor-preview"
            onClick={doBuild}
          >
            {preview === null ? t.preview : t.rebuild}
          </DyButton>
        </FormActions>
        {sections.size === 0 ? <p className="m-0 text-[0.8125rem] text-dy-red-ink">{t.noSections}</p> : null}
        <DyApiError error={build.error} />
        {preview === null ? null : (
          <div className="grid gap-3" data-testid="dy-doctor-preview-body">
            <p className="m-0 text-[0.875rem] font-bold">
              {t.total({ size: formatBytes(preview.sizeBytes), files: preview.files.length })}
            </p>
            <table className="w-full border-collapse text-[0.8125rem]" data-testid="dy-doctor-files">
              <thead>
                <tr className="text-left text-dy-muted">
                  <th className="py-1 pr-3 font-bold">{t.file}</th>
                  <th className="py-1 pr-3 font-bold">{t.section}</th>
                  <th className="py-1 pr-3 font-bold">{t.size}</th>
                  <th className="py-1 font-bold">{t.items}</th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((f) => (
                  <tr key={f.path} className="border-t border-dy-line">
                    <td className="py-1 pr-3 font-dy-mono">{f.path}</td>
                    <td className="py-1 pr-3">
                      {(t.sectionNames as Readonly<Record<string, string>>)[f.section] ?? f.section}
                    </td>
                    <td className="py-1 pr-3">{formatBytes(f.bytes)}</td>
                    <td className="py-1">{f.items === undefined ? '—' : String(f.items)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary className="cursor-pointer text-[0.875rem] font-bold">{t.summary}</summary>
              <pre
                className="mt-2 max-h-96 overflow-auto rounded-[9px] border border-dy-line bg-dy-bg p-3 text-[0.75rem] whitespace-pre-wrap"
                data-testid="dy-doctor-summary-text"
              >
                {preview.summary}
              </pre>
            </details>
            {preview.overCap ? (
              <DyNotice tone="amber" testId="dy-doctor-overcap">
                {t.overCap({ max: formatBytes(preview.attachmentMaxBytes) })}
              </DyNotice>
            ) : null}
            <p className="m-0 text-[0.75rem] text-dy-faint">
              {t.expires({ at: fmt.dateTime(preview.expiresAt) })}
            </p>
            <FormActions>
              <DyButton
                icon="file"
                busy={dl.busy}
                data-testid="dy-doctor-download"
                onClick={() => {
                  void dl.run(async () => {
                    const b = await downloadReport(preview.id);
                    saveWithLink(b.blob, b.filename ?? preview.filename);
                  });
                }}
              >
                {t.download}
              </DyButton>
            </FormActions>
            <DyApiError error={dl.error} />
            <div className="grid gap-2 border-t border-dy-line pt-3">
              <p className="m-0 font-bold">{t.sendTitle}</p>
              {preview.recipient === null ? (
                <DyNotice tone="amber" testId="dy-doctor-recipient-missing">
                  {t.recipientMissing}
                </DyNotice>
              ) : (
                <p className="m-0 text-[0.875rem]" data-testid="dy-doctor-recipient">
                  {t.recipient({ to: preview.recipient })}
                </p>
              )}
              {preview.ccAddress === null ? (
                <p className="m-0 text-[0.8125rem] text-dy-muted">{t.ccMissing}</p>
              ) : (
                <DyCheck
                  label={t.ccMe({ address: preview.ccAddress })}
                  checked={ccMe}
                  onChange={setCcMe}
                  testId="dy-doctor-ccme"
                />
              )}
              {preview.smtpReady ? null : <DyNotice tone="amber">{t.smtpMissing}</DyNotice>}
              <FormActions>
                <DyButton
                  variant="primary"
                  icon="send"
                  busy={send.busy}
                  disabled={!preview.smtpReady || preview.recipient === null}
                  data-testid="dy-doctor-send"
                  onClick={() => {
                    void send.run(async () => {
                      try {
                        setSent(await stepUp.run(() => sendReport(preview.id, ccMe), t.sendStepUp));
                      } catch (err) {
                        if (err instanceof StepUpCancelledError) return;
                        throw err;
                      }
                    });
                  }}
                >
                  {t.send}
                </DyButton>
              </FormActions>
              <DyApiError error={send.error} />
              {sent === null ? null : (
                <DyNotice tone="green" live testId="dy-doctor-sent">
                  {t.sent({
                    to: sent.cc === null ? sent.to : `${sent.to}, ${sent.cc}`,
                    at: fmt.dateTime(sent.sentAt),
                  })}
                  {sent.attached ? null : ` ${t.sentSummaryOnly}`}
                </DyNotice>
              )}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ settings

function SettingsPanel(props: {
  readonly settings: SupportSettings;
  readonly onSaved: (s: SupportSettings) => void;
}): ReactNode {
  const all = useT();
  const t = all.doctor.settings;
  const fmt = useFormat();
  const { state } = useAuth();
  const owner = state.kind === 'signedIn' && state.user.role === 'owner';
  const stepUp = useStepUp();
  const submit = useSubmit();
  const s = props.settings;
  const [email, setEmail] = useState(s.email ?? '');
  const [host, setHost] = useState(s.smtp?.host ?? '');
  const [port, setPort] = useState(String(s.smtp?.port ?? 587));
  const [security, setSecurity] = useState<'starttls' | 'tls'>(s.smtp?.security ?? 'starttls');
  const [from, setFrom] = useState(s.smtp?.from ?? '');
  const [username, setUsername] = useState(s.smtp?.username ?? '');
  const [password, setPassword] = useState('');

  function save(removeSmtp: boolean): void {
    void submit.run(async () => {
      const body = {
        // An empty field clears the address: the report is then only downloaded.
        email: email.trim() === '' ? null : email.trim(),
        ...(removeSmtp
          ? { smtp: null }
          : host.trim() === ''
            ? {}
            : {
                smtp: {
                  host: host.trim(),
                  port: Number(port),
                  security,
                  from: from.trim(),
                  username: username.trim() === '' ? null : username.trim(),
                  ...(password === '' ? {} : { password }),
                },
              }),
      };
      try {
        const next = await stepUp.run(() => putSupportSettings(body), t.saveStepUp);
        setPassword('');
        // p17-toasts-rest: a save result → toast.
        toast.success(t.saved, { id: 'doctor-support-saved', testId: 'doctor-support-saved' });
        props.onSaved(next);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    });
  }

  return (
    <Panel title={t.title} sub={t.sub} testId="dy-doctor-settings">
      <div className="grid gap-3">
        <p className="m-0 text-[0.875rem]" data-testid="dy-doctor-smtp-source">
          {t.source[s.smtpSource]}
        </p>
        <DyField
          label={t.email}
          hint={s.defaultEmail === null ? t.noDefaultEmail : t.defaultEmail({ email: s.defaultEmail })}
          value={email}
          onChange={setEmail}
          disabled={!owner}
          type="email"
          data-testid="dy-doctor-support-email"
        />
        <p className="m-0 text-[0.8125rem] font-bold">{t.smtpTitle}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <DyField label={t.host} value={host} onChange={setHost} disabled={!owner} mono />
          <DyField label={t.port} value={port} onChange={setPort} disabled={!owner} inputMode="numeric" />
          <DySelect
            label={t.security}
            value={security}
            onChange={(v) => {
              setSecurity(v === 'tls' ? 'tls' : 'starttls');
            }}
            options={[
              ['starttls', t.securityStarttls],
              ['tls', t.securityTls],
            ]}
          />
          <DyField label={t.from} value={from} onChange={setFrom} disabled={!owner} type="email" />
          <DyField
            label={t.username}
            value={username}
            onChange={setUsername}
            disabled={!owner}
            autoComplete="off"
          />
          <DyField
            label={t.password}
            value={password}
            onChange={setPassword}
            disabled={!owner}
            type="password"
            autoComplete="new-password"
            placeholder={s.smtp?.passwordSet === true ? t.passwordSet : undefined}
          />
        </div>
        {owner ? (
          <FormActions>
            <DyButton
              variant="primary"
              busy={submit.busy}
              data-testid="dy-doctor-settings-save"
              onClick={() => {
                save(false);
              }}
            >
              {t.save}
            </DyButton>
            {s.smtp === null ? null : (
              <DyButton
                variant="danger"
                busy={submit.busy}
                onClick={() => {
                  save(true);
                }}
              >
                {t.removeSmtp}
              </DyButton>
            )}
          </FormActions>
        ) : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.ownerOnly}</p>
        )}
        <DyApiError error={submit.error} />
        {s.updatedAt === null || s.updatedBy === null ? null : (
          <p className="m-0 text-[0.75rem] text-dy-faint">
            {t.updated({ at: fmt.dateTime(s.updatedAt), by: s.updatedBy.username })}
          </p>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

/**
 * p17-settings-tabs: Doktor (the run and the machine doctors; the clean URL the doctor's notifications open), Destek
 * raporu and Destek ayarları as tabs; both loads stay on the page, so a switch never waits.
 */
export function DiagnosticsView(): ReactNode {
  const t = useT().doctor;
  const tt = useT().forms.tabs.diagnostics;
  const [overview, setOverview] = useState<DoctorOverview | null>(null);
  const [settings, setSettings] = useState<SupportSettings | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([getDoctor(), getSupportSettings()]);
      setOverview(o);
      setSettings(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (overview === null || settings === null)
    return loadError === null ? (
      <Panel title={t.page.label}>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={loadError} />
    );

  return (
    <div className="grid gap-4" data-testid="dy-diagnostics">
      <DyTabs
        label={tt.label}
        testId="diagnostics-tabs"
        items={[
          { id: 'doctor', label: tt.doctor },
          { id: 'report', label: tt.report },
          { id: 'settings', label: tt.settings },
        ]}
      >
        {(tab) =>
          tab === 'report' ? (
            <ReportPanel />
          ) : tab === 'settings' ? (
            <SettingsPanel settings={settings} onSaved={setSettings} />
          ) : (
            <div className="grid gap-4">
              <DoctorPanel
                overview={overview}
                onRan={(run) => {
                  setOverview({ ...overview, latest: run });
                }}
              />
              <MachinesPanel run={overview.latest} />
            </div>
          )
        }
      </DyTabs>
    </div>
  );
}
