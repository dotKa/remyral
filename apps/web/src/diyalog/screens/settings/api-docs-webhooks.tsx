import { fill } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { verifySnippet } from '../../../api/webhooks';
import { useT } from '../../../i18n/I18nProvider';
import { DyDetails } from '../forms';
import { Panel, Pill } from '../parts';
import { eventLabel } from './webhooks-parts';

/**
 * p16-webhooks-out: the webhook catalog on Ayarlar → API, read from the OpenAPI document's `webhooks` (public, so
 * every role sees it): the headers, how to verify the signature, the retry schedule and each event with an example.
 */
export interface DocWebhook {
  readonly type: string;
  readonly summary: string;
  readonly global: boolean;
  readonly example: unknown;
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};

/** `webhooks` of an OpenAPI 3.1 document → the events (empty when the master predates the catalog). */
export function parseDocWebhooks(doc: unknown): {
  readonly events: DocWebhook[];
  readonly version: number | null;
} {
  const hooks = rec(rec(doc).webhooks);
  let version: number | null = null;
  const events = Object.entries(hooks).map(([type, v]) => {
    const post = rec(rec(v).post);
    const content = rec(rec(rec(post.requestBody).content)['application/json']);
    const example = rec(content.example);
    if (typeof example.catalogVersion === 'number') version = example.catalogVersion;
    return {
      type,
      summary: typeof post.summary === 'string' ? post.summary : '',
      global: example.project === null && type !== 'webhook.test',
      example: content.example,
    };
  });
  return { events, version };
}

export function WebhookCatalogSection(props: {
  readonly events: readonly DocWebhook[];
  readonly version: number | null;
}): ReactNode {
  const all = useT();
  const t = all.webhooks.docs;
  if (props.events.length === 0) return null;
  return (
    <Panel
      title={t.title}
      sub={props.version === null ? undefined : fill(t.version, { n: props.version })}
      testId="api-doc-webhooks"
    >
      <div className="grid gap-3">
        <p className="m-0 text-[0.875rem]">{t.sub}</p>
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.retries}</p>
        <div className="grid gap-1">
          <span className="text-[0.8125rem] font-bold">{t.headers}</span>
          <ul className="m-0 grid gap-0.5 p-0 font-dy-mono text-[0.75rem]">
            {[
              'X-Remyral-Signature',
              'X-Remyral-Delivery',
              'X-Remyral-Event',
              'X-Remyral-Event-Id',
              'X-Remyral-Attempt',
            ].map((h) => (
              <li key={h} className="list-none">
                {h}
              </li>
            ))}
          </ul>
        </div>
        <div className="grid gap-1">
          <span className="text-[0.8125rem] font-bold">{t.verify}</span>
          <pre className="m-0 overflow-x-auto rounded-md bg-dy-sunk p-3 font-dy-mono text-[0.75rem] whitespace-pre">
            {verifySnippet()}
          </pre>
        </div>
        <div className="grid gap-2">
          {props.events.map((e) => (
            <DyDetails
              key={e.type}
              testId={`api-doc-webhook-${e.type}`}
              summary={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-dy-mono text-[0.8125rem]">{e.type}</span>
                  <span>{eventLabel(all.webhooks, e.type)}</span>
                  {e.global ? <Pill tone="neutral">{t.global}</Pill> : null}
                </span>
              }
            >
              <span className="text-[0.8125rem] font-bold">{t.example}</span>
              <pre className="m-0 mt-1 max-h-80 overflow-auto rounded bg-dy-sunk p-2 font-dy-mono text-[0.75rem] whitespace-pre">
                {JSON.stringify(e.example, null, 2)}
              </pre>
            </DyDetails>
          ))}
        </div>
      </div>
    </Panel>
  );
}
