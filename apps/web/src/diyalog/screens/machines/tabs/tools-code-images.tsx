import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  getOpsStatus,
  type Op,
  type OpsStatus,
  prepareCodeImages,
  TERMINAL_STATES,
} from '../../../../api/remoteOps';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError } from '../../forms';
import { DyButton, Panel, Pill } from '../../parts';
import { OpLine, useGuarded, useOpPoll } from './config-shared';

/**
 * p14-code-images (docs/design/p14-followups.md §2): Makine → Araçlar → "Kod düğümleri". Shows whether the machine
 * runs workflow code nodes (function-code-v1) and, for admins, "Kod düğümü imajlarını hazırla": the remote op
 * `code.images.prepare` (step-up) — the worker pulls the pinned base images by digest and builds the two code images
 * from the contexts in its release, then advertises function-code-v1. The last such operation is shown with its state.
 */
export function CodeImagesPanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly isAdmin: boolean;
}): ReactNode {
  const t = useT().machines.codeImages;
  const { workerId } = props;
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const s = await getOpsStatus(workerId);
      setStatus(s);
      setOp((cur) => cur ?? s.ops.find((o) => o.kind === 'code.images.prepare') ?? null);
    });
  }, [load.run, workerId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const onDone = useCallback(() => {
    // The worker re-sends CAPABILITIES right after the build; read the readiness again.
    void refresh();
  }, [refresh]);
  useOpPoll(workerId, op, setOp, onDone);

  if (status === null) return <DyApiError error={load.error} retryLeft={load.retryLeft} />;
  const ci = status.codeImages;
  const running = op !== null && !TERMINAL_STATES.has(op.state);
  return (
    <Panel
      title={t.title}
      sub={t.sub}
      testId="code-images"
      aside={
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={ci.ready ? 'green' : 'amber'} icon={ci.ready ? 'checkc' : undefined}>
            {ci.ready ? t.ready : t.notReady}
          </Pill>
          {props.isAdmin && ci.supported ? (
            <DyButton
              icon="retry"
              busy={act.busy || running}
              disabled={running || !status.connected}
              data-testid="code-images-prepare"
              onClick={() => {
                void act.run(async () => {
                  const o = await guarded(
                    () => prepareCodeImages(workerId),
                    t.why({ machine: props.workerName }),
                  );
                  if (o !== null) setOp(o);
                });
              }}
            >
              {ci.ready ? t.prepareAgain : t.prepare}
            </DyButton>
          ) : null}
        </span>
      }
    >
      <div className="flex min-w-0 flex-col gap-2 text-[0.875rem]" data-ready={String(ci.ready)}>
        <p className="m-0">{ci.ready ? t.readyText : ci.supported ? t.notReadyText : t.unsupported}</p>
        {!status.connected && ci.supported ? <p className="m-0 text-dy-muted">{t.offline}</p> : null}
        {op !== null ? <OpLine op={op} what={t.what} testId="code-images-op" /> : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </div>
    </Panel>
  );
}
