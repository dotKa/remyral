import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../api/client';
import {
  approveInstallScript,
  evaluateInstallScript,
  type InstallScriptApproval,
  type InstallScriptEvaluation,
  listInstallScripts,
  revokeInstallScript,
} from '../../../api/installScripts';
import { toApiError } from '../../../components/ui';
import { useErrorText } from '../../../i18n/errors';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyConfirmDialog } from '../../common/actions';
import { DyNotice } from '../../common/notices';
import { toast } from '../../toast/store';
import { DyApiError, DyInput } from '../kit';
import { DyButton, Panel, SkeletonRows } from '../parts';

/**
 * p19-install-scripts (ADR-0068, docs/design/p19-install-scripts.md): Ayarlar → Güvenlik → Kurulum betikleri. An admin
 * evaluates one exact npm version (the registry's metadata: the lifecycle scripts' text, the hosts they name, the
 * publisher, provenance and signatures — nothing is downloaded or run) and approves it with a fresh authenticator code;
 * approvals are listed with what the reviewer saw and revoked behind a confirmation dialog.
 */
export function InstallScriptsPanel(): ReactNode {
  const t = useT().installScripts;
  const format = useFormat();
  const sayError = useErrorText();
  const stepUp = useStepUp();
  const [list, setList] = useState<readonly InstallScriptApproval[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [form, setForm] = useState({ name: '', version: '', reason: '' });
  const [evaluation, setEvaluation] = useState<InstallScriptEvaluation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<InstallScriptApproval | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    listInstallScripts(signal === undefined ? {} : { signal }).then(setList, (err: unknown) => {
      if (signal?.aborted !== true) setError(toApiError(err));
    });
  }, []);
  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => {
      ctl.abort();
    };
  }, [load]);

  if (error !== null) return <DyApiError error={error} />;
  if (list === null) return <SkeletonRows label={t.title} rows={3} />;

  const evaluate = async (): Promise<void> => {
    if (form.name.trim() === '' || form.version.trim() === '') return;
    setBusy('evaluate');
    setEvaluation(null);
    try {
      setEvaluation(await evaluateInstallScript({ name: form.name.trim(), version: form.version.trim() }));
    } catch (err) {
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
    }
  };
  const approve = async (e: InstallScriptEvaluation): Promise<void> => {
    setBusy('approve');
    try {
      const a = await stepUp.run(
        () =>
          approveInstallScript({
            name: e.name,
            version: e.version,
            integrity: e.integrity,
            ...(form.reason.trim() === '' ? {} : { reason: form.reason.trim() }),
          }),
        t.stepUp,
      );
      setList((l) => [a, ...(l ?? []).filter((x) => x.id !== a.id)]);
      setEvaluation(null);
      setForm({ name: '', version: '', reason: '' });
      toast({ tone: 'success', title: t.approved({ pkg: `${a.name}@${a.version}` }) });
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (a: InstallScriptApproval): Promise<void> => {
    setBusy(`revoke:${a.id}`);
    try {
      const v = await revokeInstallScript(a.id);
      setList((l) => (l ?? []).map((x) => (x.id === v.id ? v : x)));
      toast({ tone: 'success', title: t.revoked({ pkg: `${a.name}@${a.version}` }) });
    } catch (err) {
      toast({ tone: 'error', title: sayError(err) });
    } finally {
      setBusy(null);
      setRevoking(null);
    }
  };

  return (
    <div className="grid gap-4" data-testid="security-install-scripts">
      <Panel title={t.evaluateTitle} sub={t.hint} testId="install-scripts-evaluate">
        <div className="grid gap-3">
          <DyNotice tone="amber">{t.sandbox}</DyNotice>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              void evaluate();
            }}
          >
            <DyInput
              label={t.name}
              placeholder={t.namePlaceholder}
              wrapClassName="w-[16rem]"
              value={form.name}
              onChange={(ev) => {
                setForm({ ...form, name: ev.target.value });
              }}
              data-testid="install-scripts-name"
            />
            <DyInput
              label={t.version}
              placeholder={t.versionPlaceholder}
              wrapClassName="w-[10rem]"
              value={form.version}
              onChange={(ev) => {
                setForm({ ...form, version: ev.target.value });
              }}
              data-testid="install-scripts-version"
            />
            <DyButton type="submit" busy={busy === 'evaluate'} data-testid="install-scripts-evaluate-button">
              {busy === 'evaluate' ? t.evaluating : t.evaluate}
            </DyButton>
          </form>
          {evaluation === null ? null : (
            <div
              className="grid gap-3 rounded-[9px] border border-dy-line p-3"
              data-testid="install-scripts-evaluation"
            >
              <EvaluationFacts e={evaluation} />
              {evaluation.hasInstallScript ? (
                <div className="flex flex-wrap items-end gap-2">
                  <DyInput
                    label={t.reason}
                    wrapClassName="min-w-[16rem] flex-1"
                    value={form.reason}
                    maxLength={500}
                    onChange={(ev) => {
                      setForm({ ...form, reason: ev.target.value });
                    }}
                  />
                  <DyButton
                    variant="primary"
                    busy={busy === 'approve'}
                    onClick={() => void approve(evaluation)}
                    data-testid="install-scripts-approve"
                  >
                    {busy === 'approve' ? t.approving : t.approve}
                  </DyButton>
                </div>
              ) : (
                <DyNotice tone="neutral">{t.noScript}</DyNotice>
              )}
            </div>
          )}
        </div>
      </Panel>
      <Panel
        title={t.title}
        count={String(list.filter((a) => a.revokedAt === null).length)}
        testId="install-scripts-list"
      >
        {list.length === 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.empty}</p>
        ) : (
          <ul className="grid gap-1.5">
            {list.map((a) => (
              <li
                key={a.id}
                className="grid gap-2 rounded-[9px] border border-dy-line px-3 py-2"
                data-testid="install-scripts-approval"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono font-bold">
                    {a.name}@{a.version}
                  </span>
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted" title={a.integrity}>
                    {a.integrity.slice(0, 19)}…
                  </span>
                  <span className="text-[0.75rem] text-dy-muted">
                    {t.by({ who: a.approvedBy ?? '?', when: format.dateTime(a.approvedAt) })}
                    {a.via === 'chat' ? ` · ${t.viaChat}` : ''}
                  </span>
                  <span className="ml-auto">
                    {a.revokedAt === null ? (
                      <DyButton
                        variant="ghost"
                        icon="trash"
                        busy={busy === `revoke:${a.id}`}
                        onClick={() => {
                          setRevoking(a);
                        }}
                        data-testid="install-scripts-revoke"
                      >
                        {t.revoke}
                      </DyButton>
                    ) : (
                      <span className="text-[0.75rem] text-dy-muted">
                        {t.revokedState({ who: a.revokedBy ?? '?', when: format.dateTime(a.revokedAt) })}
                      </span>
                    )}
                  </span>
                </div>
                {a.reason === null ? null : <p className="m-0 text-[0.8125rem]">{a.reason}</p>}
                {a.evaluation === null ? null : <EvaluationFacts e={a.evaluation} compact />}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <DyConfirmDialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
        }}
        onConfirm={() => {
          if (revoking !== null) void revoke(revoking);
        }}
        title={revoking === null ? '' : t.revokeTitle({ pkg: `${revoking.name}@${revoking.version}` })}
        description={t.revokeBody}
        confirmLabel={t.revoke}
        busy={revoking !== null && busy === `revoke:${revoking.id}`}
        testId="install-scripts-revoke-dialog"
      />
    </div>
  );
}

/** What the reviewer sees of one version (the script text is the package author's: rendered as text). */
function EvaluationFacts(props: {
  readonly e: InstallScriptEvaluation;
  readonly compact?: boolean;
}): ReactNode {
  const t = useT().installScripts.facts;
  const format = useFormat();
  const { e } = props;
  const scripts = Object.entries(e.scripts);
  const rows: [string, ReactNode][] = [
    [t.publisher, `${e.publisher ?? t.unknown}${e.trustedPublisher ? ` (${t.trusted})` : ''}`],
    [t.provenance, e.provenance ? t.yes : t.no],
    [t.signatures, String(e.signatures)],
    [t.hosts, e.hosts.length === 0 ? t.hostsNone : e.hosts.join(', ')],
  ];
  if (props.compact !== true) {
    rows.push(
      [t.repository, e.repository ?? t.unknown],
      [t.published, e.publishedAt === null ? t.unknown : format.dateTime(e.publishedAt)],
      [t.maintainers, e.maintainers.length === 0 ? t.unknown : e.maintainers.join(', ')],
      [t.integrity, e.integrity],
    );
  }
  return (
    <div className="grid gap-2 text-[0.8125rem]">
      {scripts.length === 0 && !e.gypfile ? null : (
        <div className="grid gap-1">
          <span className="font-bold">{t.scripts}</span>
          {scripts.map(([k, v]) => (
            <pre
              key={k}
              className="m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] bg-dy-sunk px-2 py-1 font-dy-mono text-[0.75rem]"
              data-testid="install-scripts-script"
            >
              {k}: {v}
            </pre>
          ))}
          {e.gypfile ? <span className="text-dy-muted">{t.gyp}</span> : null}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-dy-muted">{k}</dt>
            <dd className="m-0 break-all font-dy-mono text-[0.75rem]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
