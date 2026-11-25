import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { approveWorker, workerAction, type WorkerSummary } from '../../../api/workers';
import { machinePath } from '../../../screens/fleet/machineLinks';
import { useGuarded } from '../../../screens/fleet/machineShared';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { ConfirmButton, DyApiError, DyField, DyNotice } from '../forms';
import { DyButton } from '../parts';
import { platformText } from './shared';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { TIME_NUMERIC } from '../../common/time';

/** The pairing command on the machine (a shell command, the same in every language). */
const PAIR = 'remyral-worker pair'; // i18n-ignore: shell command

/**
 * p12-diyalog wave 2 (W3): a machine waiting to pair, in the Diyalog language — the same rules as the classic
 * `PendingCard` (screens/fleet/machineShared.tsx): the fingerprint to compare with what `remyral-worker pair` printed,
 * the pairing code (upper-cased, at most 12 characters, approve from 8), Approve / Deny both through step-up
 * (`useGuarded`: a cancelled code dialog is not an error), the expired state, and the page header's "Onayla…"
 * focusing the code field (`focusRequest` → `onFocused`).
 */
export function PairingCard(props: {
  readonly worker: WorkerSummary;
  readonly onChanged: () => void;
  /** On the list: the name links to the machine page. */
  readonly showLink?: boolean;
  /** Bumped by the page header's "Onayla…": focus the pairing code field (then `onFocused`). */
  readonly focusRequest?: number;
  readonly onFocused?: () => void;
}): ReactNode {
  const fmt = useFormat();
  const tm = useT().machines;
  const t = tm.pairing;
  const { worker } = props;
  const [code, setCode] = useState('');
  const submit = useSubmit();
  const guarded = useGuarded();
  const label = worker.hostname ?? worker.name;
  // The code field's wrapper (DyField does not forward a ref): its input is focused on request.
  const codeRef = useRef<HTMLDivElement | null>(null);
  const { focusRequest, onFocused } = props;
  useEffect(() => {
    if (focusRequest === undefined || focusRequest === 0) return;
    const input = codeRef.current?.querySelector('input') ?? null;
    if (input === null) return;
    try {
      input.scrollIntoView({ block: 'center' });
    } catch {
      // jsdom: no scrolling
    }
    input.focus();
    onFocused?.();
  }, [focusRequest, onFocused]);

  const expired = worker.pairingExpired;
  const approve = (): void => {
    void submit
      .run(() => guarded(() => approveWorker(worker.id, code), t.approveWhy({ name: label })))
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };
  const deny = (): void => {
    void submit
      .run(() => guarded(() => workerAction(worker.id, 'deny'), t.denyWhy({ name: label })))
      .then((ok) => {
        if (ok) props.onChanged();
      });
  };

  return (
    <div
      data-testid="pending-worker"
      className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-dy-amber/45 bg-dy-card p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="m-0 flex min-w-0 items-center gap-2 text-[0.9375rem] font-bold">
          <DyIcon name="key" className="size-4 shrink-0 text-dy-amber-ink" />
          {props.showLink === true ? (
            <Link
              to={machinePath(worker.id)}
              translate="no"
              className="min-w-0 font-dy-mono text-dy-ink no-underline [overflow-wrap:anywhere] [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
            >
              {label}
            </Link>
          ) : (
            <span translate="no" className="min-w-0 font-dy-mono [overflow-wrap:anywhere]">
              {label}
            </span>
          )}
        </h3>
        <span className="text-[0.8125rem] text-dy-muted">
          {platformText(worker.os, worker.arch, tm.shared.unknownOs)} · {t.version}{' '}
          <span className="font-dy-mono">{worker.workerVersion}</span>
        </span>
      </div>

      <div className="min-w-0">
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {t.fingerprintBefore} <code className="font-dy-mono">{PAIR}</code> {t.fingerprintAfter}
        </p>
        <p
          data-testid="pending-fingerprint"
          className="m-0 mt-1 rounded-[9px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.8125rem] break-all"
        >
          {worker.fingerprint ?? t.unknown}
        </p>
      </div>

      {expired ? (
        <DyNotice tone="amber" icon="clock">
          {t.expiredBefore} <code className="font-dy-mono">{PAIR}</code> {t.expiredAfter}
        </DyNotice>
      ) : (
        <p className="m-0 flex items-center gap-1.5 text-[0.8125rem] text-dy-muted">
          <DyIcon name="clock" className="size-3.5" />
          {worker.pairingExpiresAt === null
            ? t.expiresSoon
            : t.expiresAt({ time: fmt.dateWith(worker.pairingExpiresAt, TIME_NUMERIC) })}
        </p>
      )}

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length < 8 || expired) return;
          approve();
        }}
      >
        <div ref={codeRef} className="min-w-0 sm:w-60">
          <DyField
            label={t.code}
            mono
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            value={code}
            disabled={expired}
            onChange={(v) => {
              setCode(v.toUpperCase().slice(0, 12));
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <DyButton
            type="submit"
            variant="primary"
            icon="check"
            busy={submit.busy}
            disabled={code.trim().length < 8 || expired}
          >
            {t.approve}
          </DyButton>
          <ConfirmButton
            label={t.deny}
            icon="xc"
            question={t.denyQuestion({ name: label })}
            confirmLabel={t.denyConfirm}
            disabled={submit.busy}
            testId="pairing-deny"
            onConfirm={deny}
          />
        </div>
      </form>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </div>
  );
}
