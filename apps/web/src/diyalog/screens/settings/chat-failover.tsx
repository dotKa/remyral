import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ChatSettings } from '../../../api/chat';
import {
  type FailoverEvent,
  type FailoverMachine,
  type FailoverView,
  forcePrimary,
  getFailover,
  pinMachine,
  setAutoFailover,
  unpinMachine,
} from '../../../api/chatFailover';
import type { ApiError } from '../../../api/client';
import type { WorkerSummary } from '../../../api/workers';
import { toApiError } from '../../../components/ui';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import type { Tone } from '../../tone';
import { INK } from '../../tone';
import { useGuarded } from '../usage/common';
import { DyApiError, DyNotice, DySwitch } from '../forms';
import { DyButton, DySelect, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';

/**
 * p15-chat-failover (docs/design/p15-chat-failover.md §2, §7): the backup machines of the chat assistant in Ayarlar →
 * Sohbet — the ordered list in the Asistan form with each machine's readiness (connected, worker version, assistant,
 * the chosen runtime and the fallback engine as the machine reported them), and the "Yedek geçişi" tab: who answers now
 * and why, the chain's verdicts, the controls (back to the primary, pin, automatic failover; step-up, audited) and the
 * recent switches.
 */

type T = Messages['chatFailover'];

/** A machine's readiness for the chosen runtime (and the fallback engine), as it last reported it. */
export function machineReadiness(
  t: T['backups'],
  settings: ChatSettings | null,
  workerId: string,
  runtime: string,
  fallbackRuntime: string,
): { readonly eligible: boolean; readonly lines: readonly { tone: Tone; text: string }[] } {
  const w = settings?.engines.find((x) => x.workerId === workerId);
  if (w === undefined) return { eligible: false, lines: [{ tone: 'amber', text: t.noAssistant }] };
  const lines: { tone: Tone; text: string }[] = [
    w.online ? { tone: 'green', text: t.online } : { tone: 'amber', text: t.offline },
  ];
  if (w.workerVersion !== null)
    lines.push({ tone: 'neutral', text: t.version({ version: w.workerVersion }) });
  if (!w.assistantFeature) {
    lines.push({ tone: 'amber', text: t.noAssistant });
    return { eligible: false, lines };
  }
  if (w.disabled) {
    lines.push({ tone: 'amber', text: t.disabled });
    return { eligible: false, lines };
  }
  const e = w.engines.find((x) => x.runtime === runtime);
  const engineOk = e?.ready === true;
  lines.push(
    e === undefined
      ? { tone: 'amber', text: t.engineMissing({ runtime }) }
      : e.ready
        ? { tone: 'green', text: t.engineReady({ runtime }) }
        : { tone: 'amber', text: t.engineNotReady({ runtime, reason: e.reason }) },
  );
  if (fallbackRuntime !== '' && fallbackRuntime !== runtime) {
    const fb = w.engines.find((x) => x.runtime === fallbackRuntime);
    if (fb?.ready === true)
      lines.push({ tone: 'neutral', text: t.fallbackReady({ runtime: fallbackRuntime }) });
  }
  return { eligible: w.online && engineOk, lines };
}

/** The ordered backup list of the Asistan form (add / move / remove; saved with the form). */
export function BackupMachines(props: {
  readonly settings: ChatSettings | null;
  readonly workers: readonly WorkerSummary[];
  readonly primary: string;
  readonly runtime: string;
  readonly fallbackRuntime: string;
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}): ReactNode {
  const t = useT().chatFailover.backups;
  const [pick, setPick] = useState('');
  const list = props.value.filter((id) => id !== props.primary);
  const name = (id: string): string =>
    props.workers.find((w) => w.id === id)?.name ??
    props.settings?.engines.find((e) => e.workerId === id)?.workerName ??
    id;
  const candidates = props.workers.filter((w) => w.id !== props.primary && !list.includes(w.id));
  const move = (i: number, d: -1 | 1): void => {
    const next = [...list];
    const j = i + d;
    const a = next[i];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[j] = a;
    props.onChange(next);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="chat-backups">
      <p className="m-0 text-[0.8125rem] font-bold">{t.title}</p>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{t.hint({ seconds: 60 })}</p>
      {list.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="chat-backups-empty">
          {t.empty}
        </p>
      ) : (
        <ol
          aria-label={t.listLabel}
          className="m-0 flex list-none flex-col rounded-[10px] border border-dy-line p-0"
        >
          {list.map((id, i) => {
            const r = machineReadiness(t, props.settings, id, props.runtime, props.fallbackRuntime);
            const n = name(id);
            return (
              <li
                key={id}
                data-testid={`chat-backup-${id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dy-line px-3 py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{n}</span>{' '}
                  <span className="text-[0.75rem] text-dy-muted">{t.position({ n: i + 1 })}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-[0.78125rem]">
                    {r.lines.map((l) => (
                      <span key={l.text} className={INK[l.tone]}>
                        {l.text}
                      </span>
                    ))}
                  </span>
                </span>
                <Pill tone={r.eligible ? 'green' : 'amber'}>{r.eligible ? t.eligible : t.notEligible}</Pill>
                <span className="flex items-center gap-1">
                  <DyButton
                    aria-label={t.up({ name: n })}
                    disabled={i === 0}
                    onClick={() => {
                      move(i, -1);
                    }}
                  >
                    ↑
                  </DyButton>
                  <DyButton
                    aria-label={t.down({ name: n })}
                    disabled={i === list.length - 1}
                    onClick={() => {
                      move(i, 1);
                    }}
                  >
                    ↓
                  </DyButton>
                  <DyButton
                    aria-label={t.remove({ name: n })}
                    icon="trash"
                    onClick={() => {
                      props.onChange(list.filter((x) => x !== id));
                    }}
                  />
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {candidates.length > 0 && list.length < 6 ? (
        <div className="flex flex-wrap items-end gap-2">
          <DySelect
            label={t.add}
            value={pick}
            options={[['', t.addNone], ...candidates.map((w) => [w.id, `${w.name} (${w.state})`] as const)]}
            onChange={setPick}
            className="min-w-[14rem] flex-1"
          />
          <DyButton
            icon="plus"
            disabled={pick === ''}
            aria-label={t.add}
            onClick={() => {
              if (pick === '') return;
              props.onChange([...list, pick]);
              setPick('');
            }}
          >
            {t.add}
          </DyButton>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the tab

const PIN_MINUTES = [
  ['m15', 15],
  ['h1', 60],
  ['h4', 240],
  ['h24', 1440],
] as const;

function issueText(t: T, issue: string | null): string {
  return issue !== null && issue in t.issues ? t.issues[issue as keyof T['issues']] : (issue ?? '');
}

/** Why the answering machine answers, in the reader's language. */
export function routeReasonText(
  t: T,
  v: Pick<FailoverView, 'status'>,
  time: (iso: string) => string,
): string | null {
  const r = v.status.routing;
  const primary = v.status.primary?.name ?? '';
  switch (r?.reason) {
    case 'primary':
      return t.reasons.primary;
    case 'pinned':
      return t.reasons.pinned;
    case 'primary_offline':
      return t.reasons.primary_offline({ primary });
    case 'primary_unavailable':
      return t.reasons.primary_unavailable({ primary });
    case 'primary_unstable':
      return t.reasons.primary_unstable({ primary, time: r.returnsAt === null ? '' : time(r.returnsAt) });
    default:
      return null;
  }
}

function eventText(t: T, e: FailoverEvent): string {
  const from = e.from?.name ?? t.events.unknown;
  const to = e.to?.name ?? t.events.unknown;
  const actor = e.actor ?? t.events.someone;
  switch (e.kind) {
    case 'failover':
      return t.events.failover({ from, to });
    case 'return':
      return t.events.return({ to });
    case 'rerun':
      return t.events.rerun({ from, to });
    case 'pin':
      return t.events.pin({ to, actor });
    case 'unpin':
      return t.events.unpin({ actor });
    case 'force_primary':
      return t.events.force_primary({ to, actor });
    case 'auto_off':
      return t.events.auto_off({ actor });
    case 'auto_on':
      return t.events.auto_on({ actor });
    default:
      return e.kind;
  }
}

function roleText(t: T, m: FailoverMachine): string {
  return m.role === 'primary' ? t.now.roles.primary : t.now.roles.backup({ n: m.position });
}

/** "Yedek geçişi": state, chain, controls, recent switches. */
export function FailoverTab(): ReactNode {
  const t = useT().chatFailover;
  const fmt = useFormat();
  const guard = useGuarded();
  const [view, setView] = useState<FailoverView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pinWorker, setPinWorker] = useState('');
  const [pinFor, setPinFor] = useState<string>('h1');
  const load = useCallback(() => {
    getFailover().then(
      (v) => {
        setView(v);
        setError(null);
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<FailoverView>, ok: string): Promise<void> => {
    setDone(null);
    const box: { next: FailoverView | null } = { next: null };
    const went = await guard.run(async () => {
      box.next = await fn();
    }, t.controls.stepUp);
    if (went && box.next !== null) {
      setView(box.next);
      setDone(ok);
    }
  };

  if (view === null)
    return error === null ? (
      <Panel title={t.now.title} flush>
        <SkeletonRows label={t.now.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={error} />
    );

  const time = (iso: string): string => fmt.dateTime(iso);
  const answering = view.chain.find((c) => c.answering) ?? null;
  const why = routeReasonText(t, view, time);
  const pinCandidates = view.chain;
  const pinTarget = pinWorker === '' ? (view.chain[1]?.workerId ?? view.chain[0]?.workerId ?? '') : pinWorker;
  return (
    <div className="flex flex-col gap-4" data-testid="dy-chat-failover">
      <Panel title={t.now.title} sub={t.now.sub} testId="chat-failover-now">
        <div className="flex flex-col gap-2">
          {answering === null ? (
            <DyNotice tone="amber">
              <span data-testid="chat-failover-answering">{t.now.nobody}</span>
            </DyNotice>
          ) : (
            <p className="m-0 font-medium" data-testid="chat-failover-answering">
              {t.now.answering({ machine: `${answering.name} (${roleText(t, answering)})` })}
            </p>
          )}
          {why === null ? null : (
            <p className="m-0 text-[0.875rem]" data-testid="chat-failover-why">
              {why}
            </p>
          )}
          {view.active === null ? null : (
            <p className="m-0 text-[0.78125rem] text-dy-muted">
              {t.now.since({ time: time(view.active.since) })}
            </p>
          )}
          {view.pin === null ? null : (
            <p className="m-0 text-[0.8125rem]" data-testid="chat-failover-pin">
              {t.controls.pinned({ machine: view.pin.name, time: time(view.pin.until) })}
            </p>
          )}
          {view.chain.length < 2 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.now.noBackups}</p>
          ) : null}
        </div>
      </Panel>

      <Panel title={t.chain.title} flush testId="chat-failover-chain">
        <Rows label={t.chain.caption}>
          {view.chain.map((m) => (
            <Row
              key={m.workerId}
              testId={`chat-failover-machine-${m.workerId}`}
              title={m.name}
              meta={
                <>
                  <span>{roleText(t, m)}</span>
                  {m.connectedAt === null ? null : <span>{fmt.relative(m.connectedAt)}</span>}
                  {m.workerVersion === null ? null : <span>{m.workerVersion}</span>}
                  {m.fallback && m.runtime !== null ? (
                    <span>{t.chain.fallbackEngine({ runtime: m.runtime })}</span>
                  ) : null}
                </>
              }
              trail={
                m.answering ? (
                  <Pill tone="green">{t.chain.answering}</Pill>
                ) : m.eligible ? (
                  <Pill tone="neutral">{t.chain.ready}</Pill>
                ) : (
                  <Pill tone="amber" title={m.message ?? undefined}>
                    {issueText(t, m.issue)}
                  </Pill>
                )
              }
            />
          ))}
        </Rows>
      </Panel>

      <Panel title={t.controls.title} sub={t.controls.sub} testId="chat-failover-controls">
        <div className="flex flex-col gap-4">
          <DySwitch
            label={t.controls.auto}
            hint={t.controls.autoHint}
            checked={view.auto}
            onChange={(v) => {
              void act(() => setAutoFailover(v), v ? t.controls.autoOn : t.controls.autoOff);
            }}
            testId="chat-failover-auto"
          />
          <div className="flex flex-col gap-1">
            <div>
              <DyButton
                variant="primary"
                busy={guard.busy}
                disabled={view.chain[0]?.eligible !== true || view.chain[0].answering}
                onClick={() => {
                  void act(() => forcePrimary(), t.controls.forced);
                }}
                data-testid="chat-failover-force"
              >
                {t.controls.forcePrimary}
              </DyButton>
            </div>
            <p className="m-0 text-[0.78125rem] text-dy-muted">{t.controls.forcePrimaryHint}</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <DySelect
              label={t.controls.pinMachine}
              value={pinTarget}
              options={pinCandidates.map((m) => [m.workerId, `${m.name} (${roleText(t, m)})`] as const)}
              onChange={setPinWorker}
              className="min-w-[12rem] flex-1"
            />
            <DySelect
              label={t.controls.pinFor}
              value={pinFor}
              options={PIN_MINUTES.map(([k]) => [k, t.controls.durations[k]] as const)}
              onChange={setPinFor}
            />
            <DyButton
              busy={guard.busy}
              disabled={pinTarget === ''}
              onClick={() => {
                const minutes = PIN_MINUTES.find(([k]) => k === pinFor)?.[1] ?? 60;
                const m = view.chain.find((c) => c.workerId === pinTarget);
                void act(
                  () => pinMachine(pinTarget, minutes),
                  t.controls.pinned({
                    machine: m?.name ?? pinTarget,
                    time: time(new Date(Date.now() + minutes * 60_000).toISOString()),
                  }),
                );
              }}
              data-testid="chat-failover-pin-button"
            >
              {t.controls.pin}
            </DyButton>
            {view.pin === null ? null : (
              <DyButton
                busy={guard.busy}
                onClick={() => {
                  void act(() => unpinMachine(), t.controls.unpinned);
                }}
                data-testid="chat-failover-unpin"
              >
                {t.controls.unpin}
              </DyButton>
            )}
          </div>
          {done === null ? null : (
            <p
              className="m-0 text-[0.8125rem] text-dy-green-ink"
              role="status"
              data-testid="chat-failover-done"
            >
              {done}
            </p>
          )}
          <DyApiError error={guard.error} />
        </div>
      </Panel>

      <Panel title={t.events.title} flush testId="chat-failover-events">
        {view.events.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[0.8125rem] text-dy-muted">{t.events.empty}</p>
        ) : (
          <Rows label={t.events.caption}>
            {view.events.map((e) => (
              <Row
                key={e.id}
                title={eventText(t, e)}
                meta={<span>{time(e.at)}</span>}
                tone={e.kind === 'failover' || e.kind === 'rerun' ? 'amber' : undefined}
              />
            ))}
          </Rows>
        )}
      </Panel>
    </div>
  );
}

/** The Sohbet header's routing words ("yedek — build-01 bağlı değil"), or null on the primary. */
export function headerRouting(t: T, routing: ChatSettingsRouting, primary: string): string | null {
  if (routing === null || routing.machine !== 'backup') return null;
  switch (routing.reason) {
    case 'pinned':
      return t.header.backup({ why: t.header.pinned });
    case 'primary_offline':
      return t.header.backup({ why: t.header.offline({ primary }) });
    case 'primary_unstable':
      return t.header.backup({ why: t.header.unstable({ primary }) });
    default:
      return t.header.backup({ why: t.header.unavailable({ primary }) });
  }
}

type ChatSettingsRouting = FailoverView['status']['routing'];
