import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  curlExample,
  type RunState,
  type WaitingApproval,
  type WebhookSecret,
} from '../../../api/automations';
import { CodeBlock } from '../../CodeBlock';
import { KeyValue } from '../../KeyValue';
import { DyCopy, DyNotice } from '../kit';
import { Pill } from '../parts';
import { asksHuman } from '../../../screens/automations/shared';
import { automationWord, RUN_TR, timeoutTr } from './labels';

/** p12-diyalog-w2: pills, the one-time webhook secret and the curl example of the automation screens. */

export function RunPill(props: { readonly state: RunState }): ReactNode {
  const w = RUN_TR[props.state];
  return (
    <Pill tone={w.tone} icon={w.icon}>
      <span data-testid="run-state">{w.label}</span>
    </Pill>
  );
}

export function AutomationPill(props: { readonly state: string }): ReactNode {
  const w = automationWord(props.state);
  return (
    <Pill tone={w.tone} icon={w.icon}>
      <span data-testid="automation-state">{w.label}</span>
    </Pill>
  );
}

/** A run paused on a person: amber pill and the way to the decision. */
export function WaitingPill(props: { readonly waiting: WaitingApproval }): ReactNode {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pill tone="amber" icon="shield">
        Onay bekliyor
      </Pill>
      <Link
        to={`/approvals/${encodeURIComponent(props.waiting.approvalId)}`}
        data-testid="waiting-approval-link"
        className="dy-press inline-flex min-h-8 items-center rounded-lg px-1.5 text-[0.8125rem] font-bold text-dy-amber-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
      >
        Şimdi karar ver
      </Link>
    </span>
  );
}

/** How to call a webhook (HMAC over timestamp.nonce.body), with the classic curl example. */
export function CurlExample(props: { readonly url: string; readonly open?: boolean }): ReactNode {
  return (
    <details className="text-[0.875rem]" open={props.open}>
      <summary className="w-fit cursor-pointer font-bold text-dy-teal-ink">Nasıl çağrılır (curl)</summary>
      <p className="m-0 mt-2 text-[0.8125rem] text-dy-muted">
        <code className="font-dy-mono">timestamp.nonce.body</code> metnini sırla HMAC-SHA256 ile imzala. Zaman
        damgası 5 dakika içinde olmalı; her nonce bir kez geçer.
      </p>
      <div data-testid="curl-example">
        <CodeBlock className="mt-2" prompt={null} code={curlExample(props.url)} />
      </div>
    </details>
  );
}

/** The secret of a webhook automation, shown exactly once (after create or replace), with the curl example. */
export function SecretPanel(props: { readonly webhook: WebhookSecret }): ReactNode {
  const { webhook } = props;
  return (
    <section
      aria-label="Webhook sırrı"
      data-testid="webhook-secret"
      className="grid gap-3 rounded-[14px] border border-dy-amber bg-dy-card p-4"
    >
      <DyNotice tone="amber">
        Bu sırrı şimdi sakla (örneğin çağıran sistemin sır deposuna). Bir daha gösterilmez; yalnızca
        değiştirilebilir.
      </DyNotice>
      <KeyValue
        rows={[
          { k: 'URL', v: webhook.url, mono: true },
          {
            k: 'Sır',
            mono: true,
            v: (
              <code data-testid="webhook-secret-value" className="break-all">
                {webhook.secret}
              </code>
            ),
          },
        ]}
      />
      <div>
        <DyCopy text={webhook.secret} label="Sırrı kopyala" />
      </div>
      <CurlExample url={webhook.url} open />
    </section>
  );
}

/** The warning an asking approval policy needs on every automation surface. */
export function UnattendedNote(props: {
  readonly policy: string | null | undefined;
  readonly timeoutMinutes: number | null;
}): ReactNode {
  if (!asksHuman(props.policy)) return null;
  return (
    <DyNotice tone="amber">
      <span data-testid="unattended-warning">
        <strong>Gözetimsiz çalışır — biri onaylayana kadar duraklar.</strong>{' '}
        {timeoutTr(props.timeoutMinutes)}
      </span>
    </DyNotice>
  );
}
