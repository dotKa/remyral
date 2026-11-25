import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type EgressMode,
  egressHostProblem,
  getWorkflowEgress,
  setWorkflowEgress,
  type WorkflowEgress,
} from '../../../../api/workflow-egress';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { useCardForm, useSectionSave } from '../../../formkit';
import { DyField, DyNotice } from '../../forms';
import { DyButton, Panel, Row, Rows } from '../../parts';
import { LoadState, RadioCardGroup, SaveResult } from './policy-common';

/**
 * p14-workflow-engine 14.3 (ADR-0055 K1, docs/design/p14-workflow-engine.md §8.4): Projeler → Politika → "HTTP izin
 * listesi". The default is **open** (any public address), shown with the recommendation to limit it with a list; in
 * `allowlist` mode only the listed hosts are reachable by the project's HTTP request and e-mail nodes. The security
 * floor (LAN / private / loopback / link-local / metadata always refused; requests leave from a worker) is stated, not
 * configurable. Owners / admins save with a fresh TOTP (audited by the master); everyone else reads.
 * p15-form-pattern: a section of the "Ağ erişimi" tab's form; the host list is part of its value (adding or removing a
 * host is an unsaved edit until the tab's bar saves it).
 */
export function ProjectEgressPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const t = useT().egress;
  const fmt = useFormat();
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const { project, canEdit } = props;
  const [data, setData] = useState<WorkflowEgress | null>(null);
  const [mode, setMode] = useState<EgressMode>('open');
  const [hosts, setHosts] = useState<readonly string[]>([]);
  const [entry, setEntry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const apply = (d: WorkflowEgress): void => {
    setData(d);
    setMode(d.mode);
    setHosts(d.hosts);
  };

  const refresh = useCallback(() => {
    void run(async () => {
      apply(await getWorkflowEgress(project));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = (): void => {
    const v = entry.trim();
    const p = egressHostProblem(v, hosts);
    if (p !== null) {
      setProblem(t.problems[p]);
      return;
    }
    setProblem(null);
    setHosts([...hosts, v]);
    setEntry('');
    setDone(null);
  };

  const save = (): Promise<boolean> => {
    setDone(null);
    return sectionSave(
      saver,
      async () => {
        apply(await setWorkflowEgress(project, { mode, hosts }));
        setDone(t.saved);
      },
      t.stepUp,
    );
  };

  const dirty = data !== null && (data.mode !== mode || data.hosts.join('\n') !== hosts.join('\n'));
  const card = useCardForm({
    dirty: canEdit && dirty,
    busy: saver.busy,
    save,
    discard: () => {
      if (data !== null) apply(data);
      setEntry('');
      setProblem(null);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="project-egress-panel">
      <div className="flex flex-col gap-3">
        <LoadState loaded={data !== null} error={loader.error} what={t.loading} onRetry={refresh} />
        {data === null ? null : (
          <>
            {canEdit ? null : (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="egress-read-only">
                {t.readOnly}
              </p>
            )}
            <RadioCardGroup<EgressMode>
              legend={t.modeLegend}
              value={mode}
              disabled={!canEdit}
              testId="egress-mode"
              options={[
                { value: 'open', label: t.modes.open.label, description: t.modes.open.description },
                {
                  value: 'allowlist',
                  label: t.modes.allowlist.label,
                  description: t.modes.allowlist.description,
                },
              ]}
              onChange={(v) => {
                setMode(v);
                setDone(null);
              }}
            />
            <DyNotice tone="neutral">{t.floor}</DyNotice>
            {mode === 'open' ? <p className="m-0 text-[0.78125rem] text-dy-muted">{t.openPorts}</p> : null}
            <h4 className="m-0 text-[0.8125rem] font-bold">{t.hostsTitle}</h4>
            {hosts.length === 0 ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="egress-hosts-none">
                {t.hostsNone}
              </p>
            ) : (
              <Rows label={t.hostsTitle} testId="egress-hosts">
                {hosts.map((h) => (
                  <Row
                    key={h}
                    title={<span className="font-dy-mono [overflow-wrap:anywhere]">{h}</span>}
                    actions={
                      canEdit ? (
                        <DyButton
                          variant="ghost"
                          icon="trash"
                          aria-label={t.remove({ host: h })}
                          onClick={() => {
                            setHosts(hosts.filter((x) => x !== h));
                            setDone(null);
                          }}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </Rows>
            )}
            {mode === 'allowlist' && hosts.length === 0 ? (
              <DyNotice tone="amber">{t.hostsEmptyAllowlist}</DyNotice>
            ) : null}
            {canEdit ? (
              <div className="flex flex-wrap items-end gap-2">
                <DyField
                  label={t.hostLabel}
                  value={entry}
                  mono
                  placeholder={t.hostPlaceholder}
                  wrapClassName="min-w-0 flex-1"
                  data-testid="egress-host-input"
                  error={problem}
                  onChange={(v) => {
                    setEntry(v);
                    setProblem(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <DyButton icon="plus" data-testid="egress-host-add" onClick={add}>
                  {t.add}
                </DyButton>
              </div>
            ) : null}
            {data.updatedAt === null ? null : (
              <p className="m-0 text-[0.75rem] text-dy-muted">
                {t.updated({ at: fmt.dateTime(data.updatedAt), by: data.updatedBy ?? '—' })}
              </p>
            )}
            {canEdit && !card.inScope ? (
              <div>
                <DyButton
                  variant="primary"
                  busy={saver.busy}
                  disabled={!dirty}
                  data-testid="egress-save"
                  onClick={card.submit}
                >
                  {t.save}
                </DyButton>
              </div>
            ) : null}
            <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
          </>
        )}
      </div>
    </Panel>
  );
}
