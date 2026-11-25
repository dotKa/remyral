import { fill } from '@remyral/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type ExportDoc, getExport } from '../../api/chatComplete';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { Markdown } from '../../screens/chat/markdown';
import { BrandLogo } from '../Brand';
import { DyButton } from '../screens/parts';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §3): `/chat/:id/yazdir` — the conversation's export document
 * (the caller's view: a shared reader's is filtered for them; redacted on the master) as a print page. The browser's
 * print dialog saves it as PDF: no server-side PDF engine, nothing from a third party, the console's own CSP. It opens
 * the print dialog once the document is shown; "Yazdır / PDF kaydet" opens it again.
 */
export function ChatPrintScreen(props: { readonly threadId: string }): ReactNode {
  const all = useT();
  const t = all.chatComplete.exporter;
  const f = useFormat();
  const sayError = useErrorText();
  const [doc, setDoc] = useState<ExportDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getExport(props.threadId).then(
      (d) => {
        if (live) setDoc(d);
      },
      (err: unknown) => {
        if (live) setError(fill(t.failed, { error: sayError(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [props.threadId, t, sayError]);
  useEffect(() => {
    if (doc === null) return;
    document.title = fill(t.docTitle, { title: doc.thread.title });
    // After the first paint of the document: the print dialog shows what is on screen.
    const id = window.setTimeout(() => {
      if (typeof window.print === 'function') window.print();
    }, 300);
    return () => {
      window.clearTimeout(id);
    };
  }, [doc, t]);
  const time = (iso: string): string => f.dateWith(iso, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <main
      id="main"
      tabIndex={-1}
      data-print-root=""
      data-testid="chat-print"
      className="dy-surface mx-auto w-full max-w-[780px] flex-1 bg-dy-card px-4 py-6 text-dy-ink outline-none print:max-w-none print:px-0"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2" data-print-hide="">
        <Link to={`/chat/${encodeURIComponent(props.threadId)}`} className="text-[0.875rem] underline">
          {t.back}
        </Link>
        <DyButton
          className="ml-auto"
          icon="file"
          disabled={doc === null}
          onClick={() => {
            window.print();
          }}
          data-testid="chat-print-button"
        >
          {t.print}
        </DyButton>
        <p className="m-0 basis-full text-[0.75rem] text-dy-muted">{t.hint}</p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-dy-red-ink">
          {error}
        </p>
      ) : doc === null ? (
        <p role="status" className="text-dy-muted">
          {t.loading}
        </p>
      ) : (
        <article>
          {/* p17-remyral-brand: the product's lock-up heads the printed / PDF document. */}
          <BrandLogo alt={all.auth.frame.product} height={28} className="mb-3" />
          <h1 className="m-0 text-[1.375rem] font-extrabold">{doc.thread.title}</h1>
          <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">
            {fill(t.owner, { owner: doc.thread.owner })} ·{' '}
            {fill(t.exported, { time: time(doc.exportedAt), by: doc.exportedBy })}
          </p>
          {doc.omittedVersions > 0 ? (
            <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted" data-testid="chat-print-omitted">
              {fill(t.omitted, { count: doc.omittedVersions })}
            </p>
          ) : null}
          <hr className="my-4 border-dy-line" />
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {doc.items.map((it, i) => (
              <li key={`${it.kind}:${String(i)}`} className="break-inside-avoid">
                <PrintItem item={it} time={time} />
              </li>
            ))}
          </ol>
          <p
            className="m-0 mt-6 border-t border-dy-line pt-2 text-[0.75rem] text-dy-muted"
            data-testid="chat-print-made-with"
          >
            {t.madeWith}
          </p>
        </article>
      )}
    </main>
  );
}

function PrintItem(props: {
  readonly item: ExportDoc['items'][number];
  readonly time: (iso: string) => string;
}): ReactNode {
  const t = useT().chatComplete.exporter;
  const it = props.item;
  switch (it.kind) {
    case 'message':
      return (
        <section data-testid="chat-print-message">
          <p className="m-0 text-[0.8125rem] font-bold">
            {it.role === 'user' ? it.author : t.assistant}{' '}
            <span className="font-normal text-dy-muted">· {props.time(it.at)}</span>
            {it.edited ? <span className="font-normal text-dy-muted"> · {t.edited}</span> : null}
          </p>
          {it.role === 'assistant' ? (
            <Markdown text={it.text} />
          ) : (
            <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{it.text}</p>
          )}
          {it.attachments.length === 0 ? null : (
            <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">
              {t.files}: {it.attachments.map((a) => `${a.name} [${a.kind}]`).join(', ')}
            </p>
          )}
          {it.mentions.length === 0 ? null : (
            <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">
              {t.mentions}: {it.mentions.join(', ')}
            </p>
          )}
        </section>
      );
    case 'tools':
      return (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{fill(t.tools, { names: it.names.join(', ') })}</p>
      );
    case 'notice':
      return (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink">
          {it.error ? t.error : t.notice}: {it.text}
        </p>
      );
    case 'card':
      return (
        <p
          className="m-0 rounded-[10px] border border-dy-line px-3 py-2 text-[0.875rem]"
          data-testid="chat-print-card"
        >
          <span className="font-bold">{t.card}</span> <span className="font-dy-mono">({it.cardKind})</span>
          {it.restricted ? (
            <span className="text-dy-muted"> — {t.restricted}</span>
          ) : (
            <>
              {' '}
              — {it.title} · {fill(t.state, { state: it.state })}
              {it.links.map((l) => (
                <span key={l.href}>
                  {' · '}
                  {l.href.startsWith('/') ? (
                    <Link to={l.href} className="underline">
                      {l.label}
                    </Link>
                  ) : (
                    <a href={l.href} className="underline" rel="noreferrer noopener" target="_blank">
                      {l.label}
                    </a>
                  )}
                </span>
              ))}
            </>
          )}
        </p>
      );
  }
}
