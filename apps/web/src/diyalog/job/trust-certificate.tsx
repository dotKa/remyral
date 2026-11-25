import { type ReactNode, useState } from 'react';
import type { JobDetail } from '../../api/jobs';
import { formatFingerprint, trustCertificateOfJob, untrustedCertificate } from '../../api/tls-pins';
import { useT } from '../../i18n/I18nProvider';
import { useSubmit } from '../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';
import { DyApiError, DyNotice } from '../screens/forms';
import { DyButton } from '../screens/parts';

/**
 * p22-runtime-diagnostics: the job page's "Trust this certificate" — shown when the latest attempt of a failed job
 * reported an untrusted certificate with its fingerprint. One click (plus the step-up the security policy asks for)
 * pins exactly that certificate for that host:port in the job's project; verification stays strict for everything else.
 */
export function TrustCertificateCard(props: {
  readonly detail: JobDetail;
  readonly canAct: boolean;
  readonly onDone: () => void;
}): ReactNode {
  const w = useT().job.trustCertificate;
  const stepUp = useStepUp();
  const save = useSubmit();
  const [done, setDone] = useState(false);
  const errors = props.detail.runErrors ?? [];
  const last = errors[errors.length - 1];
  const cert = last === undefined ? null : untrustedCertificate(last.code, last.params);
  if (cert === null) return null;
  const where = `${cert.host}:${String(cert.port)}`;
  const project = props.detail.job.project;
  const jobId = props.detail.job.id;
  const trust = (): void => {
    void save.run(async () => {
      try {
        await stepUp.run(() => trustCertificateOfJob(project, jobId), w.stepUp({ host: where }));
        setDone(true);
        props.onDone();
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };
  return (
    <section
      data-testid="dy-trust-certificate"
      className="grid gap-2 rounded-lg border border-dy-line bg-dy-card p-4 font-sans text-[0.875rem] text-dy-ink"
    >
      <h3 className="m-0 text-[0.9375rem] font-bold">{w.title}</h3>
      <p className="m-0">{w.body({ host: where })}</p>
      <p className="m-0 text-dy-muted">
        {w.fingerprint}:{' '}
        <code className="break-all font-dy-mono text-[0.8125rem]">{formatFingerprint(cert.sha256)}</code>
      </p>
      {cert.mismatch ? <DyNotice tone="amber">{w.mismatch}</DyNotice> : null}
      {done ? (
        <DyNotice tone="green">{w.done}</DyNotice>
      ) : (
        <>
          <p className="m-0 text-dy-muted">{w.hint}</p>
          {props.canAct ? (
            <div>
              <DyButton variant="primary" busy={save.busy} onClick={trust}>
                {w.trust}
              </DyButton>
            </div>
          ) : null}
        </>
      )}
      <DyApiError error={save.error} retryLeft={save.retryLeft} />
    </section>
  );
}
