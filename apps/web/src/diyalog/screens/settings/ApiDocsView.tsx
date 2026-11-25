import { fill } from '@remyral/i18n';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { apiRequest, type ApiError } from '../../../api/client';
import { cx, toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon } from '../../icons';
import { SOFT } from '../../tone';
import { CopyLine, DyApiError } from '../forms';
import { DySearch, Panel, Pill, SkeletonRows } from '../parts';
import { type DocWebhook, parseDocWebhooks, WebhookCatalogSection } from './api-docs-webhooks';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §10): Ayarlar → API — the public OpenAPI document (`/api/openapi.json`)
 * read by a small built-in viewer: authentication and a curl quick start, operations grouped by tag with their token
 * scope, parameters, request / response schemas and examples. No third-party script or stylesheet (the console's CSP
 * stays `script-src 'self'`); operation bodies render only when opened.
 */

type Json = Record<string, unknown>;

export interface DocOperation {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly scope: string;
  readonly op: Json;
}

export interface ParsedDoc {
  readonly title: string;
  readonly version: string;
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly operations: readonly DocOperation[];
  readonly components: Json;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function rec(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The operations of an OpenAPI document, in path order. */
export function parseOpenApi(doc: unknown): ParsedDoc {
  const d = rec(doc);
  const info = rec(d.info);
  const ops: DocOperation[] = [];
  for (const [path, item] of Object.entries(rec(d.paths))) {
    for (const m of METHODS) {
      const op = rec(rec(item)[m]);
      if (Object.keys(op).length === 0) continue;
      ops.push({
        method: m.toUpperCase(),
        path,
        summary: text(op.summary),
        tags: Array.isArray(op.tags) ? op.tags.filter((x): x is string => typeof x === 'string') : [],
        scope: text(op['x-token-scope']) || 'none',
        op,
      });
    }
  }
  const tags = Array.isArray(d.tags)
    ? d.tags.map((x) => ({ name: text(rec(x).name), description: text(rec(x).description) }))
    : [];
  return {
    title: text(info.title),
    version: text(info.version),
    tags,
    operations: ops,
    components: rec(rec(d.components).schemas),
  };
}

/** Operations matching a search (path, summary or tag; case-insensitive). */
export function filterOperations(ops: readonly DocOperation[], q: string): DocOperation[] {
  const s = q.trim().toLowerCase();
  if (s === '') return [...ops];
  return ops.filter(
    (o) =>
      o.path.toLowerCase().includes(s) ||
      o.summary.toLowerCase().includes(s) ||
      o.method.toLowerCase() === s ||
      o.tags.some((t) => t.toLowerCase().includes(s)),
  );
}

/** The curl command of an operation (path parameters as placeholders, the first JSON example as the body). */
export function curlFor(origin: string, o: DocOperation): string {
  const body = rec(rec(rec(o.op.requestBody).content)['application/json']);
  const examples = rec(body.examples);
  const first = Object.values(examples)[0];
  const sample = first === undefined ? body.example : rec(first).value;
  const lines = [
    `curl -X ${o.method} "${origin}/api${o.path}"`, // i18n-ignore: shell command
    '  -H "Authorization: Bearer $REMYRAL_TOKEN"', // i18n-ignore: shell command
  ];
  if (o.op.requestBody !== undefined) {
    lines.push('  -H "Content-Type: application/json"'); // i18n-ignore: shell command
    lines.push(`  -d '${JSON.stringify(sample ?? {})}'`); // i18n-ignore: shell command
  }
  return lines.join(' \\\n');
}

/** The first commands of the quick start (a shell command, not prose). */
export function quickstart(origin: string): string {
  return `export REMYRAL_TOKEN=ryl_pat_…\ncurl -H "Authorization: Bearer $REMYRAL_TOKEN" "${origin}/api/jobs?limit=5"`; // i18n-ignore: shell command
}

const METHOD_TONE: Readonly<Record<string, string>> = {
  GET: SOFT.teal,
  POST: SOFT.green,
  PUT: SOFT.amber,
  PATCH: SOFT.amber,
  DELETE: SOFT.red,
};

function MethodMark(props: { readonly method: string }): ReactNode {
  return (
    <span
      className={cx(
        'inline-block min-w-[3.6rem] rounded-[6px] px-1.5 py-px text-center font-dy-mono text-[0.75rem] font-bold',
        METHOD_TONE[props.method] ?? 'bg-dy-sunk',
      )}
    >
      {props.method}
    </span>
  );
}

/** A compact, recursive rendering of a JSON schema (properties, types, required, enums), depth-limited. */
function SchemaView(props: {
  readonly schema: unknown;
  readonly components: Json;
  readonly depth?: number;
}): ReactNode {
  const t = useT().apiTokens.docs;
  const depth = props.depth ?? 0;
  let s = rec(props.schema);
  const ref = text(s.$ref);
  if (ref.startsWith('#/components/schemas/')) s = rec(props.components[ref.slice(21)]);
  const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : []) as unknown[];
  const type = Array.isArray(s.type) ? s.type.join(' | ') : text(s.type);
  if (variants.length > 0 && depth < 4)
    return (
      <div className="grid gap-1">
        {variants.map((v, i) => (
          <SchemaView key={i} schema={v} components={props.components} depth={depth + 1} />
        ))}
      </div>
    );
  if (Array.isArray(s.enum))
    return (
      <code className="font-dy-mono text-[0.78125rem]">
        {s.enum.map((x) => JSON.stringify(x)).join(' | ')}
      </code>
    );
  if (type === 'array' || s.items !== undefined)
    return (
      <div className="grid gap-1">
        <code className="font-dy-mono text-[0.78125rem] text-dy-muted">{'array'}</code>
        {depth < 4 ? (
          <div className="border-l border-dy-line pl-3">
            <SchemaView schema={s.items} components={props.components} depth={depth + 1} />
          </div>
        ) : null}
      </div>
    );
  const props_ = rec(s.properties);
  const keys = Object.keys(props_);
  if (keys.length === 0 || depth >= 4)
    return <code className="font-dy-mono text-[0.78125rem] text-dy-muted">{type || 'object'}</code>;
  const required = new Set(
    Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : [],
  );
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {keys.map((k) => {
        const p = rec(props_[k]);
        const desc = text(p.description);
        return (
          <li key={k} className="grid gap-0.5">
            <span className="flex flex-wrap items-baseline gap-2">
              <code className="font-dy-mono text-[0.8125rem] font-bold">{k}</code>
              {required.has(k) ? <span className="text-[0.75rem] text-dy-red-ink">{t.required}</span> : null}
            </span>
            {desc === '' ? null : <span className="text-[0.78125rem] text-dy-muted">{desc}</span>}
            <div className="border-l border-dy-line pl-3">
              <SchemaView schema={p} components={props.components} depth={depth + 1} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function OperationBody(props: { readonly o: DocOperation; readonly components: Json }): ReactNode {
  const t = useT().apiTokens.docs;
  const { o } = props;
  const params = Array.isArray(o.op.parameters) ? o.op.parameters.map(rec) : [];
  const body = rec(rec(rec(o.op.requestBody).content)['application/json']);
  const responses = Object.entries(rec(o.op.responses));
  const examples = Object.entries(rec(body.examples));
  return (
    <div className="grid gap-3 border-t border-dy-line px-3.5 py-3 text-[0.875rem]">
      {params.length === 0 ? null : (
        <section className="grid gap-1">
          <h4 className="m-0 text-[0.8125rem] font-bold">{t.parameters}</h4>
          <ul className="m-0 grid list-none gap-1 p-0">
            {params.map((p) => (
              <li key={`${text(p.in)}:${text(p.name)}`} className="flex flex-wrap items-baseline gap-2">
                <code className="font-dy-mono text-[0.8125rem] font-bold">{text(p.name)}</code>
                <span className="text-[0.75rem] text-dy-muted">{text(p.in)}</span>
                {p.required === true ? (
                  <span className="text-[0.75rem] text-dy-red-ink">{t.required}</span>
                ) : null}
                <SchemaView schema={p.schema} components={props.components} depth={3} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {body.schema === undefined ? null : (
        <section className="grid gap-1">
          <h4 className="m-0 text-[0.8125rem] font-bold">{t.body}</h4>
          <SchemaView schema={body.schema} components={props.components} />
        </section>
      )}
      {examples.map(([k, v]) => (
        <section key={k} className="grid gap-1">
          <h4 className="m-0 text-[0.8125rem] font-bold">
            {t.example}: {text(rec(v).summary) || k}
          </h4>
          <pre className="m-0 overflow-x-auto rounded-[9px] bg-dy-sunk p-3 font-dy-mono text-[0.78125rem]">
            {JSON.stringify(rec(v).value, null, 2)}
          </pre>
        </section>
      ))}
      <section className="grid gap-2">
        <h4 className="m-0 text-[0.8125rem] font-bold">{t.responses}</h4>
        {responses.map(([status, r]) => {
          const content = rec(rec(r).content);
          const media = Object.entries(content)[0];
          const resExamples = Object.entries(rec(rec(media?.[1]).examples));
          return (
            <div key={status} className="grid gap-1">
              <span className="flex flex-wrap items-baseline gap-2">
                <code className="font-dy-mono text-[0.8125rem] font-bold">{status}</code>
                <span className="text-[0.78125rem] text-dy-muted">{text(rec(r).description)}</span>
                {media === undefined ? null : (
                  <code className="font-dy-mono text-[0.75rem] text-dy-faint">{media[0]}</code>
                )}
              </span>
              {media === undefined || status.startsWith('4') || status.startsWith('5') ? null : (
                <div className="border-l border-dy-line pl-3">
                  {rec(media[1]).schema === undefined ? (
                    <span className="text-[0.78125rem] text-dy-muted">{t.noSchema}</span>
                  ) : (
                    <SchemaView schema={rec(media[1]).schema} components={props.components} />
                  )}
                </div>
              )}
              {resExamples.map(([k, v]) => (
                <pre
                  key={k}
                  className="m-0 overflow-x-auto rounded-[9px] bg-dy-sunk p-3 font-dy-mono text-[0.78125rem]"
                >
                  {JSON.stringify(rec(v).value, null, 2)}
                </pre>
              ))}
            </div>
          );
        })}
      </section>
      {o.scope === 'none' ? null : <CopyLine text={curlFor(window.location.origin, o)} about={t.copyCurl} />}
    </div>
  );
}

function OperationItem(props: { readonly o: DocOperation; readonly components: Json }): ReactNode {
  const t = useT().apiTokens;
  const [open, setOpen] = useState(false);
  const { o } = props;
  const scope = (t.scopes as Readonly<Record<string, string>>)[o.scope];
  return (
    <li className="rounded-[10px] border border-dy-line bg-dy-card" data-testid="api-doc-operation">
      <details
        onToggle={(e) => {
          setOpen(e.currentTarget.open);
        }}
      >
        <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-2 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
          <MethodMark method={o.method} />
          <code className="min-w-0 font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]">{o.path}</code>
          <span className="min-w-0 flex-1 text-[0.8125rem] text-dy-muted">{o.summary}</span>
          {scope === undefined ? (
            <Pill tone="neutral">{t.docs.sessionOnly}</Pill>
          ) : (
            <Pill tone={o.scope === 'admin' ? 'violet' : 'teal'}>{fill(t.docs.scope, { scope })}</Pill>
          )}
        </summary>
        {open ? <OperationBody o={o} components={props.components} /> : null}
      </details>
    </li>
  );
}

function TagGroup(props: {
  readonly name: string;
  readonly description: string;
  readonly ops: readonly DocOperation[];
  readonly components: Json;
  readonly forceOpen: boolean;
}): ReactNode {
  const t = useT().apiTokens.docs;
  const [open, setOpen] = useState(false);
  const shown = open || props.forceOpen;
  return (
    <details
      open={props.forceOpen || undefined}
      data-testid={`api-doc-tag-${props.name}`}
      className="group min-w-0 rounded-[10px] border border-dy-line bg-dy-card"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3.5 text-[0.875rem] font-medium [&::-webkit-details-marker]:hidden">
        <DyIcon
          name="chev"
          className="size-4 shrink-0 -rotate-90 text-dy-muted transition-transform group-open:rotate-0 motion-reduce:transition-none"
        />
        <span className="font-bold">{props.name}</span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-dy-muted">{props.description}</span>
        <span className="font-dy-mono text-[0.75rem] text-dy-muted">
          {fill(t.operations, { n: props.ops.length })}
        </span>
      </summary>
      {shown ? (
        <ul className="m-0 grid list-none gap-1.5 border-t border-dy-line p-3">
          {props.ops.map((o) => (
            <OperationItem key={`${o.method} ${o.path}`} o={o} components={props.components} />
          ))}
        </ul>
      ) : null}
    </details>
  );
}

export function ApiDocsView(): ReactNode {
  const t = useT().apiTokens.docs;
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  // p16-webhooks-out: the webhook catalog of the same document (`webhooks`).
  const [hooks, setHooks] = useState<{ events: DocWebhook[]; version: number | null }>({
    events: [],
    version: null,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    apiRequest('GET', '/openapi.json', (b) => ({ parsed: parseOpenApi(b), hooks: parseDocWebhooks(b) })).then(
      (d) => {
        if (!live) return;
        setDoc(d.parsed);
        setHooks(d.hooks);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const ops = useMemo(() => (doc === null ? [] : filterOperations(doc.operations, q)), [doc, q]);
  const groups = useMemo(() => {
    if (doc === null) return [];
    const known = doc.tags.map((x) => x.name);
    const extra = [...new Set(ops.flatMap((o) => o.tags))].filter((n) => !known.includes(n));
    return [...doc.tags, ...extra.map((name) => ({ name, description: '' }))]
      .map((tag) => ({ ...tag, ops: ops.filter((o) => (o.tags[0] ?? '') === tag.name) }))
      .filter((g) => g.ops.length > 0);
  }, [doc, ops]);

  if (doc === null)
    return error === null ? (
      <Panel title={t.loading}>
        <SkeletonRows label={t.loading} rows={4} />
      </Panel>
    ) : (
      <DyApiError error={error} />
    );

  const origin = window.location.origin;
  const raw = `${origin}/api/openapi.json`;
  const createJob = doc.operations.find((o) => o.method === 'POST' && o.path === '/jobs');
  return (
    <div className="grid gap-4" data-testid="dy-api-docs">
      <Panel title={t.authTitle} sub={`${doc.title} · ${doc.version}`}>
        <div className="grid gap-3">
          <p className="m-0 text-[0.875rem]">{t.authBody}</p>
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            {fill(t.intro, { url: '' })}
            <a
              href="/api/openapi.json"
              className="font-dy-mono text-dy-teal-ink"
              target="_blank"
              rel="noopener noreferrer"
            >
              {raw}
            </a>
          </p>
          <h3 className="m-0 text-[0.875rem] font-bold">{t.quickstart}</h3>
          <CopyLine testId="api-doc-quickstart" text={quickstart(origin)} about={t.copyCurl} />
          {createJob === undefined ? null : <CopyLine text={curlFor(origin, createJob)} about={t.copyCurl} />}
        </div>
      </Panel>
      <div className="flex flex-wrap items-center gap-3">
        <DySearch value={q} onChange={setQ} placeholder={t.search} label={t.searchLabel} />
        <span className="font-dy-mono text-[0.8125rem] text-dy-muted" data-testid="api-doc-count">
          {fill(t.operations, { n: ops.length })}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{t.noMatch}</p>
      ) : (
        <div className="grid gap-2">
          {groups.map((g) => (
            <TagGroup
              key={g.name}
              name={g.name}
              description={g.description}
              ops={g.ops}
              components={doc.components}
              forceOpen={q.trim() !== ''}
            />
          ))}
        </div>
      )}
      <WebhookCatalogSection events={hooks.events} version={hooks.version} />
    </div>
  );
}
