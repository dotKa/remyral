import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { manageAdminHelper, startMachineTask } from '../../../../api/machineAdmin';
import type { Op } from '../../../../api/remoteOps';
import { useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError, DyNotice } from '../../forms';
import { DyButton } from '../../parts';
import { useGuardedValue } from './admin-guard';
import { OpLine } from './config-shared';

/**
 * p17-worker-managed Part 4 — under Makine yönetimi: the owner installs or removes the elevated helper's trigger from
 * the panel (the privileged helper writes the units of its release; always-fresh step-up) instead of re-running the
 * installer kit, and an admin starts the rootless Docker setup as a machine-admin job (Linux; every elevated command
 * approved per command).
 */
export function HelperManage(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly os: string | null;
  readonly isOwner: boolean;
  readonly machineAdminEnabled: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().machineManaged.helper;
  const submit = useSubmit();
  const guarded = useGuardedValue();
  const [op, setOp] = useState<Op | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const helper = (action: 'install' | 'remove'): void => {
    setOp(null);
    void submit.run(async () => {
      const r = await guarded(
        () => manageAdminHelper(props.workerId, action),
        action === 'install'
          ? t.whyInstall({ name: props.workerName })
          : t.whyRemove({ name: props.workerName }),
      );
      if (r !== null) {
        setOp(r);
        props.onChanged();
      }
    });
  };
  const docker = (): void => {
    setJob(null);
    void submit.run(async () => {
      const r = await guarded(
        () => startMachineTask(props.workerId, { title: '', prompt: '', setup: 'rootless-docker' }),
        t.dockerWhy({ name: props.workerName }),
      );
      if (r !== null) {
        setJob(r.jobId);
        props.onChanged();
      }
    });
  };
  return (
    <div
      className="flex flex-col gap-3 border-t border-dy-line pt-3"
      data-testid="machine-admin-helper-manage"
    >
      {props.isOwner ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[0.875rem] font-bold">{t.title}</p>
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.sub}</p>
          <div className="flex flex-wrap gap-2">
            <DyButton
              icon="shield"
              busy={submit.busy}
              onClick={() => {
                helper('install');
              }}
              data-testid="helper-install"
            >
              {t.install}
            </DyButton>
            <DyButton
              variant="ghost"
              busy={submit.busy}
              onClick={() => {
                helper('remove');
              }}
              data-testid="helper-remove"
            >
              {t.remove}
            </DyButton>
          </div>
          {op !== null ? <OpLine op={op} what={t.title} testId="helper-op" /> : null}
        </div>
      ) : null}
      {props.os === 'linux' ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[0.875rem] font-bold">{t.docker}</p>
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.dockerSub}</p>
          {props.machineAdminEnabled ? (
            <div>
              <DyButton busy={submit.busy} onClick={docker} data-testid="rootless-docker">
                {t.docker}
              </DyButton>
            </div>
          ) : (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.dockerNeedsAdmin}</p>
          )}
          {job !== null ? (
            <DyNotice tone="green" live testId="rootless-docker-started">
              {t.dockerStarted}{' '}
              <Link
                to={`/jobs/${encodeURIComponent(job)}`}
                className="font-bold underline underline-offset-2"
              >
                {t.openJob}
              </Link>
            </DyNotice>
          ) : null}
        </div>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </div>
  );
}
